import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises"
import path from "node:path"

import {
  deleteEpisodeRecord,
  getStoredEpisode,
  resolveLibrarySeasonNumberForAnime,
  upsertAnime,
  upsertEpisode,
} from "@/server/db/library"
import { getAnimeTitleSuffix } from "@/lib/anime-title"
import { createJob, updateJob } from "@/server/db/jobs"
import { getServerConfig } from "@/server/config"
import {
  ffprobe,
  getFileSubtitleInputArgs,
  getHardwareInputArgs,
  getHardwareInputLabel,
  getHevcFileArgs,
  runFfmpeg,
  type Mp4SubtitleOutputStream,
} from "@/server/media/ffmpeg"
import {
  formatEpisodeFileName,
  formatSeasonFolderName,
  parseAnimeFileName,
  sanitizeExportPathPart,
} from "@/server/media/filename"
import {
  generateEpisodeThumbnail,
  isMediaFile,
  parseDurationSeconds,
  pathExists,
  removeEpisodeThumbnails,
  type ProbeResult,
  waitForStableFile,
} from "@/server/media/mediaFiles"
import { emitLibraryChange } from "@/server/media/libraryEvents"
import {
  findAnimeMetadata,
  isAniListMetadataLookupUnavailableError,
} from "@/server/metadata/anilist"
import { getAudioOutputIndexesToAac } from "@/server/media/streamMetadata"
import { errorMessage, fileName } from "@/server/utils/format"
import { debugLog } from "@/server/utils/debugLog"

const hardwareMaxHevcBytesPerMinute = 25 * 1024 * 1024
const cpuMaxHevcBytesPerMinute = 30 * 1024 * 1024
const targetBytesPerMinute = 22 * 1024 * 1024
const targetAudioKbps = 320
const failedImportsFolderName = "_failed_imports"
const activeInputImportOutputs = new Map<string, number>()

type ImportFileEditKind =
  | "direct-move"
  | "audio-transcode"
  | "container-remux"
  | "video-transcode"

type VideoTranscodeReason = "none" | "shrink" | "full"

export type ProcessInputFileResult = {
  ok: boolean
  filePath: string
  planned: boolean
  message: string
}

export type DeferredInputWorkKind =
  | "video-transcode"
  | "audio-transcode"
  | "container-remux"
  | "direct-move"
  | "existing-output"
  | "catalog-only"

export type DeferredInputProcessingInfo = {
  id: string
  kind: "direct-move" | "video-transcode" | "audio-transcode" | "container-remux"
  animeTitle: string
  subtitle?: string | null
  seasonNumber: number
  episodeNumber: number
  fileName: string
}

export type DeferredInputWork = {
  kind: DeferredInputWorkKind
  filePath: string
  planned: boolean
  processing?: DeferredInputProcessingInfo
}

export type QueuedInputFileMoveKind =
  | "direct-import"
  | "transcode-output"
  | "library-relocation"

export type QueuedInputFileMove = {
  kind: QueuedInputFileMoveKind
  sourcePath: string
  destinationPath: string
  jobId?: string
}

export type QueueInputFileMove = (
  startMove: () => Promise<void>,
  move: QueuedInputFileMove
) => Promise<void>

export type ProcessInputFileOptions = {
  shutdownSignal?: AbortSignal
  deferVideoTranscodes?: boolean
  deferAudioTranscodes?: boolean
  queueFileMove: QueueInputFileMove
  onDeferredWork?: (
    startWork: () => Promise<void>,
    deferredWork: DeferredInputWork
  ) => void
}

function debugImport(jobId: string, message: string) {
  debugLog(`[Debug] [MediaImport:${jobId}] ${message}`)
}

function debugError(jobId: string, message: string, error: unknown) {
  const details = error instanceof Error && error.stack ? error.stack : errorMessage(error)
  console.error(`[Error] [MediaImport:${jobId}] ${message} - ${details}`)
}

function isSeriesFormat(format?: string | null) {
  return !format || format === "TV" || format === "TV_SHORT" || format === "ONA"
}

function seasonLabel(seasonNumber: number) {
  return `Season ${String(seasonNumber).padStart(2, "0")}`
}

function getImportProcessingSubtitle(input: {
  format?: string | null
  libraryTitle: string
  mediaTitle: string
  seasonNumber: number
}) {
  const suffix = getAnimeTitleSuffix({
    libraryTitle: input.libraryTitle,
    mediaTitle: input.mediaTitle,
  })

  if (suffix) {
    return suffix
  }

  if (isSeriesFormat(input.format) && input.seasonNumber > 1) {
    return seasonLabel(input.seasonNumber)
  }

  return null
}

function normalizeActiveOutputPath(filePath: string) {
  const resolvedPath = path.resolve(filePath)

  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath
}

export function isInputImportOutputActive(filePath: string) {
  return activeInputImportOutputs.has(normalizeActiveOutputPath(filePath))
}

function markInputImportOutputActive(filePath: string) {
  const normalizedPath = normalizeActiveOutputPath(filePath)
  const activeCount = activeInputImportOutputs.get(normalizedPath) ?? 0
  activeInputImportOutputs.set(normalizedPath, activeCount + 1)

  return () => {
    const nextCount = (activeInputImportOutputs.get(normalizedPath) ?? 1) - 1

    if (nextCount <= 0) {
      activeInputImportOutputs.delete(normalizedPath)
      return
    }

    activeInputImportOutputs.set(normalizedPath, nextCount)
  }
}

async function runWithActiveInputImportOutput<T>(
  filePath: string,
  work: () => Promise<T>
) {
  const release = markInputImportOutputActive(filePath)

  try {
    return await work()
  } finally {
    release()
  }
}

function formatDeferredWorkKind(kind: DeferredInputWorkKind) {
  if (kind === "video-transcode") {
    return "video transcode"
  }

  if (kind === "audio-transcode") {
    return "audio transcode"
  }

  if (kind === "container-remux") {
    return "MP4 remux"
  }

  if (kind === "existing-output") {
    return "existing output finalization"
  }

  if (kind === "catalog-only") {
    return "catalog-only library registration"
  }

  return "direct library move"
}

function isTranscodeWaitCancellation(error: unknown) {
  return errorMessage(error) === "Transcode request was cancelled"
}

function isShutdownCancellation(error: unknown, signal?: AbortSignal) {
  if (!signal?.aborted) {
    return false
  }

  const message = errorMessage(error).toLowerCase()

  return (
    isTranscodeWaitCancellation(error) ||
    message.includes("shutdown started") ||
    message.includes("was cancelled")
  )
}

function isInvalidMediaProbeError(error: unknown) {
  const message = errorMessage(error).toLowerCase()

  return (
    message.includes("invalid data found when processing input") ||
    message.includes("ebml header parsing failed") ||
    message.includes("invalid as first byte of an ebml number") ||
    message.includes("moov atom not found") ||
    message.includes("could not find codec parameters") ||
    message.includes("end of file")
  )
}

function hasHevcVideo(probe: ProbeResult) {
  return (probe.streams ?? []).some(
    (stream) =>
      stream.codec_type === "video" &&
      ["hevc", "h265"].includes((stream.codec_name ?? "").toLowerCase())
  )
}

const mp4ContainerFormatNames = new Set([
  "mov",
  "mp4",
  "m4a",
  "3gp",
  "3g2",
  "mj2",
])

function getProbeFormatNames(probe: ProbeResult) {
  return (probe.format?.format_name ?? "")
    .split(",")
    .map((format) => format.trim().toLowerCase())
    .filter(Boolean)
}

function usesMp4OutputContainer(filePath: string, probe: ProbeResult) {
  if (path.extname(filePath).toLowerCase() !== ".mp4") {
    return false
  }

  const formatNames = getProbeFormatNames(probe)

  return (
    formatNames.length === 0 ||
    formatNames.some((formatName) => mp4ContainerFormatNames.has(formatName))
  )
}

const mp4CopyableSubtitleCodecs = new Set(["mov_text"])
const mp4ConvertibleTextSubtitleCodecs = new Set([
  "ass",
  "ssa",
  "subrip",
  "srt",
  "text",
  "webvtt",
])

function getMp4SubtitleOutputStreams(probe: ProbeResult): Mp4SubtitleOutputStream[] {
  return (probe.streams ?? [])
    .map((stream) => {
      const codec = (stream.codec_name ?? "").trim().toLowerCase()

      if (stream.codec_type !== "subtitle" || !Number.isInteger(stream.index)) {
        return null
      }

      if (mp4CopyableSubtitleCodecs.has(codec)) {
        return { streamIndex: stream.index as number, codec: "copy" as const }
      }

      if (mp4ConvertibleTextSubtitleCodecs.has(codec)) {
        return { streamIndex: stream.index as number, codec: "mov_text" as const }
      }

      return null
    })
    .filter((stream): stream is Mp4SubtitleOutputStream => stream !== null)
}

function getMaxHevcBytesPerMinute() {
  return getServerConfig().transcodeAccel === "cpu"
    ? cpuMaxHevcBytesPerMinute
    : hardwareMaxHevcBytesPerMinute
}

function calculateVideoBitrateKbps(bytesPerMinute = targetBytesPerMinute) {
  const totalKbps = Math.floor((bytesPerMinute * 8) / 60 / 1000)
  return Math.max(totalKbps - targetAudioKbps, 500)
}

function calculateBytesPerMinute(
  fileSizeBytes: number,
  durationSeconds: number
) {
  const durationMinutes = Math.max(durationSeconds / 60, 1)
  return fileSizeBytes / durationMinutes
}

function formatMegabytesPerMinute(bytesPerMinute: number) {
  return (bytesPerMinute / 1024 / 1024).toFixed(1)
}

function metadataTitle(metadata: {
  id: number
  title: {
    userPreferred?: string | null
    english?: string | null
    romaji?: string | null
    native?: string | null
  }
}) {
  const title =
    metadata.title.english ??
    metadata.title.userPreferred ??
    metadata.title.romaji ??
    metadata.title.native

  if (!title) {
    throw new Error(`AniList media ${metadata.id} did not include a usable title`)
  }

  return title
}

function safePathSegment(value: string, label: string) {
  const safeValue = sanitizeExportPathPart(value)

  if (!safeValue) {
    throw new Error(`${label} resolved to an empty path segment`)
  }

  return safeValue
}

function mediaFolderSegments(input: {
  format: string | null | undefined
  season: number
  mediaTitle: string
}) {
  if (input.format === "MOVIE") {
    return ["Movies"]
  }

  if (input.format === "SPECIAL" || input.format === "OVA") {
    return ["Specials", input.mediaTitle]
  }

  return [formatSeasonFolderName(input.season)]
}

function summarizeProbe(probe: ProbeResult) {
  const streams = probe.streams ?? []

  return {
    videoCodecs: [
      ...new Set(
        streams
          .filter((stream) => stream.codec_type === "video")
          .map((stream) => stream.codec_name ?? "unknown")
      ),
    ],
    audioCodecs: [
      ...new Set(
        streams
          .filter((stream) => stream.codec_type === "audio")
          .map((stream) => stream.codec_name ?? "unknown")
      ),
    ],
    subtitleStreams: streams.filter(
      (stream) => stream.codec_type === "subtitle"
    ).length,
  }
}

async function replaceFile(
  source: string,
  destination: string,
  options?: { jobId?: string }
) {
  const jobId = options?.jobId
  const resolvedSource = path.resolve(source)
  const resolvedDestination = path.resolve(destination)

  if (jobId) {
    debugImport(
      jobId,
      `Preparing file replacement - Source ${resolvedSource}, Destination ${resolvedDestination}`
    )
  }

  if (resolvedSource === resolvedDestination) {
    if (jobId) {
      debugImport(jobId, "Source and destination are identical; replacement skipped.")
    }
    return
  }

  await mkdir(path.dirname(resolvedDestination), { recursive: true })

  if (jobId) {
    debugImport(
      jobId,
      `Destination directory ensured - ${path.dirname(resolvedDestination)}`
    )
  }

  await rm(resolvedDestination, { force: true })

  if (jobId) {
    debugImport(jobId, "Existing destination file removed if present.")
  }

  try {
    await rename(resolvedSource, resolvedDestination)

    if (jobId) {
      debugImport(jobId, "File moved with rename().")
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    if (code !== "EXDEV") {
      if (jobId) {
        debugError(jobId, "File rename failed", error)
      }
      throw error
    }

    if (jobId) {
      debugImport(jobId, "Cross-device move detected; falling back to copy and unlink.")
    }

    await copyFile(resolvedSource, resolvedDestination)
    await unlink(resolvedSource)

    if (jobId) {
      debugImport(jobId, "File copied to destination and original source removed.")
    }
  }

  if (!(await pathExists(resolvedDestination))) {
    throw new Error(`Destination file was not created: ${resolvedDestination}`)
  }

  if (jobId) {
    const outputStat = await stat(resolvedDestination)
    debugImport(
      jobId,
      `Destination file verified - ${resolvedDestination} (${outputStat.size} bytes)`
    )
  }
}

async function uniqueDestinationPath(destination: string) {
  if (!(await pathExists(destination))) {
    return destination
  }

  const parsed = path.parse(destination)

  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(
      parsed.dir,
      `${parsed.name} (${index})${parsed.ext}`
    )

    if (!(await pathExists(candidate))) {
      return candidate
    }
  }

  throw new Error(`Unable to find a free failed-import destination for ${destination}`)
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

async function runCooperativeSyncStep<T>(work: () => T) {
  await yieldToEventLoop()
  const result = work()
  await yieldToEventLoop()

  return result
}

function isInsideInputDirectory(inputDir: string, current: string) {
  const relative = path.relative(inputDir, current)

  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function isInsideFailedImports(inputDir: string, current: string) {
  const relative = path.relative(inputDir, path.resolve(current))

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false
  }

  return relative
    .split(path.sep)
    .some((part) => part === failedImportsFolderName)
}

function sanitizeFailedImportRelativePath(relativePath: string) {
  return relativePath
    .split(path.sep)
    .filter(Boolean)
    .map((part, index, parts) => {
      const fallback = index === parts.length - 1 ? "failed_file" : "unknown"

      return sanitizeExportPathPart(part) || fallback
    })
}

function cleanFolderTitleCandidate(value: string) {
  return value
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[._]+/g, " ")
    .replace(/\b(?:season|s)\s*\d{1,2}\b/gi, " ")
    .replace(/\b(?:1080p|720p|2160p|480p|bluray|blu-ray|bdrip|web[- ]?dl|webrip|remux|x264|x265|h264|h265|hevc|avc|aac|flac|opus|dual audio|multi audio)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function isIgnoredFolderTitleCandidate(value: string) {
  const normalized = value.trim().toLowerCase()

  return (
    !normalized ||
    normalized === failedImportsFolderName ||
    normalized === "season" ||
    normalized === "seasons" ||
    normalized === "special" ||
    normalized === "specials" ||
    normalized === "ova" ||
    normalized === "ovas" ||
    normalized === "movie" ||
    normalized === "movies" ||
    normalized === "extra" ||
    normalized === "extras" ||
    normalized === "episode" ||
    normalized === "episodes" ||
    normalized === "done" ||
    /^s\d{1,2}$/i.test(normalized) ||
    /^season\s*\d{1,2}$/i.test(normalized)
  )
}

function getFolderTitleFallbackCandidates(inputDir: string, filePath: string, parsedTitle: string) {
  const inputRoot = path.resolve(inputDir)
  const fileDirectory = path.dirname(path.resolve(filePath))
  const relativeDirectory = path.relative(inputRoot, fileDirectory)

  if (!relativeDirectory || relativeDirectory.startsWith("..") || path.isAbsolute(relativeDirectory)) {
    return []
  }

  const parts = relativeDirectory.split(path.sep).filter(Boolean)
  let candidateIndex = parts.length - 1

  while (candidateIndex >= 0) {
    const part = parts[candidateIndex]
    const cleaned = cleanFolderTitleCandidate(part)

    if (cleaned.length >= 2 && !isIgnoredFolderTitleCandidate(cleaned)) {
      break
    }

    candidateIndex -= 1
  }

  if (candidateIndex < 0) {
    return []
  }

  const cleaned = cleanFolderTitleCandidate(parts[candidateIndex])
  const key = cleaned.toLowerCase()
  const parsedTitleNormalized = parsedTitle.trim().toLowerCase()

  if (key === parsedTitleNormalized) {
    return []
  }

  return [cleaned]
}

async function moveFailedInputToFailedImports(
  filePath: string,
  options: { jobId: string; reason: string }
) {
  const inputDir = path.resolve(getServerConfig().inputDir)
  const resolvedFilePath = path.resolve(filePath)

  if (isInsideFailedImports(inputDir, resolvedFilePath)) {
    debugImport(
      options.jobId,
      `Failed input is already inside failed imports - ${resolvedFilePath}`
    )
    return resolvedFilePath
  }

  if (!isInsideInputDirectory(inputDir, resolvedFilePath)) {
    throw new Error(`Refusing to quarantine a file outside the input folder: ${resolvedFilePath}`)
  }

  const relativePath = sanitizeFailedImportRelativePath(
    path.relative(inputDir, resolvedFilePath)
  )
  const destination = await uniqueDestinationPath(
    path.resolve(inputDir, failedImportsFolderName, ...relativePath)
  )

  console.warn(
    `[Warn] [Media] Failed input moved to failed imports - ${options.reason} - ${resolvedFilePath} -> ${destination}`
  )
  debugImport(options.jobId, `Moving failed input to failed imports - ${destination}`)
  await replaceFile(resolvedFilePath, destination, { jobId: options.jobId })
  await removeNonMediaOnlyInputParents(resolvedFilePath, { jobId: options.jobId })

  return destination
}

async function tryMoveFailedInputToFailedImports(
  filePath: string,
  options: { jobId: string; reason: string }
) {
  try {
    if (!(await pathExists(filePath))) {
      debugImport(
        options.jobId,
        `Failed input source is no longer available; nothing to move - ${filePath}`
      )
      return null
    }

    return await moveFailedInputToFailedImports(filePath, options)
  } catch (error) {
    console.error(
      `[Error] [Media] Failed to move input to failed imports - processInputFile.ts - ${filePath} - ${errorMessage(error)}`
    )
    debugError(options.jobId, "Failed to move input to failed imports", error)
    return null
  }
}

async function finishRetryableInputFailure(
  filePath: string,
  options: { jobId: string; error: unknown; context: string }
): Promise<ProcessInputFileResult> {
  const message = errorMessage(options.error) || "Unknown media processing error"
  const retryMessage = `${message}; input file was left in the input folder for retry.`

  console.warn(
    `[Warn] [Media] ${options.context} - processInputFile.ts - ${filePath} - ${retryMessage}`
  )
  debugError(options.jobId, options.context, options.error)

  updateJob(options.jobId, {
    status: "failed",
    error: message,
    message: retryMessage,
    finishedAt: new Date().toISOString(),
  })

  return {
    ok: false,
    filePath,
    planned: false,
    message: retryMessage,
  }
}

async function probeInputFileWithRetry(filePath: string, jobId: string) {
  let lastError: unknown

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return (await ffprobe(filePath)) as ProbeResult
    } catch (error) {
      lastError = error

      if (!isInvalidMediaProbeError(error) || attempt === 3) {
        break
      }

      console.warn(
        `[Warn] [Media] ffprobe could not read input media; retrying ${attempt}/3 - ${fileName(filePath)} - ${errorMessage(error)}`
      )
      debugError(jobId, `ffprobe failed on attempt ${attempt}/3`, error)
      await sleep(2000 * attempt)
    }
  }

  throw lastError
}

async function unlinkFileWithRetry(
  filePath: string,
  options?: { jobId?: string; attempts?: number }
) {
  const attempts = options?.attempts ?? 5

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await unlink(filePath)

      if (options?.jobId) {
        debugImport(options.jobId, `Removed input source file - ${filePath}`)
      }

      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      if (code === "ENOENT") {
        return
      }

      if (attempt >= attempts) {
        if (options?.jobId) {
          debugError(options.jobId, "Input source file removal failed", error)
        }
        throw error
      }

      if (options?.jobId) {
        debugImport(
          options.jobId,
          `Input source file removal failed; retrying ${attempt}/${attempts} - ${filePath}`
        )
      }

      await sleep(250 * attempt)
    }
  }
}

async function directoryContainsMediaFile(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => null)

  if (!entries) {
    return false
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      if (await directoryContainsMediaFile(entryPath)) {
        return true
      }

      continue
    }

    if (entry.isFile() && isMediaFile(entryPath)) {
      return true
    }
  }

  return false
}

async function removeNonMediaOnlyInputParents(
  filePath: string,
  options?: { jobId?: string }
) {
  const inputDir = path.resolve(getServerConfig().inputDir)
  let current = path.dirname(path.resolve(filePath))

  while (isInsideInputDirectory(inputDir, current)) {
    if (await directoryContainsMediaFile(current)) {
      if (options?.jobId) {
        debugImport(
          options.jobId,
          `Input cleanup stopped; media files still remain in ${current}`
        )
      }

      return
    }

    if (options?.jobId) {
      debugImport(
        options.jobId,
        `Removing input folder with only non-media leftovers - ${current}`
      )
    }

    await rm(current, { force: true, recursive: true })
    current = path.dirname(current)
  }
}

async function transcodeFile(
  inputPath: string,
  outputPath: string,
  options: {
    convertVideo: boolean
    audioOutputIndexesToAac: number[]
    subtitleStreams: Mp4SubtitleOutputStream[]
    videoBitrateKbps: number
    maxVideoBitrateKbps: number
    jobId?: string
  }
) {
  await mkdir(path.dirname(outputPath), { recursive: true })

  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    ...(options.convertVideo
      ? getHardwareInputArgs({ keepFramesOnDevice: true })
      : []),
    ...getFileSubtitleInputArgs(options),
    "-i",
    inputPath,
    ...getHevcFileArgs(options),
    "-y",
    outputPath,
  ]

  if (options.jobId) {
    debugImport(
      options.jobId,
      `Temporary transcode directory ensured - ${path.dirname(outputPath)}`
    )
    debugImport(options.jobId, `FFmpeg file-processing command - ${args.join(" ")}`)
  }

  try {
    await runFfmpeg(args, { protectFromParentSignals: true })
  } catch (error) {
    if (options.jobId) {
      debugError(options.jobId, "FFmpeg file processing failed", error)
    }
    throw error
  }

  if (!(await pathExists(outputPath))) {
    throw new Error(`FFmpeg completed but did not create output file: ${outputPath}`)
  }

  if (options.jobId) {
    const outputStat = await stat(outputPath)
    debugImport(
      options.jobId,
      `FFmpeg output verified - ${outputPath} (${outputStat.size} bytes)`
    )
  }
}

export async function processInputFile(
  filePath: string,
  options: ProcessInputFileOptions
): Promise<ProcessInputFileResult> {
  const jobId = createJob(filePath)
  const config = getServerConfig()
  const importEnabled = config.importEnabled

  console.log(
    `[Info] [Media] Input file processing started - ${fileName(filePath)}`
  )
  debugImport(jobId, `Created media-processing job for ${filePath}`)

  try {
    updateJob(jobId, {
      status: "processing",
      startedAt: new Date().toISOString(),
      message: "Waiting for input file to become stable.",
    })
    debugImport(jobId, "Job marked as processing.")

    debugImport(jobId, `Checking media file extension - ${filePath}`)
    if (!isMediaFile(filePath)) {
      console.log(
        `[Info] [Media] Skipped non-media input file - ${fileName(filePath)}`
      )
      updateJob(jobId, {
        status: "skipped",
        message: "Skipped non-media file.",
        finishedAt: new Date().toISOString(),
      })

      return {
        ok: true,
        filePath,
        planned: false,
        message: "Skipped non-media file.",
      }
    }

    debugImport(jobId, `Checking input path exists - ${filePath}`)
    if (!(await pathExists(filePath))) {
      throw new Error("Input file is no longer available")
    }
    debugImport(jobId, "Input path exists.")

    console.log(
      `[Info] [Media] Waiting for input file to become stable - ${fileName(filePath)}`
    )
    await waitForStableFile(filePath)
    debugImport(jobId, "Input file is stable.")

    debugImport(jobId, "Parsing anime filename.")
    const parsed = parseAnimeFileName(filePath)

    if (!parsed) {
      const error = "Unable to extract anime title and episode number"

      if (!importEnabled) {
        const message = `${error}; input file was left untouched because import processing is disabled.`

        updateJob(jobId, {
          status: "failed",
          error,
          message,
          finishedAt: new Date().toISOString(),
        })

        debugImport(jobId, message)

        return {
          ok: true,
          filePath,
          planned: false,
          message,
        }
      }

      const failedPath = await moveFailedInputToFailedImports(filePath, {
        jobId,
        reason: error,
      })
      const message = `Unrecognized media filename was moved to failed imports: ${failedPath}`

      updateJob(jobId, {
        status: "failed",
        error,
        message,
        finishedAt: new Date().toISOString(),
      })

      debugImport(jobId, message)

      return {
        ok: true,
        filePath: failedPath,
        planned: false,
        message,
      }
    }

    console.log(
      `[Info] [Media] Recognized input file - Title: ${parsed.title}, Season: ${parsed.season}${parsed.part ? `, Part: ${parsed.part}` : ""}, Episode: ${parsed.episode}`
    )
    debugImport(
      jobId,
      `Parsed input file - Title ${parsed.title}, Season ${parsed.season}${parsed.part ? `, Part ${parsed.part}` : ""}, Episode ${parsed.episode}`
    )

    updateJob(jobId, {
      message: "Fetching AniList metadata.",
    })

    debugImport(jobId, "Starting AniList metadata lookup.")
    let metadata: Awaited<ReturnType<typeof findAnimeMetadata>>
    let resolvedParsed = parsed

    try {
      metadata = await findAnimeMetadata(
        parsed.title,
        parsed.season,
        parsed.episode,
        parsed.part
      )

      if (!metadata) {
        const fallbackTitles = getFolderTitleFallbackCandidates(
          config.inputDir,
          filePath,
          parsed.title
        )

        for (const fallbackTitle of fallbackTitles) {
          console.warn(
            `[Warn] [Media] AniList could not match filename title "${parsed.title}"; trying folder title "${fallbackTitle}" - ${fileName(filePath)}`
          )
          debugImport(
            jobId,
            `Trying folder title fallback - Filename title ${parsed.title}, Folder title ${fallbackTitle}`
          )
          updateJob(jobId, {
            message: `Fetching AniList metadata using folder title: ${fallbackTitle}.`,
          })

          const fallbackMetadata = await findAnimeMetadata(
            fallbackTitle,
            parsed.season,
            parsed.episode,
            parsed.part
          )

          if (!fallbackMetadata) {
            continue
          }

          metadata = fallbackMetadata
          resolvedParsed = { ...parsed, title: fallbackTitle }
          console.log(
            `[Info] [Media] Folder title fallback matched AniList metadata - ${fallbackTitle} - ${fileName(filePath)}`
          )
          debugImport(jobId, `Folder title fallback matched - ${fallbackTitle}.`)
          break
        }
      }
    } catch (error) {
      if (isAniListMetadataLookupUnavailableError(error)) {
        return finishRetryableInputFailure(filePath, {
          jobId,
          error,
          context: "AniList metadata lookup could not complete",
        })
      }

      throw error
    }

    if (!metadata) {
      const error = `AniList could not match "${parsed.title}"`

      if (!importEnabled) {
        const message = `${error}; input file was left untouched because import processing is disabled.`

        updateJob(jobId, {
          status: "failed",
          error,
          message,
          finishedAt: new Date().toISOString(),
        })

        debugImport(jobId, message)

        return {
          ok: true,
          filePath,
          planned: false,
          message,
        }
      }

      const failedPath = await moveFailedInputToFailedImports(filePath, {
        jobId,
        reason: error,
      })
      const message = `Unmatched media file was moved to failed imports: ${failedPath}`

      updateJob(jobId, {
        status: "failed",
        error,
        message,
        finishedAt: new Date().toISOString(),
      })

      debugImport(jobId, message)

      return {
        ok: true,
        filePath: failedPath,
        planned: false,
        message,
      }
    }

    const inputParsed: NonNullable<ReturnType<typeof parseAnimeFileName>> = resolvedParsed
    const inputMetadata: NonNullable<Awaited<ReturnType<typeof findAnimeMetadata>>> = metadata

    debugImport(jobId, `AniList metadata lookup completed - Anime id ${inputMetadata.id}.`)
    debugImport(jobId, "Saving AniList metadata before media processing.")
    await runCooperativeSyncStep(() => upsertAnime(inputMetadata))
    debugImport(jobId, "AniList metadata saved.")

    const librarySeason = await runCooperativeSyncStep(() =>
      resolveLibrarySeasonNumberForAnime({
        animeId: inputMetadata.id,
        parsedSeason: inputParsed.season,
        parsedPart: inputParsed.part,
      })
    )

    if (librarySeason !== inputParsed.season) {
      console.log(
        `[Info] [Media] Resolved library season - Parsed Season ${inputParsed.season}, Library Season ${librarySeason}, Anime id ${inputMetadata.id}`
      )
      debugImport(
        jobId,
        `Library season resolved from parsed season ${inputParsed.season} to ${librarySeason}.`
      )
    }

    console.log(
      `[Info] [Media] Resolved AniList metadata - Found match ${
        inputMetadata.title.english ??
        inputParsed.title
      } - id ${inputMetadata.id}`
    )

    updateJob(jobId, {
      animeId: inputMetadata.id,
      epNr: inputParsed.episode,
      message: "Inspecting media streams.",
    })

    debugImport(jobId, `Reading input file stat - ${filePath}`)
    const inputStat = await stat(filePath)
    debugImport(jobId, `Input file stat read - ${inputStat.size} bytes.`)

    debugImport(jobId, `Running ffprobe - ${filePath}`)
    let probe: ProbeResult

    try {
      probe = await probeInputFileWithRetry(filePath, jobId)
    } catch (error) {
      if (!isInvalidMediaProbeError(error)) {
        throw error
      }

      const errorText = errorMessage(error)

      if (!importEnabled) {
        const message = `Invalid media file was left untouched because import processing is disabled: ${errorText}`

        updateJob(jobId, {
          status: "failed",
          error: errorText,
          message,
          finishedAt: new Date().toISOString(),
        })

        debugImport(jobId, message)

        return {
          ok: true,
          filePath,
          planned: false,
          message,
        }
      }

      const failedPath = await moveFailedInputToFailedImports(filePath, {
        jobId,
        reason: errorText,
      })
      const message = `Invalid media file was moved to failed imports: ${failedPath}`

      updateJob(jobId, {
        status: "failed",
        error: errorText,
        message,
        finishedAt: new Date().toISOString(),
      })

      debugImport(jobId, message)

      return {
        ok: true,
        filePath: failedPath,
        planned: false,
        message,
      }
    }

    debugImport(jobId, `ffprobe completed - Streams ${(probe.streams ?? []).length}.`)

    const durationSeconds = parseDurationSeconds(probe)
    debugImport(jobId, `Parsed duration - ${durationSeconds}s.`)

    const mediaTitle = metadataTitle(inputMetadata)
    const resolvedLibrary = inputMetadata.library

    if (!resolvedLibrary?.title) {
      throw new Error(`AniList media ${inputMetadata.id} did not resolve a library root`)
    }

    const library = resolvedLibrary
    const libraryTitle = library.title

    function emitEpisodeAdded() {
      emitLibraryChange({
        type: "episode-added",
        animeId: inputMetadata.id,
        rootAnimeId: library.primaryAnimeId,
        librarySlug: library.slug,
        seasonNumber: librarySeason,
        episodeNumber: inputParsed.episode,
      })
    }

    async function runDeferredImportWork(input: {
      kind: DeferredInputWorkKind
      outputPath: string
      work: () => Promise<ProcessInputFileResult>
    }) {
      const label = formatDeferredWorkKind(input.kind)

      try {
        await runWithActiveInputImportOutput(input.outputPath, async () => {
          await yieldToEventLoop()
          return input.work()
        })
      } catch (error) {
        const message = errorMessage(error) || "Unknown media processing error"

        if (isShutdownCancellation(error, options.shutdownSignal)) {
          const shutdownMessage = `Skipped queued ${label} because shutdown started.`

          console.warn(
            `[Warn] [Media] Queued ${label} cancelled during shutdown - processInputFile.ts - ${filePath}`
          )
          debugImport(jobId, shutdownMessage)
          updateJob(jobId, {
            status: "skipped",
            message: shutdownMessage,
            finishedAt: new Date().toISOString(),
          })
          return
        }

        if (!importEnabled) {
          const failureMessage = `${message}; input file was left untouched because import processing is disabled.`

          console.error(
            `[Error] [Media] Deferred ${label} failed - processInputFile.ts - ${filePath} - ${failureMessage}`
          )
          debugError(jobId, `Deferred ${label} failed`, error)

          updateJob(jobId, {
            status: "failed",
            error: message,
            message: failureMessage,
            finishedAt: new Date().toISOString(),
          })
          return
        }

        const inputStillExists = await pathExists(filePath)
        const failureMessage = inputStillExists
          ? `${message}; input file was left in the input folder for retry.`
          : `${message}; input source was already moved or removed before the deferred failure.`

        console.error(
          `[Error] [Media] Deferred ${label} failed - processInputFile.ts - ${filePath} - ${failureMessage}`
        )
        debugError(jobId, `Deferred ${label} failed`, error)

        updateJob(jobId, {
          status: "failed",
          error: message,
          message: failureMessage,
          finishedAt: new Date().toISOString(),
        })
      }
    }

    function queueDeferredImportWork(input: {
      kind: DeferredInputWorkKind
      outputPath: string
      planned: boolean
      message: string
      work: () => Promise<ProcessInputFileResult>
      processing?: DeferredInputProcessingInfo
    }): ProcessInputFileResult {
      const startDeferredWork = () =>
        runDeferredImportWork({
          kind: input.kind,
          outputPath: input.outputPath,
          work: input.work,
        })

      if (options.onDeferredWork) {
        options.onDeferredWork(startDeferredWork, {
          kind: input.kind,
          filePath: input.outputPath,
          planned: input.planned,
          processing: input.processing,
        })
      } else {
        void startDeferredWork()
      }

      return {
        ok: true,
        filePath: input.outputPath,
        planned: input.planned,
        message: input.message,
      }
    }

    if (!importEnabled) {
      const catalogExistingEpisode = await runCooperativeSyncStep(() =>
        getStoredEpisode(
          inputMetadata.id,
          librarySeason,
          inputParsed.episode
        )
      )
      const resolvedInputPath = path.resolve(filePath)

      if (catalogExistingEpisode) {
        const existingPath = path.resolve(catalogExistingEpisode.filePath)
        const existingPathStillExists = await pathExists(existingPath)

        if (existingPathStillExists && existingPath !== resolvedInputPath) {
          const message = `Episode already exists in the library and import processing is disabled; duplicate input was left untouched: ${libraryTitle} S${String(librarySeason).padStart(2, "0")}E${String(inputParsed.episode).padStart(2, "0")}`

          updateJob(jobId, {
            status: "skipped",
            outputPath: existingPath,
            message,
            finishedAt: new Date().toISOString(),
          })

          debugImport(jobId, `${message}; existing path ${existingPath}`)

          return {
            ok: true,
            filePath: existingPath,
            planned: false,
            message,
          }
        }

        if (existingPathStillExists && existingPath === resolvedInputPath) {
          const message = `Input file is already registered in the library: ${libraryTitle} S${String(librarySeason).padStart(2, "0")}E${String(inputParsed.episode).padStart(2, "0")}`

          updateJob(jobId, {
            status: "skipped",
            outputPath: resolvedInputPath,
            message,
            finishedAt: new Date().toISOString(),
          })

          debugImport(jobId, message)

          return {
            ok: true,
            filePath: resolvedInputPath,
            planned: false,
            message,
          }
        }
      }

      async function finishCatalogOnlyImport() {
        const catalogLegacyEpisode =
          librarySeason !== inputParsed.season
            ? await runCooperativeSyncStep(() =>
                getStoredEpisode(
                  inputMetadata.id,
                  inputParsed.season,
                  inputParsed.episode
                )
              )
            : null

        if (catalogLegacyEpisode) {
          await runCooperativeSyncStep(() =>
            deleteEpisodeRecord({
              animeId: inputMetadata.id,
              seasonNr: inputParsed.season,
              epNr: inputParsed.episode,
            })
          )
          debugImport(jobId, "Legacy parsed-season episode record removed without touching files.")
        }

        updateJob(jobId, {
          outputPath: resolvedInputPath,
          message: "Generating thumbnail.",
        })

        console.log(
          `[Info] [Media] Generating episode thumbnail - ${fileName(resolvedInputPath)}`
        )

        const thumbnailPath = await generateEpisodeThumbnail(
          resolvedInputPath,
          durationSeconds
        )
        debugImport(jobId, `Thumbnail generated - ${thumbnailPath}`)

        await runCooperativeSyncStep(() =>
          upsertEpisode({
            animeId: inputMetadata.id,
            seasonNr: librarySeason,
            epNr: inputParsed.episode,
            filePath: resolvedInputPath,
            thumbnailPath,
            durationSeconds,
          })
        )
        emitEpisodeAdded()

        const message = "Input file added to the library without moving, deleting, or transcoding."

        updateJob(jobId, {
          status: "completed",
          outputPath: resolvedInputPath,
          message,
          finishedAt: new Date().toISOString(),
        })

        debugImport(jobId, `Catalog-only import completed successfully - ${resolvedInputPath}`)

        return {
          ok: true,
          filePath: resolvedInputPath,
          planned: false,
          message,
        }
      }

      updateJob(jobId, {
        message: "Cataloging input file in background.",
      })
      console.log(
        `[Info] [Media] Cataloging input file in background - ${fileName(filePath)}`
      )
      debugImport(jobId, "Catalog-only import moved to immediate background work.")

      return queueDeferredImportWork({
        kind: "catalog-only",
        outputPath: resolvedInputPath,
        planned: false,
        message: "Cataloging input file in background.",
        work: finishCatalogOnlyImport,
      })
    }

    const inputBytesPerMinute = calculateBytesPerMinute(
      inputStat.size,
      durationSeconds
    )
    const maxHevcBytesPerMinute = getMaxHevcBytesPerMinute()
    const inputHasHevcVideo = hasHevcVideo(probe)
    const audioOutputIndexesToAac = getAudioOutputIndexesToAac(probe)
    const subtitleStreams = getMp4SubtitleOutputStreams(probe)
    const convertAudioToAac = audioOutputIndexesToAac.length > 0
    const inputUsesMp4Container = inputHasHevcVideo
      ? usesMp4OutputContainer(filePath, probe)
      : false
    const requiresVideoShrink = inputHasHevcVideo
      ? inputBytesPerMinute > maxHevcBytesPerMinute
      : false
    const requiresMp4ContainerRemux = inputHasHevcVideo
      ? !inputUsesMp4Container
      : false
    const requiredSingleStepEdits = inputHasHevcVideo
      ? [requiresVideoShrink, requiresMp4ContainerRemux, convertAudioToAac].filter(
          Boolean
        ).length
      : 0
    const videoTranscodeReason: VideoTranscodeReason = !inputHasHevcVideo
      ? "full"
      : requiredSingleStepEdits > 1
        ? "full"
        : requiresVideoShrink
          ? "shrink"
          : "none"
    const convertVideo = videoTranscodeReason !== "none"
    const importFileEditKind: ImportFileEditKind = convertVideo
      ? "video-transcode"
      : convertAudioToAac
        ? "audio-transcode"
        : requiresMp4ContainerRemux
          ? "container-remux"
          : "direct-move"
    const needsFfmpegProcessing = importFileEditKind !== "direct-move"
    const videoBitrateKbps = calculateVideoBitrateKbps()
    const skippedDetailedEditChecks = !inputHasHevcVideo

    debugImport(
      jobId,
      skippedDetailedEditChecks
        ? `Processing decision - hevc false, action ${importFileEditKind}, videoTranscodeReason ${videoTranscodeReason}, needsFfmpegProcessing ${needsFfmpegProcessing}; skipped shrink/remux/audio-decision checks because full processing is required. Audio tracks to AAC for output [${audioOutputIndexesToAac.join(", ")}], subtitleTracks [${subtitleStreams.map((stream) => `${stream.streamIndex}:${stream.codec}`).join(", ")}]`
        : `Processing decision - hevc ${inputHasHevcVideo}, belowMaxSize ${!requiresVideoShrink}, mp4Container ${inputUsesMp4Container}, audioTracksToAac [${audioOutputIndexesToAac.join(", ")}], subtitleTracks [${subtitleStreams.map((stream) => `${stream.streamIndex}:${stream.codec}`).join(", ")}], requiredEdits ${requiredSingleStepEdits}, action ${importFileEditKind}, videoTranscodeReason ${videoTranscodeReason}, needsFfmpegProcessing ${needsFfmpegProcessing}`
    )

    const safeLibraryTitle = safePathSegment(libraryTitle, "Library title")
    const safeMediaTitle = safePathSegment(mediaTitle, "Media title")
    const extension = needsFfmpegProcessing ? ".mp4" : path.extname(filePath)
    const finalName = formatEpisodeFileName({
      title: safeMediaTitle,
      season: librarySeason,
      episode: inputParsed.episode,
      extension,
    })
    const finalPath = path.resolve(
      config.mediaDir,
      safeLibraryTitle,
      ...mediaFolderSegments({
        format: inputMetadata.format,
        season: librarySeason,
        mediaTitle: safeMediaTitle,
      }),
      finalName
    )
    const tempPath = path.resolve(
      config.tempDir,
      "jobs",
      jobId,
      finalName
    )
    debugImport(jobId, `Resolved output path - ${finalPath}`)
    debugImport(jobId, `Resolved temp path - ${tempPath}`)

    const processingInfo = {
      id: jobId,
      animeTitle: libraryTitle,
      subtitle: getImportProcessingSubtitle({
        format: inputMetadata.format,
        libraryTitle,
        mediaTitle,
        seasonNumber: librarySeason,
      }),
      seasonNumber: librarySeason,
      episodeNumber: inputParsed.episode,
      fileName: finalName,
    }

    async function moveLibraryFileThroughQueue(
      sourcePath: string,
      destinationPath: string,
      kind: QueuedInputFileMoveKind
    ) {
      const startMove = () => replaceFile(sourcePath, destinationPath, { jobId })

      await options.queueFileMove(startMove, {
        kind,
        sourcePath,
        destinationPath,
        jobId,
      })
    }

    debugImport(jobId, "Checking for existing episode/file conflicts.")
    const existingEpisode = await runCooperativeSyncStep(() =>
      getStoredEpisode(
        inputMetadata.id,
        librarySeason,
        inputParsed.episode
      )
    )
    const legacySeasonEpisode =
      librarySeason !== inputParsed.season
        ? await runCooperativeSyncStep(() =>
            getStoredEpisode(inputMetadata.id, inputParsed.season, inputParsed.episode)
          )
        : null

    const existingEpisodeFileExists = existingEpisode
      ? await pathExists(existingEpisode.filePath)
      : false
    let finalPathExists = await pathExists(finalPath)

    if (existingEpisodeFileExists && existingEpisode) {
      const existingPath = path.resolve(existingEpisode.filePath)
      const inputPath = path.resolve(filePath)
      const message = `Episode already exists in the library: ${safeLibraryTitle} S${String(librarySeason).padStart(2, "0")}E${String(inputParsed.episode).padStart(2, "0")}`

      console.warn(
        `[Warn] [Media] ${message}; cleaning duplicate input if needed - ${filePath}`
      )
      debugImport(jobId, `${message}; existing path ${existingPath}`)

      if (existingPath !== inputPath && (await pathExists(filePath))) {
        await unlinkFileWithRetry(filePath, { jobId })
        await removeNonMediaOnlyInputParents(filePath, { jobId })
      }

      updateJob(jobId, {
        status: "skipped",
        outputPath: existingPath,
        message,
        finishedAt: new Date().toISOString(),
      })

      return {
        ok: true,
        filePath: existingPath,
        planned: false,
        message,
      }
    }

    if (legacySeasonEpisode && (await pathExists(legacySeasonEpisode.filePath))) {
      console.warn(
        `[Warn] [Media] Existing episode was stored under parsed Season ${inputParsed.season}; moving it to library Season ${librarySeason} - ${legacySeasonEpisode.filePath}`
      )

      if (finalPathExists) {
        await unlinkFileWithRetry(legacySeasonEpisode.filePath, { jobId })
      } else {
        await moveLibraryFileThroughQueue(
          legacySeasonEpisode.filePath,
          finalPath,
          "library-relocation"
        )
        finalPathExists = true
      }

      await removeEpisodeThumbnails(legacySeasonEpisode.filePath)
      await runCooperativeSyncStep(() =>
        deleteEpisodeRecord({
          animeId: inputMetadata.id,
          seasonNr: inputParsed.season,
          epNr: inputParsed.episode,
        })
      )
      debugImport(jobId, "Legacy parsed-season episode record removed.")
    }

    const useExistingOutput = finalPathExists

    if (useExistingOutput) {
      console.warn(
        `[Warn] [Media] Output file already exists without a stored episode; finishing database import and cleaning input duplicate - ${finalPath}`
      )
      debugImport(
        jobId,
        `Output already exists without a stored episode; using existing output - ${finalPath}`
      )
    } else {
      debugImport(jobId, "No existing episode/file conflict found.")
    }

    const summary = summarizeProbe(probe)
    const importAnimeId = inputMetadata.id
    const importEpisodeNumber = inputParsed.episode

    console.log(
      `[Info] [Media] Media stream inspection completed - ${fileName(filePath)} - Video: ${summary.videoCodecs.join(", ") || "unknown"}, Audio: ${summary.audioCodecs.join(", ") || "unknown"}, Duration: ${Math.round(durationSeconds)}s, Size: ${formatMegabytesPerMinute(inputBytesPerMinute)} MB/min`
    )

    async function finalizeImport(input: {
      planned: boolean
      completedMessage: string
    }): Promise<ProcessInputFileResult> {
      updateJob(jobId, {
        outputPath: finalPath,
        message: "Generating thumbnail.",
      })

      console.log(
        `[Info] [Media] Generating episode thumbnail - ${fileName(finalPath)}`
      )

      debugImport(jobId, `Checking output file before thumbnail - ${finalPath}`)
      if (!(await pathExists(finalPath))) {
        throw new Error(`Output file is missing before thumbnail generation: ${finalPath}`)
      }

      const thumbnailPath = await generateEpisodeThumbnail(
        finalPath,
        durationSeconds
      )
      debugImport(jobId, `Thumbnail generated - ${thumbnailPath}`)

      debugImport(jobId, "Saving episode row.")
      await runCooperativeSyncStep(() =>
        upsertEpisode({
          animeId: importAnimeId,
          seasonNr: librarySeason,
          epNr: importEpisodeNumber,
          filePath: finalPath,
          thumbnailPath,
          durationSeconds,
        })
      )
      emitEpisodeAdded()

      console.log(
        `[Info] [Media] Episode added to database - Anime id ${importAnimeId}, Season ${librarySeason}, Episode ${importEpisodeNumber}`
      )
      debugImport(jobId, "Episode row saved.")

      updateJob(jobId, {
        status: "completed",
        outputPath: finalPath,
        message: input.completedMessage,
        finishedAt: new Date().toISOString(),
      })

      debugImport(jobId, `Media import completed successfully - ${finalPath}`)

      return {
        ok: true,
        filePath: finalPath,
        planned: input.planned,
        message: input.completedMessage,
      }
    }

    async function runFfmpegProcessing() {
      const processingLabel = convertVideo
        ? videoTranscodeReason === "shrink"
          ? "shrinking video transcode"
          : "full video transcode"
        : convertAudioToAac
          ? "audio transcode"
          : "MP4 remux"

      updateJob(jobId, {
        message: convertVideo
          ? videoTranscodeReason === "shrink"
            ? "Shrinking media file."
            : "Transcoding media file."
          : convertAudioToAac
            ? "Converting audio tracks to LC-AAC."
            : "Remuxing media file to MP4.",
      })

      console.log(
        `[Info] [Media] Starting ${processingLabel} - ${fileName(filePath)} - Accel: ${config.transcodeAccel}, HW decode: ${convertVideo ? getHardwareInputLabel() : "not needed"}, HEVC: ${inputHasHevcVideo ? "yes" : "no"}, Size: ${formatMegabytesPerMinute(inputBytesPerMinute)} MB/min, AAC audio tracks: ${audioOutputIndexesToAac.length ? audioOutputIndexesToAac.join(", ") : "none"}, MP4 remux: ${requiresMp4ContainerRemux ? "yes" : "no"}, Target: ${formatMegabytesPerMinute(targetBytesPerMinute)} MB/min, Bitrate: ${videoBitrateKbps}k, Maxrate: ${calculateVideoBitrateKbps(maxHevcBytesPerMinute)}k`
      )

      await transcodeFile(filePath, tempPath, {
        convertVideo,
        audioOutputIndexesToAac,
        subtitleStreams,
        videoBitrateKbps,
        maxVideoBitrateKbps: calculateVideoBitrateKbps(maxHevcBytesPerMinute),
        jobId,
      })
      debugImport(jobId, "FFmpeg processing step completed successfully.")

      console.log(
        `[Info] [Media] Media processing completed - ${fileName(filePath)}`
      )
      updateJob(jobId, {
        message: "Moving processed output into the library.",
      })
      debugImport(jobId, "Queueing transcoded output move into the library.")
      await moveLibraryFileThroughQueue(tempPath, finalPath, "transcode-output")
      debugImport(jobId, "Transcoded output move completed.")
      debugImport(jobId, "Removing temporary job directory.")
      await rm(path.dirname(tempPath), { force: true, recursive: true })
      debugImport(jobId, "Temporary job directory removed.")
      debugImport(jobId, "Removing original input file after processed output move.")
      await unlinkFileWithRetry(filePath, { jobId })
      debugImport(jobId, "Cleaning input parent folders.")
      await removeNonMediaOnlyInputParents(filePath, { jobId })
      debugImport(jobId, "Input parent cleanup completed.")
    }

    async function finishExistingOutputImport() {
      if (await pathExists(filePath)) {
        debugImport(jobId, "Removing duplicate input source for existing output file.")
        await unlinkFileWithRetry(filePath, { jobId })
      }

      debugImport(jobId, "Cleaning input parent folders after existing output recovery.")
      await removeNonMediaOnlyInputParents(filePath, { jobId })
      debugImport(jobId, "Input parent cleanup completed after existing output recovery.")

      return finalizeImport({
        planned: false,
        completedMessage: "Existing output file was added to the library.",
      })
    }

    async function runFfmpegImport() {
      await runFfmpegProcessing()

      return finalizeImport({
        planned: true,
        completedMessage: "Media processed and added to the library.",
      })
    }

    async function runDirectMoveImport() {
      updateJob(jobId, {
        message: "Moving direct-import media file.",
      })

      console.log(
        `[Info] [Media] Skipping processing and moving direct-import file - ${fileName(filePath)}`
      )

      await moveLibraryFileThroughQueue(filePath, finalPath, "direct-import")

      if (await pathExists(filePath)) {
        debugImport(jobId, "Source still exists after direct-import move; removing it.")
        await unlinkFileWithRetry(filePath, { jobId })
      }

      debugImport(jobId, "Direct-import file move completed.")
      debugImport(jobId, "Cleaning input parent folders.")
      await removeNonMediaOnlyInputParents(filePath, { jobId })
      debugImport(jobId, "Input parent cleanup completed.")

      return finalizeImport({
        planned: false,
        completedMessage: "Media added to the library without transcoding.",
      })
    }

    if (useExistingOutput) {
      updateJob(jobId, {
        message: "Finishing existing output import in background.",
      })
      console.log(
        `[Info] [Media] Finishing existing output import in background - ${fileName(filePath)}`
      )
      debugImport(jobId, "Existing output finalization moved to immediate background work.")

      return queueDeferredImportWork({
        kind: "existing-output",
        outputPath: finalPath,
        planned: false,
        message: "Finishing existing output import in background.",
        work: finishExistingOutputImport,
      })
    }

    if (needsFfmpegProcessing && convertVideo && options.deferVideoTranscodes) {
      const videoQueueMessage = videoTranscodeReason === "shrink"
        ? "Queued for shrinking video transcode."
        : "Queued for full video transcode."

      updateJob(jobId, {
        message: videoQueueMessage,
      })
      console.log(
        `[Info] [Media] ${videoQueueMessage.replace(/\.$/, "")} and continuing import scan - ${fileName(filePath)}`
      )
      debugImport(jobId, "Video transcode queued in the shared file-edit queue so other import inspections can continue.")

      return queueDeferredImportWork({
        kind: "video-transcode",
        outputPath: finalPath,
        planned: true,
        message: videoQueueMessage,
        work: runFfmpegImport,
        processing: {
          ...processingInfo,
          kind: "video-transcode",
        },
      })
    }

    if (needsFfmpegProcessing && !convertVideo && options.deferAudioTranscodes) {
      const queueMessage = convertAudioToAac
        ? "Queued for audio transcode."
        : "Queued for MP4 remux."

      updateJob(jobId, {
        message: queueMessage,
      })
      console.log(
        `[Info] [Media] ${convertAudioToAac ? "Queued audio transcode" : "Queued MP4 remux"} and continuing import scan - ${fileName(filePath)}`
      )
      debugImport(
        jobId,
        convertAudioToAac
          ? "Audio-only LC-AAC transcode queued in the shared file-edit queue."
          : "Container remux queued in the shared file-edit queue."
      )

      return queueDeferredImportWork({
        kind: convertAudioToAac ? "audio-transcode" : "container-remux",
        outputPath: finalPath,
        planned: true,
        message: queueMessage,
        work: runFfmpegImport,
        processing: {
          ...processingInfo,
          kind: convertAudioToAac ? "audio-transcode" : "container-remux",
        },
      })
    }

    if (needsFfmpegProcessing) {
      return runWithActiveInputImportOutput(finalPath, runFfmpegImport)
    }

    updateJob(jobId, {
      message: "Moving direct-import media file in background.",
    })
    console.log(
      `[Info] [Media] Moving direct-import media file in background - ${fileName(filePath)}`
    )
    debugImport(jobId, "Direct-import move queued for file-edit processing.")

    return queueDeferredImportWork({
      kind: "direct-move",
      outputPath: finalPath,
      planned: false,
      message: "Moving direct-import media file in background.",
      work: runDirectMoveImport,
      processing: {
        ...processingInfo,
        kind: "direct-move",
      },
    })
  } catch (error) {
    const message = errorMessage(error) || "Unknown media processing error"

    if (isShutdownCancellation(error, options.shutdownSignal)) {
      const shutdownMessage = "Skipped queued import file action because shutdown started."

      console.warn(
        `[Warn] [Media] Input file processing cancelled during shutdown - processInputFile.ts - ${filePath}`
      )
      debugImport(jobId, shutdownMessage)
      updateJob(jobId, {
        status: "skipped",
        message: shutdownMessage,
        finishedAt: new Date().toISOString(),
      })

      return {
        ok: true,
        filePath,
        planned: true,
        message: shutdownMessage,
      }
    }

    if (isAniListMetadataLookupUnavailableError(error)) {
      return finishRetryableInputFailure(filePath, {
        jobId,
        error,
        context: "AniList metadata lookup could not complete",
      })
    }

    if (!importEnabled) {
      const failureMessage = `${message}; input file was left untouched because import processing is disabled.`

      console.error(
        `[Error] [Media] Input file cataloging failed - processInputFile.ts - ${filePath} - ${failureMessage}`
      )
      debugError(jobId, "Input file cataloging failed", error)

      updateJob(jobId, {
        status: "failed",
        error: message,
        message: failureMessage,
        finishedAt: new Date().toISOString(),
      })

      return {
        ok: false,
        filePath,
        planned: false,
        message: failureMessage,
      }
    }

    const failedPath = await tryMoveFailedInputToFailedImports(filePath, {
      jobId,
      reason: message,
    })
    const failureMessage = failedPath
      ? `${message}; input moved to failed imports: ${failedPath}`
      : message

    console.error(
      `[Error] [Media] Input file processing failed - processInputFile.ts - ${filePath} - ${failureMessage}`
    )
    debugError(jobId, "Input file processing failed", error)

    updateJob(jobId, {
      status: "failed",
      error: message,
      message: failureMessage,
      finishedAt: new Date().toISOString(),
    })

    return {
      ok: false,
      filePath: failedPath ?? filePath,
      planned: false,
      message: failureMessage,
    }
  }
}
