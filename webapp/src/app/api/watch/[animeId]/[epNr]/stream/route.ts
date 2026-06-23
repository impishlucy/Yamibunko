import { spawn } from "node:child_process"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import { Readable, Transform } from "node:stream"

import type { PlaybackMode, PlaybackProfile } from "@/lib/types"
import { requireApiUser } from "@/server/auth/api"
import { guardRequest } from "@/server/security/abuseGuard"
import {
  acquireStreamUpload,
  createUnmeteredStreamUploadLease,
  estimateUploadKbps,
  getActiveStreamConflict,
  getLiveTranscodeVideoBitrateKbps,
  isStreamServerShutdownActive,
  publishStreamPriorityAction,
  shouldRestartLiveTranscodeForBitrate,
  type StreamUploadLease,
} from "@/server/bandwidth/streamBandwidth"
import { getUser } from "@/server/db/users"
import { getServerConfig } from "@/server/config"
import { isLocalStreamBandwidthBypassRequest } from "@/server/http/request"
import {
  ffprobe,
  getLcAacStereoArgs,
  getLiveMp4AvcAacArgs,
  getLiveTranscodeInputArgs,
} from "@/server/media/ffmpeg"
import { validateCastStreamToken } from "@/server/media/castTokens"
import type { ProbeResult } from "@/server/media/mediaFiles"
import { getMediaStreamMetadata } from "@/server/media/streamMetadata"
import { resolveEpisodeMedia } from "@/server/media/resolveMediaId"
import { createElapsedPlaybackProgressTracker } from "@/server/media/watchProgress"
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

type DirectAudioMode = "copy" | "aac" | null
type DirectContainerMode = "source" | "mp4" | null
type VideoShape = {
  width?: number
  height?: number
  frameRate?: number
}

type TranscodeOutputLimit = {
  maxWidth?: number
  maxHeight?: number
}

const streamLogTtlMs = 30 * 60 * 1000
const maxStreamPreloadCacheSeconds = 10 * 60
const streamCacheControl = `private, max-age=${maxStreamPreloadCacheSeconds}, no-transform`
const transcodeStartupTimeoutMs = 15_000
const transcodeStartupByteThreshold = 64 * 1024
const ffmpegShutdownGraceMs = 2_000
const liveTranscodeBitrateMonitorMs = 3_000
const loggedStreamStarts = new Map<string, number>()

function streamCorsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Range, Content-Type",
    "access-control-expose-headers":
      "Accept-Ranges, Content-Disposition, Content-Duration, Content-Length, Content-Range, Content-Type, X-Content-Duration",
  }
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: streamCorsHeaders(),
  })
}

async function guardStreamRequest(request: Request) {
  return guardRequest(request, { kind: "api", count: false })
}

export async function HEAD(request: Request, context: StreamContext) {
  const abuseError = await guardStreamRequest(request)

  if (abuseError) {
    return abuseError
  }

  const { animeId, epNr } = await context.params
  const animeIdNumber = parsePositiveInt(animeId)
  const episodeNumber = parsePositiveInt(epNr)

  if (!animeIdNumber || !episodeNumber) {
    return jsonError("Episode not found.", 404)
  }

  const url = new URL(request.url)
  const seasonNumber = parsePositiveInt(url.searchParams.get("season") ?? "1")
  const mode = getMode(url.searchParams.get("mode"))
  const directAudioMode = mode === "direct" ? getDirectAudioMode(url.searchParams.get("audioMode")) : null
  const directContainerMode = mode === "direct"
    ? getDirectContainerMode(url.searchParams.get("containerMode"))
    : null
  const clientId = parseClientId(url.searchParams.get("clientId"))

  if (!clientId) {
    return jsonError("Missing stream client id.", 400)
  }

  if (!seasonNumber) {
    return jsonError("Episode not found.", 404)
  }

  if (mode === "transcode" && !liveTranscodingEnabled()) {
    return jsonError(
      "Live transcoding is disabled when TRANSCODE_ACCEL=cpu.",
      403
    )
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
      `[Error] [Stream] Unable to resolve media file for probe - stream/route.ts - Anime ${animeId}, Season ${seasonNumber}, Episode ${episodeNumber} - ${errorMessage(error)}`
    )
    return jsonError("Media file could not be resolved.", 500)
  }

  if (!resolved) {
    return jsonError("Media file not found.", 404)
  }

  const directResponseContentType =
    mode === "direct" && directAudioMode
      ? getDirectRemuxTarget({
          file: resolved.file,
          audioMode: directAudioMode,
          containerMode: directContainerMode,
          inputVideoCodec: null,
        }).contentType
      : getDirectContentType(resolved.file)
  const headers = new Headers({
    ...streamCorsHeaders(),
    "accept-ranges": mode === "direct" && !directAudioMode ? "bytes" : "none",
    "cache-control": streamCacheControl,
    "content-disposition": getInlineContentDispositionForRequest(resolved.file, mode),
    "content-type": mode === "direct" ? directResponseContentType : "video/mp4",
    "x-content-type-options": "nosniff",
  })

  setDurationHeaders(headers, resolved.durationSeconds)

  if (mode === "direct" && !directAudioMode) {
    headers.set("content-length", String(resolved.size))
  }

  return new Response(null, {
    status: 200,
    headers,
  })
}

function getMode(value: string | null): PlaybackMode {
  return value === "transcode" ? "transcode" : "direct"
}


function getProfile(): PlaybackProfile {
  return "original"
}

function getDirectAudioMode(value: string | null): DirectAudioMode {
  if (value === "copy" || value === "aac") {
    return value
  }

  return null
}

function getDirectContainerMode(value: string | null): DirectContainerMode {
  if (value === "source" || value === "mp4") {
    return value
  }

  return null
}

function liveTranscodingEnabled() {
  return true
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

async function runCooperativeSyncStep<T>(work: () => T) {
  await yieldToEventLoop()
  const result = work()
  await yieldToEventLoop()

  return result
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

function parseOutputLimitDimension(value: string | null) {
  if (!value) {
    return undefined
  }

  const dimension = Number(value)

  return Number.isInteger(dimension) && dimension >= 360 && dimension <= 8192
    ? dimension
    : undefined
}

function parseTranscodeOutputLimit(url: URL): TranscodeOutputLimit {
  return {
    maxWidth: parseOutputLimitDimension(url.searchParams.get("maxWidth")),
    maxHeight: parseOutputLimitDimension(url.searchParams.get("maxHeight")),
  }
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
  const media = await runCooperativeSyncStep(() =>
    resolveEpisodeMedia(animeId, seasonNumber, episodeNumber)
  )

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
        username: castAuth.username,
        displayUsername: `${castAuth.username} (cast)`,
        isCastStream: true,
        isVip:
          (await runCooperativeSyncStep(() => getUser(castAuth.username)))?.isVip ??
          false,
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
    displayUsername: auth.user.username,
    isCastStream: false,
    isVip: auth.user.isVip,
  }
}

function logStreamStartOnce(input: {
  username: string
  type: "direct" | "direct-remux" | "direct-audio-transcode" | "transcode"
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

function getUserFacingLiveTranscodeError() {
  return "Server Error. Yamibunko could not start live transcoding. Try again or check the server logs."
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

function getPrimaryVideoStream(probe: ProbeResult) {
  return (probe.streams ?? []).find((stream) => stream.codec_type === "video")
}

function getPrimaryVideoCodec(probe: ProbeResult) {
  return getPrimaryVideoStream(probe)?.codec_name?.trim() || null
}

function parseFrameRate(value: string | undefined) {
  if (!value || value === "0/0") {
    return undefined
  }

  const [numeratorText, denominatorText] = value.split("/")
  const numerator = Number(numeratorText)
  const denominator = Number(denominatorText ?? "1")

  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return undefined
  }

  const frameRate = numerator / denominator

  return frameRate > 0 ? frameRate : undefined
}

function getPrimaryVideoShape(probe: ProbeResult): VideoShape {
  const stream = getPrimaryVideoStream(probe)

  if (!stream) {
    return {}
  }

  return {
    width: stream.width,
    height: stream.height,
    frameRate:
      parseFrameRate(stream.avg_frame_rate) ??
      parseFrameRate(stream.r_frame_rate),
  }
}

function formatVideoShapeForLog(shape: VideoShape) {
  const width = typeof shape.width === "number" ? shape.width : null
  const height = typeof shape.height === "number" ? shape.height : null
  const frameRate = typeof shape.frameRate === "number" && Number.isFinite(shape.frameRate)
    ? `${shape.frameRate.toFixed(3)}fps`
    : "unknown fps"

  return width && height ? `${width}x${height} ${frameRate}` : `unknown size ${frameRate}`
}

function parseClientId(value: string | null) {
  if (!value) {
    return null
  }

  const trimmed = value.trim()

  return /^[a-z0-9._:-]{8,128}$/i.test(trimmed) ? trimmed : null
}

function releaseStreamUploadOnce(lease: StreamUploadLease) {
  let released = false

  return () => {
    if (released) {
      return
    }

    released = true
    lease.release()
  }
}

function createUploadThrottledReadable(input: {
  readable: Readable
  request: Request
  uploadLease: StreamUploadLease
  onBytes?: (bytes: number) => void
}) {
  const throttled = new Transform({
    transform(chunk, _encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const bytes = data.byteLength

      void input.uploadLease
        .waitForUploadBytes(bytes, input.request.signal)
        .then(() => {
          input.uploadLease.observeUploadBytes(bytes)
          input.onBytes?.(bytes)
          callback(null, data)
        })
        .catch((error) =>
          callback(error instanceof Error ? error : new Error(String(error)))
        )
    },
  })

  throttled.once("error", () => {
    input.readable.destroy()
  })
  input.readable.pipe(throttled)

  return throttled
}

const directContentTypesByExtension = new Map<string, string>([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".webm", "video/webm"],
  [".mkv", "video/x-matroska"],
  [".mov", "video/quicktime"],
  [".avi", "video/x-msvideo"],
  [".flv", "video/x-flv"],
  [".ts", "video/mp2t"],
  [".m2ts", "video/mp2t"],
  [".mts", "video/mp2t"],
  [".mpg", "video/mpeg"],
  [".mpeg", "video/mpeg"],
  [".ogm", "video/ogg"],
  [".ogv", "video/ogg"],
  [".wmv", "video/x-ms-wmv"],
  [".3gp", "video/3gpp"],
  [".3g2", "video/3gpp2"],
])

function getDirectContentType(file: string) {
  return (
    directContentTypesByExtension.get(path.extname(file).toLowerCase()) ??
    "application/octet-stream"
  )
}

function setDurationHeaders(headers: Headers, durationSeconds?: number) {
  if (!durationSeconds || durationSeconds <= 0 || !Number.isFinite(durationSeconds)) {
    return
  }

  const duration = durationSeconds.toFixed(3)
  headers.set("x-content-duration", duration)
  headers.set("content-duration", duration)
}

function getInlineContentDisposition(file: string) {
  return getInlineContentDispositionForName(fileName(file))
}

function getInlineContentDispositionForGeneratedFile(file: string, extension: string) {
  const baseName = fileName(file).replace(/\.[^.]+$/, "") || "Yamibunko"

  return getInlineContentDispositionForName(`${baseName}${extension}`)
}

function getInlineContentDispositionForRequest(file: string, mode: PlaybackMode) {
  return mode === "transcode"
    ? getInlineContentDispositionForGeneratedFile(file, ".mp4")
    : getInlineContentDisposition(file)
}

function getInlineContentDispositionForName(name: string) {
  const normalizedName = name.replace(/["\r\n]/g, "_").trim() || "Yamibunko.mp4"
  const asciiName = normalizedName.replace(/[^\x20-\x7E]/g, "_")
  const encodedName = encodeURIComponent(normalizedName)

  return `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
}


type StreamProgressTarget = {
  animeIdNumber: number
  enabled: boolean
  episodeNumber: number
  progressUsername: string
  seasonNumber: number
}

function getRangeStartSeconds(input: {
  durationSeconds?: number
  range: Exclude<ByteRange, "invalid"> | null
  size: number
}) {
  if (!input.range || !input.durationSeconds || input.size <= 0) {
    return 0
  }

  return (input.range.start / input.size) * input.durationSeconds
}

function createStreamProgressTracker(input: StreamProgressTarget & {
  durationSeconds?: number
  startSeconds: number
}) {
  return createElapsedPlaybackProgressTracker({
    username: input.progressUsername,
    animeId: input.animeIdNumber,
    seasonNumber: input.seasonNumber,
    episodeNumber: input.episodeNumber,
    durationSeconds: input.durationSeconds,
    enabled: input.enabled,
    startSeconds: input.startSeconds,
  })
}

async function handleDirect(input: StreamProgressTarget & {
  request: Request
  file: string
  size: number
  durationSeconds?: number
  uploadLease: StreamUploadLease
}) {
  const { request, file, size, uploadLease } = input
  const releaseUpload = releaseStreamUploadOnce(uploadLease)
  const range = parseByteRange(request.headers.get("range"), size)

  if (range === "invalid") {
    console.warn(
      `[Warn] [Stream] Invalid byte range requested - stream/route.ts - ${file} - ${request.headers.get("range")}`
    )
    releaseUpload()
    return new Response(null, {
      status: 416,
      headers: {
        ...streamCorsHeaders(),
        "accept-ranges": "bytes",
        "content-range": `bytes */${size}`,
      },
    })
  }

  const progressTracker = createStreamProgressTracker({
    ...input,
    startSeconds: getRangeStartSeconds({
      durationSeconds: input.durationSeconds,
      range,
      size,
    }),
  })
  let released = false

  function releaseStream() {
    if (released) {
      return
    }

    released = true
    progressTracker.stop()
    releaseUpload()
  }

  const headers = new Headers({
    ...streamCorsHeaders(),
    "accept-ranges": "bytes",
    "cache-control": streamCacheControl,
    "content-disposition": getInlineContentDispositionForRequest(file, "direct"),
    "content-type": getDirectContentType(file),
    "x-content-type-options": "nosniff",
  })
  setDurationHeaders(headers, input.durationSeconds)

  function bindFileStream(fileStream: ReturnType<typeof createReadStream>) {
    const abort = () => {
      fileStream.destroy()
      releaseStream()
    }

    uploadLease.setForceClose(abort)
    fileStream.once("close", releaseStream)
    fileStream.once("error", releaseStream)
    request.signal.addEventListener("abort", abort, { once: true })
    fileStream.once("close", () => {
      request.signal.removeEventListener("abort", abort)
    })
    return fileStream
  }

  if (range) {
    const contentLength = range.end - range.start + 1
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`)
    headers.set("content-length", String(contentLength))

    const fileStream = bindFileStream(createReadStream(file, {
      start: range.start,
      end: range.end,
    }))
    const throttledStream = createUploadThrottledReadable({
      readable: fileStream,
      request,
      uploadLease,
    })

    return new Response(
      Readable.toWeb(throttledStream) as ReadableStream<Uint8Array>,
      {
        status: 206,
        headers,
      }
    )
  }

  headers.set("content-length", String(size))
  const fileStream = bindFileStream(createReadStream(file))
  const throttledStream = createUploadThrottledReadable({
    readable: fileStream,
    request,
    uploadLease,
  })

  return new Response(
    Readable.toWeb(throttledStream) as ReadableStream<Uint8Array>,
    {
      headers,
    }
  )
}

function getDirectRemuxVideoTagArgs(inputVideoCodec?: string | null) {
  const normalizedCodec = inputVideoCodec?.trim().toLowerCase().replace(/[._-]+/g, "") ?? ""

  if (normalizedCodec === "av1" || normalizedCodec === "av01") {
    return ["-tag:v", "av01"]
  }

  if (normalizedCodec === "h264" || normalizedCodec === "avc" || normalizedCodec === "avc1") {
    return ["-tag:v", "avc1"]
  }

  if (
    normalizedCodec === "hevc" ||
    normalizedCodec === "h265" ||
    normalizedCodec === "hvc1" ||
    normalizedCodec === "hev1"
  ) {
    return ["-tag:v", "hvc1"]
  }

  return []
}

function getDirectRemuxTarget(input: {
  file: string
  audioMode: Exclude<DirectAudioMode, null>
  containerMode?: DirectContainerMode
  inputVideoCodec?: string | null
}) {
  const extension = path.extname(input.file).toLowerCase()
  const useSourceContainer =
    input.containerMode === "source" && input.audioMode !== "aac" && extension === ".webm"

  if (useSourceContainer) {
    return {
      contentType: "video/webm",
      extension: ".webm",
      args: ["-f", "webm"],
    }
  }

  return {
    contentType: "video/mp4",
    extension: ".mp4",
    args: [
      ...getDirectRemuxVideoTagArgs(input.inputVideoCodec),
      ...(input.audioMode === "copy" ? ["-strict", "-2"] : []),
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

async function handleDirectAudioRemux(input: StreamProgressTarget & {
  request: Request
  file: string
  animeId: string
  seasonNumber: number
  episodeNumber: number
  durationSeconds?: number
  username: string
  profile: PlaybackProfile
  startSeconds: number
  audioStreamIndex?: number
  audioMode: Exclude<DirectAudioMode, null>
  containerMode: DirectContainerMode
  inputVideoCodec?: string | null
  uploadLease: StreamUploadLease
}) {
  const config = getServerConfig()
  const target = getDirectRemuxTarget({
    file: input.file,
    audioMode: input.audioMode,
    containerMode: input.containerMode,
    inputVideoCodec: input.inputVideoCodec,
  })

  logStreamStartOnce({
    username: input.username,
    type: input.audioMode === "aac" ? "direct-audio-transcode" : "direct-remux",
    animeId: input.animeId,
    seasonNumber: input.seasonNumber,
    episodeNumber: input.episodeNumber,
    profile: input.profile,
    file: input.file,
  })

  const audioMapArgs = Number.isInteger(input.audioStreamIndex)
    ? ["-map", `0:${input.audioStreamIndex}`]
    : []
  const audioCodecArgs = audioMapArgs.length
    ? input.audioMode === "aac"
      ? getLcAacStereoArgs()
      : ["-c:a", "copy"]
    : []

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
      ...audioMapArgs,
      "-sn",
      "-dn",
      "-c:v",
      "copy",
      ...audioCodecArgs,
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
    input.uploadLease.release()
    console.error(
      `[Error] [Stream] Unable to start direct audio remuxer - stream/route.ts - ${input.file}`
    )
    return jsonError("Unable to start direct audio stream.", 500)
  }

  let stderr = ""
  let settled = false
  let clientClosed = false
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null
  const releaseUpload = releaseStreamUploadOnce(input.uploadLease)
  const progressTracker = createStreamProgressTracker({
    ...input,
    startSeconds: input.startSeconds,
  })
  let released = false

  function releaseStream() {
    if (released) {
      return
    }

    released = true
    progressTracker.stop()
    releaseUpload()
  }

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
    releaseStream()
  }

  input.uploadLease.setForceClose(onAbort)

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      input.request.signal.addEventListener("abort", onAbort, { once: true })

      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) {
          return
        }

        child.stdout?.pause()
        void input.uploadLease
          .waitForUploadBytes(chunk.byteLength, input.request.signal)
          .then(() => {
            if (settled) {
              return
            }

            try {
              input.uploadLease.observeUploadBytes(chunk.byteLength)
              controller.enqueue(new Uint8Array(chunk))
              child.stdout?.resume()
            } catch {
              clientClosed = true
              settled = true
              stopChild()
              releaseStream()
            }
          })
          .catch(() => {
            clientClosed = true
            settled = true
            stopChild()
            releaseStream()
          })
      })

      child.once("error", (error) => {
        console.error(
          `[Error] [Stream] Direct audio remuxer process failed - stream/route.ts - ${input.file} - ${errorMessage(error)}`
        )

        if (!settled) {
          settled = true
          controller.error(error)
        }

        releaseStream()
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

        releaseStream()
      })
    },
    cancel() {
      clientClosed = true
      settled = true
      stopChild()
      releaseStream()
    },
  })

  const headers = new Headers({
    ...streamCorsHeaders(),
    "cache-control": streamCacheControl,
    "content-disposition": getInlineContentDispositionForGeneratedFile(input.file, target.extension),
    "content-type": target.contentType,
    "x-content-type-options": "nosniff",
  })
  setDurationHeaders(headers, input.durationSeconds)

  return new Response(body, { headers })
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

function inputReleaseUpload(uploadLease?: StreamUploadLease) {
  uploadLease?.release()
}

async function handleTranscode(
  request: Request,
  file: string,
  animeId: string,
  seasonNumber: number,
  episodeNumber: number,
  username: string,
  priorityUsername: string,
  clientId: string | null,
  isVip: boolean,
  profile: PlaybackProfile,
  startSeconds: number,
  durationSeconds?: number,
  sourceBitrateKbps?: number,
  inputVideoCodec?: string | null,
  videoShape: VideoShape = {},
  outputLimit: TranscodeOutputLimit = {},
  audioStreamIndex?: number,
  uploadLease?: StreamUploadLease,
  progressTarget?: StreamProgressTarget,
  bypassUploadBandwidth = false
) {
  const streamName = fileName(file)

  console.info(
    `[Info] [Stream] Live transcode request received - stream/route.ts - User ${username} - ${streamName} - start ${startSeconds.toFixed(3)}s${bypassUploadBandwidth ? " - LAN/local bypass" : ""}`
  )

  let waitLogged = false
  const waitLogTimer = setTimeout(() => {
    waitLogged = true
    console.warn(
      `[Warn] [Stream] Waiting for live transcode slot - User ${username} - ${streamName}`
    )
  }, 2_000)
  waitLogTimer.unref?.()

  const lease = await acquireLiveTranscode(
    `${animeId}:${seasonNumber}:${episodeNumber}:${profile}`,
    request.signal,
    { isVip }
  ).catch((error) => {
    const aborted = request.signal.aborted
    console.warn(
      `[Warn] [Stream] Live transcode request ${aborted ? "aborted before slot acquired" : "cancelled"} - stream/route.ts - Anime ${animeId}, Season ${seasonNumber}, Episode ${episodeNumber} - ${errorMessage(error)}`
    )
    return null
  })
  clearTimeout(waitLogTimer)

  if (!lease) {
    inputReleaseUpload(uploadLease)
    return jsonError("Transcode request was cancelled.", 499)
  }

  if (waitLogged) {
    console.log(
      `[Info] [Stream] Live transcode slot acquired - User ${username} - ${fileName(file)}`
    )
  }

  const config = getServerConfig()
  const videoBitrateKbps = getLiveTranscodeVideoBitrateKbps({
    bypassUploadBandwidth,
    sourceBitrateKbps,
    uploadLease,
  })

  logStreamStartOnce({
    username,
    type: "transcode",
    animeId,
    seasonNumber,
    episodeNumber,
    profile,
    file,
  })

  const ffmpegArgs = [
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
    ...getLiveTranscodeInputArgs(inputVideoCodec),
    ...(startSeconds > 0 ? ["-ss", startSeconds.toFixed(3)] : []),
    "-i",
    file,
    ...getLiveMp4AvcAacArgs(profile, {
      audioStreamIndex,
      sourceBitrateKbps,
      videoBitrateKbps,
      videoWidth: videoShape.width,
      videoHeight: videoShape.height,
      videoFrameRate: videoShape.frameRate,
      maxVideoWidth: outputLimit.maxWidth,
      maxVideoHeight: outputLimit.maxHeight,
    }),
    "-map_chapters",
    "-1",
    "-max_muxing_queue_size",
    "2048",
    "-avoid_negative_ts",
    "make_zero",
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
  ]

  console.info(
    `[Info] [Stream] Live transcode encoder starting - stream/route.ts - ${streamName} - video ${videoBitrateKbps}k, audio 320k, codec ${inputVideoCodec ?? "unknown"}, ${formatVideoShapeForLog(videoShape)}${outputLimit.maxWidth || outputLimit.maxHeight ? `, output cap ${outputLimit.maxWidth ?? "?"}x${outputLimit.maxHeight ?? "?"}` : ""}`
  )

  const child = spawn(
    config.ffmpegPath,
    ffmpegArgs,
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  )

  if (!child.stdout) {
    lease.release()
    inputReleaseUpload(uploadLease)
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
  const releaseUpload = uploadLease ? releaseStreamUploadOnce(uploadLease) : null
  const progressTracker = createStreamProgressTracker({
    ...(progressTarget ?? {
      animeIdNumber: 0,
      enabled: false,
      episodeNumber,
      progressUsername: username,
      seasonNumber,
    }),
    durationSeconds,
    startSeconds,
  })
  let settled = false
  let clientClosed = false
  let startupTimer: ReturnType<typeof setTimeout> | null = null
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null
  let bitrateMonitorTimer: ReturnType<typeof setInterval> | null = null
  let lastNotifiedVideoBitrateKbps = videoBitrateKbps

  const publishLiveTranscodeFailure = (message = getUserFacingLiveTranscodeError()) => {
    publishStreamPriorityAction({
      username: priorityUsername,
      clientId,
      action: {
        type: "liveTranscodeFailed",
        message,
        createdAt: new Date().toISOString(),
      },
    })
  }

  const clearStartupTimer = () => {
    if (startupTimer) {
      clearTimeout(startupTimer)
      startupTimer = null
    }
  }

  const clearBitrateMonitorTimer = () => {
    if (bitrateMonitorTimer) {
      clearInterval(bitrateMonitorTimer)
      bitrateMonitorTimer = null
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
    clearBitrateMonitorTimer()
    request.signal.removeEventListener("abort", onAbort)
    lease.release()
    progressTracker.stop()
    releaseUpload?.()
  }

  const onAbort = () => {
    if (!settled && bytesSent < transcodeStartupByteThreshold) {
      const details = compactStderr(stderr)

      console.warn(
        `[Warn] [Stream] Live transcode request closed before startup completed - stream/route.ts - ${file}${details ? ` - ${details}` : ""}`
      )
    } else if (!settled) {
      console.info(
        `[Info] [Stream] Live transcode client closed stream - stream/route.ts - ${file} - sent ${bytesSent} byte(s)`
      )
    }

    clientClosed = true
    settled = true
    stopChild()
    release()
  }

  uploadLease?.setForceClose(onAbort)

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
        publishLiveTranscodeFailure()
        controller.error(error)
        stopChild()
        release()
      }, transcodeStartupTimeoutMs)

      if (uploadLease?.isMetered && !bypassUploadBandwidth) {
        bitrateMonitorTimer = setInterval(() => {
          if (settled) {
            clearBitrateMonitorTimer()
            return
          }

          const nextVideoBitrateKbps = getLiveTranscodeVideoBitrateKbps({
            bypassUploadBandwidth,
            sourceBitrateKbps,
            uploadLease,
          })
          const changedFromRunningBitrate = shouldRestartLiveTranscodeForBitrate({
            bypassUploadBandwidth,
            currentVideoBitrateKbps: videoBitrateKbps,
            sourceBitrateKbps,
            uploadLease,
          })
          const changedFromLastNotice =
            Math.abs(nextVideoBitrateKbps - lastNotifiedVideoBitrateKbps) >= 256

          if (!changedFromLastNotice) {
            return
          }

          lastNotifiedVideoBitrateKbps = nextVideoBitrateKbps

          const bitrateRestored = !changedFromRunningBitrate
          const message = bitrateRestored
            ? "Live transcode upload bitrate recovered. Keeping the current buffered stream."
            : "Live transcode upload bitrate changed. Playback will switch at the buffered edge."

          console.info(
            `[Info] [Stream] Live transcode upload bitrate update - stream/route.ts - ${fileName(file)} - ${videoBitrateKbps}k -> ${nextVideoBitrateKbps}k`
          )

          publishStreamPriorityAction({
            username: priorityUsername,
            clientId,
            action: {
              type: "liveTranscodeBitrateChanged",
              message,
              createdAt: new Date().toISOString(),
              currentVideoBitrateKbps: videoBitrateKbps,
              nextVideoBitrateKbps,
            },
          })
        }, liveTranscodeBitrateMonitorMs)
        bitrateMonitorTimer.unref?.()
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) {
          return
        }

        child.stdout?.pause()
        const uploadWait =
          uploadLease?.waitForUploadBytes(chunk.byteLength, request.signal) ??
          Promise.resolve()

        void uploadWait
          .then(() => {
            if (settled) {
              return
            }

            try {
              const previousBytesSent = bytesSent
              bytesSent += chunk.byteLength
              uploadLease?.observeUploadBytes(chunk.byteLength)
              if (previousBytesSent === 0) {
                console.info(
                  `[Info] [Stream] Live transcode started sending media - stream/route.ts - ${streamName} - first chunk ${chunk.byteLength} bytes`
                )
              }
              if (bytesSent >= transcodeStartupByteThreshold) {
                clearStartupTimer()
              }
              controller.enqueue(new Uint8Array(chunk))
              child.stdout?.resume()
            } catch {
              clientClosed = true
              settled = true
              stopChild()
              release()
            }
          })
          .catch(() => {
            clientClosed = true
            settled = true
            stopChild()
            release()
          })
      })

      child.once("error", (error) => {
        clearStartupTimer()
        console.error(
          `[Error] [Stream] Live transcoder process failed - stream/route.ts - ${file} - ${errorMessage(error)}`
        )

        if (!settled) {
          settled = true
          publishLiveTranscodeFailure()
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

          if (!settled) {
            settled = true
            publishLiveTranscodeFailure()
            controller.error(new Error("Live transcoder exited with an error."))
          }
        }

        if (!code && bytesSent < 1024 && !clientClosed) {
          const details = compactStderr(stderr)

          console.error(
            `[Error] [Stream] Live transcoder exited without sending media - stream/route.ts - ${file}${details ? ` - ${details}` : ""}`
          )

          if (!settled) {
            settled = true
            publishLiveTranscodeFailure()
            controller.error(new Error("Live transcoder exited without sending media."))
          }
        }

        if (!settled) {
          settled = true
          controller.close()
        }

        release()
      })
    },
    cancel() {
      if (!settled) {
        console.info(
          `[Info] [Stream] Live transcode response cancelled - stream/route.ts - ${file} - sent ${bytesSent} byte(s)`
        )
      }

      clientClosed = true
      settled = true
      stopChild()
      release()
    },
  })

  const headers = new Headers({
    ...streamCorsHeaders(),
    "cache-control": streamCacheControl,
    "content-disposition": getInlineContentDispositionForRequest(file, "transcode"),
    "content-type": "video/mp4",
  })
  setDurationHeaders(headers, durationSeconds)

  return new Response(body, { headers })
}

export async function GET(request: Request, context: StreamContext) {
  const abuseError = await guardStreamRequest(request)

  if (abuseError) {
    return abuseError
  }

  const { animeId, epNr } = await context.params
  const animeIdNumber = parsePositiveInt(animeId)
  const episodeNumber = parsePositiveInt(epNr)

  if (!animeIdNumber || !episodeNumber) {
    return jsonError("Episode not found.", 404)
  }

  const url = new URL(request.url)
  const seasonNumber = parsePositiveInt(url.searchParams.get("season") ?? "1")
  const mode = getMode(url.searchParams.get("mode"))
  const directAudioMode = mode === "direct" ? getDirectAudioMode(url.searchParams.get("audioMode")) : null
  const directContainerMode = mode === "direct"
    ? getDirectContainerMode(url.searchParams.get("containerMode"))
    : null
  const profile = getProfile()
  const startSeconds = parseStartSeconds(url.searchParams.get("start"))
  const transcodeOutputLimit = parseTranscodeOutputLimit(url)
  const clientId = parseClientId(url.searchParams.get("clientId"))
  const requestedAudioStreamIndex = parseOptionalStreamIndex(
    url.searchParams.get("audio")
  )
  const bypassUploadBandwidth = await isLocalStreamBandwidthBypassRequest(request)

  if (!clientId) {
    return jsonError("Missing stream client id.", 400)
  }

  if (!seasonNumber) {
    return jsonError("Episode not found.", 404)
  }

  if (isStreamServerShutdownActive()) {
    return jsonError("Server is shutting down. New streams are disabled.", 503)
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


  const activeStreamConflict = bypassUploadBandwidth
    ? null
    : getActiveStreamConflict({
        username: streamUser.username,
        clientId,
      })

  if (activeStreamConflict) {
    return jsonError("Only one active stream is allowed at a time.", 403)
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
  let inputVideoCodec: string | null = null
  let inputVideoShape: VideoShape = {}

  const shouldInspectStreams =
    mode === "transcode" ||
    typeof requestedAudioStreamIndex === "number" ||
    directAudioMode !== null

  if (shouldInspectStreams) {
    try {
      const probe = (await ffprobe(resolved.file)) as ProbeResult
      inputVideoCodec = getPrimaryVideoCodec(probe)
      inputVideoShape = getPrimaryVideoShape(probe)
      const metadata = getMediaStreamMetadata(probe)
      audioSelection = resolveAudioSelection({
        metadata,
        requestedAudioStreamIndex,
      })
    } catch (error) {
      console.warn(
        `[Warn] [Stream] Unable to inspect streams, using first audio stream and generic hardware decode - stream/route.ts - ${resolved.file} - ${errorMessage(error)}`
      )
    }
  }

  const sourceBitrateKbps = calculateSourceBitrateKbps(resolved)
  const selectedDirectAudioStreamIndex = audioSelection.requestedAudioStreamIndex

  const directAudioRemuxRequested =
    mode === "direct" &&
    (directAudioMode !== null ||
      (typeof selectedDirectAudioStreamIndex === "number" &&
        shouldUseDirectAudioRemux({
          requestedAudioStreamIndex: selectedDirectAudioStreamIndex,
          defaultDirectAudioStreamIndex: audioSelection.defaultDirectAudioStreamIndex,
        })))
  const requestedUploadKbps = estimateUploadKbps({
    bypassUploadBandwidth,
    sourceBitrateKbps,
    profile,
    mode,
  })
  let uploadLease: StreamUploadLease

  if (bypassUploadBandwidth) {
    uploadLease = createUnmeteredStreamUploadLease({
      clientId,
      username: streamUser.username,
      mode,
      profile,
      animeId,
      seasonNumber,
      episodeNumber,
    })
  } else {
    try {
      uploadLease = await acquireStreamUpload({
        clientId,
        username: streamUser.username,
        isVip: streamUser.isVip,
        mode,
        profile,
        estimatedUploadKbps: requestedUploadKbps,
        animeId,
        seasonNumber,
        episodeNumber,
        signal: request.signal,
      })
    } catch (error) {
      console.warn(
        `[Warn] [Stream] Waiting stream upload reservation cancelled - stream/route.ts - Anime ${animeId}, Season ${seasonNumber}, Episode ${episodeNumber} - ${errorMessage(error)}`
      )

      if (isStreamServerShutdownActive()) {
        return jsonError("Server is shutting down. New streams are disabled.", 503)
      }

      return jsonError("Stream upload reservation was cancelled.", 499)
    }
  }

  if (isStreamServerShutdownActive()) {
    uploadLease.release()
    return jsonError("Server is shutting down. New streams are disabled.", 503)
  }

  const effectiveMode = uploadLease.effectiveMode
  const effectiveProfile = uploadLease.effectiveProfile
  const streamProgressTarget = {
    animeIdNumber,
    enabled: streamUser.isCastStream,
    episodeNumber,
    progressUsername: streamUser.username,
    seasonNumber,
  }

  if (effectiveMode === "direct") {
    if (directAudioRemuxRequested) {
      return await handleDirectAudioRemux({
        ...streamProgressTarget,
        request,
        file: resolved.file,
        animeId,
        seasonNumber,
        episodeNumber,
        durationSeconds: resolved.durationSeconds,
        username: streamUser.displayUsername,
        profile: effectiveProfile,
        startSeconds,
        audioStreamIndex: selectedDirectAudioStreamIndex,
        audioMode: directAudioMode ?? "copy",
        containerMode: directContainerMode,
        inputVideoCodec,
        uploadLease,
      })
    }

    logStreamStartOnce({
      username: streamUser.displayUsername,
      type: "direct",
      animeId,
      seasonNumber,
      episodeNumber,
      profile: effectiveProfile,
      file: resolved.file,
    })

    return handleDirect({
      ...streamProgressTarget,
      request,
      file: resolved.file,
      size: resolved.size,
      durationSeconds: resolved.durationSeconds,
      uploadLease,
    })
  }

  return await handleTranscode(
    request,
    resolved.file,
    animeId,
    seasonNumber,
    episodeNumber,
    streamUser.displayUsername,
    streamUser.username,
    clientId,
    streamUser.isVip,
    effectiveProfile,
    startSeconds,
    resolved.durationSeconds,
    sourceBitrateKbps,
    inputVideoCodec,
    inputVideoShape,
    transcodeOutputLimit,
    audioSelection.requestedAudioStreamIndex,
    uploadLease,
    streamProgressTarget,
    bypassUploadBandwidth
  )
}
