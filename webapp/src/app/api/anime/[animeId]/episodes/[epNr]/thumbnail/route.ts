import { spawn } from "node:child_process"
import { createReadStream } from "node:fs"
import path from "node:path"
import { stat } from "node:fs/promises"
import { Readable } from "node:stream"

import { requireApiUser } from "@/server/auth/api"
import { getEpisodeThumbnailPath } from "@/server/db/library"
import {
  generateEpisodeThumbnail,
  thumbnailPathForEpisode,
} from "@/server/media/mediaFiles"
import { getEpisode } from "@/server/media/libraryStore"
import { getServerConfig } from "@/server/config"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type ThumbnailContext = {
  params: Promise<{
    animeId: string
    epNr: string
  }>
}

const fallbackThumbnail = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
)

function parseFrameTime(value: string | null, durationSeconds?: number) {
  if (!value) {
    return 0
  }

  const parsed = Number(value)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0
  }

  if (durationSeconds && durationSeconds > 0) {
    return Math.min(parsed, Math.max(durationSeconds - 0.25, 0))
  }

  return parsed
}

async function generatePreviewFrame(filePath: string, frameTime: number) {
  const config = getServerConfig()
  const child = spawn(
    config.ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      frameTime.toFixed(3),
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-vf",
      "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
      "-f",
      "image2pipe",
      "-vcodec",
      "libwebp",
      "-quality",
      "82",
      "-compression_level",
      "4",
      "pipe:1",
    ],
    {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }
  )

  const chunks: Buffer[] = []
  let size = 0

  const timeout = setTimeout(() => {
    child.kill("SIGKILL")
  }, 5000)
  timeout.unref?.()

  child.stdout?.on("data", (chunk: Buffer) => {
    size += chunk.byteLength

    if (size <= 2 * 1024 * 1024) {
      chunks.push(chunk)
    } else {
      child.kill("SIGKILL")
    }
  })

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve(code))
  }).finally(() => clearTimeout(timeout))

  if (exitCode !== 0 || chunks.length === 0) {
    return null
  }

  return Buffer.concat(chunks)
}

const imageContentTypesByExtension = new Map<string, string>([
  [".webp", "image/webp"],
  [".png", "image/png"],
])

function contentTypeForImagePath(filePath: string) {
  return imageContentTypesByExtension.get(path.extname(filePath).toLowerCase()) ?? "image/jpeg"
}

async function existingImageStat(filePath: string) {
  const fileStat = await stat(/*turbopackIgnore: true*/ filePath)

  return fileStat.isFile() ? fileStat : null
}

function fallbackThumbnailResponse() {
  return new Response(fallbackThumbnail, {
    headers: {
      "content-type": "image/png",
      "content-length": String(fallbackThumbnail.length),
      "cache-control": "private, max-age=300",
    },
  })
}

export async function GET(request: Request, context: ThumbnailContext) {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const { animeId, epNr } = await context.params
  const url = new URL(request.url)
  const season = url.searchParams.get("season") ?? "1"
  const episode = getEpisode(animeId, season, epNr)

  if (!episode) {
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 })
  }

  const frameTime = parseFrameTime(
    url.searchParams.get("time"),
    episode.durationSeconds
  )

  if (frameTime > 0) {
    const previewFrame = await generatePreviewFrame(
      episode.filePath,
      frameTime
    ).catch(() => null)

    if (previewFrame) {
      return new Response(previewFrame, {
        headers: {
          "content-type": "image/webp",
          "content-length": String(previewFrame.length),
          "cache-control": "private, max-age=600",
        },
      })
    }
  }

  const storedThumbnailPath = getEpisodeThumbnailPath(animeId, season, epNr)
  const generatedThumbnailPath = thumbnailPathForEpisode(episode.filePath)
  const thumbnailCandidates = [
    storedThumbnailPath,
    generatedThumbnailPath,
  ].filter((candidate, index, candidates): candidate is string => {
    return Boolean(candidate) && candidates.indexOf(candidate) === index
  })

  for (const thumbnailPath of thumbnailCandidates) {
    const fileStat = await existingImageStat(thumbnailPath).catch(() => null)

    if (!fileStat) {
      continue
    }

    const fileStream = createReadStream(/*turbopackIgnore: true*/ thumbnailPath)

    return new Response(
      Readable.toWeb(fileStream) as ReadableStream<Uint8Array>,
      {
        headers: {
          "content-type": contentTypeForImagePath(thumbnailPath),
          "content-length": String(fileStat.size),
          "cache-control": "private, max-age=3600",
        },
      }
    )
  }

  const regeneratedThumbnailPath = await generateEpisodeThumbnail(
    episode.filePath,
    episode.durationSeconds ?? 0
  ).catch(() => null)

  if (!regeneratedThumbnailPath) {
    return fallbackThumbnailResponse()
  }

  try {
    const fileStat = await existingImageStat(regeneratedThumbnailPath)

    if (!fileStat) {
      return fallbackThumbnailResponse()
    }

    const fileStream = createReadStream(
      /*turbopackIgnore: true*/ regeneratedThumbnailPath
    )

    return new Response(
      Readable.toWeb(fileStream) as ReadableStream<Uint8Array>,
      {
        headers: {
          "content-type": contentTypeForImagePath(regeneratedThumbnailPath),
          "content-length": String(fileStat.size),
          "cache-control": "private, max-age=3600",
        },
      }
    )
  } catch {
    return fallbackThumbnailResponse()
  }
}
