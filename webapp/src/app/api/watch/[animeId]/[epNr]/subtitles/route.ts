import { spawn } from "node:child_process"

import { requireApiUser } from "@/server/auth/api"
import { isStreamServerShutdownActive } from "@/server/bandwidth/streamBandwidth"
import { guardApiRequest } from "@/server/security/abuseGuard"
import { getServerConfig } from "@/server/config"
import { validateCastStreamToken } from "@/server/media/castTokens"
import { ffprobe } from "@/server/media/ffmpeg"
import type { ProbeResult } from "@/server/media/mediaFiles"
import { resolveEpisodeMedia } from "@/server/media/resolveMediaId"
import { getMediaStreamMetadata } from "@/server/media/streamMetadata"
import { errorMessage, fileName, parsePositiveInt } from "@/server/utils/format"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type SubtitleContext = {
  params: Promise<{
    animeId: string
    epNr: string
  }>
}

const ffmpegShutdownGraceMs = 2_000
const maxSubtitleBytes = 8 * 1024 * 1024

function subtitleCorsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type",
  }
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: subtitleCorsHeaders(),
  })
}

function jsonError(message: string, status: number) {
  return Response.json(
    { ok: false, message },
    {
      status,
      headers: subtitleCorsHeaders(),
    }
  )
}

function parseStreamIndex(value: string | null) {
  if (!value) {
    return null
  }

  const index = Number(value)

  return Number.isInteger(index) && index >= 0 ? index : null
}

function stripSubtitleFormatting(value: string) {
  return value
    .replace(/\{\\[^}]*}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[ \t]+$/gm, "")
}

async function resolveSubtitleUser(input: {
  animeId: string
  seasonNumber: number
  episodeNumber: number
  castToken: string | null
}) {
  if (input.castToken) {
    const castAuth = validateCastStreamToken({
      token: input.castToken,
      animeId: input.animeId,
      seasonNumber: input.seasonNumber,
      episodeNumber: input.episodeNumber,
    })

    if (castAuth) {
      return { ok: true as const }
    }
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return { ok: false as const, response: auth.response }
  }

  return { ok: true as const }
}

function extractSubtitleWebVtt(input: {
  request: Request
  file: string
  streamIndex: number
}) {
  const child = spawn(
    getServerConfig().ffmpegPath,
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-fix_sub_duration",
      "-copyts",
      "-i",
      input.file,
      "-map",
      `0:${input.streamIndex}`,
      "-c:s",
      "webvtt",
      "-f",
      "webvtt",
      "pipe:1",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  )

  if (!child.stdout) {
    child.kill("SIGKILL")
    return Promise.reject(new Error("Unable to start subtitle extractor."))
  }

  const chunks: Buffer[] = []
  let byteLength = 0
  let stderr = ""
  let settled = false
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null

  const stopChild = () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }

    child.kill("SIGTERM")

    if (!shutdownTimer) {
      shutdownTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL")
        }
      }, ffmpegShutdownGraceMs)
      shutdownTimer.unref?.()
    }
  }

  return new Promise<string>((resolve, reject) => {
    const finishError = (error: Error) => {
      if (settled) {
        return
      }

      settled = true
      input.request.signal.removeEventListener("abort", onAbort)
      stopChild()
      reject(error)
    }

    const onAbort = () => {
      finishError(new Error("Subtitle request was cancelled."))
    }

    input.request.signal.addEventListener("abort", onAbort, { once: true })

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000)
    })

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) {
        return
      }

      byteLength += chunk.byteLength

      if (byteLength > maxSubtitleBytes) {
        finishError(new Error("Subtitle output was too large."))
        return
      }

      chunks.push(chunk)
    })

    child.once("error", (error) => {
      finishError(error)
    })

    child.once("close", (code) => {
      input.request.signal.removeEventListener("abort", onAbort)

      if (shutdownTimer) {
        clearTimeout(shutdownTimer)
        shutdownTimer = null
      }

      if (settled) {
        return
      }

      if (code && code !== 0) {
        settled = true
        reject(
          new Error(
            `Subtitle extractor failed with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
          )
        )
        return
      }

      settled = true
      resolve(stripSubtitleFormatting(Buffer.concat(chunks).toString("utf8")))
    })
  })
}

export async function GET(request: Request, context: SubtitleContext) {
  const abuseError = await guardApiRequest(request)

  if (abuseError) {
    return abuseError
  }

  const { animeId, epNr } = await context.params
  const episodeNumber = parsePositiveInt(epNr)
  const url = new URL(request.url)
  const seasonNumber = parsePositiveInt(url.searchParams.get("season") ?? "1")
  const streamIndex = parseStreamIndex(url.searchParams.get("stream"))

  if (!episodeNumber || !seasonNumber || streamIndex === null) {
    return jsonError("Subtitle stream not found.", 404)
  }

  if (isStreamServerShutdownActive()) {
    return jsonError(
      "Server is shutting down. New subtitle streams are disabled.",
      503
    )
  }

  const user = await resolveSubtitleUser({
    animeId,
    seasonNumber,
    episodeNumber,
    castToken: url.searchParams.get("castToken"),
  })

  if (!user.ok) {
    return user.response
  }

  let media: ReturnType<typeof resolveEpisodeMedia>

  try {
    media = resolveEpisodeMedia(animeId, seasonNumber, episodeNumber)
  } catch (error) {
    console.error(
      `[Error] [Subtitles] Unable to resolve media file - route.ts - Anime ${animeId}, Season ${seasonNumber}, Episode ${episodeNumber} - ${errorMessage(error)}`
    )
    return jsonError("Media file could not be resolved.", 500)
  }

  if (!media) {
    return jsonError("Media file not found.", 404)
  }

  let subtitleStream

  try {
    const metadata = getMediaStreamMetadata((await ffprobe(media.file)) as ProbeResult)
    subtitleStream = metadata.subtitleStreams.find(
      (stream) => stream.index === streamIndex && stream.isSupported
    )
  } catch (error) {
    console.error(
      `[Error] [Subtitles] Unable to inspect subtitle streams - route.ts - ${media.file} - ${errorMessage(error)}`
    )
    return jsonError("Subtitle stream could not be inspected.", 500)
  }

  if (!subtitleStream) {
    return jsonError("Subtitle stream not found or not supported.", 404)
  }

  try {
    const body = await extractSubtitleWebVtt({
      request,
      file: media.file,
      streamIndex: subtitleStream.index,
    })

    return new Response(body, {
      headers: {
        ...subtitleCorsHeaders(),
        "cache-control": "no-store",
        "content-type": "text/vtt; charset=utf-8",
      },
    })
  } catch (error) {
    console.error(
      `[Error] [Subtitles] Subtitle extractor failed - route.ts - ${fileName(media.file)} - ${errorMessage(error)}`
    )
    return jsonError("Subtitle stream could not be extracted.", 500)
  }
}
