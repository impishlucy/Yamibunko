import type { MediaStreamInfo, WatchPayload } from "@/lib/types"

export type DirectAudioMode = "copy" | "aac"
export type DirectContainerMode = "source" | "mp4"

type LocalDirectStreamMode =
  | "plain"
  | "source-remux"
  | "mp4-remux"
  | "audio-transcode"

type AndroidTvAppCodecSupport = {
  supported?: boolean
  decoderName?: string | null
  reason?: string | null
}

export type LiveTranscodeOutputLimit = {
  maxWidth: number
  maxHeight: number
}

type YamibunkoAndroidTvBridge = {
  supportsVideoConfig?: (codec: string, width: string, height: string) => string
}

declare global {
  interface Window {
    YamibunkoAndroidTv?: YamibunkoAndroidTvBridge
  }
}

const h264CodecChecks = [
  "avc1.640034",
  "avc1.64002A",
  "avc1.640028",
  "avc1.64001F",
  "avc1.4D402A",
  "avc1.4D4028",
  "avc1.4D401F",
  "avc1.42E01E",
  "avc1",
]

const hevcCodecChecks = [
  "hvc1.2.4.L153.B0",
  "hev1.2.4.L153.B0",
  "hvc1.1.6.L123.B0",
  "hev1.1.6.L123.B0",
  "hvc1.1.6.L93.B0",
  "hev1.1.6.L93.B0",
  "hevc",
  "hvc1",
  "hev1",
]

const containerByExtension = new Map<string, string>([
  ["mp4", "mp4"],
  ["m4v", "mp4"],
  ["mov", "mov"],
  ["qt", "mov"],
  ["3gp", "3gpp"],
  ["3g2", "3gpp2"],
  ["mkv", "matroska"],
  ["mka", "matroska"],
  ["webm", "webm"],
  ["avi", "avi"],
  ["ts", "mpegts"],
  ["m2ts", "mpegts"],
  ["mts", "mpegts"],
  ["mpg", "mpeg"],
  ["mpeg", "mpeg"],
  ["mpe", "mpeg"],
  ["ogg", "ogg"],
  ["ogm", "ogg"],
  ["ogv", "ogg"],
  ["flv", "flv"],
  ["asf", "asf"],
  ["wmv", "asf"],
])

const directMimeTypesByContainer: Record<string, string[]> = {
  mp4: ["video/mp4"],
  mov: ["video/quicktime", "video/mp4"],
  "3gpp": ["video/3gpp"],
  "3gpp2": ["video/3gpp2"],
  webm: ["video/webm"],
  matroska: ["video/x-matroska"],
  avi: ["video/x-msvideo"],
  mpegts: ["video/mp2t", "video/MP2T"],
  mpeg: ["video/mpeg"],
  ogg: ["video/ogg", "application/ogg"],
  flv: ["video/x-flv"],
  asf: ["video/x-ms-asf", "video/x-ms-wmv"],
}

const directAudioMimeTypesByContainer: Record<string, string[]> = {
  mp4: ["audio/mp4"],
  mov: ["audio/mp4", "audio/quicktime"],
  "3gpp": ["audio/3gpp"],
  "3gpp2": ["audio/3gpp2"],
  webm: ["audio/webm"],
  matroska: ["audio/x-matroska"],
  mpeg: ["audio/mpeg"],
  ogg: ["audio/ogg", "application/ogg"],
  asf: ["audio/x-ms-wma", "audio/x-ms-asf"],
}

const fallbackDirectMimeTypes = [
  "video/mp4",
  "video/webm",
  "video/x-matroska",
  "video/ogg",
  "video/mp2t",
  "video/mpeg",
]

const fallbackDirectAudioMimeTypes = [
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
]

function canPlayAny(mediaElement: HTMLMediaElement | null, checks: string[]) {
  if (!mediaElement || !checks.length) {
    return false
  }

  return checks.some((codec) => {
    const result = mediaElement.canPlayType(codec)
    return result === "probably" || result === "maybe"
  })
}

export function normalizeCodecName(codec: string | undefined) {
  return codec?.trim().toLowerCase().replace(/[._\s-]+/g, "") ?? ""
}

function isAv1VideoCodec(codec: string | undefined) {
  const normalized = normalizeCodecName(codec)

  return normalized.startsWith("av1") || normalized.startsWith("av01")
}

function isHevcVideoCodec(codec: string | undefined) {
  const normalized = normalizeCodecName(codec)

  return (
    normalized.startsWith("hevc") ||
    normalized.startsWith("h265") ||
    normalized.startsWith("hvc1") ||
    normalized.startsWith("hev1")
  )
}

function normalizeContainerName(container: string | undefined) {
  return container?.trim().toLowerCase().replace(/[._\s-]+/g, "") ?? ""
}

export function getMediaContainer(fileName: string, container: string | undefined) {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? ""
  const extensionContainer = containerByExtension.get(extension)

  if (extensionContainer) {
    return extensionContainer
  }

  const normalizedContainer = normalizeContainerName(container)

  if (
    normalizedContainer.includes("mp4") ||
    normalizedContainer.includes("mov") ||
    normalizedContainer.includes("m4v") ||
    normalizedContainer.includes("quicktime")
  ) {
    return "mp4"
  }

  if (normalizedContainer.includes("3gp") || normalizedContainer.includes("3gpp")) {
    return "3gpp"
  }

  if (normalizedContainer.includes("matroska") || normalizedContainer.includes("mkv")) {
    return "matroska"
  }

  if (normalizedContainer.includes("webm")) {
    return "webm"
  }

  if (normalizedContainer.includes("avi")) {
    return "avi"
  }

  if (normalizedContainer.includes("mpegts") || normalizedContainer === "mpegts") {
    return "mpegts"
  }

  if (normalizedContainer.includes("mpeg") || normalizedContainer.includes("mpg")) {
    return "mpeg"
  }

  if (normalizedContainer.includes("ogg") || normalizedContainer.includes("ogv")) {
    return "ogg"
  }

  if (normalizedContainer.includes("flv")) {
    return "flv"
  }

  if (normalizedContainer.includes("asf") || normalizedContainer.includes("wmv")) {
    return "asf"
  }

  return "unknown"
}

function getDirectMimeTypes(container: string) {
  return directMimeTypesByContainer[container] ?? fallbackDirectMimeTypes
}

function getDirectAudioMimeTypes(container: string) {
  return directAudioMimeTypesByContainer[container] ?? fallbackDirectAudioMimeTypes
}

function getPlaybackProbeVideo(video?: HTMLVideoElement | null) {
  if (video) {
    return video
  }

  if (typeof document === "undefined") {
    return null
  }

  return document.createElement("video")
}

function getPlaybackProbeAudio() {
  if (typeof document === "undefined") {
    return null
  }

  return document.createElement("audio")
}

function getVideoCodecChecks(codec: string | undefined) {
  switch (normalizeCodecName(codec)) {
    case "h264":
    case "avc":
    case "avc1":
      return h264CodecChecks
    case "hevc":
    case "h265":
    case "hvc1":
    case "hev1":
      return hevcCodecChecks
    case "vp9":
    case "vp09":
      return [
        "vp09.00.10.08",
        "vp09.00.10.10",
        "vp09.02.10.10",
        "vp09",
        "vp9",
      ]
    case "vp8":
      return ["vp8"]
    case "av1":
    case "av01":
      return [
        "av01.0.05M.08",
        "av01.0.05M.10",
        "av01.0.08M.08",
        "av01.0.08M.10",
        "av01.0.12M.10",
        "av01",
      ]
    case "mpeg4":
    case "mp4v":
    case "xvid":
    case "divx":
      return ["mp4v.20.8", "mp4v.20.240", "mp4v"]
    case "mpeg2video":
    case "mpeg2":
      return ["mp4v.61", "mpeg2", "mp2v"]
    case "mpeg1video":
    case "mpeg1":
      return ["mpeg1", "mpgv"]
    case "theora":
      return ["theora"]
    case "wmv3":
    case "wmv2":
    case "wmv1":
    case "vc1":
      return ["wmv3", "wmv2", "wmv1", "vc-1"]
    default:
      return []
  }
}

function getAacCodecChecks(profile: string | undefined) {
  const normalizedProfile = profile?.trim().toLowerCase() ?? ""

  if (normalizedProfile.includes("he-aacv2") || normalizedProfile.includes("he-aac v2")) {
    return ["mp4a.40.29"]
  }

  if (normalizedProfile.includes("he-aac") || normalizedProfile === "he") {
    return ["mp4a.40.5"]
  }

  return ["mp4a.40.2"]
}

function getAudioCodecChecks(audioStream: MediaStreamInfo | undefined) {
  if (!audioStream) {
    return []
  }

  switch (normalizeCodecName(audioStream.codec)) {
    case "aac":
    case "mp4a":
      return getAacCodecChecks(audioStream.profile)
    case "mp3":
      return ["mp4a.40.34", "mp4a.69", "mp4a.6B", "mp3"]
    case "mp2":
      return ["mp4a.69", "mp2"]
    case "mp1":
      return ["mp4a.6B", "mp1"]
    case "opus":
      return ["opus", "Opus"]
    case "vorbis":
      return ["vorbis"]
    case "flac":
      return ["flac", "fLaC"]
    case "alac":
      return ["alac"]
    case "ac3":
      return ["ac-3"]
    case "eac3":
      return ["ec-3"]
    case "pcm":
    case "pcms16le":
    case "pcms16be":
    case "pcms24le":
    case "pcms24be":
    case "pcms32le":
    case "pcms32be":
    case "pcmf32le":
    case "pcmf32be":
      return ["lpcm"]
    default:
      return []
  }
}

function buildPlaybackChecks(input: {
  media: WatchPayload["media"]
  mimeTypes: string[]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  const videoCodecChecks = getVideoCodecChecks(input.media.videoCodec)
  const hasAudio = input.media.audioStreams.length > 0
  const audioCodecChecks = hasAudio ? getAudioCodecChecks(input.selectedAudioStream) : []
  const checks: string[] = []

  if (!videoCodecChecks.length || (hasAudio && !audioCodecChecks.length)) {
    return []
  }

  for (const mimeType of input.mimeTypes) {
    for (const videoCodecCheck of videoCodecChecks) {
      if (!hasAudio) {
        checks.push(`${mimeType}; codecs="${videoCodecCheck}"`)
        continue
      }

      for (const audioCodecCheck of audioCodecChecks) {
        checks.push(`${mimeType}; codecs="${videoCodecCheck}, ${audioCodecCheck}"`)
      }
    }
  }

  return checks
}

function buildVideoPlaybackChecks(input: {
  media: WatchPayload["media"]
  mimeTypes: string[]
}) {
  const videoCodecChecks = getVideoCodecChecks(input.media.videoCodec)
  const checks: string[] = []

  if (!videoCodecChecks.length) {
    return []
  }

  for (const mimeType of input.mimeTypes) {
    for (const videoCodecCheck of videoCodecChecks) {
      checks.push(`${mimeType}; codecs="${videoCodecCheck}"`)
    }
  }

  return checks
}

function buildAudioPlaybackChecks(input: {
  mimeTypes: string[]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  const audioCodecChecks = getAudioCodecChecks(input.selectedAudioStream)
  const checks: string[] = []

  if (!audioCodecChecks.length) {
    return []
  }

  for (const mimeType of input.mimeTypes) {
    for (const audioCodecCheck of audioCodecChecks) {
      checks.push(`${mimeType}; codecs="${audioCodecCheck}"`)
    }
  }

  return checks
}

function buildDirectPlaybackChecks(input: {
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  const container = getMediaContainer(input.fileName, input.media.container)

  return buildPlaybackChecks({
    media: input.media,
    mimeTypes: getDirectMimeTypes(container),
    selectedAudioStream: input.selectedAudioStream,
  })
}

function buildDirectVideoPlaybackChecks(input: {
  fileName: string
  media: WatchPayload["media"]
}) {
  const container = getMediaContainer(input.fileName, input.media.container)

  return buildVideoPlaybackChecks({
    media: input.media,
    mimeTypes: getDirectMimeTypes(container),
  })
}

function buildDirectAudioPlaybackChecks(input: {
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  const container = getMediaContainer(input.fileName, input.media.container)

  return buildAudioPlaybackChecks({
    mimeTypes: getDirectAudioMimeTypes(container),
    selectedAudioStream: input.selectedAudioStream,
  })
}

function buildDirectMp4PlaybackChecks(input: {
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  return buildPlaybackChecks({
    media: input.media,
    mimeTypes: ["video/mp4"],
    selectedAudioStream: input.selectedAudioStream,
  })
}

function buildDirectMp4VideoPlaybackChecks(input: {
  media: WatchPayload["media"]
}) {
  return buildVideoPlaybackChecks({
    media: input.media,
    mimeTypes: ["video/mp4"],
  })
}

function buildDirectMp4AudioPlaybackChecks(input: {
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  return buildAudioPlaybackChecks({
    mimeTypes: ["audio/mp4"],
    selectedAudioStream: input.selectedAudioStream,
  })
}

function canPlayContainer(video: HTMLVideoElement | null, mimeTypes: string[]) {
  return canPlayAny(video, mimeTypes)
}

function shouldBlockDirectVideoCodec(media: WatchPayload["media"]) {
  const appSupport = getAndroidTvAppHardwarePlaybackSupport(media)

  if (appSupport === null) {
    return false
  }

  return !appSupport
}

function supportsDirectPlayback(input: {
  video?: HTMLVideoElement | null
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  if (shouldBlockDirectVideoCodec(input.media)) {
    return false
  }

  const video = getPlaybackProbeVideo(input.video)

  return canPlayAny(video, buildDirectPlaybackChecks(input))
}

function supportsDirectVideoTrack(input: {
  video?: HTMLVideoElement | null
  fileName: string
  media: WatchPayload["media"]
}) {
  if (shouldBlockDirectVideoCodec(input.media)) {
    return false
  }

  const video = getPlaybackProbeVideo(input.video)

  return canPlayAny(video, buildDirectVideoPlaybackChecks(input))
}

function supportsDirectAudioTrack(input: {
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  if (!input.media.audioStreams.length) {
    return true
  }

  return canPlayAny(getPlaybackProbeAudio(), buildDirectAudioPlaybackChecks(input))
}

function supportsDirectCompatibleMp4Playback(input: {
  video?: HTMLVideoElement | null
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  if (shouldBlockDirectVideoCodec(input.media)) {
    return false
  }

  const video = getPlaybackProbeVideo(input.video)

  return canPlayAny(video, buildDirectMp4PlaybackChecks(input))
}

function supportsDirectCompatibleMp4VideoTrack(input: {
  video?: HTMLVideoElement | null
  media: WatchPayload["media"]
}) {
  if (shouldBlockDirectVideoCodec(input.media)) {
    return false
  }

  const video = getPlaybackProbeVideo(input.video)

  return canPlayAny(video, buildDirectMp4VideoPlaybackChecks(input))
}

function supportsDirectCompatibleMp4AudioTrack(input: {
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  if (!input.media.audioStreams.length) {
    return true
  }

  return canPlayAny(getPlaybackProbeAudio(), buildDirectMp4AudioPlaybackChecks(input))
}

function getLocalPlaybackSupport(input: {
  video?: HTMLVideoElement | null
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  const video = getPlaybackProbeVideo(input.video)
  const sourceContainer = getMediaContainer(input.fileName, input.media.container)
  const sourceMimeTypes = getDirectMimeTypes(sourceContainer)

  return {
    source: {
      container: canPlayContainer(video, sourceMimeTypes),
      video: supportsDirectVideoTrack({
        video,
        fileName: input.fileName,
        media: input.media,
      }),
      audio: supportsDirectAudioTrack({
        fileName: input.fileName,
        media: input.media,
        selectedAudioStream: input.selectedAudioStream,
      }),
      playback: supportsDirectPlayback({
        video,
        fileName: input.fileName,
        media: input.media,
        selectedAudioStream: input.selectedAudioStream,
      }),
    },
    mp4: {
      container: canPlayContainer(video, ["video/mp4"]),
      video: supportsDirectCompatibleMp4VideoTrack({
        video,
        media: input.media,
      }),
      audio: supportsDirectCompatibleMp4AudioTrack({
        media: input.media,
        selectedAudioStream: input.selectedAudioStream,
      }),
      playback: supportsDirectCompatibleMp4Playback({
        video,
        media: input.media,
        selectedAudioStream: input.selectedAudioStream,
      }),
    },
  }
}

function canTryOptimisticMp4AudioCopy(input: {
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  if (!input.media.audioStreams.length) {
    return true
  }

  switch (normalizeCodecName(input.selectedAudioStream?.codec)) {
    case "aac":
    case "mp4a":
    case "mp3":
    case "ac3":
    case "eac3":
    case "alac":
    case "opus":
      return true
    default:
      return false
  }
}

function shouldPreferMp4Remux(input: {
  sourceContainer: string
  mp4ContainerSupported: boolean
  mp4VideoSupported: boolean
  canCopyAudioToMp4: boolean
}) {
  if (
    !input.mp4ContainerSupported ||
    !input.mp4VideoSupported ||
    !input.canCopyAudioToMp4
  ) {
    return false
  }

  switch (input.sourceContainer) {
    case "mp4":
    case "mov":
    case "3gpp":
    case "3gpp2":
      return false
    case "webm":
    case "matroska":
    case "avi":
    case "mpegts":
    case "mpeg":
    case "ogg":
    case "flv":
    case "asf":
    case "unknown":
      return true
    default:
      return false
  }
}

export function getLocalDirectStreamMode(input: {
  video?: HTMLVideoElement | null
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
  directAudioRemuxActive: boolean
}): LocalDirectStreamMode | null {
  const support = getLocalPlaybackSupport(input)
  const sourceContainer = getMediaContainer(input.fileName, input.media.container)
  const canCopyAudioToMp4 = canTryOptimisticMp4AudioCopy({
    media: input.media,
    selectedAudioStream: input.selectedAudioStream,
  })
  const canUseMp4AudioCopy =
    support.mp4.playback ||
    (support.mp4.container && support.mp4.video && canCopyAudioToMp4)
  const prefersMp4Remux = shouldPreferMp4Remux({
    sourceContainer,
    mp4ContainerSupported: support.mp4.container,
    mp4VideoSupported: support.mp4.video,
    canCopyAudioToMp4,
  })

  if (prefersMp4Remux) {
    return "mp4-remux"
  }

  if (support.source.playback) {
    return input.directAudioRemuxActive ? "source-remux" : "plain"
  }

  if (canUseMp4AudioCopy) {
    return "mp4-remux"
  }

  if (support.mp4.container && support.mp4.video) {
    return "audio-transcode"
  }

  return null
}

export function getLocalDirectAudioMode(mode: LocalDirectStreamMode | null): DirectAudioMode | null {
  if (mode === "audio-transcode") {
    return "aac"
  }

  if (mode === "source-remux" || mode === "mp4-remux") {
    return "copy"
  }

  return null
}

export function getLocalDirectContainerMode(
  mode: LocalDirectStreamMode | null
): DirectContainerMode | null {
  if (mode === "source-remux") {
    return "source"
  }

  if (mode === "mp4-remux" || mode === "audio-transcode") {
    return "mp4"
  }

  return null
}

export function supportsLocalDirectPlayback(input: {
  video?: HTMLVideoElement | null
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
  directAudioRemuxActive: boolean
}) {
  return getLocalDirectStreamMode(input) !== null
}

export function isAndroidBrowser() {
  if (typeof navigator === "undefined") {
    return false
  }

  return /\bAndroid\b/i.test(navigator.userAgent)
}

function isYamibunkoTvWebViewBrowser() {
  if (typeof navigator === "undefined") {
    return false
  }

  return /YamibunkoTV-WebView|YamibunkoTV/i.test(navigator.userAgent)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizeBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function readAndroidTvAppCodecAnswer(rawSupport: string | undefined): AndroidTvAppCodecSupport | null {
  if (!rawSupport) {
    return null
  }

  try {
    const parsed = JSON.parse(rawSupport) as unknown
    if (!isRecord(parsed)) {
      return null
    }

    return {
      supported: normalizeBoolean(parsed.supported),
      decoderName: normalizeOptionalString(parsed.decoderName),
      reason: normalizeOptionalString(parsed.reason),
    }
  } catch {
    return null
  }
}

function askAndroidTvAppForCodecSupport(input: {
  codec: string | undefined
  width: number | undefined
  height: number | undefined
}) {
  if (typeof window === "undefined") {
    return null
  }

  const width = Math.trunc(input.width ?? 0)
  const height = Math.trunc(input.height ?? 0)
  if (width <= 0 || height <= 0) {
    return null
  }

  return readAndroidTvAppCodecAnswer(
    window.YamibunkoAndroidTv?.supportsVideoConfig?.(
      input.codec ?? "",
      String(width),
      String(height)
    )
  )
}

function getAndroidTvAppHardwarePlaybackSupport(media: WatchPayload["media"]): boolean | null {
  if (!isYamibunkoTvWebViewBrowser()) {
    return null
  }

  if (!isAv1VideoCodec(media.videoCodec) && !isHevcVideoCodec(media.videoCodec)) {
    return null
  }

  const support = askAndroidTvAppForCodecSupport({
    codec: media.videoCodec,
    width: media.videoWidth,
    height: media.videoHeight,
  })

  return support?.supported === true
}

function hasUsableVideoDimensions(media: WatchPayload["media"]) {
  return (
    typeof media.videoWidth === "number" &&
    Number.isFinite(media.videoWidth) &&
    media.videoWidth > 0 &&
    typeof media.videoHeight === "number" &&
    Number.isFinite(media.videoHeight) &&
    media.videoHeight > 0
  )
}

function fitsInside(media: WatchPayload["media"], limit: LiveTranscodeOutputLimit) {
  const videoWidth = media.videoWidth
  const videoHeight = media.videoHeight

  if (
    typeof videoWidth !== "number" ||
    !Number.isFinite(videoWidth) ||
    videoWidth <= 0 ||
    typeof videoHeight !== "number" ||
    !Number.isFinite(videoHeight) ||
    videoHeight <= 0
  ) {
    return false
  }

  return videoWidth <= limit.maxWidth && videoHeight <= limit.maxHeight
}

function canAndroidTvAppDecodeH264(media: WatchPayload["media"], limit?: LiveTranscodeOutputLimit) {
  const support = askAndroidTvAppForCodecSupport({
    codec: "h264",
    width: limit?.maxWidth ?? media.videoWidth,
    height: limit?.maxHeight ?? media.videoHeight,
  })

  return support?.supported === true
}

export function getLocalLiveTranscodeOutputLimit(media: WatchPayload["media"]): LiveTranscodeOutputLimit | null {
  if (!isYamibunkoTvWebViewBrowser() || !hasUsableVideoDimensions(media)) {
    return null
  }

  if (canAndroidTvAppDecodeH264(media)) {
    return null
  }

  const fallbackLimits: LiveTranscodeOutputLimit[] = [
    { maxWidth: 1920, maxHeight: 1080 },
    { maxWidth: 1280, maxHeight: 720 },
  ]

  for (const limit of fallbackLimits) {
    if (fitsInside(media, limit)) {
      return null
    }

    if (canAndroidTvAppDecodeH264(media, limit)) {
      return limit
    }
  }

  return fallbackLimits[fallbackLimits.length - 1]
}

export function isIosBrowser() {
  if (typeof navigator === "undefined") {
    return false
  }

  return (
    /iP(?:hone|ad|od)/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  )
}

export function isIphoneBrowser() {
  if (typeof navigator === "undefined") {
    return false
  }

  return /iPhone|iPod/i.test(navigator.userAgent)
}
