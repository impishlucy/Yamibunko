import { constants } from "node:fs"
import { access, rm, stat } from "node:fs/promises"
import path from "node:path"

import { runFfmpeg } from "@/server/media/ffmpeg"

export type ProbeStream = {
  index?: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  duration?: string
  bit_rate?: string
  channels?: number
  disposition?: {
    default?: number
    forced?: number
    hearing_impaired?: number
  }
  tags?: {
    language?: string
    title?: string
  }
}

export type ProbeResult = {
  streams?: ProbeStream[]
  format?: {
    duration?: string
    size?: string
    format_name?: string
  }
}

export const mediaExtensions = new Set([
  ".mkv",
  ".mp4",
  ".m4v",
  ".avi",
  ".mov",
  ".webm",
])

export function isMediaFile(filePath: string) {
  return mediaExtensions.has(path.extname(filePath).toLowerCase())
}

export function parseDurationSeconds(probe: ProbeResult) {
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

export async function waitForStableFile(filePath: string) {
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

export async function pathExists(filePath: string) {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export function thumbnailPathForEpisode(filePath: string) {
  const extension = path.extname(filePath)
  return `${filePath.slice(0, -extension.length)}.jpg`
}

function thumbnailSeekTimes(durationSeconds: number) {
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds
    : 60

  const maxSeek = Math.max(duration - 1, 1)
  const candidates = [
    duration / 2,
    duration * 0.25,
    Math.min(60, maxSeek),
    Math.min(5, maxSeek),
  ]

  return Array.from(
    new Set(
      candidates
        .map((time) => Math.min(Math.max(time, 1), maxSeek))
        .map((time) => Number(time.toFixed(3)))
    )
  )
}

async function assertThumbnailWritten(thumbnailPath: string) {
  const thumbnailStat = await stat(thumbnailPath)

  if (!thumbnailStat.isFile() || thumbnailStat.size <= 0) {
    throw new Error(`Thumbnail output was not written: ${thumbnailPath}`)
  }
}

function thumbnailArgs(filePath: string, thumbnailPath: string, seekTime: number) {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-analyzeduration",
    "100M",
    "-probesize",
    "100M",
    "-ss",
    String(seekTime),
    "-i",
    filePath,
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-dn",
    "-frames:v",
    "1",
    "-vf",
    "scale=640:-2:force_original_aspect_ratio=decrease,format=yuvj420p",
    "-q:v",
    "3",
    "-strict",
    "unofficial",
    "-y",
    thumbnailPath,
  ]
}

export async function generateEpisodeThumbnail(
  filePath: string,
  durationSeconds: number
) {
  const thumbnailPath = thumbnailPathForEpisode(filePath)
  let lastError: unknown = null

  for (const seekTime of thumbnailSeekTimes(durationSeconds)) {
    try {
      await rm(thumbnailPath, { force: true })
      await runFfmpeg(thumbnailArgs(filePath, thumbnailPath, seekTime), {
        protectFromParentSignals: true,
      })
      await assertThumbnailWritten(thumbnailPath)

      return thumbnailPath
    } catch (error) {
      lastError = error
      await rm(thumbnailPath, { force: true })
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Thumbnail generation failed: ${filePath}`)
}
