import { spawn } from "node:child_process"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { Readable } from "node:stream"

import type { PlaybackMode, PlaybackProfile } from "@/lib/types"
import { requireApiUser } from "@/server/auth/api"
import { getServerConfig } from "@/server/config"
import { getLiveH264Args } from "@/server/media/ffmpeg"
import { resolveEpisodeFile } from "@/server/media/resolveMediaId"
import { tryAcquireLiveTranscode } from "@/server/transcode/transcodeCapacity"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type StreamContext = {
  params: Promise<{
    animeId: string
    epNr: string
  }>
}

type ByteRange =
  | {
      start: number
      end: number
    }
  | "invalid"

function getMode(value: string | null): PlaybackMode {
  return value === "transcode" ? "transcode" : "direct"
}

function getProfile(value: string | null): PlaybackProfile {
  return value === "dataSaver" ? "dataSaver" : "original"
}

function parseByteRange(
  rangeHeader: string | null,
  size: number
): ByteRange | null {
  if (!rangeHeader) {
    return null
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)

  if (!match) {
    return "invalid"
  }

  const [, rawStart, rawEnd] = match

  if (!rawStart && !rawEnd) {
    return "invalid"
  }

  let start: number
  let end: number

  if (!rawStart) {
    const suffixLength = Number(rawEnd)

    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return "invalid"
    }

    start = Math.max(size - suffixLength, 0)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Number(rawEnd) : size - 1
  }

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return "invalid"
  }

  return {
    start,
    end: Math.min(end, size - 1),
  }
}

async function resolveReadableFile(animeId: string, episodeNumber: number) {
  const file = resolveEpisodeFile(animeId, episodeNumber)

  if (!file) {
    return null
  }

  const fileStat = await stat(file)

  if (!fileStat.isFile()) {
    return null
  }

  return {
    file,
    size: fileStat.size,
  }
}

function jsonError(message: string, status: number) {
  return Response.json({ ok: false, message }, { status })
}

async function handleDirect(request: Request, file: string, size: number) {
  const range = parseByteRange(request.headers.get("range"), size)

  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: {
        "accept-ranges": "bytes",
        "content-range": `bytes */${size}`,
      },
    })
  }

  const headers = new Headers({
    "accept-ranges": "bytes",
    "content-type": "application/octet-stream",
  })

  if (range) {
    const contentLength = range.end - range.start + 1
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`)
    headers.set("content-length", String(contentLength))

    const fileStream = createReadStream(file, {
      start: range.start,
      end: range.end,
    })

    return new Response(
      Readable.toWeb(fileStream) as ReadableStream<Uint8Array>,
      {
        status: 206,
        headers,
      }
    )
  }

  headers.set("content-length", String(size))
  const fileStream = createReadStream(file)

  return new Response(
    Readable.toWeb(fileStream) as ReadableStream<Uint8Array>,
    {
      headers,
    }
  )
}

async function handleTranscode(
  request: Request,
  file: string,
  animeId: string,
  episodeNumber: number,
  profile: PlaybackProfile
) {
  const lease = await tryAcquireLiveTranscode(
    `${animeId}:${episodeNumber}:${profile}`
  )

  if (!lease) {
    return Response.json(
      {
        ok: false,
        reason: "NO_TRANSCODE_CAPACITY",
        message: "Transcoding not possible right now.",
        retryAfterSeconds: 20,
      },
      {
        status: 429,
        headers: {
          "retry-after": "20",
        },
      }
    )
  }

  const config = getServerConfig()
  const child = spawn(
    config.ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-i",
      file,
      ...getLiveH264Args(profile),
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-f",
      "mp4",
      "pipe:1",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  )

  if (!child.stdout) {
    lease.release()
    return jsonError("Unable to start transcoder.", 500)
  }

  child.stderr?.on("data", (chunk: Buffer) => {
    console.warn("[transcode]", chunk.toString("utf8").trim())
  })

  let released = false
  let settled = false

  const release = () => {
    if (released) {
      return
    }

    released = true
    request.signal.removeEventListener("abort", onAbort)
    lease.release()
  }

  const onAbort = () => {
    child.kill("SIGTERM")
    release()
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      request.signal.addEventListener("abort", onAbort, { once: true })

      child.stdout?.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
      })

      child.once("error", (error) => {
        if (!settled) {
          settled = true
          controller.error(error)
        }

        release()
      })

      child.once("close", () => {
        if (!settled) {
          settled = true
          controller.close()
        }

        release()
      })
    },
    cancel() {
      child.kill("SIGTERM")
      release()
    },
  })

  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "video/mp4",
    },
  })
}

export async function GET(request: Request, context: StreamContext) {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const { animeId, epNr } = await context.params
  const episodeNumber = Number.parseInt(epNr, 10)

  if (!Number.isInteger(episodeNumber) || episodeNumber < 1) {
    return jsonError("Episode not found.", 404)
  }

  const url = new URL(request.url)
  const mode = getMode(url.searchParams.get("mode"))
  const profile = getProfile(url.searchParams.get("profile"))

  let resolved: Awaited<ReturnType<typeof resolveReadableFile>>

  try {
    resolved = await resolveReadableFile(animeId, episodeNumber)
  } catch (error) {
    console.error("[watch] Unable to resolve media file.", error)
    return jsonError("Media file could not be resolved.", 500)
  }

  if (!resolved) {
    return jsonError("Media file not found.", 404)
  }

  if (mode === "direct") {
    return handleDirect(request, resolved.file, resolved.size)
  }

  return await handleTranscode(
    request,
    resolved.file,
    animeId,
    episodeNumber,
    profile
  )
}
