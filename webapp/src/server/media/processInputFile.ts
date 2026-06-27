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
  getMp4FileArgs,
  getWebVttSidecarFileArgs,
  mp4FileExtension,
  runFfmpeg,
  type FileSubtitleOutputStream,
} from "@/server/media/ffmpeg"
import {
  formatEpisodeFileName,
  formatSeasonFolderName,
  formatStandaloneMediaFileName,
  getAnimeMetadataLookupSeason,
  getFolderTitleFallbackCandidates,
  getStandaloneMediaTitleFallbackCandidates,
  parseAnimeFilePath,
  sanitizeExportPathPart,
  type ParsedAnimeFileName,
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
  createNonAnimeMetadata,
  nonAnimeFolderName,
  parseNonAnimeFilePath,
} from "@/server/media/nonAnime"
import {
  registerActiveCacheJobDirectory,
  removeCacheJobDirectory,
} from "@/server/media/cacheMaintenance"
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
  subtitleSidecarPathForMediaFile,
  type SubtitleSidecar,
} from "@/server/media/subtitles"
import { errorMessage, fileName } from "@/server/utils/format"
import { debugLog } from "@/server/utils/debugLog"

const targetHevcBytesPerMinute = 32 * 1024 * 1024
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
  displaySeasonLabel?: string | null
  displayEpisodeLabel?: string | null
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

const importErrorMaxLogLength = 1200

function compactImportErrorDetails(value: string) {
  const normalized = value
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)

  const deduped: string[] = []
  let previous = ""
  let repeated = 0

  const flushRepeated = () => {
    if (repeated > 0) {
      deduped.push(`Previous line repeated ${repeated} time${repeated === 1 ? "" : "s"}.`)
      repeated = 0
    }
  }

  for (const line of normalized) {
    if (line === previous) {
      repeated += 1
      continue
    }

    flushRepeated()
    deduped.push(line)
    previous = line
  }

  flushRepeated()

  const compacted = deduped.join("\n")

  if (compacted.length <= importErrorMaxLogLength) {
    return compacted
  }

  return `${compacted.slice(0, importErrorMaxLogLength)}…`
}

function importErrorMessage(error: unknown) {
  const message = errorMessage(error)
  const stderr = error && typeof error === "object" && "stderr" in error
    ? (error as { stderr?: unknown }).stderr
    : undefined

  if (typeof stderr === "string" && stderr.trim()) {
    const exitLabel =
      message.match(/Command failed with exit code [^:]+/)?.[0] ??
      "FFmpeg command failed"

    return compactImportErrorDetails(`${exitLabel}\n${stderr.trim()}`)
  }

  return compactImportErrorDetails(message)
}

function debugError(jobId: string, message: string, error: unknown) {
  const details = importErrorMessage(error)
  console.error(`[Error] [MediaImport:${jobId}] ${message} - ${details}`)
}

function isSeriesFormat(format?: string | null) {
  return !format || format === "TV" || format === "TV_SHORT" || format === "ONA"
}

function isSeriesMetadataFormat(format?: string | null) {
  return format === "TV" || format === "TV_SHORT"
}

function isStandaloneMediaParsed(parsed: Pick<ParsedAnimeFileName, "mediaKind">) {
  return parsed.mediaKind === "movie"
}

function isParsedMediaCompatibleWithMetadata(
  parsed: Pick<ParsedAnimeFileName, "mediaKind" | "title">,
  metadata: { format?: string | null }
) {
  return !isStandaloneMediaParsed(parsed) || !isSeriesMetadataFormat(metadata.format)
}

function standaloneMediaKindLabel(format?: string | null) {
  if (format === "MOVIE") {
    return "Movie"
  }

  if (format === "SPECIAL") {
    return "Special"
  }

  if (format === "OVA") {
    return "OVA"
  }

  return "Standalone media"
}

function seasonLabel(seasonNumber: number, partNumber?: number) {
  return formatSeasonFolderName(seasonNumber, partNumber)
}

function episodeBadgeLabel(input: {
  seasonNumber: number
  episodeNumber: number
  partNumber?: number
}) {
  const season = String(input.seasonNumber).padStart(2, "0")
  const part = input.partNumber && input.partNumber > 1
    ? `P${String(input.partNumber).padStart(2, "0")}`
    : ""
  const episode = String(input.episodeNumber).padStart(2, "0")

  return `S${season}${part} E${episode}`
}

function getImportProcessingSubtitle(input: {
  format?: string | null
  libraryTitle: string
  mediaTitle: string
  seasonNumber: number
  partNumber?: number
}) {
  const suffix = getAnimeTitleSuffix({
    libraryTitle: input.libraryTitle,
    mediaTitle: input.mediaTitle,
  })

  if (suffix) {
    return suffix
  }

  if (isSeriesFormat(input.format) && input.seasonNumber > 1) {
    return seasonLabel(input.seasonNumber, input.partNumber)
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

const deferredWorkKindLabels: Record<DeferredInputWorkKind, string> = {
  "video-transcode": "video transcode",
  "audio-transcode": "audio transcode",
  "container-remux": "MP4 remux",
  "direct-move": "direct import move",
  "existing-output": "existing output finalization",
  "catalog-only": "catalog-only library registration",
}

function formatDeferredWorkKind(kind: DeferredInputWorkKind) {
  return deferredWorkKindLabels[kind]
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

function normalizeVideoCodec(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_")
}

function isTargetVideoCodec(codec: string | null | undefined) {
  const normalized = normalizeVideoCodec(codec)

  return normalized === "hevc" || normalized === "h265"
}

function hasTargetImportVideo(probe: ProbeResult) {
  return (probe.streams ?? []).some(
    (stream) => stream.codec_type === "video" && isTargetVideoCodec(stream.codec_name)
  )
}

function getPrimaryVideoCodec(probe: ProbeResult) {
  return (
    (probe.streams ?? [])
      .find((stream) => stream.codec_type === "video")
      ?.codec_name?.trim() || null
  )
}

const mp4ContainerFormatNames = new Set(["mov", "mp4", "m4a", "3gp", "3g2", "mj2"])

function getProbeFormatNames(probe: ProbeResult) {
  return (probe.format?.format_name ?? "")
    .split(",")
    .map((format) => format.trim().toLowerCase())
    .filter(Boolean)
}

function usesMp4OutputContainer(filePath: string, probe: ProbeResult) {
  if (path.extname(filePath).toLowerCase() !== mp4FileExtension) {
    return false
  }

  const formatNames = getProbeFormatNames(probe)

  return (
    formatNames.length === 0 ||
    formatNames.some((formatName) => mp4ContainerFormatNames.has(formatName))
  )
}

function assertValidMp4ImportOutput(filePath: string, probe: ProbeResult) {
  if (!usesMp4OutputContainer(filePath, probe)) {
    throw new Error(`FFmpeg output is not an MP4 container: ${filePath}`)
  }

  if (!hasTargetImportVideo(probe)) {
    throw new Error(`FFmpeg output is not HEVC video: ${filePath}`)
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

  const embeddedSubtitleCodec = (probe.streams ?? []).find(
    (stream) => stream.codec_type === "subtitle"
  )?.codec_name

  if (embeddedSubtitleCodec) {
    throw new Error(
      `FFmpeg output still has embedded subtitles (${embeddedSubtitleCodec}): ${filePath}`
    )
  }
}

function hasEmbeddedSubtitles(probe: ProbeResult) {
  return (probe.streams ?? []).some(
    (stream) =>
      stream.codec_type === "subtitle" &&
      isConvertibleTextSubtitleCodec(stream.codec_name)
  )
}

function getFileSubtitleOutputStreams(input: {
  probe: ProbeResult
  sidecarSubtitle?: SubtitleSidecar | null
}): FileSubtitleOutputStream[] {
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
    .filter((stream): stream is FileSubtitleOutputStream => stream !== null)

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


function calculateVideoBitrateKbps(bytesPerMinute: number) {
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
    throw new Error(`Media ${metadata.id} did not include a usable title`)
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
    .some((part) => part.toLowerCase() === failedImportsFolderName)
}

function failedImportRelativePathParts(relativePath: string) {
  return relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((part, index, parts) => {
      const fallback = index === parts.length - 1 ? "failed_file" : "unknown"
      const trimmedPart = part.trim()

      return trimmedPart && trimmedPart !== "." && trimmedPart !== ".."
        ? part
        : fallback
    })
}

function formatDetectedEpisode(input: {
  animeTitle: string
  seasonNumber: number
  episodeNumber: number
  partNumber?: number
  episodeTitle?: string | null
}) {
  const episodeName = input.episodeTitle?.trim()

  return `Anime: ${input.animeTitle}, ${seasonLabel(input.seasonNumber, input.partNumber)}, Episode ${input.episodeNumber}${episodeName ? ` (${episodeName})` : ""}`
}

function formatDetectedMedia(input: {
  animeTitle: string
  mediaTitle: string
  seasonNumber: number
  episodeNumber: number
  partNumber?: number
  episodeTitle?: string | null
  mediaKind?: ParsedAnimeFileName["mediaKind"]
  format?: string | null
}) {
  if (input.mediaKind === "movie") {
    return `${standaloneMediaKindLabel(input.format)}: ${input.mediaTitle}`
  }

  return formatDetectedEpisode(input)
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

  const relativePath = failedImportRelativePathParts(
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

async function extractSubtitleSidecar(input: {
  inputPath: string
  outputPath: string
  sidecarSubtitle?: SubtitleSidecar | null
  subtitleStream: FileSubtitleOutputStream
  jobId?: string
}) {
  await mkdir(path.dirname(input.outputPath), { recursive: true })

  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    ...getFileSubtitleInputArgs(),
    "-i",
    input.inputPath,
    ...(input.sidecarSubtitle ? ["-i", input.sidecarSubtitle.filePath] : []),
    ...getWebVttSidecarFileArgs(input.subtitleStream),
    "-y",
    input.outputPath,
  ]

  if (input.jobId) {
    debugImport(input.jobId, `FFmpeg subtitle sidecar command - ${args.join(" ")}`)
  }

  await runFfmpeg(args, { protectFromParentSignals: true })

  if (!(await pathExists(input.outputPath))) {
    throw new Error(`FFmpeg completed but did not create subtitle sidecar: ${input.outputPath}`)
  }
}

async function transcodeFile(
  inputPath: string,
  outputPath: string,
  options: {
    convertVideo: boolean
    audioOutputIndexesToOpus: number[]
    subtitleStream?: FileSubtitleOutputStream | null
    subtitleOutputPath?: string | null
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
    "-nostdin",
    "-loglevel",
    "error",
    ...(options.convertVideo
      ? getFileHardwareInputArgs({
          inputVideoCodec: options.inputVideoCodec,
          keepFramesOnDevice: false,
        })
      : []),
    ...getFileSubtitleInputArgs(),
    "-i",
    inputPath,
    ...getMp4FileArgs(options),
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

  await runFfmpeg(args, {
    priorityRole: options.convertVideo ? "file-encoding" : undefined,
    protectFromParentSignals: true,
  })

  if (!(await pathExists(outputPath))) {
    throw new Error(`FFmpeg completed but did not create output file: ${outputPath}`)
  }

  const outputProbe = (await ffprobe(outputPath)) as ProbeResult
  assertValidMp4ImportOutput(outputPath, outputProbe)

  if (options.subtitleStream && options.subtitleOutputPath) {
    await extractSubtitleSidecar({
      inputPath,
      outputPath: options.subtitleOutputPath,
      sidecarSubtitle: options.sidecarSubtitle,
      subtitleStream: options.subtitleStream,
      jobId: options.jobId,
    })
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

    debugImport(jobId, "Parsing input filename.")
    const nonAnimeInput = parseNonAnimeFilePath(filePath, config.inputDir)
    const parsed =
      nonAnimeInput?.parsed ?? parseAnimeFilePath(filePath, { rootDir: config.inputDir })

    if (nonAnimeInput) {
      const nonAnimeParsed = nonAnimeInput.parsed
      debugImport(
        jobId,
        `Parsed ${nonAnimeFolderName} input file - Library ${nonAnimeInput.libraryTitle}, Media ${nonAnimeInput.mediaTitle}, Season ${nonAnimeParsed.season}${nonAnimeParsed.part ? `, Part ${nonAnimeParsed.part}` : ""}, Episode ${nonAnimeParsed.episode}`
      )
    } else if (parsed?.titleSource === "folder") {
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
      message: nonAnimeInput ? "Preparing local non-anime metadata." : "Fetching AniList metadata.",
    })

    let metadata: Awaited<ReturnType<typeof findAnimeMetadata>> = null
    let resolvedParsed = parsed

    if (nonAnimeInput) {
      metadata = createNonAnimeMetadata({
        libraryTitle: nonAnimeInput.libraryTitle,
        mediaTitle: nonAnimeInput.mediaTitle,
        parsed: nonAnimeInput.parsed,
        episodeNumber: nonAnimeInput.parsed.episode,
      })
      debugImport(jobId, `Prepared local non-anime metadata - Media id ${metadata.id}.`)
    } else {
      debugImport(jobId, "Starting AniList metadata lookup.")

      try {
        const directMetadata = await findAnimeMetadata(
          parsed.title,
          getAnimeMetadataLookupSeason(parsed),
          parsed.episode,
          parsed.part,
          { mediaKind: parsed.mediaKind }
        )

        if (directMetadata && isParsedMediaCompatibleWithMetadata(parsed, directMetadata)) {
          metadata = directMetadata
        } else if (directMetadata) {
          console.warn(
            `[Warn] [Media] Ignored unsafe standalone media AniList match - Filename title "${parsed.title}" matched ${directMetadata.format ?? "unknown format"} media - ${fileName(filePath)}`
          )
          debugImport(
            jobId,
            `Ignored unsafe standalone media AniList match - Parsed title ${parsed.title}, matched format ${directMetadata.format ?? "unknown"}.`
          )
        }

        if (!metadata) {
          const fallbackTitles = isStandaloneMediaParsed(parsed)
            ? getStandaloneMediaTitleFallbackCandidates(
                config.inputDir,
                filePath,
                parsed.title
              )
            : getFolderTitleFallbackCandidates(
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
              parsed.part,
              { mediaKind: parsed.mediaKind }
            )

            if (!fallbackMetadata) {
              continue
            }

            if (!isParsedMediaCompatibleWithMetadata(parsed, fallbackMetadata)) {
              console.warn(
                `[Warn] [Media] Ignored unsafe folder fallback AniList match - Filename title "${parsed.title}" matched ${fallbackMetadata.format ?? "unknown format"} media through folder title "${fallbackTitle}" - ${fileName(filePath)}`
              )
              debugImport(
                jobId,
                `Ignored unsafe folder fallback AniList match - Parsed title ${parsed.title}, Folder title ${fallbackTitle}, matched format ${fallbackMetadata.format ?? "unknown"}.`
              )
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

    debugImport(jobId, `${nonAnimeInput ? "Local metadata prepared" : "AniList metadata lookup completed"} - Media id ${inputMetadata.id}.`)
    debugImport(jobId, "Saving media metadata before media processing.")
    await runCooperativeSyncStep(() => upsertAnime(inputMetadata))
    debugImport(jobId, "Media metadata saved.")

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
    const inputIsStandaloneMedia = isStandaloneMediaParsed(inputParsed)
    const detectedMediaLabel = formatDetectedMedia({
      animeTitle: libraryTitle,
      mediaTitle,
      seasonNumber: inputParsed.season,
      partNumber: inputParsed.part,
      episodeNumber: inputParsed.episode,
      episodeTitle: inputParsed.episodeTitle,
      mediaKind: inputParsed.mediaKind,
      format: inputMetadata.format,
    })

    console.log(
      `[Info] [Media] Detected input media - ${detectedMediaLabel} - ${fileName(filePath)}`
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
        const message = importErrorMessage(error) || "Unknown media processing error"

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

          updateJob(jobId, {
            status: "failed",
            error: message,
            message: failureMessage,
            finishedAt: new Date().toISOString(),
          })
          throw new Error(failureMessage)
        }

        const inputStillExists = await pathExists(filePath)
        const failedPath = inputStillExists
          ? await tryMoveFailedInputToFailedImports(filePath, {
              jobId,
              reason: message,
            })
          : null
        const failureMessage = failedPath
          ? `${message}; input moved to failed imports: ${failedPath}`
          : inputStillExists
            ? `${message}; input could not be moved to failed imports and remains in the input folder.`
            : `${message}; input source was already moved or removed before the deferred failure.`

        console.error(
          `[Error] [Media] Deferred ${label} failed - processInputFile.ts - ${filePath} - ${failureMessage}`
        )

        updateJob(jobId, {
          status: "failed",
          error: message,
          message: failureMessage,
          finishedAt: new Date().toISOString(),
        })
        throw new Error(failureMessage)
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
        `[Info] [File Import] ${input.kind === "catalog-only" ? "Scheduled" : "Added to queue"} - ${label} - ${detectedMediaLabel} - ${fileName(filePath)}`
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
          `[Info] [Media] Database import completed - ${detectedMediaLabel} - ${fileName(resolvedInputPath)}`
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
    const maxTargetBytesPerMinute = targetHevcBytesPerMinute
    const inputVideoCodec = getPrimaryVideoCodec(probe)
    const inputHasTargetVideo = hasTargetImportVideo(probe)
    const inputUsesMp4Container = usesMp4OutputContainer(filePath, probe)
    const subtitleStreams = getFileSubtitleOutputStreams({
      probe,
      sidecarSubtitle,
    })
    const subtitleStream = subtitleStreams[0] ?? null
    const inputHasSubtitleSource = embeddedSubtitles || Boolean(sidecarSubtitle)
    const convertAudioToOpusOutputIndexes = getAudioOutputIndexesToOpus(probe)
    const convertAudioToOpus = convertAudioToOpusOutputIndexes.length > 0
    const requiresMp4ContainerRemux = inputHasTargetVideo && !inputUsesMp4Container
    const requiresSubtitleSidecarExtraction = inputHasSubtitleSource
    const inputMatchesMp4Target =
      inputUsesMp4Container &&
      inputHasTargetVideo &&
      !convertAudioToOpus &&
      !embeddedSubtitles
    const requiresVideoShrink = inputMatchesMp4Target
      ? inputBytesPerMinute > maxTargetBytesPerMinute
      : false
    const requiredSingleStepEdits = inputHasTargetVideo
      ? [
          requiresMp4ContainerRemux,
          convertAudioToOpus,
          requiresSubtitleSidecarExtraction,
        ].filter(Boolean).length
      : 0
    const videoTranscodeReason: VideoTranscodeReason = !inputHasTargetVideo
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
        : requiresMp4ContainerRemux || requiresSubtitleSidecarExtraction
          ? "container-remux"
          : "direct-move"
    const needsFfmpegProcessing = importFileEditKind !== "direct-move"
    const videoBitrateKbps = calculateVideoBitrateKbps(maxTargetBytesPerMinute)
    const skippedDetailedEditChecks = !inputHasTargetVideo

    debugImport(
      jobId,
      skippedDetailedEditChecks
        ? `Processing decision - inputCodec ${inputVideoCodec ?? "unknown"}, target HEVC, targetVideo false, action ${importFileEditKind}, videoTranscodeReason ${videoTranscodeReason}, needsFfmpegProcessing ${needsFfmpegProcessing}; skipped MP4/audio/subtitle/shrink decision checks because full processing is required. Audio tracks to Opus for output [${audioOutputIndexesToOpus.join(", ")}], subtitleTrack ${subtitleStream ? `${subtitleStream.inputIndex}:${subtitleStream.streamIndex}:${subtitleStream.codec}` : "none"}`
        : `Processing decision - inputCodec ${inputVideoCodec ?? "unknown"}, target HEVC, targetVideo ${inputHasTargetVideo}, mp4Container ${inputUsesMp4Container}, opusAudio ${!convertAudioToOpus}, sidecarSubtitleNeeded ${requiresSubtitleSidecarExtraction}, conformsBeforeShrink ${inputMatchesMp4Target}, belowMaxSize ${!requiresVideoShrink}, audioTracksToOpus [${audioOutputIndexesToOpus.join(", ")}], subtitleTrack ${subtitleStream ? `${subtitleStream.inputIndex}:${subtitleStream.streamIndex}:${subtitleStream.codec}` : "none"}, requiredFormatEdits ${requiredSingleStepEdits}, action ${importFileEditKind}, videoTranscodeReason ${videoTranscodeReason}, needsFfmpegProcessing ${needsFfmpegProcessing}`
    )

    const safeLibraryTitle = safePathSegment(libraryTitle, "Library title")
    const safeMediaTitle = safePathSegment(mediaTitle, "Media title")
    const extension = mp4FileExtension
    const finalName = inputIsStandaloneMedia
      ? formatStandaloneMediaFileName({
          title: safeMediaTitle,
          extension,
        })
      : formatEpisodeFileName({
          title: safeMediaTitle,
          season: inputParsed.season,
          part: inputParsed.part,
          episode: inputParsed.episode,
          extension,
        })
    const finalPath = path.resolve(
      config.mediaDir,
      ...(nonAnimeInput ? [nonAnimeFolderName, safeLibraryTitle] : [safeLibraryTitle]),
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
    const finalSubtitlePath = subtitleSidecarPathForMediaFile(finalPath)
    const tempSubtitlePath = subtitleSidecarPathForMediaFile(tempPath)
    debugImport(jobId, `Resolved output path - ${finalPath}`)
    debugImport(jobId, `Resolved temp path - ${tempPath}`)
    if (subtitleStream) {
      debugImport(jobId, `Resolved subtitle sidecar path - ${finalSubtitlePath}`)
    }

    const processingInfo = {
      id: jobId,
      animeTitle: libraryTitle,
      subtitle: getImportProcessingSubtitle({
        format: inputMetadata.format,
        libraryTitle,
        mediaTitle,
        seasonNumber: inputParsed.season,
        partNumber: inputParsed.part,
      }),
      seasonNumber: inputParsed.season,
      episodeNumber: inputParsed.episode,
      displaySeasonLabel: inputIsStandaloneMedia
        ? standaloneMediaKindLabel(inputMetadata.format)
        : seasonLabel(inputParsed.season, inputParsed.part),
      displayEpisodeLabel: inputIsStandaloneMedia
        ? standaloneMediaKindLabel(inputMetadata.format)
        : episodeBadgeLabel({
            seasonNumber: inputParsed.season,
            partNumber: inputParsed.part,
            episodeNumber: inputParsed.episode,
          }),
      fileName: finalName,
    }

    async function prepareExistingEpisodeReplacement() {
      if (!replacingExistingEpisode || !existingEpisode || existingEpisodeCleanupDone) {
        return
      }

      existingEpisodeCleanupDone = true
      const oldPath = path.resolve(existingEpisode.filePath)
      const resolvedFinalPath = path.resolve(finalPath)

      updateJob(jobId, {
        message: "Replacing existing episode file.",
      })

      if (oldPath !== resolvedFinalPath && (await pathExists(oldPath))) {
        debugImport(jobId, `Removing old episode file before replacement move - ${oldPath}`)
        await unlinkFileWithRetry(oldPath, { jobId })
        await rm(subtitleSidecarPathForMediaFile(oldPath), { force: true }).catch((error) => {
          debugError(jobId, "Old episode subtitle sidecar cleanup failed during replacement", error)
        })
      }

      if (await pathExists(resolvedFinalPath)) {
        debugImport(jobId, `Removing previous destination file before replacement move - ${resolvedFinalPath}`)
        await unlinkFileWithRetry(resolvedFinalPath, { jobId })
        await rm(finalSubtitlePath, { force: true }).catch((error) => {
          debugError(jobId, "Destination subtitle sidecar cleanup failed during replacement", error)
        })
      }

      await removeEpisodeThumbnails(oldPath).catch((error) => {
        debugError(jobId, "Old episode thumbnail cleanup failed during replacement", error)
      })
      debugImport(jobId, "Existing episode replacement target prepared.")
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
    const replacingExistingEpisode = Boolean(existingEpisode && existingEpisodeFileExists)
    let existingEpisodeCleanupDone = false
    let finalPathExists = await pathExists(finalPath)

    if (replacingExistingEpisode && existingEpisode) {
      debugImport(
        jobId,
        `Existing episode will be replaced after the new output is ready - Old path ${path.resolve(existingEpisode.filePath)}, New path ${finalPath}`
      )
      console.log(
        `[Info] [Media] Replacement import detected - ${detectedMediaLabel} - ${fileName(filePath)}`
      )
    }

    if (legacySeasonEpisode && (await pathExists(legacySeasonEpisode.filePath))) {
      console.warn(
        `[Warn] [Media] Existing episode was stored under parsed ${seasonLabel(inputParsed.season, inputParsed.part)}; moving it to internal library Season ${librarySeason} - ${legacySeasonEpisode.filePath}`
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

    const useExistingOutput = finalPathExists && !replacingExistingEpisode

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
        `[Info] [Media] Database import completed - ${detectedMediaLabel} - ${fileName(finalPath)}`
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
      const jobTempDirectory = path.dirname(tempPath)
      const releaseCacheJobDirectory = registerActiveCacheJobDirectory(
        jobTempDirectory
      )

      updateJob(jobId, {
        message: convertVideo
          ? videoTranscodeReason === "shrink"
            ? "Shrinking media file."
            : "Transcoding media file."
          : convertAudioToOpus
            ? "Converting audio tracks to Opus."
            : "Remuxing media file to MP4.",
      })

      try {
        await transcodeFile(filePath, tempPath, {
          convertVideo,
          inputVideoCodec,
          audioOutputIndexesToOpus,
          subtitleStream,
          subtitleOutputPath: subtitleStream ? tempSubtitlePath : null,
          sidecarSubtitle,
          videoBitrateKbps,
          maxVideoBitrateKbps: calculateVideoBitrateKbps(maxTargetBytesPerMinute),
          jobId,
        })
        debugImport(jobId, "FFmpeg processing step completed successfully.")

        await prepareExistingEpisodeReplacement()
        updateJob(jobId, {
          message: "Moving processed output into the library.",
        })
        debugImport(jobId, "Queueing transcoded output move into the library.")
        await moveLibraryFileThroughQueue(tempPath, finalPath, "transcode-output")
        if (subtitleStream && (await pathExists(tempSubtitlePath))) {
          await replaceFile(tempSubtitlePath, finalSubtitlePath, { jobId })
          debugImport(jobId, "Subtitle sidecar move completed.")
        } else {
          await rm(finalSubtitlePath, { force: true }).catch((error) => {
            debugError(jobId, "Unused destination subtitle sidecar cleanup failed", error)
          })
        }
        debugImport(jobId, "Transcoded output move completed.")
        debugImport(jobId, "Removing original input file after processed output move.")
        await unlinkFileWithRetry(filePath, { jobId })
        await removeInputSidecarIfUsed()
        debugImport(jobId, "Cleaning input parent folders.")
        await removeNonMediaOnlyInputParents(filePath, { jobId })
        debugImport(jobId, "Input parent cleanup completed.")
      } finally {
        debugImport(jobId, "Removing temporary job directory.")
        await removeCacheJobDirectory(jobTempDirectory, { allowActive: true })
          .then((removed) => {
            if (removed) {
              debugImport(jobId, "Temporary job directory removed.")
            }
          })
          .catch((error) => {
            debugError(jobId, "Temporary job directory cleanup failed", error)
          })
          .finally(releaseCacheJobDirectory)
      }
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
        completedMessage: replacingExistingEpisode
          ? "Episode replaced after media processing."
          : "Media processed and added to the library.",
      })
    }

    async function runDirectMoveImport() {
      updateJob(jobId, {
        message: "Moving direct-import media file.",
      })

      await prepareExistingEpisodeReplacement()
      await moveLibraryFileThroughQueue(filePath, finalPath, "direct-import")
      await rm(finalSubtitlePath, { force: true }).catch((error) => {
        debugError(jobId, "Direct-import destination subtitle sidecar cleanup failed", error)
      })

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
        completedMessage: replacingExistingEpisode
          ? "Episode replaced without transcoding."
          : "Media added to the library without transcoding.",
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
        : "Queued for MP4 remux."

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
    const message = importErrorMessage(error) || "Unknown media processing error"

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
