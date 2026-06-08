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
import {
  findSubtitleSidecar,
  isWebVttSubtitleCodec,
  normalizeSubtitleCodecName,
  readWebVttSidecar,
  sidecarSubtitleStreamId,
  type SubtitleSidecar,
} from "@/server/media/subtitles"
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

function normalizeWebVttResponse(value: string) {
  const normalized = value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()

  if (!normalized) {
    return "WEBVTT\n"
  }

  if (/^WEBVTT(?:[ \t].*)?(?:\n|$)/i.test(normalized)) {
    return `${normalized}\n`
  }

  return `WEBVTT\n\n${normalized}\n`
}

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

function parseSubtitleStreamId(value: string | null) {
  if (!value) {
    return null
  }

  if (value === sidecarSubtitleStreamId) {
    return value
  }

  const index = Number(value)

  return Number.isInteger(index) && index >= 0 ? String(index) : null
}

function parseOffsetSeconds(value: string | null) {
  if (!value) {
    return 0
  }

  const seconds = Number(value)

  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
}

function parseWebVttTimestamp(value: string) {
  const parts = value.trim().replace(",", ".").split(":")

  if (parts.length < 2 || parts.length > 3) {
    return null
  }

  const seconds = Number(parts.at(-1))
  const minutes = Number(parts.at(-2))
  const hours = parts.length === 3 ? Number(parts[0]) : 0

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds)
  ) {
    return null
  }

  return hours * 3600 + minutes * 60 + seconds
}

function formatWebVttTimestamp(seconds: number) {
  const clampedSeconds = Math.max(seconds, 0)
  const wholeSeconds = Math.floor(clampedSeconds)
  const milliseconds = Math.round((clampedSeconds - wholeSeconds) * 1000)
  const normalizedWholeSeconds =
    milliseconds >= 1000 ? wholeSeconds + 1 : wholeSeconds
  const normalizedMilliseconds = milliseconds >= 1000 ? 0 : milliseconds
  const hours = Math.floor(normalizedWholeSeconds / 3600)
  const minutes = Math.floor((normalizedWholeSeconds % 3600) / 60)
  const remainingSeconds = normalizedWholeSeconds % 60

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}.${String(normalizedMilliseconds).padStart(3, "0")}`
}

function shiftWebVttTimestamps(value: string, offsetSeconds: number) {
  if (!Number.isFinite(offsetSeconds) || offsetSeconds <= 0) {
    return value
  }

  const blocks = value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n{2,}/)
  const shiftedBlocks: string[] = []

  for (const block of blocks) {
    const lines = block.split("\n")
    const timingLineIndex = lines.findIndex((line) => line.includes("-->"))

    if (timingLineIndex === -1) {
      shiftedBlocks.push(block)
      continue
    }

    const timingLine = lines[timingLineIndex]
    const match = /^(\s*)(\S+)\s+-->\s+(\S+)(.*)$/.exec(timingLine)

    if (!match) {
      shiftedBlocks.push(block)
      continue
    }

    const [, indent, rawStart, rawEnd, settings] = match
    const start = parseWebVttTimestamp(rawStart)
    const end = parseWebVttTimestamp(rawEnd)

    if (start === null || end === null) {
      shiftedBlocks.push(block)
      continue
    }

    const shiftedStart = start - offsetSeconds
    const shiftedEnd = end - offsetSeconds

    if (shiftedEnd <= 0) {
      continue
    }

    lines[timingLineIndex] = `${indent}${formatWebVttTimestamp(shiftedStart)} --> ${formatWebVttTimestamp(shiftedEnd)}${settings}`
    shiftedBlocks.push(lines.join("\n"))
  }

  return shiftedBlocks.join("\n\n")
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

function hasWebVttCueTimings(value: string) {
  return /(?:^|\n)\s*\S+\s+-->\s+\S+/.test(value)
}

function runSubtitleWebVttCommand(input: {
  request: Request
  args: string[]
  failureLabel: string
}) {
  const child = spawn(getServerConfig().ffmpegPath, input.args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })

  if (!child.stdout) {
    child.kill("SIGKILL")
    return Promise.reject(new Error(`Unable to start ${input.failureLabel}.`))
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
            `${input.failureLabel} failed with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
          )
        )
        return
      }

      settled = true
      resolve(normalizeWebVttResponse(Buffer.concat(chunks).toString("utf8")))
    })
  })
}

function subtitleExtractionArgs(input: {
  file: string
  streamIndex: number
  codec?: string
}) {
  const streamMap = `0:${input.streamIndex}`
  const commonInputArgs = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-analyzeduration",
    "100M",
    "-probesize",
    "100M",
  ]
  const commonMapArgs = ["-map", streamMap]
  const webVttOutputArgs = ["-f", "webvtt", "pipe:1"]
  const encodeOutputArgs = [...commonMapArgs, "-c:s", "webvtt", ...webVttOutputArgs]

  if (isWebVttSubtitleCodec(input.codec)) {
    return [
      [
        ...commonInputArgs,
        "-copyts",
        "-i",
        input.file,
        ...commonMapArgs,
        "-c:s",
        "copy",
        ...webVttOutputArgs,
      ],
      [...commonInputArgs, "-copyts", "-i", input.file, ...encodeOutputArgs],
    ]
  }

  return [
    [
      ...commonInputArgs,
      "-fix_sub_duration",
      "-copyts",
      "-i",
      input.file,
      ...encodeOutputArgs,
    ],
  ]
}

async function extractSubtitleWebVtt(input: {
  request: Request
  file: string
  streamIndex: number
  codec?: string
}) {
  let lastError: Error | null = null

  for (const args of subtitleExtractionArgs(input)) {
    try {
      const body = await runSubtitleWebVttCommand({
        request: input.request,
        args,
        failureLabel: "subtitle extractor",
      })

      if (hasWebVttCueTimings(body)) {
        return body
      }

      lastError = new Error("Subtitle extractor returned WebVTT without cue timings.")
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(errorMessage(error))
    }
  }

  throw lastError ?? new Error("Subtitle stream could not be extracted.")
}


async function extractSidecarWebVtt(input: {
  request: Request
  sidecar: SubtitleSidecar
}) {
  if (input.sidecar.extension === ".vtt") {
    return normalizeWebVttResponse(await readWebVttSidecar(input.sidecar))
  }

  const child = spawn(
    getServerConfig().ffmpegPath,
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-fix_sub_duration",
      "-i",
      input.sidecar.filePath,
      "-map",
      "0:0",
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
    return Promise.reject(new Error("Unable to start subtitle sidecar converter."))
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
            `Subtitle sidecar converter failed with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
          )
        )
        return
      }

      settled = true
      resolve(normalizeWebVttResponse(Buffer.concat(chunks).toString("utf8")))
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
  const streamId = parseSubtitleStreamId(url.searchParams.get("stream"))
  const offsetSeconds = parseOffsetSeconds(url.searchParams.get("offset"))

  if (!episodeNumber || !seasonNumber || streamId === null) {
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

  const config = getServerConfig()
  let subtitleStream
  let sidecarSubtitle: SubtitleSidecar | null = null

  try {
    const probe = (await ffprobe(media.file)) as ProbeResult
    const hasEmbeddedSubtitles = (probe.streams ?? []).some(
      (stream) => stream.codec_type === "subtitle"
    )
    sidecarSubtitle = config.importEnabled || hasEmbeddedSubtitles
      ? null
      : await findSubtitleSidecar(media.file)
    const metadata = getMediaStreamMetadata(probe, { sidecarSubtitle })
    subtitleStream = metadata.subtitleStreams.find(
      (stream) => stream.id === streamId && stream.isSupported
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
    const body = subtitleStream.id === sidecarSubtitleStreamId
      ? sidecarSubtitle
        ? await extractSidecarWebVtt({ request, sidecar: sidecarSubtitle })
        : null
      : await extractSubtitleWebVtt({
          request,
          file: media.file,
          streamIndex: subtitleStream.index,
          codec: normalizeSubtitleCodecName(subtitleStream.codec),
        })

    if (body === null) {
      return jsonError("Subtitle sidecar could not be resolved.", 404)
    }

    return new Response(shiftWebVttTimestamps(body, offsetSeconds), {
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
