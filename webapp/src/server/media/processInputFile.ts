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
  getFileHardwareInputArgs,
  getFileSubtitleInputArgs,
  getWebmFileArgs,
  runFfmpeg,
  webmFileExtension,
  type WebmSubtitleOutputStream,
} from "@/server/media/ffmpeg"
import {
  formatEpisodeFileName,
  formatSeasonFolderName,
  getAnimeMetadataLookupSeason,
  getFolderTitleFallbackCandidates,
  parseAnimeFilePath,
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
import { getAudioOutputIndexesToOpus } from "@/server/media/streamMetadata"
import {
  findSubtitleSidecar,
  isConvertibleTextSubtitleCodec,
  isWebVttSubtitleCodec,
  normalizeSubtitleCodecName,
  type SubtitleSidecar,
} from "@/server/media/subtitles"
import { errorMessage, fileName } from "@/server/utils/format"
import { debugLog } from "@/server/utils/debugLog"

const targetAv1BytesPerMinute = 22 * 1024 * 1024
const targetBytesPerMinute = targetAv1BytesPerMinute
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
    return "WebM remux"
  }

  if (kind === "existing-output") {
    return "existing output finalization"
  }

  if (kind === "catalog-only") {
    return "catalog-only library registration"
  }

  return "direct import move"
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

function hasAv1Video(probe: ProbeResult) {
  return (probe.streams ?? []).some(
    (stream) =>
      stream.codec_type === "video" &&
      (stream.codec_name ?? "").toLowerCase() === "av1"
  )
}

function getPrimaryVideoCodec(probe: ProbeResult) {
  return (
    (probe.streams ?? [])
      .find((stream) => stream.codec_type === "video")
      ?.codec_name?.trim() || null
  )
}

const webmContainerFormatNames = new Set(["matroska", "webm"])

function getProbeFormatNames(probe: ProbeResult) {
  return (probe.format?.format_name ?? "")
    .split(",")
    .map((format) => format.trim().toLowerCase())
    .filter(Boolean)
}

function usesWebmOutputContainer(filePath: string, probe: ProbeResult) {
  if (path.extname(filePath).toLowerCase() !== webmFileExtension) {
    return false
  }

  const formatNames = getProbeFormatNames(probe)

  return (
    formatNames.length === 0 ||
    formatNames.some((formatName) => webmContainerFormatNames.has(formatName))
  )
}

function assertValidWebmAv1Output(filePath: string, probe: ProbeResult) {
  if (!usesWebmOutputContainer(filePath, probe)) {
    throw new Error(`FFmpeg output is not a WebM container: ${filePath}`)
  }

  if (!hasAv1Video(probe)) {
    throw new Error(`FFmpeg output is not AV1 video: ${filePath}`)
  }

  const invalidAudioCodec = (probe.streams ?? []).find(
    (stream) =>
      stream.codec_type === "audio" &&
      (stream.codec_name ?? "").trim().toLowerCase() !== "opus"
  )?.codec_name

  if (invalidAudioCodec) {
    throw new Error(
      `FFmpeg output has non-Opus audio (${invalidAudioCodec}): ${filePath}`
    )
  }

  const invalidSubtitleCodec = (probe.streams ?? []).find(
    (stream) =>
      stream.codec_type === "subtitle" && !isWebVttSubtitleCodec(stream.codec_name)
  )?.codec_name

  if (invalidSubtitleCodec) {
    throw new Error(
      `FFmpeg output has non-WebVTT subtitles (${invalidSubtitleCodec}): ${filePath}`
    )
  }
}

function hasEmbeddedSubtitles(probe: ProbeResult) {
  return (probe.streams ?? []).some((stream) => stream.codec_type === "subtitle")
}

function hasNonWebVttEmbeddedSubtitle(probe: ProbeResult) {
  return (probe.streams ?? []).some(
    (stream) =>
      stream.codec_type === "subtitle" && !isWebVttSubtitleCodec(stream.codec_name)
  )
}

function getWebmSubtitleOutputStreams(input: {
  probe: ProbeResult
  sidecarSubtitle?: SubtitleSidecar | null
}): WebmSubtitleOutputStream[] {
  const embeddedStreams = (input.probe.streams ?? [])
    .map((stream) => {
      const codec = normalizeSubtitleCodecName(stream.codec_name)

      if (stream.codec_type !== "subtitle" || !Number.isInteger(stream.index)) {
        return null
      }

      if (isWebVttSubtitleCodec(codec)) {
        return {
          inputIndex: 0,
          streamIndex: stream.index as number,
          codec: "copy" as const,
        }
      }

      if (isConvertibleTextSubtitleCodec(codec)) {
        return {
          inputIndex: 0,
          streamIndex: stream.index as number,
          codec: "webvtt" as const,
        }
      }

      return null
    })
    .filter((stream): stream is WebmSubtitleOutputStream => stream !== null)

  if (embeddedStreams.length || !input.sidecarSubtitle) {
    return embeddedStreams
  }

  return [
    {
      inputIndex: 1,
      streamIndex: 0,
      codec: isWebVttSubtitleCodec(input.sidecarSubtitle.codec) ? "copy" : "webvtt",
    },
  ]
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
  part?: number
}) {
  if (input.format === "MOVIE") {
    return ["Movies"]
  }

  if (input.format === "SPECIAL" || input.format === "OVA") {
    return ["Specials", input.mediaTitle]
  }

  return [formatSeasonFolderName(input.season, input.part)]
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

function formatDetectedEpisode(input: {
  animeTitle: string
  seasonNumber: number
  episodeNumber: number
  episodeTitle?: string | null
}) {
  const episodeName = input.episodeTitle?.trim()

  return `Anime: ${input.animeTitle}, Season ${input.seasonNumber}, Episode ${input.episodeNumber}${episodeName ? ` (${episodeName})` : ""}`
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
    audioOutputIndexesToOpus: number[]
    subtitleStreams: WebmSubtitleOutputStream[]
    videoBitrateKbps: number
    maxVideoBitrateKbps: number
    inputVideoCodec?: string | null
    sidecarSubtitle?: SubtitleSidecar | null
    jobId?: string
  }
) {
  await mkdir(path.dirname(outputPath), { recursive: true })

  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    ...(options.convertVideo
      ? getFileHardwareInputArgs({
          inputVideoCodec: options.inputVideoCodec,
          keepFramesOnDevice: true,
        })
      : []),
    ...getFileSubtitleInputArgs(),
    "-i",
    inputPath,
    ...(options.sidecarSubtitle ? ["-i", options.sidecarSubtitle.filePath] : []),
    ...getWebmFileArgs(options),
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

  const outputProbe = (await ffprobe(outputPath)) as ProbeResult
  assertValidWebmAv1Output(outputPath, outputProbe)

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

    await waitForStableFile(filePath)
    debugImport(jobId, "Input file is stable.")

    debugImport(jobId, "Parsing anime filename.")
    const parsed = parseAnimeFilePath(filePath, { rootDir: config.inputDir })

    if (parsed?.titleSource === "folder") {
      debugImport(
        jobId,
        `Parsed input file using folder title fallback - Title ${parsed.title}, Season ${parsed.season}${parsed.part ? `, Part ${parsed.part}` : ""}, Episode ${parsed.episode}`
      )
    }

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
        getAnimeMetadataLookupSeason(parsed),
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
            getAnimeMetadataLookupSeason(parsed),
            parsed.episode,
            parsed.part
          )

          if (!fallbackMetadata) {
            continue
          }

          metadata = fallbackMetadata
          resolvedParsed = { ...parsed, title: fallbackTitle, titleSource: "folder" }
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

    const inputParsed = resolvedParsed
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
      debugImport(
        jobId,
        `Library season resolved from parsed season ${inputParsed.season} to ${librarySeason}.`
      )
    }

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

    const embeddedSubtitles = hasEmbeddedSubtitles(probe)
    const sidecarSubtitle = embeddedSubtitles ? null : await findSubtitleSidecar(filePath)

    if (sidecarSubtitle) {
      debugImport(jobId, `Subtitle sidecar detected - ${sidecarSubtitle.filePath}`)
    }

    const durationSeconds = parseDurationSeconds(probe)
    debugImport(jobId, `Parsed duration - ${durationSeconds}s.`)

    const mediaTitle = metadataTitle(inputMetadata)
    const resolvedLibrary = inputMetadata.library

    if (!resolvedLibrary?.title) {
      throw new Error(`AniList media ${inputMetadata.id} did not resolve a library root`)
    }

    const library = resolvedLibrary
    const libraryTitle = library.title

    console.log(
      `[Info] [Media] Detected input episode - ${formatDetectedEpisode({ animeTitle: libraryTitle, seasonNumber: librarySeason, episodeNumber: inputParsed.episode, episodeTitle: inputParsed.episodeTitle })} - ${fileName(filePath)}`
    )

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
      const label = formatDeferredWorkKind(input.kind)
      const startDeferredWork = () =>
        runDeferredImportWork({
          kind: input.kind,
          outputPath: input.outputPath,
          work: input.work,
        })

      console.log(
        `[Info] [File Import] ${input.kind === "catalog-only" ? "Scheduled" : "Added to queue"} - ${label} - ${formatDetectedEpisode({ animeTitle: libraryTitle, seasonNumber: librarySeason, episodeNumber: inputParsed.episode, episodeTitle: inputParsed.episodeTitle })} - ${fileName(filePath)}`
      )

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

        console.log(
          `[Info] [Media] Database import completed - ${formatDetectedEpisode({ animeTitle: libraryTitle, seasonNumber: librarySeason, episodeNumber: inputParsed.episode, episodeTitle: inputParsed.episodeTitle })} - ${fileName(resolvedInputPath)}`
        )

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
    const maxAv1BytesPerMinute = targetAv1BytesPerMinute
    const inputVideoCodec = getPrimaryVideoCodec(probe)
    const inputHasAv1Video = hasAv1Video(probe)
    const inputUsesWebmContainer = usesWebmOutputContainer(filePath, probe)
    const subtitleStreams = getWebmSubtitleOutputStreams({
      probe,
      sidecarSubtitle,
    })
    const inputHasSubtitleSource = embeddedSubtitles || Boolean(sidecarSubtitle)
    const inputHasEmbeddedWebVttSubtitles = embeddedSubtitles
      ? !hasNonWebVttEmbeddedSubtitle(probe)
      : false
    const inputHasWebVttSubtitles = inputHasSubtitleSource
      ? inputHasEmbeddedWebVttSubtitles
      : true
    const convertAudioToOpusOutputIndexes = getAudioOutputIndexesToOpus(probe)
    const convertAudioToOpus = convertAudioToOpusOutputIndexes.length > 0
    const requiresWebmContainerRemux = inputHasAv1Video && !inputUsesWebmContainer
    const requiresSubtitleWebVttConversion = inputHasSubtitleSource
      ? !inputHasWebVttSubtitles || Boolean(sidecarSubtitle)
      : false
    const inputMatchesWebmAv1OpusWebVtt =
      inputUsesWebmContainer &&
      inputHasAv1Video &&
      !convertAudioToOpus &&
      inputHasWebVttSubtitles
    const requiresVideoShrink = inputMatchesWebmAv1OpusWebVtt
      ? inputBytesPerMinute > maxAv1BytesPerMinute
      : false
    const requiredSingleStepEdits = inputHasAv1Video
      ? [
          requiresWebmContainerRemux,
          convertAudioToOpus,
          requiresSubtitleWebVttConversion,
        ].filter(Boolean).length
      : 0
    const videoTranscodeReason: VideoTranscodeReason = !inputHasAv1Video
      ? "full"
      : requiresVideoShrink
        ? "shrink"
        : "none"
    const convertVideo = videoTranscodeReason !== "none"
    const audioOutputIndexesToOpus = convertVideo
      ? (probe.streams ?? [])
          .filter((stream) => stream.codec_type === "audio")
          .map((_stream, outputAudioIndex) => outputAudioIndex)
      : convertAudioToOpusOutputIndexes
    const importFileEditKind: ImportFileEditKind = convertVideo
      ? "video-transcode"
      : convertAudioToOpus
        ? "audio-transcode"
        : requiresWebmContainerRemux || requiresSubtitleWebVttConversion
          ? "container-remux"
          : "direct-move"
    const needsFfmpegProcessing = importFileEditKind !== "direct-move"
    const videoBitrateKbps = calculateVideoBitrateKbps()
    const skippedDetailedEditChecks = !inputHasAv1Video

    debugImport(
      jobId,
      skippedDetailedEditChecks
        ? `Processing decision - inputCodec ${inputVideoCodec ?? "unknown"}, av1 false, action ${importFileEditKind}, videoTranscodeReason ${videoTranscodeReason}, needsFfmpegProcessing ${needsFfmpegProcessing}; skipped WebM/audio/subtitle/shrink decision checks because full processing is required. Audio tracks to Opus for output [${audioOutputIndexesToOpus.join(", ")}], subtitleTracks [${subtitleStreams.map((stream) => `${stream.inputIndex}:${stream.streamIndex}:${stream.codec}`).join(", ")}]`
        : `Processing decision - inputCodec ${inputVideoCodec ?? "unknown"}, av1 ${inputHasAv1Video}, webmContainer ${inputUsesWebmContainer}, opusAudio ${!convertAudioToOpus}, webVttSubtitles ${inputHasWebVttSubtitles}, conformsBeforeShrink ${inputMatchesWebmAv1OpusWebVtt}, belowMaxSize ${!requiresVideoShrink}, audioTracksToOpus [${audioOutputIndexesToOpus.join(", ")}], subtitleTracks [${subtitleStreams.map((stream) => `${stream.inputIndex}:${stream.streamIndex}:${stream.codec}`).join(", ")}], requiredFormatEdits ${requiredSingleStepEdits}, action ${importFileEditKind}, videoTranscodeReason ${videoTranscodeReason}, needsFfmpegProcessing ${needsFfmpegProcessing}`
    )

    const safeLibraryTitle = safePathSegment(libraryTitle, "Library title")
    const safeMediaTitle = safePathSegment(mediaTitle, "Media title")
    const extension = webmFileExtension
    const finalName = formatEpisodeFileName({
      title: safeMediaTitle,
      season: inputParsed.season,
      part: inputParsed.part,
      episode: inputParsed.episode,
      extension,
    })
    const finalPath = path.resolve(
      config.mediaDir,
      safeLibraryTitle,
      ...mediaFolderSegments({
        format: inputMetadata.format,
        season: inputParsed.season,
        part: inputParsed.part,
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

    async function removeInputSidecarIfUsed() {
      if (!sidecarSubtitle || !(await pathExists(sidecarSubtitle.filePath))) {
        return
      }

      debugImport(jobId, `Removing consumed subtitle sidecar - ${sidecarSubtitle.filePath}`)
      await unlinkFileWithRetry(sidecarSubtitle.filePath, { jobId })
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
    const importAnimeId = inputMetadata.id
    const importEpisodeNumber = inputParsed.episode

    async function finalizeImport(input: {
      planned: boolean
      completedMessage: string
    }): Promise<ProcessInputFileResult> {
      updateJob(jobId, {
        outputPath: finalPath,
        message: "Generating thumbnail.",
      })

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
        `[Info] [Media] Database import completed - ${formatDetectedEpisode({ animeTitle: libraryTitle, seasonNumber: librarySeason, episodeNumber: importEpisodeNumber, episodeTitle: inputParsed.episodeTitle })} - ${fileName(finalPath)}`
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
      updateJob(jobId, {
        message: convertVideo
          ? videoTranscodeReason === "shrink"
            ? "Shrinking media file."
            : "Transcoding media file."
          : convertAudioToOpus
            ? "Converting audio tracks to Opus."
            : "Remuxing media file to WebM.",
      })

      await transcodeFile(filePath, tempPath, {
        convertVideo,
        inputVideoCodec,
        audioOutputIndexesToOpus,
        subtitleStreams,
        sidecarSubtitle,
        videoBitrateKbps,
        maxVideoBitrateKbps: calculateVideoBitrateKbps(maxAv1BytesPerMinute),
        jobId,
      })
      debugImport(jobId, "FFmpeg processing step completed successfully.")

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
      await removeInputSidecarIfUsed()
      debugImport(jobId, "Cleaning input parent folders.")
      await removeNonMediaOnlyInputParents(filePath, { jobId })
      debugImport(jobId, "Input parent cleanup completed.")
    }

    async function finishExistingOutputImport() {
      if (await pathExists(filePath)) {
        debugImport(jobId, "Removing duplicate input source for existing output file.")
        await unlinkFileWithRetry(filePath, { jobId })
      }
      await removeInputSidecarIfUsed()

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

      await moveLibraryFileThroughQueue(filePath, finalPath, "direct-import")

      if (await pathExists(filePath)) {
        debugImport(jobId, "Source still exists after direct-import move; removing it.")
        await unlinkFileWithRetry(filePath, { jobId })
      }
      await removeInputSidecarIfUsed()

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
      const queueMessage = convertAudioToOpus
        ? "Queued for audio transcode."
        : "Queued for WebM remux."

      updateJob(jobId, {
        message: queueMessage,
      })
      debugImport(
        jobId,
        convertAudioToOpus
          ? "Audio-only Opus transcode queued in the shared file-edit queue."
          : "Container/subtitle remux queued in the shared file-edit queue."
      )

      return queueDeferredImportWork({
        kind: convertAudioToOpus ? "audio-transcode" : "container-remux",
        outputPath: finalPath,
        planned: true,
        message: queueMessage,
        work: runFfmpegImport,
        processing: {
          ...processingInfo,
          kind: convertAudioToOpus ? "audio-transcode" : "container-remux",
        },
      })
    }

    if (needsFfmpegProcessing) {
      return runWithActiveInputImportOutput(finalPath, runFfmpegImport)
    }

    updateJob(jobId, {
      message: "Moving direct-import media file in background.",
    })
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
