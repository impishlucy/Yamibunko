import { spawn } from "node:child_process"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"

import type { PlaybackMode, PlaybackProfile } from "@/lib/types"
import { requireApiUser } from "@/server/auth/api"
import { getServerConfig } from "@/server/config"
import {
  ffprobe,
  getLiveH264Args,
  getLiveTranscodeInputArgs,
} from "@/server/media/ffmpeg"
import { validateCastStreamToken } from "@/server/media/castTokens"
import type { ProbeResult } from "@/server/media/mediaFiles"
import { getMediaStreamMetadata } from "@/server/media/streamMetadata"
import { resolveEpisodeMedia } from "@/server/media/resolveMediaId"
import { acquireLiveTranscode } from "@/server/transcode/transcodeCapacity"
import { errorMessage, fileName, parsePositiveInt } from "@/server/utils/format"

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

const streamLogTtlMs = 30 * 60 * 1000
const transcodeStartupTimeoutMs = 15_000
const transcodeStartupByteThreshold = 64 * 1024
const ffmpegShutdownGraceMs = 2_000
const loggedStreamStarts = new Map<string, number>()

function streamCorsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Range, Content-Type",
    "access-control-expose-headers":
      "Accept-Ranges, Content-Length, Content-Range, Content-Type",
  }
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: streamCorsHeaders(),
  })
}

function getMode(value: string | null): PlaybackMode {
  return value === "transcode" ? "transcode" : "direct"
}

function getProfile(value: string | null): PlaybackProfile {
  return value === "dataSaver" ? "dataSaver" : "original"
}

function liveTranscodingEnabled() {
  return getServerConfig().transcodeAccel !== "cpu"
}

function parseOptionalStreamIndex(value: string | null) {
  if (!value) {
    return undefined
  }

  const index = Number(value)

  return Number.isInteger(index) && index >= 0 ? index : undefined
}

function parseStartSeconds(value: string | null) {
  if (!value) {
    return 0
  }

  const seconds = Number(value)

  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
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

async function resolveReadableFile(
  animeId: string,
  seasonNumber: number,
  episodeNumber: number
) {
  const media = resolveEpisodeMedia(animeId, seasonNumber, episodeNumber)

  if (!media) {
    return null
  }

  const fileStat = await stat(media.file)

  if (!fileStat.isFile()) {
    return null
  }

  return {
    file: media.file,
    size: fileStat.size,
    durationSeconds: media.episode.durationSeconds,
  }
}

function jsonError(message: string, status: number) {
  return Response.json(
    { ok: false, message },
    {
      status,
      headers: streamCorsHeaders(),
    }
  )
}

async function resolveStreamUser(input: {
  request: Request
  animeId: string
  seasonNumber: number
  episodeNumber: number
  mode: PlaybackMode
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
      return {
        ok: true as const,
        username: `${castAuth.username} (cast)`,
      }
    }
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return { ok: false as const, response: auth.response }
  }

  return {
    ok: true as const,
    username: auth.user.username,
  }
}

function logStreamStartOnce(input: {
  username: string
  type: "direct" | "direct-remux" | "transcode"
  animeId: string
  seasonNumber: number
  episodeNumber: number
  profile: PlaybackProfile
  file: string
}) {
  const now = Date.now()
  const key = `${input.username}:${input.type}:${input.animeId}:${input.seasonNumber}:${input.episodeNumber}:${input.profile}`
  const lastLoggedAt = loggedStreamStarts.get(key)

  if (lastLoggedAt && now - lastLoggedAt < streamLogTtlMs) {
    return
  }

  for (const [cachedKey, loggedAt] of loggedStreamStarts) {
    if (now - loggedAt >= streamLogTtlMs) {
      loggedStreamStarts.delete(cachedKey)
    }
  }

  loggedStreamStarts.set(key, now)
  console.log(
    `[Info] [Stream] Starting ${input.type} stream for user ${input.username} - ${fileName(input.file)}`
  )
}

function appendStderr(current: string, chunk: Buffer) {
  const next = current + chunk.toString("utf8")
  return next.length > 12_000 ? next.slice(-12_000) : next
}

function compactStderr(stderr: string) {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const uniqueLines: string[] = []

  for (const line of lines) {
    if (uniqueLines.at(-1) !== line) {
      uniqueLines.push(line)
    }
  }

  return uniqueLines.slice(-8).join(" | ")
}

function calculateSourceBitrateKbps(input: {
  size: number
  durationSeconds?: number
}) {
  if (!input.durationSeconds || input.durationSeconds <= 0) {
    return undefined
  }

  return Math.max(
    Math.floor((input.size * 8) / input.durationSeconds / 1000),
    1
  )
}

function getDirectContentType(file: string) {
  const extension = path.extname(file).toLowerCase()

  if (extension === ".mp4" || extension === ".m4v") {
    return "video/mp4"
  }

  if (extension === ".webm") {
    return "video/webm"
  }

  if (extension === ".mkv") {
    return "video/x-matroska"
  }

  if (extension === ".mov") {
    return "video/quicktime"
  }

  if (extension === ".avi") {
    return "video/x-msvideo"
  }

  return "application/octet-stream"
}

async function handleDirect(request: Request, file: string, size: number) {
  const range = parseByteRange(request.headers.get("range"), size)

  if (range === "invalid") {
    console.warn(
      `[Warn] [Stream] Invalid byte range requested - stream/route.ts - ${file} - ${request.headers.get("range")}`
    )
    return new Response(null, {
      status: 416,
      headers: {
        ...streamCorsHeaders(),
        "accept-ranges": "bytes",
        "content-range": `bytes */${size}`,
      },
    })
  }

  const headers = new Headers({
    ...streamCorsHeaders(),
    "accept-ranges": "bytes",
    "content-type": getDirectContentType(file),
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


function getDirectRemuxTarget(file: string) {
  const extension = path.extname(file).toLowerCase()

  if (extension === ".webm") {
    return {
      contentType: "video/webm",
      args: ["-f", "webm"],
    }
  }

  return {
    contentType: "video/mp4",
    args: [
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset",
      "-frag_duration",
      "1000000",
      "-f",
      "mp4",
    ],
  }
}

function shouldUseDirectAudioRemux(input: {
  requestedAudioStreamIndex?: number
  defaultDirectAudioStreamIndex?: number
}) {
  return (
    typeof input.requestedAudioStreamIndex === "number" &&
    typeof input.defaultDirectAudioStreamIndex === "number" &&
    input.requestedAudioStreamIndex !== input.defaultDirectAudioStreamIndex
  )
}

async function handleDirectAudioRemux(input: {
  request: Request
  file: string
  animeId: string
  seasonNumber: number
  episodeNumber: number
  username: string
  profile: PlaybackProfile
  startSeconds: number
  audioStreamIndex: number
}) {
  const config = getServerConfig()
  const target = getDirectRemuxTarget(input.file)

  logStreamStartOnce({
    username: input.username,
    type: "direct-remux",
    animeId: input.animeId,
    seasonNumber: input.seasonNumber,
    episodeNumber: input.episodeNumber,
    profile: input.profile,
    file: input.file,
  })

  const child = spawn(
    config.ffmpegPath,
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-fflags",
      "+genpts",
      "-ignore_unknown",
      ...(input.startSeconds > 0 ? ["-ss", input.startSeconds.toFixed(3)] : []),
      "-i",
      input.file,
      "-map",
      "0:V:0",
      "-map",
      `0:${input.audioStreamIndex}`,
      "-sn",
      "-dn",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-map_chapters",
      "-1",
      "-avoid_negative_ts",
      "make_zero",
      "-max_muxing_queue_size",
      "2048",
      ...target.args,
      "pipe:1",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  )

  if (!child.stdout) {
    child.kill("SIGKILL")
    console.error(
      `[Error] [Stream] Unable to start direct audio remuxer - stream/route.ts - ${input.file}`
    )
    return jsonError("Unable to start direct audio stream.", 500)
  }

  let stderr = ""
  let settled = false
  let clientClosed = false
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = appendStderr(stderr, chunk)
  })

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

  const onAbort = () => {
    clientClosed = true
    settled = true
    stopChild()
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      input.request.signal.addEventListener("abort", onAbort, { once: true })

      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) {
          return
        }

        try {
          controller.enqueue(new Uint8Array(chunk))
        } catch {
          clientClosed = true
          settled = true
          stopChild()
        }
      })

      child.once("error", (error) => {
        console.error(
          `[Error] [Stream] Direct audio remuxer process failed - stream/route.ts - ${input.file} - ${errorMessage(error)}`
        )

        if (!settled) {
          settled = true
          controller.error(error)
        }
      })

      child.once("close", (code, signal) => {
        input.request.signal.removeEventListener("abort", onAbort)

        if (shutdownTimer) {
          clearTimeout(shutdownTimer)
          shutdownTimer = null
        }

        if (code && code !== 0 && !clientClosed) {
          const details = compactStderr(stderr)

          console.error(
            `[Error] [Stream] Direct audio remuxer exited with an error - stream/route.ts - ${input.file} - code ${code}${signal ? `, signal ${signal}` : ""}${details ? ` - ${details}` : ""}`
          )
        }

        if (!settled) {
          settled = true
          controller.close()
        }
      })
    },
    cancel() {
      clientClosed = true
      settled = true
      stopChild()
    },
  })

  return new Response(body, {
    headers: {
      ...streamCorsHeaders(),
      "cache-control": "no-store",
      "content-type": target.contentType,
    },
  })
}

function resolveAudioSelection(input: {
  metadata: ReturnType<typeof getMediaStreamMetadata>
  requestedAudioStreamIndex?: number
}) {
  const audioStreams = input.metadata.audioStreams
  const requestedAudioStream = audioStreams.find(
    (stream) => stream.index === input.requestedAudioStreamIndex
  )
  const fallbackAudioStream = audioStreams.find(
    (stream) => stream.id === input.metadata.defaultAudioStreamId
  )
  const directAudioStream = audioStreams.find(
    (stream) => stream.id === input.metadata.directAudioStreamId
  )

  return {
    requestedAudioStreamIndex:
      requestedAudioStream?.index ?? fallbackAudioStream?.index ?? undefined,
    defaultDirectAudioStreamIndex: directAudioStream?.index,
  }
}

async function handleTranscode(
  request: Request,
  file: string,
  animeId: string,
  seasonNumber: number,
  episodeNumber: number,
  username: string,
  profile: PlaybackProfile,
  startSeconds: number,
  sourceBitrateKbps?: number,
  audioStreamIndex?: number
) {
  let waitLogged = false
  const waitLogTimer = setTimeout(() => {
    waitLogged = true
    console.warn(
      `[Warn] [Stream] Waiting for live transcode hardware slot - User ${username} - ${fileName(file)}`
    )
  }, 2_000)
  waitLogTimer.unref?.()

  const lease = await acquireLiveTranscode(
    `${animeId}:${seasonNumber}:${episodeNumber}:${profile}`,
    profile,
    request.signal
  ).catch((error) => {
    console.warn(
      `[Warn] [Stream] Live transcode request cancelled - stream/route.ts - Anime ${animeId}, Season ${seasonNumber}, Episode ${episodeNumber} - ${errorMessage(error)}`
    )
    return null
  })
  clearTimeout(waitLogTimer)

  if (!lease) {
    return jsonError("Transcode request was cancelled.", 499)
  }

  if (waitLogged) {
    console.log(
      `[Info] [Stream] Live transcode hardware slot acquired - User ${username} - ${fileName(file)}`
    )
  }

  const config = getServerConfig()
  logStreamStartOnce({
    username,
    type: "transcode",
    animeId,
    seasonNumber,
    episodeNumber,
    profile,
    file,
  })

  const child = spawn(
    config.ffmpegPath,
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-probesize",
      "16M",
      "-analyzeduration",
      "5M",
      "-fflags",
      "+genpts",
      "-ignore_unknown",
      ...getLiveTranscodeInputArgs(),
      ...(startSeconds > 0 ? ["-ss", startSeconds.toFixed(3)] : []),
      "-i",
      file,
      ...getLiveH264Args(profile, {
        audioStreamIndex,
        sourceBitrateKbps,
      }),
      "-map_chapters",
      "-1",
      "-max_muxing_queue_size",
      "2048",
      "-avoid_negative_ts",
      "make_zero",
      "-tag:v",
      "avc1",
      "-flush_packets",
      "1",
      "-muxdelay",
      "0",
      "-muxpreload",
      "0",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset",
      "-frag_duration",
      "1000000",
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
    console.error(
      `[Error] [Stream] Unable to start live transcoder - stream/route.ts - ${file}`
    )
    return jsonError("Unable to start transcoder.", 500)
  }

  let stderr = ""
  let bytesSent = 0
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = appendStderr(stderr, chunk)
  })

  let released = false
  let settled = false
  let clientClosed = false
  let startupTimer: ReturnType<typeof setTimeout> | null = null
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null

  const clearStartupTimer = () => {
    if (startupTimer) {
      clearTimeout(startupTimer)
      startupTimer = null
    }
  }

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

  const release = () => {
    if (released) {
      return
    }

    released = true
    clearStartupTimer()
    request.signal.removeEventListener("abort", onAbort)
    lease.release()
  }

  const onAbort = () => {
    clientClosed = true
    settled = true
    stopChild()
    release()
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      request.signal.addEventListener("abort", onAbort, { once: true })
      startupTimer = setTimeout(() => {
        if (
          settled ||
          bytesSent >= transcodeStartupByteThreshold ||
          clientClosed
        ) {
          return
        }

        const details = compactStderr(stderr)
        const error = new Error("Live transcoder produced insufficient media.")

        settled = true
        console.error(
          `[Error] [Stream] Live transcoder produced insufficient media - stream/route.ts - ${file}${details ? ` - ${details}` : ""}`
        )
        controller.error(error)
        stopChild()
        release()
      }, transcodeStartupTimeoutMs)

      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) {
          return
        }

        try {
          bytesSent += chunk.byteLength
          if (bytesSent >= transcodeStartupByteThreshold) {
            clearStartupTimer()
          }
          controller.enqueue(new Uint8Array(chunk))
        } catch {
          clientClosed = true
          settled = true
          stopChild()
          release()
        }
      })

      child.once("error", (error) => {
        clearStartupTimer()
        console.error(
          `[Error] [Stream] Live transcoder process failed - stream/route.ts - ${file} - ${errorMessage(error)}`
        )

        if (!settled) {
          settled = true
          controller.error(error)
        }

        release()
      })

      child.once("close", (code, signal) => {
        clearStartupTimer()
        if (shutdownTimer) {
          clearTimeout(shutdownTimer)
          shutdownTimer = null
        }

        if (code && code !== 0 && !clientClosed) {
          const details = compactStderr(stderr)

          console.error(
            `[Error] [Stream] Live transcoder exited with an error - stream/route.ts - ${file} - code ${code}${signal ? `, signal ${signal}` : ""}${details ? ` - ${details}` : ""}`
          )
        }

        if (!code && bytesSent < 1024 && !clientClosed) {
          const details = compactStderr(stderr)

          console.error(
            `[Error] [Stream] Live transcoder exited without sending media - stream/route.ts - ${file}${details ? ` - ${details}` : ""}`
          )
        }

        if (!settled) {
          settled = true
          controller.close()
        }

        release()
      })
    },
    cancel() {
      clientClosed = true
      settled = true
      stopChild()
      release()
    },
  })

  return new Response(body, {
    headers: {
      ...streamCorsHeaders(),
      "cache-control": "no-store",
      "content-type": "video/mp4",
    },
  })
}

export async function GET(request: Request, context: StreamContext) {
  const { animeId, epNr } = await context.params
  const episodeNumber = parsePositiveInt(epNr)

  if (!episodeNumber) {
    return jsonError("Episode not found.", 404)
  }

  const url = new URL(request.url)
  const seasonNumber = parsePositiveInt(url.searchParams.get("season") ?? "1")
  const mode = getMode(url.searchParams.get("mode"))
  const profile = getProfile(url.searchParams.get("profile"))
  const startSeconds = parseStartSeconds(url.searchParams.get("start"))
  const requestedAudioStreamIndex = parseOptionalStreamIndex(
    url.searchParams.get("audio")
  )

  if (!seasonNumber) {
    return jsonError("Episode not found.", 404)
  }

  const streamUser = await resolveStreamUser({
    request,
    animeId,
    seasonNumber,
    episodeNumber,
    mode,
    castToken: url.searchParams.get("castToken"),
  })

  if (!streamUser.ok) {
    return streamUser.response
  }

  let resolved: Awaited<ReturnType<typeof resolveReadableFile>>

  try {
    resolved = await resolveReadableFile(animeId, seasonNumber, episodeNumber)
  } catch (error) {
    console.error(
      `[Error] [Stream] Unable to resolve media file - stream/route.ts - Anime ${animeId}, Season ${seasonNumber}, Episode ${episodeNumber} - ${errorMessage(error)}`
    )
    return jsonError("Media file could not be resolved.", 500)
  }

  if (!resolved) {
    return jsonError("Media file not found.", 404)
  }

  if (mode === "transcode" && !liveTranscodingEnabled()) {
    return jsonError(
      "Live transcoding is disabled when TRANSCODE_ACCEL=cpu.",
      403
    )
  }

  let audioSelection: ReturnType<typeof resolveAudioSelection> = {
    requestedAudioStreamIndex,
    defaultDirectAudioStreamIndex: undefined,
  }

  try {
    const metadata = getMediaStreamMetadata(
      (await ffprobe(resolved.file)) as ProbeResult
    )
    audioSelection = resolveAudioSelection({
      metadata,
      requestedAudioStreamIndex,
    })
  } catch (error) {
    console.warn(
      `[Warn] [Stream] Unable to inspect audio streams, using first audio stream - stream/route.ts - ${resolved.file} - ${errorMessage(error)}`
    )
  }

  if (mode === "direct") {
    const selectedDirectAudioStreamIndex = audioSelection.requestedAudioStreamIndex

    if (
      shouldUseDirectAudioRemux({
        requestedAudioStreamIndex: selectedDirectAudioStreamIndex,
        defaultDirectAudioStreamIndex: audioSelection.defaultDirectAudioStreamIndex,
      }) &&
      typeof selectedDirectAudioStreamIndex === "number"
    ) {
      return await handleDirectAudioRemux({
        request,
        file: resolved.file,
        animeId,
        seasonNumber,
        episodeNumber,
        username: streamUser.username,
        profile,
        startSeconds,
        audioStreamIndex: selectedDirectAudioStreamIndex,
      })
    }

    logStreamStartOnce({
      username: streamUser.username,
      type: "direct",
      animeId,
      seasonNumber,
      episodeNumber,
      profile,
      file: resolved.file,
    })

    return handleDirect(request, resolved.file, resolved.size)
  }

  return await handleTranscode(
    request,
    resolved.file,
    animeId,
    seasonNumber,
    episodeNumber,
    streamUser.username,
    profile,
    startSeconds,
    calculateSourceBitrateKbps(resolved),
    audioSelection.requestedAudioStreamIndex
  )
}
