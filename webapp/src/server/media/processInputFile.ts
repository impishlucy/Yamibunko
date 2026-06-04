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
import { createJob, updateJob } from "@/server/db/jobs"
import { getServerConfig } from "@/server/config"
import {
  ffprobe,
  getHardwareInputArgs,
  getHardwareInputLabel,
  getHevcFileArgs,
  runFfmpeg,
} from "@/server/media/ffmpeg"
import {
  formatEpisodeFileName,
  formatSeasonFolderName,
  parseAnimeFileName,
  sanitizePathPart,
} from "@/server/media/filename"
import {
  generateEpisodeThumbnail,
  isMediaFile,
  parseDurationSeconds,
  pathExists,
  thumbnailPathForEpisode,
  type ProbeResult,
  waitForStableFile,
} from "@/server/media/mediaFiles"
import { findAnimeMetadata } from "@/server/metadata/anilist"
import {
  acquireAudioTranscode,
  acquireVideoTranscode,
} from "@/server/transcode/transcodeCapacity"
import { getAudioOutputIndexesToMp3 } from "@/server/media/streamMetadata"
import { errorMessage, fileName } from "@/server/utils/format"
import { debugLog } from "@/server/utils/debugLog"

const hardwareMaxHevcBytesPerMinute = 20 * 1024 * 1024
const cpuMaxHevcBytesPerMinute = 30 * 1024 * 1024
const targetBytesPerMinute = 17 * 1024 * 1024
const targetAudioKbps = 256
const failedImportsFolderName = "_Failed Imports"
const activeInputImportOutputs = new Map<string, number>()

export type ProcessInputFileResult = {
  ok: boolean
  filePath: string
  planned: boolean
  message: string
}

export type DeferredInputWorkKind =
  | "video-transcode"
  | "audio-transcode"
  | "direct-move"
  | "existing-output"

export type DeferredInputWork = {
  kind: DeferredInputWorkKind
  filePath: string
  planned: boolean
}

export type ProcessInputFileOptions = {
  transcodeWaitSignal?: AbortSignal
  deferVideoTranscodes?: boolean
  deferAudioTranscodes?: boolean
  deferDirectMoves?: boolean
  onDeferredWork?: (work: Promise<void>, deferredWork: DeferredInputWork) => void
}

function debugImport(jobId: string, message: string) {
  debugLog(`[Debug] [MediaImport:${jobId}] ${message}`)
}

function debugError(jobId: string, message: string, error: unknown) {
  const details = error instanceof Error && error.stack ? error.stack : errorMessage(error)
  console.error(`[Error] [MediaImport:${jobId}] ${message} - ${details}`)
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

  if (kind === "existing-output") {
    return "existing output finalization"
  }

  return "direct library move"
}

function isTranscodeWaitCancellation(error: unknown) {
  return errorMessage(error) === "Transcode request was cancelled"
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

function getMaxHevcBytesPerMinute() {
  return getServerConfig().transcodeAccel === "cpu"
    ? cpuMaxHevcBytesPerMinute
    : hardwareMaxHevcBytesPerMinute
}

function calculateVideoBitrateKbps() {
  const totalKbps = Math.floor((targetBytesPerMinute * 8) / 60 / 1000)
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
  const safeValue = sanitizePathPart(value)

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

function isInsideInputDirectory(inputDir: string, current: string) {
  const relative = path.relative(inputDir, current)

  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function isInsideFailedImports(inputDir: string, current: string) {
  const relative = path.relative(inputDir, path.resolve(current))

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false
  }

  return relative.split(path.sep).includes(failedImportsFolderName)
}

async function moveInvalidInputToFailedImports(
  filePath: string,
  options: { jobId: string }
) {
  const inputDir = path.resolve(getServerConfig().inputDir)
  const resolvedFilePath = path.resolve(filePath)

  if (isInsideFailedImports(inputDir, resolvedFilePath)) {
    debugImport(
      options.jobId,
      `Invalid media is already inside failed imports - ${resolvedFilePath}`
    )
    return resolvedFilePath
  }

  if (!isInsideInputDirectory(inputDir, resolvedFilePath)) {
    throw new Error(`Refusing to quarantine a file outside the input folder: ${resolvedFilePath}`)
  }

  const relativePath = path.relative(inputDir, resolvedFilePath)
  const destination = await uniqueDestinationPath(
    path.resolve(inputDir, failedImportsFolderName, relativePath)
  )

  console.warn(
    `[Warn] [Media] Invalid media file moved to failed imports - ${resolvedFilePath} -> ${destination}`
  )
  debugImport(options.jobId, `Moving invalid media to failed imports - ${destination}`)
  await replaceFile(resolvedFilePath, destination, { jobId: options.jobId })
  await removeNonMediaOnlyInputParents(resolvedFilePath, { jobId: options.jobId })

  return destination
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
    audioOutputIndexesToMp3: number[]
    videoBitrateKbps: number
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
  options: ProcessInputFileOptions = {}
): Promise<ProcessInputFileResult> {
  const jobId = createJob(filePath)
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
      throw new Error("Unable to extract anime title and episode number")
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
    const metadata = await findAnimeMetadata(
      parsed.title,
      parsed.season,
      parsed.episode,
      parsed.part
    )

    if (!metadata) {
      throw new Error(`AniList could not match "${parsed.title}"`)
    }

    debugImport(jobId, `AniList metadata lookup completed - Anime id ${metadata.id}.`)
    debugImport(jobId, "Saving AniList metadata before media processing.")
    upsertAnime(metadata)
    debugImport(jobId, "AniList metadata saved.")

    const librarySeason = resolveLibrarySeasonNumberForAnime({
      animeId: metadata.id,
      parsedSeason: parsed.season,
      parsedPart: parsed.part,
    })

    if (librarySeason !== parsed.season) {
      console.log(
        `[Info] [Media] Resolved library season - Parsed Season ${parsed.season}, Library Season ${librarySeason}, Anime id ${metadata.id}`
      )
      debugImport(
        jobId,
        `Library season resolved from parsed season ${parsed.season} to ${librarySeason}.`
      )
    }

    console.log(
      `[Info] [Media] Resolved AniList metadata - Found match ${
        metadata.title.english ??
        parsed.title
      } - id ${metadata.id}`
    )

    updateJob(jobId, {
      animeId: metadata.id,
      epNr: parsed.episode,
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

      const failedPath = await moveInvalidInputToFailedImports(filePath, { jobId })
      const message = `Invalid media file was moved to failed imports: ${failedPath}`

      updateJob(jobId, {
        status: "failed",
        error: errorMessage(error),
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
    const inputBytesPerMinute = calculateBytesPerMinute(
      inputStat.size,
      durationSeconds
    )
    const maxHevcBytesPerMinute = getMaxHevcBytesPerMinute()
    const inputHasHevcVideo = hasHevcVideo(probe)
    const convertVideo =
      !inputHasHevcVideo || inputBytesPerMinute > maxHevcBytesPerMinute
    const audioOutputIndexesToMp3 = getAudioOutputIndexesToMp3(probe)
    const convertAudioToMp3 = audioOutputIndexesToMp3.length > 0
    const needsFfmpegProcessing = convertVideo || convertAudioToMp3
    const videoBitrateKbps = calculateVideoBitrateKbps()
    const mediaTitle = metadataTitle(metadata)
    const libraryTitle = metadata.library?.title

    debugImport(
      jobId,
      `Processing decision - convertVideo ${convertVideo}, audioTracksToMp3 [${audioOutputIndexesToMp3.join(", ")}], needsFfmpegProcessing ${needsFfmpegProcessing}`
    )

    if (!libraryTitle) {
      throw new Error(`AniList media ${metadata.id} did not resolve a library root`)
    }

    const safeLibraryTitle = safePathSegment(libraryTitle, "Library title")
    const safeMediaTitle = safePathSegment(mediaTitle, "Media title")
    const extension = needsFfmpegProcessing ? ".mkv" : path.extname(filePath)
    const finalName = formatEpisodeFileName({
      title: safeMediaTitle,
      season: librarySeason,
      episode: parsed.episode,
      extension,
    })
    const finalPath = path.resolve(
      getServerConfig().mediaDir,
      safeLibraryTitle,
      ...mediaFolderSegments({
        format: metadata.format,
        season: librarySeason,
        mediaTitle: safeMediaTitle,
      }),
      finalName
    )
    const tempPath = path.resolve(
      getServerConfig().tempDir,
      "jobs",
      jobId,
      finalName
    )
    debugImport(jobId, `Resolved output path - ${finalPath}`)
    debugImport(jobId, `Resolved temp path - ${tempPath}`)
    debugImport(jobId, "Checking for existing episode/file conflicts.")
    const existingEpisode = getStoredEpisode(
      metadata.id,
      librarySeason,
      parsed.episode
    )
    const legacySeasonEpisode =
      librarySeason !== parsed.season
        ? getStoredEpisode(metadata.id, parsed.season, parsed.episode)
        : null

    const existingEpisodeFileExists = existingEpisode
      ? await pathExists(existingEpisode.filePath)
      : false
    let finalPathExists = await pathExists(finalPath)

    if (existingEpisodeFileExists && existingEpisode) {
      const existingPath = path.resolve(existingEpisode.filePath)
      const inputPath = path.resolve(filePath)
      const message = `Episode already exists in the library: ${safeLibraryTitle} S${String(librarySeason).padStart(2, "0")}E${String(parsed.episode).padStart(2, "0")}`

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
        `[Warn] [Media] Existing episode was stored under parsed Season ${parsed.season}; moving it to library Season ${librarySeason} - ${legacySeasonEpisode.filePath}`
      )

      if (finalPathExists) {
        await unlinkFileWithRetry(legacySeasonEpisode.filePath, { jobId })
      } else {
        await replaceFile(legacySeasonEpisode.filePath, finalPath, { jobId })
        finalPathExists = true
      }

      await rm(thumbnailPathForEpisode(legacySeasonEpisode.filePath), {
        force: true,
      })
      deleteEpisodeRecord({
        animeId: metadata.id,
        seasonNr: parsed.season,
        epNr: parsed.episode,
      })
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
    const importAnimeId = metadata.id
    const importEpisodeNumber = parsed.episode

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
      upsertEpisode({
        animeId: importAnimeId,
        seasonNr: librarySeason,
        epNr: importEpisodeNumber,
        filePath: finalPath,
        thumbnailPath,
        durationSeconds,
      })

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
      const lease = convertVideo
        ? await (async () => {
            updateJob(jobId, {
              message: "Waiting for video transcode capacity.",
            })

            console.log(
              `[Info] [Media] Waiting for background transcode capacity - ${fileName(filePath)}`
            )
            debugImport(jobId, "Waiting for video transcode lease.")

            const lease = await acquireVideoTranscode(
              `video:${jobId}`,
              options.transcodeWaitSignal
            )
            debugImport(jobId, `Video transcode lease acquired - ${lease.id}`)
            return lease
          })()
        : await (async () => {
            updateJob(jobId, {
              message: "Waiting for audio transcode capacity.",
            })
            console.log(
              `[Info] [Media] Waiting for audio transcode capacity - ${fileName(filePath)}`
            )
            debugImport(jobId, "Waiting for audio transcode lease.")
            const lease = await acquireAudioTranscode(
              `audio:${jobId}`,
              options.transcodeWaitSignal
            )
            debugImport(jobId, `Audio transcode lease acquired - ${lease.id}`)
            return lease
          })()

      try {
        updateJob(jobId, {
          message: convertVideo
            ? "Transcoding media file."
            : "Converting audio tracks.",
        })

        console.log(
          `[Info] [Media] Starting media transcode - ${fileName(filePath)} - Accel: ${getServerConfig().transcodeAccel}, HW decode: ${convertVideo ? getHardwareInputLabel() : "not needed"}, HEVC: ${convertVideo ? `yes (${inputHasHevcVideo ? `over ${formatMegabytesPerMinute(maxHevcBytesPerMinute)} MB/min` : "source is not HEVC"})` : "copy"}, MP3 audio tracks: ${audioOutputIndexesToMp3.length ? audioOutputIndexesToMp3.join(", ") : "none"}, Target: ${formatMegabytesPerMinute(targetBytesPerMinute)} MB/min, Bitrate: ${videoBitrateKbps}k`
        )

        await transcodeFile(filePath, tempPath, {
          convertVideo,
          audioOutputIndexesToMp3,
          videoBitrateKbps,
          jobId,
        })
        debugImport(jobId, "Transcode step completed successfully.")
      } finally {
        lease.release()
        debugImport(jobId, "Transcode lease released.")
      }

      console.log(
        `[Info] [Media] Media transcode completed - ${fileName(filePath)}`
      )
      await replaceFile(tempPath, finalPath, { jobId })
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
        message: "Moving direct-play media file.",
      })

      console.log(
        `[Info] [Media] Skipping transcode and moving direct-play file - ${fileName(filePath)}`
      )

      await replaceFile(filePath, finalPath, { jobId })

      if (await pathExists(filePath)) {
        debugImport(jobId, "Source still exists after direct-play move; removing it.")
        await unlinkFileWithRetry(filePath, { jobId })
      }

      debugImport(jobId, "Direct-play file move completed.")
      debugImport(jobId, "Cleaning input parent folders.")
      await removeNonMediaOnlyInputParents(filePath, { jobId })
      debugImport(jobId, "Input parent cleanup completed.")

      return finalizeImport({
        planned: false,
        completedMessage: "Media added to the library without transcoding.",
      })
    }

    async function runDeferredImportWork(input: {
      kind: DeferredInputWorkKind
      work: () => Promise<ProcessInputFileResult>
    }) {
      const label = formatDeferredWorkKind(input.kind)

      try {
        await runWithActiveInputImportOutput(finalPath, input.work)
      } catch (error) {
        const message = errorMessage(error) || "Unknown media processing error"

        if (
          isTranscodeWaitCancellation(error) &&
          options.transcodeWaitSignal?.aborted
        ) {
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

        console.error(
          `[Error] [Media] Deferred ${label} failed - processInputFile.ts - ${filePath} - ${message}`
        )
        debugError(jobId, `Deferred ${label} failed`, error)

        updateJob(jobId, {
          status: "failed",
          error: message,
          message,
          finishedAt: new Date().toISOString(),
        })
      }
    }

    function queueDeferredImportWork(input: {
      kind: DeferredInputWorkKind
      planned: boolean
      message: string
      work: () => Promise<ProcessInputFileResult>
    }): ProcessInputFileResult {
      const deferredWork = runDeferredImportWork({
        kind: input.kind,
        work: input.work,
      })
      options.onDeferredWork?.(deferredWork, {
        kind: input.kind,
        filePath: finalPath,
        planned: input.planned,
      })

      return {
        ok: true,
        filePath: finalPath,
        planned: input.planned,
        message: input.message,
      }
    }

    if (useExistingOutput) {
      if (options.deferDirectMoves) {
        updateJob(jobId, {
          message: "Queued existing output finalization.",
        })
        console.log(
          `[Info] [Media] Queued existing output finalization and continuing import scan - ${fileName(filePath)}`
        )
        debugImport(jobId, "Existing output finalization deferred so input scanning can continue.")

        return queueDeferredImportWork({
          kind: "existing-output",
          planned: false,
          message: "Queued existing output finalization.",
          work: finishExistingOutputImport,
        })
      }

      return runWithActiveInputImportOutput(finalPath, finishExistingOutputImport)
    }

    if (needsFfmpegProcessing && convertVideo && options.deferVideoTranscodes) {
      updateJob(jobId, {
        message: "Queued for video transcode.",
      })
      console.log(
        `[Info] [Media] Queued video transcode and continuing import scan - ${fileName(filePath)}`
      )
      debugImport(jobId, "Video transcode deferred so other import inspections can continue.")

      return queueDeferredImportWork({
        kind: "video-transcode",
        planned: true,
        message: "Queued for video transcode.",
        work: runFfmpegImport,
      })
    }

    if (needsFfmpegProcessing && !convertVideo && options.deferAudioTranscodes) {
      updateJob(jobId, {
        message: "Queued for audio transcode.",
      })
      console.log(
        `[Info] [Media] Queued audio transcode and continuing import scan - ${fileName(filePath)}`
      )
      debugImport(jobId, "Audio-only transcode deferred into the audio-priority transcode queue.")

      return queueDeferredImportWork({
        kind: "audio-transcode",
        planned: true,
        message: "Queued for audio transcode.",
        work: runFfmpegImport,
      })
    }

    if (needsFfmpegProcessing) {
      return runWithActiveInputImportOutput(finalPath, runFfmpegImport)
    }

    if (options.deferDirectMoves) {
      updateJob(jobId, {
        message: "Queued direct library move.",
      })
      console.log(
        `[Info] [Media] Queued direct-play move and continuing import scan - ${fileName(filePath)}`
      )
      debugImport(jobId, "Direct-play move deferred so input scanning can continue.")

      return queueDeferredImportWork({
        kind: "direct-move",
        planned: false,
        message: "Queued direct library move.",
        work: runDirectMoveImport,
      })
    }

    return runWithActiveInputImportOutput(finalPath, runDirectMoveImport)
  } catch (error) {
    const message = errorMessage(error) || "Unknown media processing error"

    if (
      isTranscodeWaitCancellation(error) &&
      options.transcodeWaitSignal?.aborted
    ) {
      const shutdownMessage = "Skipped queued transcode because shutdown started."

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

    console.error(
      `[Error] [Media] Input file processing failed - processInputFile.ts - ${filePath} - ${errorMessage(error)}`
    )
    debugError(jobId, "Input file processing failed", error)

    updateJob(jobId, {
      status: "failed",
      error: message,
      message,
      finishedAt: new Date().toISOString(),
    })

    return {
      ok: false,
      filePath,
      planned: false,
      message,
    }
  }
}
