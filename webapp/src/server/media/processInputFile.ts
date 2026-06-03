import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises"
import path from "node:path"

import {
  getStoredEpisode,
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

const hardwareMaxHevcBytesPerMinute = 20 * 1024 * 1024
const cpuMaxHevcBytesPerMinute = 30 * 1024 * 1024
const targetBytesPerMinute = 17 * 1024 * 1024
const targetAudioKbps = 256

export type ProcessInputFileResult = {
  ok: boolean
  filePath: string
  planned: boolean
  message: string
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

async function replaceFile(source: string, destination: string) {
  if (path.resolve(source) === path.resolve(destination)) {
    return
  }

  await mkdir(path.dirname(destination), { recursive: true })
  await rm(destination, { force: true })

  try {
    await rename(source, destination)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    if (code !== "EXDEV") {
      throw error
    }

    await copyFile(source, destination)
    await unlink(source)
  }
}

async function removeEmptyInputParents(filePath: string) {
  const inputDir = path.resolve(getServerConfig().inputDir)
  let current = path.dirname(path.resolve(filePath))

  while (current.startsWith(inputDir) && current !== inputDir) {
    const entries = await readdir(current).catch(() => null)

    if (!entries || entries.length > 0) {
      return
    }

    await rmdir(current).catch(() => undefined)
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
  }
) {
  await mkdir(path.dirname(outputPath), { recursive: true })

  await runFfmpeg([
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
  ])
}

export async function processInputFile(
  filePath: string
): Promise<ProcessInputFileResult> {
  const jobId = createJob(filePath)
  console.log(
    `[Info] [Media] Input file processing started - ${fileName(filePath)}`
  )

  try {
    updateJob(jobId, {
      status: "processing",
      startedAt: new Date().toISOString(),
      message: "Waiting for input file to become stable.",
    })

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

    if (!(await pathExists(filePath))) {
      throw new Error("Input file is no longer available")
    }

    console.log(
      `[Info] [Media] Waiting for input file to become stable - ${fileName(filePath)}`
    )
    await waitForStableFile(filePath)

    const parsed = parseAnimeFileName(filePath)

    if (!parsed) {
      throw new Error("Unable to extract anime title and episode number")
    }

    console.log(
      `[Info] [Media] Recognized input file - Title: ${parsed.title}, Season: ${parsed.season}, Episode: ${parsed.episode}`
    )

    updateJob(jobId, {
      message: "Fetching AniList metadata.",
    })

    const metadata = await findAnimeMetadata(parsed.title, parsed.season, parsed.episode)

    if (!metadata) {
      throw new Error(`AniList could not match "${parsed.title}"`)
    }

    upsertAnime(metadata)
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

    const inputStat = await stat(filePath)
    const probe = (await ffprobe(filePath)) as ProbeResult
    const durationSeconds = parseDurationSeconds(probe)
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

    if (!libraryTitle) {
      throw new Error(`AniList media ${metadata.id} did not resolve a library root`)
    }

    const safeLibraryTitle = safePathSegment(libraryTitle, "Library title")
    const safeMediaTitle = safePathSegment(mediaTitle, "Media title")
    const extension = needsFfmpegProcessing ? ".mkv" : path.extname(filePath)
    const finalName = formatEpisodeFileName({
      title: safeMediaTitle,
      season: parsed.season,
      episode: parsed.episode,
      extension,
    })
    const finalPath = path.resolve(
      getServerConfig().mediaDir,
      safeLibraryTitle,
      ...mediaFolderSegments({
        format: metadata.format,
        season: parsed.season,
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
    const existingEpisode = getStoredEpisode(
      metadata.id,
      parsed.season,
      parsed.episode
    )

    if (
      (existingEpisode && (await pathExists(existingEpisode.filePath))) ||
      (await pathExists(finalPath))
    ) {
      throw new Error(
        `Episode already exists in the library: ${safeLibraryTitle} S${String(parsed.season).padStart(2, "0")}E${String(parsed.episode).padStart(2, "0")}`
      )
    }

    const summary = summarizeProbe(probe)

    console.log(
      `[Info] [Media] Media stream inspection completed - ${fileName(filePath)} - Video: ${summary.videoCodecs.join(", ") || "unknown"}, Audio: ${summary.audioCodecs.join(", ") || "unknown"}, Duration: ${Math.round(durationSeconds)}s, Size: ${formatMegabytesPerMinute(inputBytesPerMinute)} MB/min`
    )

    if (needsFfmpegProcessing) {
      const lease = convertVideo
        ? await (async () => {
            updateJob(jobId, {
              message: "Waiting for video transcode capacity.",
            })

            console.log(
              `[Info] [Media] Waiting for background transcode capacity - ${fileName(filePath)}`
            )

            return acquireVideoTranscode(`video:${jobId}`)
          })()
        : await acquireAudioTranscode(`audio:${jobId}`)

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
        })
      } finally {
        lease?.release()
      }

      console.log(
        `[Info] [Media] Media transcode completed - ${fileName(filePath)}`
      )
      await replaceFile(tempPath, finalPath)
      await rm(path.dirname(tempPath), { force: true, recursive: true })
      await unlink(filePath).catch(() => undefined)
      await removeEmptyInputParents(filePath)
    } else {
      updateJob(jobId, {
        message: "Moving direct-play media file.",
      })

      console.log(
        `[Info] [Media] Skipping transcode and moving direct-play file - ${fileName(filePath)}`
      )

      await replaceFile(filePath, finalPath)
      await removeEmptyInputParents(filePath)
    }

    updateJob(jobId, {
      outputPath: finalPath,
      message: "Generating thumbnail.",
    })

    console.log(
      `[Info] [Media] Generating episode thumbnail - ${fileName(finalPath)}`
    )

    const thumbnailPath = await generateEpisodeThumbnail(
      finalPath,
      durationSeconds
    )

    upsertEpisode({
      animeId: metadata.id,
      seasonNr: parsed.season,
      epNr: parsed.episode,
      filePath: finalPath,
      thumbnailPath,
      durationSeconds,
    })

    console.log(
      `[Info] [Media] Episode added to database - Anime id ${metadata.id}, Season ${parsed.season}, Episode ${parsed.episode}`
    )

    updateJob(jobId, {
      status: "completed",
      outputPath: finalPath,
      message: needsFfmpegProcessing
        ? "Media processed and added to the library."
        : "Media added to the library without transcoding.",
      finishedAt: new Date().toISOString(),
    })

    return {
      ok: true,
      filePath: finalPath,
      planned: needsFfmpegProcessing,
      message: needsFfmpegProcessing
        ? "Media processed and added to the library."
        : "Media added to the library without transcoding.",
    }
  } catch (error) {
    const message = errorMessage(error) || "Unknown media processing error"

    console.error(
      `[Error] [Media] Input file processing failed - processInputFile.ts - ${filePath} - ${errorMessage(error)}`
    )

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
