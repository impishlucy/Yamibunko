import { constants } from "node:fs"
import {
  access,
  copyFile,
  mkdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises"
import path from "node:path"

import { upsertAnime, upsertEpisode } from "@/server/db/library"
import { createJob, updateJob } from "@/server/db/jobs"
import { getServerConfig } from "@/server/config"
import { ffprobe, getHevcFileArgs, runFfmpeg } from "@/server/media/ffmpeg"
import {
  formatEpisodeFileName,
  formatSeasonFolderName,
  parseAnimeFileName,
  sanitizePathPart,
} from "@/server/media/filename"
import { findAnimeMetadata } from "@/server/metadata/anilist"
import { acquireBackgroundTranscode } from "@/server/transcode/transcodeCapacity"

const mediaExtensions = new Set([
  ".mkv",
  ".mp4",
  ".m4v",
  ".avi",
  ".mov",
  ".webm",
])

const hevcSkipThresholdBytes = 450 * 1024 * 1024
const targetOutputBytes = 400 * 1024 * 1024

export type ProcessInputFileResult = {
  ok: boolean
  filePath: string
  planned: boolean
  message: string
}

type ProbeStream = {
  codec_type?: string
  codec_name?: string
  duration?: string
}

type ProbeResult = {
  streams?: ProbeStream[]
  format?: {
    duration?: string
    size?: string
  }
}

function isMediaFile(filePath: string) {
  return mediaExtensions.has(path.extname(filePath).toLowerCase())
}

function parseDurationSeconds(probe: ProbeResult) {
  const duration = Number.parseFloat(probe.format?.duration ?? "")

  if (Number.isFinite(duration) && duration > 0) {
    return duration
  }

  for (const stream of probe.streams ?? []) {
    const streamDuration = Number.parseFloat(stream.duration ?? "")

    if (Number.isFinite(streamDuration) && streamDuration > 0) {
      return streamDuration
    }
  }

  return 24 * 60
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

function calculateVideoBitrateKbps(durationSeconds: number) {
  const totalKbps = Math.floor((targetOutputBytes * 8) / durationSeconds / 1000)
  return Math.max(totalKbps - 256, 500)
}

async function waitForStableFile(filePath: string) {
  let previousSize = -1
  let stableReads = 0

  while (stableReads < 3) {
    const fileStat = await stat(filePath)

    if (!fileStat.isFile()) {
      throw new Error("Input is not a file")
    }

    if (fileStat.size === previousSize) {
      stableReads += 1
    } else {
      previousSize = fileStat.size
      stableReads = 0
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
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

function thumbnailPathForEpisode(filePath: string) {
  const extension = path.extname(filePath)
  return `${filePath.slice(0, -extension.length)}.jpg`
}

async function generateThumbnail(filePath: string, durationSeconds: number) {
  const thumbnailPath = thumbnailPathForEpisode(filePath)

  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "warning",
    "-ss",
    String(Math.max(durationSeconds / 2, 1)),
    "-i",
    filePath,
    "-frames:v",
    "1",
    "-vf",
    "scale=640:-2:force_original_aspect_ratio=decrease",
    "-y",
    thumbnailPath,
  ])

  return thumbnailPath
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

  try {
    updateJob(jobId, {
      status: "processing",
      startedAt: new Date().toISOString(),
      message: "Waiting for input file to become stable.",
    })

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

    await access(filePath, constants.R_OK)
    await waitForStableFile(filePath)

    const parsed = parseAnimeFileName(filePath)

    if (!parsed) {
      throw new Error("Unable to extract anime title and episode number")
    }

    updateJob(jobId, {
      message: "Fetching AniList metadata.",
    })

    const metadata = await findAnimeMetadata(parsed.title, parsed.season)

    if (!metadata) {
      throw new Error(`AniList could not match "${parsed.title}"`)
    }

    upsertAnime(metadata)

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

    if (needsTranscode) {
      updateJob(jobId, {
        message: "Waiting for transcode capacity.",
      })

      const lease = await acquireBackgroundTranscode(`background:${jobId}`)

      try {
        updateJob(jobId, {
          message: "Transcoding media file.",
        })

        await transcodeFile(filePath, tempPath, {
          convertVideo,
          convertAudioToMp3,
          videoBitrateKbps: calculateVideoBitrateKbps(durationSeconds),
        })
      } finally {
        lease.release()
      }

      await replaceFile(tempPath, finalPath)
      await rm(path.dirname(tempPath), { force: true, recursive: true })
      await unlink(filePath).catch(() => undefined)
    } else {
      updateJob(jobId, {
        message: "Moving direct-play media file.",
      })

      await replaceFile(filePath, finalPath)
    }

    updateJob(jobId, {
      outputPath: finalPath,
      message: "Generating thumbnail.",
    })

    await generateThumbnail(finalPath, durationSeconds)

    upsertEpisode({
      animeId: metadata.id,
      epNr: parsed.episode,
      filePath: finalPath,
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
