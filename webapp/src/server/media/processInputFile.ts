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
import { serverLog } from "@/server/logger"
import { ffprobe, getHevcFileArgs, runFfmpeg } from "@/server/media/ffmpeg"
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
import { acquireBackgroundTranscode } from "@/server/transcode/transcodeCapacity"

const hevcSkipThresholdBytes = 450 * 1024 * 1024
const targetBytesPerMinute = 18 * 1024 * 1024
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

function needsMp3Audio(probe: ProbeResult) {
  return (probe.streams ?? []).some((stream) => {
    const codec = (stream.codec_name ?? "").toLowerCase()

    return (
      stream.codec_type === "audio" &&
      (codec === "flac" || codec === "wav" || codec.startsWith("pcm_"))
    )
  })
}

function calculateVideoBitrateKbps() {
  const totalKbps = Math.floor((targetBytesPerMinute * 8) / 60 / 1000)
  return Math.max(totalKbps - targetAudioKbps, 500)
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
    subtitleStreams: streams.filter((stream) => stream.codec_type === "subtitle")
      .length,
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
    convertAudioToMp3: boolean
    videoBitrateKbps: number
  }
) {
  await mkdir(path.dirname(outputPath), { recursive: true })

  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "warning",
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
  serverLog.info("Media", "Input file processing started.", { filePath, jobId })

  try {
    updateJob(jobId, {
      status: "processing",
      startedAt: new Date().toISOString(),
      message: "Waiting for input file to become stable.",
    })

    if (!isMediaFile(filePath)) {
      serverLog.info("Media", "Skipped non-media input file.", {
        filePath,
        jobId,
      })
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

    serverLog.info("Media", "Waiting for input file to become stable.", {
      filePath,
      jobId,
    })
    await waitForStableFile(filePath)

    const parsed = parseAnimeFileName(filePath)

    if (!parsed) {
      throw new Error("Unable to extract anime title and episode number")
    }

    serverLog.info("Media", "Recognized input file.", {
      filePath,
      jobId,
      title: parsed.title,
      season: parsed.season,
      episode: parsed.episode,
    })

    updateJob(jobId, {
      message: "Fetching AniList metadata.",
    })

    const metadata = await findAnimeMetadata(parsed.title, parsed.season)

    if (!metadata) {
      throw new Error(`AniList could not match "${parsed.title}"`)
    }

    upsertAnime(metadata)
    serverLog.info("Media", "Resolved AniList metadata for input file.", {
      filePath,
      jobId,
      title: parsed.title,
      anilistId: metadata.id,
      matchedTitle:
        metadata.title.userPreferred ??
        metadata.title.english ??
        metadata.title.romaji,
    })

    updateJob(jobId, {
      animeId: metadata.id,
      epNr: parsed.episode,
      message: "Inspecting media streams.",
    })

    const inputStat = await stat(filePath)
    const probe = (await ffprobe(filePath)) as ProbeResult
    const durationSeconds = parseDurationSeconds(probe)
    const convertVideo =
      !hasHevcVideo(probe) || inputStat.size >= hevcSkipThresholdBytes
    const convertAudioToMp3 = needsMp3Audio(probe)
    const needsTranscode = convertVideo || convertAudioToMp3
    const videoBitrateKbps = calculateVideoBitrateKbps()
    const title =
      metadata.title.userPreferred ??
      metadata.title.english ??
      metadata.title.romaji ??
      parsed.title
    const safeTitle = sanitizePathPart(title) || `AniList ${metadata.id}`
    const extension = needsTranscode ? ".mkv" : path.extname(filePath)
    const finalName = formatEpisodeFileName({
      title: safeTitle,
      season: parsed.season,
      episode: parsed.episode,
      extension,
    })
    const finalPath = path.resolve(
      getServerConfig().mediaDir,
      safeTitle,
      formatSeasonFolderName(parsed.season),
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
        `Episode already exists in the library: ${safeTitle} S${String(parsed.season).padStart(2, "0")}E${String(parsed.episode).padStart(2, "0")}`
      )
    }

    serverLog.info("Media", "Media stream inspection completed.", {
      filePath,
      jobId,
      sizeBytes: inputStat.size,
      durationSeconds,
      ...summarizeProbe(probe),
      hevcUnderThreshold: hasHevcVideo(probe) && inputStat.size < hevcSkipThresholdBytes,
      convertVideoToHevc: convertVideo,
      convertAudioToMp3,
      needsTranscode,
      finalPath,
    })

    if (needsTranscode) {
      updateJob(jobId, {
        message: "Waiting for transcode capacity.",
      })

      serverLog.info("Media", "Waiting for background transcode capacity.", {
        filePath,
        jobId,
      })

      const lease = await acquireBackgroundTranscode(`background:${jobId}`)

      try {
        updateJob(jobId, {
          message: "Transcoding media file.",
        })

        serverLog.info("Media", "Starting media transcode.", {
          filePath,
          jobId,
          outputPath: tempPath,
          acceleration: getServerConfig().transcodeAccel,
          convertVideoToHevc: convertVideo,
          convertAudioToMp3,
          videoBitrateKbps,
        })

        await transcodeFile(filePath, tempPath, {
          convertVideo,
          convertAudioToMp3,
          videoBitrateKbps,
        })
      } finally {
        lease.release()
      }

      serverLog.info("Media", "Media transcode completed.", {
        filePath,
        jobId,
        outputPath: tempPath,
      })
      await replaceFile(tempPath, finalPath)
      await rm(path.dirname(tempPath), { force: true, recursive: true })
      await unlink(filePath).catch(() => undefined)
      await removeEmptyInputParents(filePath)
    } else {
      updateJob(jobId, {
        message: "Moving direct-play media file.",
      })

      serverLog.info("Media", "Skipping transcode and moving direct-play file.", {
        filePath,
        jobId,
        finalPath,
        reason: "HEVC video is under the configured size threshold and audio does not need conversion.",
      })

      await replaceFile(filePath, finalPath)
      await removeEmptyInputParents(filePath)
    }

    updateJob(jobId, {
      outputPath: finalPath,
      message: "Generating thumbnail.",
    })

    serverLog.info("Media", "Generating episode thumbnail.", {
      filePath: finalPath,
      jobId,
      durationSeconds,
    })

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

    serverLog.info("Media", "Episode added to database.", {
      jobId,
      animeId: metadata.id,
      season: parsed.season,
      episode: parsed.episode,
      filePath: finalPath,
      thumbnailPath,
    })

    updateJob(jobId, {
      status: "completed",
      outputPath: finalPath,
      message: needsTranscode
        ? "Media processed and added to the library."
        : "Media added to the library without transcoding.",
      finishedAt: new Date().toISOString(),
    })

    return {
      ok: true,
      filePath: finalPath,
      planned: needsTranscode,
      message: needsTranscode
        ? "Media processed and added to the library."
        : "Media added to the library without transcoding.",
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown media processing error"

    serverLog.error("Media", "Input file processing failed.", {
      filePath,
      jobId,
      error,
    })

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
