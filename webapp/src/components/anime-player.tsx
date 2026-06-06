"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Cast,
  Info,
  Loader2,
  Maximize2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Settings,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { HoverHint } from "@/components/ui/hover-hint"
import { getPreferredPlayerAspectRatio } from "@/lib/player-aspect-ratio"
import {
  addGoogleCastMediaStateListener,
  addGoogleCastSessionStateListener,
  assertGoogleCastReceiverUrlReachable,
  createGoogleCastLoadRequest,
  ensureGoogleCastFramework,
  getGoogleCastMediaState,
  getGoogleCastContext,
  getGoogleCastSession,
  getGoogleCastCurrentPageSenderUnavailableReason,
  getGoogleCastReceiverUrlUnavailableReason,
  googleCastMediaUrlMessage,
  googleCastUnreachableUrlErrorCode,
  isGoogleCastConnectedState,
  isGoogleCastEndingState,
  pauseGoogleCastMedia,
  playGoogleCastMedia,
  requestGoogleCastSession,
  safeEndGoogleCastSession,
  seekGoogleCastMedia,
  setGoogleCastReceiverVolumeOnce,
  waitForGoogleCastMediaLoad,
  type GoogleCastMediaState,
  type GoogleCastSessionHandle,
} from "@/lib/google-cast"
import type {
  Episode,
  MediaStreamInfo,
  PlaybackProfile,
  WatchPayload,
} from "@/lib/types"

type AnimePlayerProps = {
  animeId: string
  seasonNumber: number
  episodeNumber: number
  playback: WatchPayload["playback"]
  media: WatchPayload["media"]
  fileName: string
  previousEpisode?: Episode
  nextEpisode?: Episode
  durationSeconds?: number
  thumbnailUrl?: string
  autoPlay?: boolean
  clientStreamId?: string
  onEpisodeChange?: (episode: Episode, autoPlay: boolean) => void
}

type PlaybackStatusState = "checking" | "direct" | "transcoding" | "blocked"

type SwitchSourceOptions = {
  preservePosition?: boolean
  waitForMedia?: boolean
  transcodeStartTime?: number
  forceReload?: boolean
}

type SeekPreviewFrame = {
  time: number
  leftPercent: number
}

type StreamPriorityAction = {
  type:
    | "forceDataSaver"
    | "restoreOriginal"
    | "waitingForBandwidth"
    | "bandwidthRecheckStarted"
    | "bandwidthRecheckFinished"
    | "serverShutdownStarted"
  message: string
  createdAt: string
}

type LocalPlaybackSnapshot = {
  sourceUrl: string | null
  status: PlaybackStatusState
  quality: PlaybackProfile
  directPossible: boolean
  position: number
  wasMuted: boolean
}

type BandwidthRecheckSnapshot = {
  wasCasting: boolean
  wasPlaying: boolean
  position: number
  sourceUrl: string | null
  status: PlaybackStatusState
}

type PriorityInfo = {
  type:
    | "forceDataSaver"
    | "restoreOriginal"
    | "waitingForBandwidth"
    | "protectedDataSaver"
    | "bandwidthRecheckStarted"
    | "bandwidthRecheckFinished"
    | "serverShutdownStarted"
  message: string
  createdAt: string
}

type CastTextTrack = {
  id: number
  language?: string
  label: string
  url: string
}

type BrowserAudioTrack = {
  enabled: boolean
  id?: string
  kind?: string
  label?: string
  language?: string
}

type BrowserAudioTrackList = {
  length: number
  [index: number]: BrowserAudioTrack
}

type HtmlVideoElementWithAudioTracks = HTMLVideoElement & {
  audioTracks?: BrowserAudioTrackList
}

type HtmlVideoElementWithNativePlayback = HTMLVideoElement & {
  disableRemotePlayback?: boolean
  remote?: {
    state?: "connecting" | "connected" | "disconnected"
    prompt?: () => Promise<void>
    watchAvailability?: (callback: (available: boolean) => void) => Promise<number>
    cancelWatchAvailability?: (watchId: number) => Promise<void>
    addEventListener?: (type: string, listener: EventListener) => void
    removeEventListener?: (type: string, listener: EventListener) => void
  }
  webkitCurrentPlaybackTargetIsWireless?: boolean
  webkitEnterFullscreen?: () => void
  webkitPresentationMode?: string
  webkitShowPlaybackTargetPicker?: () => void
  webkitSupportsPresentationMode?: (mode: string) => boolean
  webkitSetPresentationMode?: (mode: string) => void
}

type WebKitPlaybackTargetAvailabilityEvent = Event & {
  availability?: "available" | "not-available"
}

type SubtitleCue = {
  start: number
  end: number
  text: string
}

const hevcMp4Checks = [
  'video/mp4; codecs="hvc1.1.6.L93.B0"',
  'video/mp4; codecs="hev1.1.6.L93.B0"',
  'video/mp4; codecs="hvc1"',
  'video/mp4; codecs="hev1"',
]

function createClientStreamId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

function canPlayAny(video: HTMLVideoElement, checks: string[]) {
  return checks.some((codec) => {
    const result = video.canPlayType(codec)
    return result === "probably" || result === "maybe"
  })
}

function supportsHevcDecode(video: HTMLVideoElement) {
  return canPlayAny(video, hevcMp4Checks)
}

function normalizeCodecName(codec: string | undefined) {
  return codec?.trim().toLowerCase().replace(/[._-]+/g, "") ?? ""
}

function getMediaContainer(fileName: string, container: string | undefined) {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? ""
  const normalizedContainer = container?.trim().toLowerCase() ?? ""

  if (extension === "mp4" || extension === "m4v") {
    return "mp4"
  }

  if (extension === "mov") {
    return "mov"
  }

  if (extension === "mkv") {
    return "matroska"
  }

  if (extension === "webm") {
    return "webm"
  }

  if (extension === "avi") {
    return "avi"
  }

  if (normalizedContainer.includes("mp4") || normalizedContainer.includes("mov")) {
    return "mp4"
  }

  if (normalizedContainer.includes("matroska")) {
    return "matroska"
  }

  if (normalizedContainer.includes("webm")) {
    return "webm"
  }

  if (normalizedContainer.includes("avi")) {
    return "avi"
  }

  return "unknown"
}

function getDirectMimeTypes(container: string) {
  if (container === "mp4") {
    return ["video/mp4"]
  }

  if (container === "mov") {
    return ["video/quicktime", "video/mp4"]
  }

  if (container === "webm") {
    return ["video/webm"]
  }

  if (container === "matroska") {
    return ["video/x-matroska"]
  }

  if (container === "avi") {
    return ["video/x-msvideo"]
  }

  return ["video/mp4", "video/webm", "video/x-matroska"]
}

function getVideoCodecChecks(codec: string | undefined, mimeType: string) {
  const normalizedCodec = normalizeCodecName(codec)

  if (!normalizedCodec) {
    return []
  }

  if (normalizedCodec === "h264" || normalizedCodec === "avc1") {
    return ["avc1.640028", "avc1.4D401F", "avc1.42E01E", "avc1"]
  }

  if (
    normalizedCodec === "hevc" ||
    normalizedCodec === "h265" ||
    normalizedCodec === "hvc1" ||
    normalizedCodec === "hev1"
  ) {
    return mimeType === "video/x-matroska"
      ? ["hvc1", "hev1", "hevc"]
      : ["hvc1.1.6.L93.B0", "hev1.1.6.L93.B0", "hvc1", "hev1"]
  }

  if (normalizedCodec === "vp9" || normalizedCodec === "vp09") {
    return ["vp09.00.10.08", "vp9"]
  }

  if (normalizedCodec === "vp8") {
    return ["vp8"]
  }

  if (normalizedCodec === "av1" || normalizedCodec === "av01") {
    return ["av01.0.05M.08", "av01"]
  }

  return []
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
  const normalizedCodec = normalizeCodecName(audioStream?.codec)

  if (!audioStream || !normalizedCodec) {
    return []
  }

  if (normalizedCodec === "aac") {
    return getAacCodecChecks(audioStream.profile)
  }

  if (normalizedCodec === "mp3" || normalizedCodec === "mp2" || normalizedCodec === "mp1") {
    return ["mp4a.40.34", "mp4a.69", "mp4a.6B", "mp3"]
  }

  if (normalizedCodec === "opus") {
    return ["opus"]
  }

  if (normalizedCodec === "vorbis") {
    return ["vorbis"]
  }

  if (normalizedCodec === "flac") {
    return ["flac"]
  }

  if (normalizedCodec === "ac3") {
    return ["ac-3"]
  }

  if (normalizedCodec === "eac3") {
    return ["ec-3"]
  }

  return []
}

function buildDirectPlaybackChecks(input: {
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  const container = getMediaContainer(input.fileName, input.media.container)
  const mimeTypes = getDirectMimeTypes(container)
  const hasAudio = input.media.audioStreams.length > 0
  const videoCodec = input.media.videoCodec
  const audioCodecChecks = getAudioCodecChecks(input.selectedAudioStream)
  const checks: string[] = []

  if (hasAudio && !audioCodecChecks.length) {
    return []
  }

  for (const mimeType of mimeTypes) {
    const videoCodecChecks = getVideoCodecChecks(videoCodec, mimeType)

    if (!videoCodecChecks.length) {
      checks.push(mimeType)
      continue
    }

    for (const videoCodecCheck of videoCodecChecks) {
      if (audioCodecChecks.length) {
        for (const audioCodecCheck of audioCodecChecks) {
          checks.push(`${mimeType}; codecs="${videoCodecCheck}, ${audioCodecCheck}"`)
        }
      } else {
        checks.push(`${mimeType}; codecs="${videoCodecCheck}"`)
      }
    }
  }

  return checks
}

function buildDirectVideoPlaybackChecks(input: {
  fileName: string
  media: WatchPayload["media"]
}) {
  const container = getMediaContainer(input.fileName, input.media.container)
  const mimeTypes = getDirectMimeTypes(container)
  const checks: string[] = []

  for (const mimeType of mimeTypes) {
    const videoCodecChecks = getVideoCodecChecks(input.media.videoCodec, mimeType)

    if (!videoCodecChecks.length) {
      checks.push(mimeType)
      continue
    }

    for (const videoCodecCheck of videoCodecChecks) {
      checks.push(`${mimeType}; codecs="${videoCodecCheck}"`)
    }
  }

  return checks
}

function getDirectAudioMimeTypes(container: string) {
  if (container === "webm") {
    return ["audio/webm", "video/webm"]
  }

  if (container === "matroska") {
    return ["video/x-matroska"]
  }

  return ["audio/mp4", "video/mp4"]
}

function buildDirectAudioPlaybackChecks(input: {
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  if (!input.media.audioStreams.length) {
    return []
  }

  const container = getMediaContainer(input.fileName, input.media.container)
  const audioCodecChecks = getAudioCodecChecks(input.selectedAudioStream)

  if (!audioCodecChecks.length) {
    return []
  }

  const mimeTypes = getDirectAudioMimeTypes(container)
  const checks: string[] = []

  for (const audioCodecCheck of audioCodecChecks) {
    if (audioCodecCheck === "mp3") {
      checks.push('audio/mpeg')
    }

    for (const mimeType of mimeTypes) {
      checks.push(`${mimeType}; codecs="${audioCodecCheck}"`)
    }
  }

  return checks
}

function isOptimisticDirectVideoCandidate(input: {
  fileName: string
  media: WatchPayload["media"]
}) {
  const container = getMediaContainer(input.fileName, input.media.container)
  const videoCodec = normalizeCodecName(input.media.videoCodec)

  if (container !== "mp4" && container !== "mov") {
    return false
  }

  return (
    videoCodec === "h264" ||
    videoCodec === "avc1" ||
    videoCodec === "hevc" ||
    videoCodec === "h265" ||
    videoCodec === "hvc1" ||
    videoCodec === "hev1"
  )
}

function supportsDirectVideoTrack(input: {
  video: HTMLVideoElement
  fileName: string
  media: WatchPayload["media"]
}) {
  const videoCodec = normalizeCodecName(input.media.videoCodec)
  const isHevcVideo =
    videoCodec === "hevc" ||
    videoCodec === "h265" ||
    videoCodec === "hvc1" ||
    videoCodec === "hev1"

  if (isHevcVideo && supportsHevcDecode(input.video)) {
    return true
  }

  const checks = buildDirectVideoPlaybackChecks(input)

  if (checks.length > 0 && canPlayAny(input.video, checks)) {
    return true
  }

  return isOptimisticDirectVideoCandidate(input)
}

function isOptimisticDirectAudioCandidate(input: {
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  if (!input.media.audioStreams.length) {
    return true
  }

  const container = getMediaContainer(input.fileName, input.media.container)
  const audioCodec = normalizeCodecName(input.selectedAudioStream?.codec)

  if (!audioCodec) {
    return false
  }

  if (container === "mp4" || container === "mov") {
    return (
      audioCodec === "aac" ||
      audioCodec === "mp3" ||
      audioCodec === "mp2" ||
      audioCodec === "mp1" ||
      audioCodec === "ac3" ||
      audioCodec === "eac3"
    )
  }

  if (container === "webm") {
    return audioCodec === "opus" || audioCodec === "vorbis"
  }

  return false
}

function supportsDirectAudioTrack(input: {
  video: HTMLVideoElement
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  if (!input.media.audioStreams.length) {
    return true
  }

  if (!input.selectedAudioStream) {
    return false
  }

  const checks = buildDirectAudioPlaybackChecks(input)

  if (checks.length > 0 && canPlayAny(input.video, checks)) {
    return true
  }

  return isOptimisticDirectAudioCandidate(input)
}

function supportsDirectPlayback(input: {
  video: HTMLVideoElement
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  const checks = buildDirectPlaybackChecks(input)

  if (checks.length && canPlayAny(input.video, checks)) {
    return true
  }

  return (
    supportsDirectVideoTrack(input) &&
    supportsDirectAudioTrack(input)
  )
}

function isAndroidBrowser() {
  if (typeof navigator === "undefined") {
    return false
  }

  return /\bAndroid\b/i.test(navigator.userAgent)
}

function isIosBrowser() {
  if (typeof navigator === "undefined") {
    return false
  }

  return (
    /iP(?:hone|ad|od)/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  )
}

function hasNativeRemotePlaybackPicker(video: HTMLVideoElement | null) {
  if (!video) {
    return false
  }

  const nativeVideo = video as HtmlVideoElementWithNativePlayback

  return typeof nativeVideo.webkitShowPlaybackTargetPicker === "function"
}

function hasNativeRemotePlaybackPrompt(video: HTMLVideoElement | null) {
  if (!video) {
    return false
  }

  const nativeVideo = video as HtmlVideoElementWithNativePlayback

  return typeof nativeVideo.remote?.prompt === "function"
}

function canUseNativeRemotePlayback(video: HTMLVideoElement | null) {
  if (!video) {
    return false
  }

  return hasNativeRemotePlaybackPrompt(video) || hasNativeRemotePlaybackPicker(video)
}

function canUseNativeRemotePlaybackFallback(
  video: HTMLVideoElement | null,
  targetAvailable: boolean
) {
  return isIosBrowser() && targetAvailable && canUseNativeRemotePlayback(video)
}

function getGoogleCastUnavailableMessage(input: {
  castPreflightError: string | null
  senderPreflightError: string | null
}) {
  if (input.castPreflightError) {
    return input.castPreflightError
  }

  if (input.senderPreflightError) {
    return input.senderPreflightError
  }

  if (isAndroidBrowser()) {
    return "Google Cast did not become available in Android Chrome. Make sure Chrome is up to date, the phone is on the same network as the Cast receiver, and Google Play Services is available."
  }

  return "Casting is not available in this browser."
}

function requestNativeRemotePlayback(video: HTMLVideoElement) {
  const nativeVideo = video as HtmlVideoElementWithNativePlayback

  if (typeof nativeVideo.webkitShowPlaybackTargetPicker === "function") {
    nativeVideo.webkitShowPlaybackTargetPicker()
    return true
  }

  if (typeof nativeVideo.remote?.prompt === "function") {
    void nativeVideo.remote.prompt().catch(() => undefined)
    return true
  }

  return false
}

function isNativeRemotePlaybackConnected(video: HTMLVideoElement | null) {
  if (!video) {
    return false
  }

  const nativeVideo = video as HtmlVideoElementWithNativePlayback

  return (
    nativeVideo.webkitCurrentPlaybackTargetIsWireless === true ||
    nativeVideo.remote?.state === "connected" ||
    nativeVideo.remote?.state === "connecting"
  )
}

function requestNativeVideoFullscreen(video: HTMLVideoElement | null) {
  if (!video) {
    return false
  }

  const nativeVideo = video as HtmlVideoElementWithNativePlayback

  if (
    typeof nativeVideo.webkitSupportsPresentationMode === "function" &&
    typeof nativeVideo.webkitSetPresentationMode === "function" &&
    nativeVideo.webkitSupportsPresentationMode("fullscreen")
  ) {
    nativeVideo.webkitSetPresentationMode("fullscreen")
    return true
  }

  if (typeof nativeVideo.webkitEnterFullscreen === "function") {
    nativeVideo.webkitEnterFullscreen()
    return true
  }

  return false
}

function supportsCastDirectPlayback(input: {
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  const container = getMediaContainer(input.fileName, input.media.container)
  const videoCodec = normalizeCodecName(input.media.videoCodec)
  const audioCodec = normalizeCodecName(input.selectedAudioStream?.codec)

  if (container !== "mp4") {
    return false
  }

  if (
    videoCodec !== "h264" &&
    videoCodec !== "avc1" &&
    videoCodec !== "hevc" &&
    videoCodec !== "h265" &&
    videoCodec !== "hvc1" &&
    videoCodec !== "hev1"
  ) {
    return false
  }

  if (!input.media.audioStreams.length) {
    return true
  }

  return audioCodec === "aac" || audioCodec === "mp3"
}

function isPlayerControlTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest("button,input,a,select,textarea,label"))
  )
}

function getCastDirectContentType(fileName: string, usesAudioRemux = false) {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? ""

  if (usesAudioRemux) {
    return extension === "webm" ? "video/webm" : "video/mp4"
  }

  if (extension === "mp4" || extension === "m4v") {
    return "video/mp4"
  }

  if (extension === "webm") {
    return "video/webm"
  }

  if (extension === "mkv") {
    return "video/x-matroska"
  }

  return "application/octet-stream"
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "00:00"
  }

  const totalSeconds = Math.floor(seconds)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const remainingSeconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
  }

  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
}

function isUsableDuration(seconds: number | undefined | null): seconds is number {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
}

function getStableDuration(
  fileDurationSeconds: number | undefined,
  measuredDurationSeconds?: number,
  fallbackDurationSeconds?: number
) {
  if (isUsableDuration(fileDurationSeconds)) {
    return fileDurationSeconds
  }

  if (isUsableDuration(measuredDurationSeconds)) {
    return measuredDurationSeconds
  }

  if (isUsableDuration(fallbackDurationSeconds)) {
    return fallbackDurationSeconds
  }

  return 0
}

function clampTime(seconds: number, durationSeconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? seconds : 0
  const minClamped = Math.max(safeSeconds, 0)

  if (durationSeconds > 0) {
    return Math.min(minClamped, durationSeconds)
  }

  return minClamped
}

function serializeUrl(originalUrl: string, url: URL) {
  return /^https?:\/\//i.test(originalUrl)
    ? url.toString()
    : `${url.pathname}${url.search}${url.hash}`
}

function getUrlBase() {
  return typeof window === "undefined"
    ? "http://localhost"
    : window.location.href
}

function withStreamParams(
  sourceUrl: string,
  input: {
    audioStreamId?: string | null
    startTime?: number | null
    clientId?: string | null
  }
) {
  const url = new URL(sourceUrl, getUrlBase())

  if (input.audioStreamId) {
    url.searchParams.set("audio", input.audioStreamId)
  } else {
    url.searchParams.delete("audio")
  }

  if (input.clientId) {
    url.searchParams.set("clientId", input.clientId)
  }

  const startTime = input.startTime

  if (
    typeof startTime === "number" &&
    Number.isFinite(startTime) &&
    startTime > 0.25
  ) {
    url.searchParams.set("start", startTime.toFixed(3))
  } else {
    url.searchParams.delete("start")
  }

  return serializeUrl(sourceUrl, url)
}

function withSubtitleStream(
  sourceUrl: string,
  streamId: string,
  options: { offsetSeconds?: number | null } = {}
) {
  const url = new URL(sourceUrl, getUrlBase())
  url.searchParams.set("stream", streamId)

  const offsetSeconds = options.offsetSeconds

  if (
    typeof offsetSeconds === "number" &&
    Number.isFinite(offsetSeconds) &&
    offsetSeconds > 0.25
  ) {
    url.searchParams.set("offset", offsetSeconds.toFixed(3))
  } else {
    url.searchParams.delete("offset")
  }

  return serializeUrl(sourceUrl, url)
}


function estimateStreamMbps(input: {
  quality: PlaybackProfile
  sourceBitrateMbps?: number
  status: PlaybackStatusState
}) {
  const source = input.sourceBitrateMbps
  const overheadFactor = 1.06

  if (!source || source <= 0) {
    return undefined
  }

  if (input.status === "direct") {
    return Number((source * overheadFactor).toFixed(2))
  }

  if (input.quality === "dataSaver") {
    return Number((Math.max(source / 2, 0.628) * overheadFactor).toFixed(2))
  }

  return Number(((Math.min(Math.max(source, 1.5), 50) + 0.192) * overheadFactor).toFixed(2))
}

function getBufferedEnd(video: HTMLVideoElement) {
  const { buffered } = video

  if (!buffered.length) {
    return 0
  }

  let end = 0

  for (let index = 0; index < buffered.length; index += 1) {
    end = Math.max(end, buffered.end(index))
  }

  return end
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

function stripSubtitleFormatting(value: string) {
  return value
    .replace(/\{\\[^}]*}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .trim()
}

function parseWebVtt(input: string) {
  const cues: SubtitleCue[] = []
  const blocks = input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n{2,}/)

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)

    if (!lines.length) {
      continue
    }

    const firstLine = lines[0].toUpperCase()

    if (
      firstLine.startsWith("WEBVTT") ||
      firstLine.startsWith("NOTE") ||
      firstLine.startsWith("STYLE") ||
      firstLine.startsWith("REGION")
    ) {
      continue
    }

    const timingLineIndex = lines.findIndex((line) => line.includes("-->"))

    if (timingLineIndex === -1) {
      continue
    }

    const timingLine = lines[timingLineIndex]
    const [rawStart, rawEndWithSettings] = timingLine.split(/\s+-->\s+/)
    const rawEnd = rawEndWithSettings?.split(/\s+/)[0]
    const start = rawStart ? parseWebVttTimestamp(rawStart) : null
    const end = rawEnd ? parseWebVttTimestamp(rawEnd) : null

    if (start === null || end === null || end <= start) {
      continue
    }

    const text = lines
      .slice(timingLineIndex + 1)
      .map(stripSubtitleFormatting)
      .filter(Boolean)
      .join("\n")

    if (text) {
      cues.push({ start, end, text })
    }
  }

  return cues.sort((a, b) => a.start - b.start)
}

function getActiveSubtitleTexts(cues: SubtitleCue[], seconds: number) {
  if (!Number.isFinite(seconds) || !cues.length) {
    return []
  }

  let low = 0
  let high = cues.length - 1
  let firstPossibleIndex = cues.length

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)

    if (cues[mid].end >= seconds) {
      firstPossibleIndex = mid
      high = mid - 1
    } else {
      low = mid + 1
    }
  }

  if (firstPossibleIndex === cues.length) {
    return []
  }

  const texts: string[] = []

  for (let index = firstPossibleIndex; index < cues.length; index += 1) {
    const cue = cues[index]

    if (cue.start > seconds) {
      break
    }

    if (seconds >= cue.start && seconds <= cue.end) {
      texts.push(cue.text)
    }
  }

  return texts
}

function subtitleTextKey(texts: string[]) {
  return texts.join("\u001f")
}

function normalizeTrackLanguage(value: string | undefined) {
  const language = value?.trim().toLowerCase()

  if (!language) {
    return undefined
  }

  if (language === "eng" || language.startsWith("en")) {
    return "en"
  }

  if (language === "jpn" || language.startsWith("ja")) {
    return "ja"
  }

  return language.slice(0, 2)
}

function applyDirectAudioTrack(
  video: HTMLVideoElement,
  selectedAudioStream: MediaStreamInfo | undefined,
  audioStreams: MediaStreamInfo[]
) {
  const tracks = (video as HtmlVideoElementWithAudioTracks).audioTracks

  if (!tracks?.length || !selectedAudioStream) {
    return false
  }

  const selectedOrdinal = audioStreams.findIndex(
    (stream) => stream.id === selectedAudioStream.id
  )
  const selectedLanguage = normalizeTrackLanguage(selectedAudioStream.language)
  let selectedTrackIndex = -1

  if (selectedLanguage) {
    for (let index = 0; index < tracks.length; index += 1) {
      if (normalizeTrackLanguage(tracks[index]?.language) === selectedLanguage) {
        selectedTrackIndex = index
        break
      }
    }
  }

  if (selectedTrackIndex === -1 && selectedOrdinal >= 0 && selectedOrdinal < tracks.length) {
    selectedTrackIndex = selectedOrdinal
  }

  if (selectedTrackIndex === -1) {
    return false
  }

  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]

    if (track) {
      track.enabled = index === selectedTrackIndex
    }
  }

  return true
}


function subtitleLanguageLabel(languageCode: string | undefined) {
  if (!languageCode) {
    return "Default"
  }

  const names: Record<string, string> = {
    en: "English",
    ja: "Japanese",
    de: "German",
    fr: "French",
    es: "Spanish",
    it: "Italian",
    ko: "Korean",
    zh: "Chinese",
    pt: "Portuguese",
    ru: "Russian",
  }

  return names[languageCode] ?? languageCode.toUpperCase()
}

function subtitlePreferenceScore(stream: WatchPayload["media"]["subtitleStreams"][number]) {
  const text = `${stream.label} ${stream.codec ?? ""}`
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")

  let score = 0

  if (stream.isDefault) {
    score += 6
  }

  if (stream.isForced) {
    score -= 35
  }

  if (/\bfull\b/.test(text) || /full subs?/.test(text)) {
    score += 80
  }

  if (/without\s+honou?rifics?/.test(text) || /no\s+honou?rifics?/.test(text)) {
    score += 70
  } else if (/with\s+honou?rifics?/.test(text)) {
    score -= 25
  }

  if (/signs?/.test(text) || /songs?/.test(text) || /karaoke/.test(text)) {
    score -= 75
  }

  if (/dialogue/.test(text)) {
    score += 15
  }

  return score
}

function chooseBestSubtitleStream(
  streams: WatchPayload["media"]["subtitleStreams"],
  language?: string
) {
  const candidates = streams.filter((stream) =>
    language ? stream.language === language : !stream.language
  )

  return candidates
    .slice()
    .sort((left, right) => {
      const scoreDiff = subtitlePreferenceScore(right) - subtitlePreferenceScore(left)

      if (scoreDiff !== 0) {
        return scoreDiff
      }

      return left.index - right.index
    })[0]
}

function getSubtitleLanguageOptions(
  streams: WatchPayload["media"]["subtitleStreams"]
) {
  const groupedStreams = new Map<string, WatchPayload["media"]["subtitleStreams"]>()

  for (const stream of streams) {
    const key = stream.language ?? "default"
    const existing = groupedStreams.get(key) ?? []
    existing.push(stream)
    groupedStreams.set(key, existing)
  }

  return Array.from(groupedStreams.entries())
    .map(([languageKey, languageStreams]) => {
      const language = languageKey === "default" ? undefined : languageKey
      const stream = chooseBestSubtitleStream(languageStreams, language) ?? languageStreams[0]

      return {
        id: stream.id,
        label: subtitleLanguageLabel(language),
        language,
        stream,
      }
    })
    .sort((left, right) => {
      if (left.language === "en") {
        return -1
      }

      if (right.language === "en") {
        return 1
      }

      if (!left.language) {
        return 1
      }

      if (!right.language) {
        return -1
      }

      return left.label.localeCompare(right.label)
    })
}

function selectSubtitleForAudio(
  audioStream: MediaStreamInfo | undefined,
  subtitleStreams: WatchPayload["media"]["subtitleStreams"]
) {
  if (audioStream?.language === "en") {
    return null
  }

  const supportedSubtitles = subtitleStreams.filter((stream) => stream.isSupported)

  if (!supportedSubtitles.length) {
    return null
  }

  return (
    chooseBestSubtitleStream(supportedSubtitles, "en") ??
    chooseBestSubtitleStream(supportedSubtitles) ??
    supportedSubtitles
      .slice()
      .sort((left, right) => {
        const scoreDiff = subtitlePreferenceScore(right) - subtitlePreferenceScore(left)

        if (scoreDiff !== 0) {
          return scoreDiff
        }

        return left.index - right.index
      })[0]
  )
}

function shouldUseDirectAudioRemux(
  audioStreamId: string | null,
  directAudioStreamId: string | null
) {
  return Boolean(
    audioStreamId && directAudioStreamId && audioStreamId !== directAudioStreamId
  )
}

function statusLabel(status: PlaybackStatusState) {
  if (status === "direct") {
    return "Direct"
  }

  if (status === "transcoding") {
    return "Transcode"
  }

  if (status === "blocked") {
    return "Blocked"
  }

  return "Checking"
}


function formatClientError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function reportCastError(error: unknown) {
  const formattedError = formatClientError(error)

  void fetch("/api/cast/log", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      error: formattedError,
    }),
  }).catch(() => undefined)
}

function formatCastErrorMessage(error: unknown) {
  if (error instanceof Error) {
    if (error.message === googleCastUnreachableUrlErrorCode) {
      return googleCastMediaUrlMessage
    }

    return error.message
  }

  if (typeof error === "string") {
    return error
  }

  return "Google Cast failed to start."
}

function RadioOffIcon({ className }: { className?: string }) {
  return (
    <span className={`relative inline-grid place-items-center ${className ?? ""}`}>
      <Radio className="size-full" />
      <span className="absolute h-[2px] w-[115%] rotate-45 rounded-full bg-current" />
    </span>
  )
}

export function AnimePlayer({
  animeId,
  seasonNumber,
  episodeNumber,
  playback,
  media,
  fileName,
  previousEpisode,
  nextEpisode,
  durationSeconds,
  thumbnailUrl,
  autoPlay = false,
  clientStreamId,
  onEpisodeChange,
}: AnimePlayerProps) {
  const playerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const settingsPanelRef = useRef<HTMLDivElement>(null)
  const settingsButtonRef = useRef<HTMLDivElement>(null)
  const volumeControlRef = useRef<HTMLDivElement>(null)
  const playbackKeyRef = useRef(`${animeId}:${seasonNumber}:${episodeNumber}`)
  const clientStreamIdRef = useRef(clientStreamId ?? createClientStreamId())
  const castSelectionKeyRef = useRef("")
  const lastProgressSavePositionRef = useRef(0)
  const lastNonZeroVolumeRef = useRef(1)
  const lastVolumePointerTypeRef = useRef<string | null>(null)
  const touchControlClickSuppressionRef = useRef(false)
  const completedProgressRef = useRef(false)
  const directFallbackAttemptedRef = useRef(false)
  const currentTimeRef = useRef(0)
  const subtitleCuesRef = useRef<SubtitleCue[]>([])
  const activeSubtitleKeyRef = useRef("")
  const pendingSeekRef = useRef<number | null>(null)
  const sourceUrlRef = useRef<string | null>(null)
  const statusRef = useRef<PlaybackStatusState>("checking")
  const activeSourceStartRef = useRef(0)
  const shouldAutoPlaySourceRef = useRef(autoPlay)
  const sourceSwitchPauseSuppressionUntilRef = useRef(0)
  const isCastingRef = useRef(false)
  const isNativeRemoteCastingRef = useRef(false)
  const nativeRemoteFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isCastLoadingRef = useRef(false)
  const isPlayingRef = useRef(false)
  const castContentIdRef = useRef<string | null>(null)
  const castSourceStartOffsetRef = useRef(0)
  const castErrorFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const castErrorMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const castFinishedHandledRef = useRef(false)
  const castMediaCleanupRef = useRef<(() => void) | null>(null)
  const castProgressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const castStartPromiseRef = useRef<Promise<boolean> | null>(null)
  const localPlaybackBeforeCastRef = useRef<LocalPlaybackSnapshot | null>(null)
  const resumeLocalAfterCastEndRef = useRef(false)
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hardwareWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const priorityInfoTimerRef = useRef<number | null>(null)
  const pendingPrioritySwitchRef = useRef(false)
  const bandwidthRecheckHoldRef = useRef(false)
  const bandwidthRecheckSnapshotRef = useRef<BandwidthRecheckSnapshot | null>(null)
  const handledPriorityActionsRef = useRef<Set<string>>(new Set())
  const forcedDowngradeHistoryRef = useRef<Array<{ playbackKey: string; downgradedAt: number }>>([])
  const seekPreviewFrameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const subtitleAnimationFrameRef = useRef<number | null>(null)
  const streamStatsSampleRef = useRef<{
    bufferedEnd: number
    sampledAt: number
  } | null>(null)
  const startGoogleCastingRef = useRef<
    (
      video: HTMLVideoElement,
      shouldResume: boolean,
      startTimeOverride?: number
    ) => Promise<boolean>
  >(async () => false)
  const switchSourceRef = useRef<
    (
      nextSourceUrl: string,
      nextStatus: PlaybackStatusState,
      options?: SwitchSourceOptions
    ) => void
  >(() => undefined)
  const handleCastEndedRef = useRef<() => void>(() => undefined)
  const [quality, setQuality] = useState<PlaybackProfile>("original")
  const [detectedPlayerAspectRatio, setDetectedPlayerAspectRatio] = useState<{
    playbackKey: string
    aspectRatio: string
  } | null>(null)
  const [selectedAudioStreamId, setSelectedAudioStreamId] = useState<string | null>(
    media.defaultAudioStreamId
  )
  const [selectedSubtitleStreamId, setSelectedSubtitleStreamId] = useState<
    string | null
  >(media.defaultSubtitleStreamId)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<PlaybackStatusState>("checking")
  const [directPossible, setDirectPossible] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isWaitingForMedia, setIsWaitingForMedia] = useState(false)
  const [showHardwareWait, setShowHardwareWait] = useState(false)
  const [priorityInfo, setPriorityInfo] = useState<PriorityInfo | null>(null)
  const [dataSaverProtectionKey, setDataSaverProtectionKey] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [seekPreview, setSeekPreview] = useState<number | null>(null)
  const [seekPreviewFrame, setSeekPreviewFrame] = useState<SeekPreviewFrame | null>(null)
  const [duration, setDuration] = useState(getStableDuration(durationSeconds))
  const [controlsVisible, setControlsVisible] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [isPortraitViewport, setIsPortraitViewport] = useState(false)
  const [isMobilePortraitViewport, setIsMobilePortraitViewport] = useState(false)
  const [isPhoneViewport, setIsPhoneViewport] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isCasting, setIsCasting] = useState(false)
  const [isNativeRemoteCasting, setIsNativeRemoteCasting] = useState(false)
  const [isCastStarting, setIsCastStarting] = useState(false)
  const [isIosDevice, setIsIosDevice] = useState(false)
  const [nativeRemotePlaybackSupported, setNativeRemotePlaybackSupported] = useState(false)
  const [nativeRemotePlaybackAvailable, setNativeRemotePlaybackAvailable] = useState(false)
  const [castErrorFlash, setCastErrorFlash] = useState(false)
  const [castErrorMessage, setCastErrorMessage] = useState<string | null>(null)
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([])
  const [activeSubtitleTexts, setActiveSubtitleTexts] = useState<string[]>([])
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [volumeOpen, setVolumeOpen] = useState(false)

  const playbackKey = `${animeId}:${seasonNumber}:${episodeNumber}`
  const liveTranscodeEnabled = playback.liveTranscodeEnabled !== false
  const importProcessingEnabled = playback.importEnabled !== false
  const automaticDataSaverSwitchingEnabled = !importProcessingEnabled
  const dataSaverBlockedByDirect = liveTranscodeEnabled && importProcessingEnabled && directPossible
  const showQualityControl = liveTranscodeEnabled && !dataSaverBlockedByDirect
  const selectedAudioStream = useMemo(
    () => media.audioStreams.find((stream) => stream.id === selectedAudioStreamId),
    [media.audioStreams, selectedAudioStreamId]
  )
  const playbackAudioStream = useMemo(
    () =>
      selectedAudioStream ??
      media.audioStreams.find((stream) => stream.id === media.defaultAudioStreamId) ??
      media.audioStreams[0],
    [media.audioStreams, media.defaultAudioStreamId, selectedAudioStream]
  )
  const directAudioRemuxActive = shouldUseDirectAudioRemux(
    selectedAudioStreamId,
    media.directAudioStreamId
  )
  const supportedSubtitleStreams = useMemo(
    () => media.subtitleStreams.filter((stream) => stream.isSupported),
    [media.subtitleStreams]
  )
  const subtitleLanguageOptions = useMemo(
    () => getSubtitleLanguageOptions(supportedSubtitleStreams),
    [supportedSubtitleStreams]
  )
  const selectedSubtitleStream = useMemo(
    () =>
      supportedSubtitleStreams.find(
        (stream) => stream.id === selectedSubtitleStreamId
      ) ?? null,
    [selectedSubtitleStreamId, supportedSubtitleStreams]
  )
  const subtitleTrackUrl = selectedSubtitleStream
    ? withSubtitleStream(playback.subtitleUrl, selectedSubtitleStream.id)
    : null
  const streamMbps = estimateStreamMbps({
    quality,
    sourceBitrateMbps: media.sourceBitrateMbps,
    status,
  })
  const displayMethod = statusLabel(status)
  const castSelectionKey = `${playbackKey}:${quality}:${selectedAudioStreamId ?? ""}:${selectedSubtitleStreamId ?? ""}`

  useEffect(() => {
    sourceUrlRef.current = sourceUrl
    streamStatsSampleRef.current = null

    const timer = window.setTimeout(() => {
    }, 0)

    return () => window.clearTimeout(timer)
  }, [sourceUrl])

  useEffect(() => {
    isCastingRef.current = isCasting
  }, [isCasting])

  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    if (liveTranscodeEnabled || quality === "original") {
      return
    }

    const timer = window.setTimeout(() => {
      setQuality("original")
    }, 0)

    return () => window.clearTimeout(timer)
  }, [liveTranscodeEnabled, quality])

  useEffect(() => {
    if (!dataSaverBlockedByDirect || quality === "original") {
      return
    }

    const timer = window.setTimeout(() => {
      setQuality("original")
    }, 0)

    return () => window.clearTimeout(timer)
  }, [dataSaverBlockedByDirect, quality])

  useEffect(() => {
    const video = videoRef.current

    if (!video || status !== "direct") {
      return
    }

    applyDirectAudioTrack(video, selectedAudioStream, media.audioStreams)
  }, [media.audioStreams, selectedAudioStream, sourceUrl, status])

  useEffect(() => {
    const defaultSubtitle = supportedSubtitleStreams.find(
      (stream) => stream.id === media.defaultSubtitleStreamId
    )
    const bestDefaultSubtitle = defaultSubtitle
      ? subtitleLanguageOptions.find(
          (option) => option.language === defaultSubtitle.language
        )?.stream ?? defaultSubtitle
      : null
    const timer = window.setTimeout(() => {
      setSelectedAudioStreamId(media.defaultAudioStreamId)
      setSelectedSubtitleStreamId(bestDefaultSubtitle?.id ?? null)
    }, 0)

    return () => window.clearTimeout(timer)
  }, [
    media.defaultAudioStreamId,
    media.defaultSubtitleStreamId,
    playbackKey,
    subtitleLanguageOptions,
    supportedSubtitleStreams,
  ])

  useEffect(() => {
    if (!selectedSubtitleStreamId) {
      return
    }

    const selectedStream = supportedSubtitleStreams.find(
      (stream) => stream.id === selectedSubtitleStreamId
    )
    const bestLanguageOption = selectedStream
      ? subtitleLanguageOptions.find(
          (option) => option.language === selectedStream.language
        )
      : null
    const nextSubtitleStreamId = selectedStream
      ? bestLanguageOption && bestLanguageOption.id !== selectedSubtitleStreamId
        ? bestLanguageOption.id
        : selectedSubtitleStreamId
      : null

    if (nextSubtitleStreamId === selectedSubtitleStreamId) {
      return
    }

    const timer = window.setTimeout(() => {
      setSelectedSubtitleStreamId(nextSubtitleStreamId)
    }, 0)

    return () => window.clearTimeout(timer)
  }, [selectedSubtitleStreamId, subtitleLanguageOptions, supportedSubtitleStreams])

  const clearControlsTimer = useCallback(() => {
    if (controlsTimerRef.current) {
      clearTimeout(controlsTimerRef.current)
      controlsTimerRef.current = null
    }
  }, [])

  const clearHardwareWaitTimer = useCallback(() => {
    if (hardwareWaitTimerRef.current) {
      clearTimeout(hardwareWaitTimerRef.current)
      hardwareWaitTimerRef.current = null
    }
  }, [])

  const clearPriorityInfoTimer = useCallback(() => {
    if (priorityInfoTimerRef.current) {
      window.clearTimeout(priorityInfoTimerRef.current)
      priorityInfoTimerRef.current = null
    }
  }, [])

  const clearSeekPreviewFrameTimer = useCallback(() => {
    if (seekPreviewFrameTimerRef.current) {
      clearTimeout(seekPreviewFrameTimerRef.current)
      seekPreviewFrameTimerRef.current = null
    }
  }, [])

  const clearSubtitleAnimationFrame = useCallback(() => {
    if (subtitleAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(subtitleAnimationFrameRef.current)
      subtitleAnimationFrameRef.current = null
    }
  }, [])

  const clearCastErrorFlashTimer = useCallback(() => {
    if (castErrorFlashTimerRef.current) {
      clearTimeout(castErrorFlashTimerRef.current)
      castErrorFlashTimerRef.current = null
    }

    if (castErrorMessageTimerRef.current) {
      clearTimeout(castErrorMessageTimerRef.current)
      castErrorMessageTimerRef.current = null
    }
  }, [])

  const flashCastError = useCallback(
    (error: unknown) => {
      reportCastError(error)
      clearCastErrorFlashTimer()
      setCastErrorFlash(true)
      setCastErrorMessage(formatCastErrorMessage(error))

      castErrorFlashTimerRef.current = setTimeout(() => {
        setCastErrorFlash(false)
        castErrorFlashTimerRef.current = null
      }, 1800)
      castErrorMessageTimerRef.current = setTimeout(() => {
        setCastErrorMessage(null)
        castErrorMessageTimerRef.current = null
      }, 8000)
    },
    [clearCastErrorFlashTimer]
  )

  const clearCastMediaSync = useCallback(() => {
    castMediaCleanupRef.current?.()
    castMediaCleanupRef.current = null

    if (castProgressTimerRef.current) {
      clearInterval(castProgressTimerRef.current)
      castProgressTimerRef.current = null
    }
  }, [])

  const beginMediaWait = useCallback(
    (forceTranscodeWait = false) => {
      clearHardwareWaitTimer()
      setIsWaitingForMedia(true)
      setShowHardwareWait(false)

      if (forceTranscodeWait || statusRef.current === "transcoding") {
        hardwareWaitTimerRef.current = setTimeout(() => {
          setShowHardwareWait(true)
        }, 5000)
      }
    },
    [clearHardwareWaitTimer]
  )

  const endMediaWait = useCallback(() => {
    clearHardwareWaitTimer()
    setIsWaitingForMedia(false)
    setShowHardwareWait(false)
  }, [clearHardwareWaitTimer])

  const clearNativeRemoteFallbackTimer = useCallback(() => {
    if (nativeRemoteFallbackTimerRef.current) {
      clearTimeout(nativeRemoteFallbackTimerRef.current)
      nativeRemoteFallbackTimerRef.current = null
    }
  }, [])

  const setNativeRemoteCastingState = useCallback(
    (nextIsCasting: boolean) => {
      isNativeRemoteCastingRef.current = nextIsCasting
      setIsNativeRemoteCasting(nextIsCasting)

      if (!nextIsCasting) {
        clearNativeRemoteFallbackTimer()
      }
    },
    [clearNativeRemoteFallbackTimer]
  )

  const showControls = useCallback(
    (keepVisible = false) => {
      clearControlsTimer()
      setControlsVisible(true)

      if (
        !keepVisible &&
        isPlayingRef.current &&
        !isCastingRef.current &&
        !isNativeRemoteCastingRef.current
      ) {
        controlsTimerRef.current = setTimeout(() => {
          setControlsVisible(false)
          setSettingsOpen(false)
        }, 2500)
      }
    },
    [clearControlsTimer]
  )

  useEffect(() => {
    return () => {
      clearNativeRemoteFallbackTimer()
    }
  }, [clearNativeRemoteFallbackTimer])

  useEffect(() => {
    const removeListener = addGoogleCastSessionStateListener((event) => {
      if (isGoogleCastConnectedState(event.sessionState)) {
        showControls(true)
      }

      if (
        isGoogleCastEndingState(event.sessionState) &&
        (isCastingRef.current || isCastLoadingRef.current)
      ) {
        handleCastEndedRef.current()
      }
    })

    return () => {
      removeListener()
    }
  }, [showControls])

  useEffect(() => {
    const portraitQuery = window.matchMedia("(orientation: portrait)")
    const mobilePortraitQuery = window.matchMedia(
      "(max-width: 767px) and (orientation: portrait)"
    )
    const phoneQuery = window.matchMedia(
      "(pointer: coarse) and (max-width: 767px), (pointer: coarse) and (max-height: 480px)"
    )

    function syncViewport() {
      setIsPortraitViewport(portraitQuery.matches)
      setIsMobilePortraitViewport(mobilePortraitQuery.matches)
      setIsPhoneViewport(phoneQuery.matches)
    }

    syncViewport()
    portraitQuery.addEventListener("change", syncViewport)
    mobilePortraitQuery.addEventListener("change", syncViewport)
    phoneQuery.addEventListener("change", syncViewport)

    return () => {
      portraitQuery.removeEventListener("change", syncViewport)
      mobilePortraitQuery.removeEventListener("change", syncViewport)
      phoneQuery.removeEventListener("change", syncViewport)
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    const isIos = isIosBrowser()
    let cancelled = false
    let remoteWatchId: number | null = null
    let initialSyncTimer: ReturnType<typeof setTimeout> | null = null

    function syncNativePlaybackState() {
      if (cancelled) {
        return
      }

      setIsIosDevice(isIos)

      if (!video || !isIos) {
        setNativeRemotePlaybackSupported(false)
        setNativeRemotePlaybackAvailable(false)
        return
      }

      const supportsNativePlayback = canUseNativeRemotePlayback(video)
      setNativeRemotePlaybackSupported(supportsNativePlayback)
      setNativeRemotePlaybackAvailable(
        supportsNativePlayback &&
          (hasNativeRemotePlaybackPrompt(video) || hasNativeRemotePlaybackPicker(video))
      )
    }

    initialSyncTimer = setTimeout(syncNativePlaybackState, 0)

    if (!video || !isIos) {
      return () => {
        cancelled = true
        if (initialSyncTimer) {
          clearTimeout(initialSyncTimer)
        }
      }
    }

    const nativeVideo = video as HtmlVideoElementWithNativePlayback
    nativeVideo.disableRemotePlayback = false
    nativeVideo.setAttribute("x-webkit-airplay", "allow")
    nativeVideo.setAttribute("webkit-playsinline", "")
    nativeVideo.setAttribute("playsinline", "")

    function handleWebKitAvailability(event: Event) {
      const availability = (event as WebKitPlaybackTargetAvailabilityEvent).availability
      setNativeRemotePlaybackAvailable(
        availability === "available" ||
          hasNativeRemotePlaybackPrompt(video) ||
          hasNativeRemotePlaybackPicker(video)
      )
    }

    function handleNativeTargetChanged() {
      const connected = isNativeRemotePlaybackConnected(video)
      setNativeRemoteCastingState(connected)

      if (!connected) {
        isCastLoadingRef.current = false
        setIsCastStarting(false)
        endMediaWait()
        return
      }

      showControls(true)
    }

    video.addEventListener(
      "webkitplaybacktargetavailabilitychanged",
      handleWebKitAvailability
    )
    video.addEventListener(
      "webkitcurrentplaybacktargetiswirelesschanged",
      handleNativeTargetChanged
    )
    nativeVideo.remote?.addEventListener?.("connect", handleNativeTargetChanged)
    nativeVideo.remote?.addEventListener?.("disconnect", handleNativeTargetChanged)

    if (typeof nativeVideo.remote?.watchAvailability === "function") {
      nativeVideo.remote
        .watchAvailability((available) => {
          if (!cancelled) {
            setNativeRemotePlaybackAvailable(
              available ||
                hasNativeRemotePlaybackPrompt(video) ||
                hasNativeRemotePlaybackPicker(video)
            )
          }
        })
        .then((watchId) => {
          if (cancelled) {
            void nativeVideo.remote?.cancelWatchAvailability?.(watchId)
            return
          }

          remoteWatchId = watchId
        })
        .catch(() => undefined)
    }

    return () => {
      cancelled = true
      if (initialSyncTimer) {
        clearTimeout(initialSyncTimer)
      }
      video.removeEventListener(
        "webkitplaybacktargetavailabilitychanged",
        handleWebKitAvailability
      )
      video.removeEventListener(
        "webkitcurrentplaybacktargetiswirelesschanged",
        handleNativeTargetChanged
      )
      nativeVideo.remote?.removeEventListener?.("connect", handleNativeTargetChanged)
      nativeVideo.remote?.removeEventListener?.("disconnect", handleNativeTargetChanged)

      if (remoteWatchId !== null) {
        void nativeVideo.remote?.cancelWatchAvailability?.(remoteWatchId)
      }
    }
  }, [endMediaWait, setNativeRemoteCastingState, showControls, sourceUrl])

  useEffect(() => {
    const video = videoRef.current

    function syncFullscreenState() {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }

    function markNativeFullscreen() {
      setIsFullscreen(true)
    }

    function clearNativeFullscreen() {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }

    syncFullscreenState()
    document.addEventListener("fullscreenchange", syncFullscreenState)
    video?.addEventListener("webkitbeginfullscreen", markNativeFullscreen)
    video?.addEventListener("webkitendfullscreen", clearNativeFullscreen)

    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState)
      video?.removeEventListener("webkitbeginfullscreen", markNativeFullscreen)
      video?.removeEventListener("webkitendfullscreen", clearNativeFullscreen)
    }
  }, [])

  useEffect(() => {
    if (!isMobilePortraitViewport || isCasting || isNativeRemoteCasting || isFullscreen) {
      return
    }

    const video = videoRef.current

    if (video && !video.paused) {
      video.pause()
    }
  }, [isCasting, isFullscreen, isMobilePortraitViewport, isNativeRemoteCasting])

  useEffect(() => {
    if (!settingsOpen) {
      return
    }

    function handleDocumentPointerDown(event: PointerEvent) {
      const target = event.target

      if (!(target instanceof Node)) {
        return
      }

      if (settingsPanelRef.current?.contains(target)) {
        return
      }

      if (settingsButtonRef.current?.contains(target)) {
        return
      }

      setSettingsOpen(false)
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown)

    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown)
    }
  }, [settingsOpen])


  useEffect(() => {
    if (!volumeOpen) {
      return
    }

    function handleDocumentPointerDown(event: PointerEvent) {
      const target = event.target

      if (!(target instanceof Node)) {
        return
      }

      if (volumeControlRef.current?.contains(target)) {
        return
      }

      setVolumeOpen(false)
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown)

    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown)
    }
  }, [volumeOpen])

  const saveProgress = useCallback(
    async (
      watchedSeconds: number,
      knownDurationSeconds: number | undefined,
      completed: boolean
    ) => {
      lastProgressSavePositionRef.current = watchedSeconds

      await fetch(
        `/api/watch/${encodeURIComponent(animeId)}/${episodeNumber}/progress?season=${seasonNumber}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            season: seasonNumber,
            watchedSeconds,
            durationSeconds: knownDurationSeconds,
            completed,
          }),
        }
      ).catch(() => undefined)
    },
    [animeId, episodeNumber, seasonNumber]
  )

  function updateWatchedProgress(watchedSeconds: number, measuredDuration?: number) {
    const effectiveDuration = getStableDuration(
      durationSeconds,
      measuredDuration,
      duration
    )

    currentTimeRef.current = watchedSeconds
    setCurrentTime(watchedSeconds)
    syncSubtitleOverlay(watchedSeconds)

    if (effectiveDuration) {
      setDuration(effectiveDuration)
    }

    if (
      effectiveDuration &&
      watchedSeconds / effectiveDuration >= 0.8 &&
      !completedProgressRef.current
    ) {
      completedProgressRef.current = true
      void saveProgress(watchedSeconds, effectiveDuration, true)
      return
    }

    if (Math.abs(watchedSeconds - lastProgressSavePositionRef.current) >= 15) {
      void saveProgress(watchedSeconds, effectiveDuration, false)
    }
  }

  function completePlayback(endedTime: number, knownDuration?: number) {
    const finalTime =
      knownDuration && Number.isFinite(knownDuration) ? knownDuration : endedTime
    const completedEnough =
      knownDuration && knownDuration > 0 ? endedTime / knownDuration >= 0.9 : endedTime >= 60

    setIsPlaying(false)
    completedProgressRef.current = Boolean(completedEnough)
    showControls(true)
    void saveProgress(
      completedEnough ? finalTime : endedTime,
      knownDuration && Number.isFinite(knownDuration) ? knownDuration : undefined,
      Boolean(completedEnough)
    )

    if (completedEnough && nextEpisode && onEpisodeChange) {
      onEpisodeChange(nextEpisode, true)
    }
  }

  useEffect(
    () => () => {
      clearControlsTimer()
      clearHardwareWaitTimer()
      clearPriorityInfoTimer()
      clearCastErrorFlashTimer()
      clearCastMediaSync()
      clearSeekPreviewFrameTimer()
      clearSubtitleAnimationFrame()
    },
    [
      clearControlsTimer,
      clearHardwareWaitTimer,
      clearPriorityInfoTimer,
      clearCastErrorFlashTimer,
      clearCastMediaSync,
      clearSeekPreviewFrameTimer,
      clearSubtitleAnimationFrame,
    ]
  )

  const getPlaybackClockPosition = useCallback((video: HTMLVideoElement | null) => {
    if (
      video &&
      Number.isFinite(video.currentTime) &&
      activeSourceStartRef.current > 0
    ) {
      return Math.max(activeSourceStartRef.current + video.currentTime, 0)
    }

    const seconds =
      video && Number.isFinite(video.currentTime)
        ? video.currentTime
        : currentTimeRef.current

    return Math.max(seconds, 0)
  }, [])

  const getPlaybackPosition = useCallback(() => {
    return getPlaybackClockPosition(videoRef.current)
  }, [getPlaybackClockPosition])

  const syncSubtitleOverlay = useCallback(
    (seconds = getPlaybackPosition()) => {
      const texts = getActiveSubtitleTexts(subtitleCuesRef.current, seconds)
      const key = subtitleTextKey(texts)

      if (key === activeSubtitleKeyRef.current) {
        return
      }

      activeSubtitleKeyRef.current = key
      setActiveSubtitleTexts(texts)
    },
    [getPlaybackPosition]
  )

  function applyPendingSeek(video: HTMLVideoElement) {
    const pendingSeek = pendingSeekRef.current

    if (pendingSeek === null) {
      return
    }

    const knownDuration = getStableDuration(durationSeconds, video.duration, duration)
    const target = knownDuration > 0 ? Math.min(pendingSeek, knownDuration) : pendingSeek

    if (Number.isFinite(target) && target > 0) {
      video.currentTime = target
      currentTimeRef.current = target
      setCurrentTime(target)
    }

    pendingSeekRef.current = null
  }

  const getDirectUrl = useCallback(
    (startTime?: number) =>
      withStreamParams(playback.directUrl, {
        audioStreamId: selectedAudioStreamId,
        startTime: directAudioRemuxActive ? startTime : null,
        clientId: clientStreamIdRef.current,
      }),
    [directAudioRemuxActive, playback.directUrl, selectedAudioStreamId]
  )

  const getTranscodeUrl = useCallback(
    (profile: PlaybackProfile, startTime?: number) =>
      withStreamParams(
        profile === "dataSaver"
          ? playback.dataSaverUrl
          : playback.originalTranscodeUrl,
        {
          audioStreamId: selectedAudioStreamId,
          startTime,
          clientId: clientStreamIdRef.current,
        }
      ),
    [playback.dataSaverUrl, playback.originalTranscodeUrl, selectedAudioStreamId]
  )

  function switchSource(
    nextSourceUrl: string,
    nextStatus: PlaybackStatusState,
    options: SwitchSourceOptions = {}
  ) {
    const video = videoRef.current
    const previousPosition = options.preservePosition ? getPlaybackPosition() : 0
    const sourceUsesOffset = nextStatus === "transcoding" || directAudioRemuxActive
    const sourceStartTime = sourceUsesOffset
      ? options.transcodeStartTime ?? previousPosition
      : 0
    const sourceToLoad = sourceUsesOffset
      ? withStreamParams(nextSourceUrl, {
          audioStreamId: selectedAudioStreamId,
          startTime: sourceStartTime,
          clientId: clientStreamIdRef.current,
        })
      : withStreamParams(nextSourceUrl, {
          audioStreamId: selectedAudioStreamId,
          startTime: null,
          clientId: clientStreamIdRef.current,
        })
    const shouldResume =
      Boolean(video && !video.paused) ||
      isPlayingRef.current ||
      shouldAutoPlaySourceRef.current

    activeSourceStartRef.current = sourceStartTime

    if (options.preservePosition) {
      currentTimeRef.current = previousPosition
      setCurrentTime(previousPosition)
      syncSubtitleOverlay(previousPosition)
      pendingSeekRef.current = sourceUsesOffset ? null : previousPosition
    } else {
      pendingSeekRef.current = null

      if (sourceUsesOffset && sourceStartTime > 0) {
        currentTimeRef.current = sourceStartTime
        setCurrentTime(sourceStartTime)
        syncSubtitleOverlay(sourceStartTime)
      }
    }

    const sourceChanged = sourceUrlRef.current !== sourceToLoad || options.forceReload === true

    if (sourceChanged && shouldResume) {
      shouldAutoPlaySourceRef.current = true
      sourceSwitchPauseSuppressionUntilRef.current = Date.now() + 5000
    } else if (sourceChanged) {
      sourceSwitchPauseSuppressionUntilRef.current = 0
    }

    setStatus(nextStatus)
    statusRef.current = nextStatus

    if (sourceChanged) {
      sourceUrlRef.current = sourceToLoad
      if (video) {
        video.src = sourceToLoad
        video.load()
      }
      setSourceUrl(sourceToLoad)
    }

    if (options.waitForMedia || (sourceChanged && shouldResume)) {
      beginMediaWait(nextStatus === "transcoding")
    } else {
      endMediaWait()
    }

    showControls(true)
  }

  useEffect(() => {
    switchSourceRef.current = switchSource
  })

  const blockLiveTranscodePlayback = useCallback(() => {
    const video = videoRef.current

    video?.pause()
    video?.removeAttribute("src")
    video?.load()
    sourceUrlRef.current = null
    activeSourceStartRef.current = 0
    pendingSeekRef.current = null
    setSourceUrl(null)
    setStatus("blocked")
    statusRef.current = "blocked"
    setIsPlaying(false)
    endMediaWait()
    showControls(true)
  }, [endMediaWait, showControls])

  useEffect(() => {
    let cancelled = false

    async function selectSource() {
      const previousSourceUrl = sourceUrlRef.current
      const episodeChanged = playbackKeyRef.current !== playbackKey

      if (episodeChanged) {
        playbackKeyRef.current = playbackKey
        forcedDowngradeHistoryRef.current = []
        setDataSaverProtectionKey(null)
        setPriorityInfo(null)
        clearPriorityInfoTimer()
        currentTimeRef.current = 0
        activeSourceStartRef.current = 0
        activeSubtitleKeyRef.current = ""
        pendingSeekRef.current = null
        shouldAutoPlaySourceRef.current = autoPlay || isPlayingRef.current
        setCurrentTime(0)
        setSeekPreview(null)
        setSeekPreviewFrame(null)
        setActiveSubtitleTexts([])
        setDuration(getStableDuration(durationSeconds))
        setControlsVisible(!isPlayingRef.current)
        setSettingsOpen(false)
        endMediaWait()
        lastProgressSavePositionRef.current = 0
        completedProgressRef.current = false
        directFallbackAttemptedRef.current = false
      }

      if (isCastingRef.current) {
        const video = videoRef.current

        if (episodeChanged && video) {
          void startGoogleCastingRef.current(
            video,
            autoPlay || isPlayingRef.current,
            0
          )
        }

        return
      }

      const video = videoRef.current
      const canUseDirect = video
        ? supportsDirectPlayback({
            video,
            fileName,
            media,
            selectedAudioStream: playbackAudioStream,
          })
        : false
      const waitForPrioritySwitch = pendingPrioritySwitchRef.current
      pendingPrioritySwitchRef.current = false

      setDirectPossible(canUseDirect)
      setStatus("checking")
      endMediaWait()

      if (quality === "original" && canUseDirect) {
        directFallbackAttemptedRef.current = false
        switchSourceRef.current(getDirectUrl(), "direct", {
          preservePosition: Boolean(previousSourceUrl) && !episodeChanged,
          waitForMedia: waitForPrioritySwitch,
        })
        return
      }

      if (cancelled) {
        return
      }

      if (!liveTranscodeEnabled) {
        blockLiveTranscodePlayback()
        return
      }

      switchSourceRef.current(getTranscodeUrl(quality), "transcoding", {
        preservePosition: Boolean(previousSourceUrl) && !episodeChanged,
        waitForMedia: waitForPrioritySwitch,
      })
    }

    void selectSource()

    return () => {
      cancelled = true
    }
  }, [
    autoPlay,
    blockLiveTranscodePlayback,
    durationSeconds,
    endMediaWait,
    clearPriorityInfoTimer,
    fileName,
    getDirectUrl,
    getTranscodeUrl,
    liveTranscodeEnabled,
    media,
    playbackKey,
    quality,
    playbackAudioStream,
  ])

  useEffect(() => {
    const video = videoRef.current

    if (!video || !sourceUrl) {
      return
    }

    if (shouldAutoPlaySourceRef.current) {
      const timer = window.setTimeout(() => {
        shouldAutoPlaySourceRef.current = false
        beginMediaWait()
        void video.play().catch(() => {
          setIsPlaying(false)
          endMediaWait()
        })
      }, 0)

      return () => window.clearTimeout(timer)
    }
  }, [beginMediaWait, endMediaWait, sourceUrl])

  useEffect(() => {
    let cancelled = false

    subtitleCuesRef.current = []
    activeSubtitleKeyRef.current = ""

    const resetTimer = window.setTimeout(() => {
      if (!cancelled) {
        setSubtitleCues([])
        setActiveSubtitleTexts([])
      }
    }, 0)

    if (!selectedSubtitleStream || !subtitleTrackUrl) {
      return () => {
        cancelled = true
        window.clearTimeout(resetTimer)
      }
    }

    void fetch(subtitleTrackUrl, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Subtitle request failed with status ${response.status}`)
        }

        return response.text()
      })
      .then((text) => {
        if (!cancelled) {
          const cues = parseWebVtt(text)
          subtitleCuesRef.current = cues
          setSubtitleCues(cues)
          syncSubtitleOverlay()
        }
      })
      .catch((error) => {
        if (!cancelled) {
          subtitleCuesRef.current = []
          activeSubtitleKeyRef.current = ""
          setSubtitleCues([])
          setActiveSubtitleTexts([])
          console.error(error)
        }
      })

    return () => {
      cancelled = true
      window.clearTimeout(resetTimer)
    }
  }, [selectedSubtitleStream, subtitleTrackUrl, syncSubtitleOverlay])

  useEffect(() => {
    subtitleCuesRef.current = subtitleCues
    activeSubtitleKeyRef.current = ""

    const frame = window.requestAnimationFrame(() => {
      syncSubtitleOverlay()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [subtitleCues, syncSubtitleOverlay])

  useEffect(() => {
    clearSubtitleAnimationFrame()

    if (!subtitleCues.length || isCasting) {
      activeSubtitleKeyRef.current = ""
      const timer = window.setTimeout(() => {
        setActiveSubtitleTexts([])
      }, 0)

      return () => window.clearTimeout(timer)
    }

    const tick = () => {
      syncSubtitleOverlay()
      subtitleAnimationFrameRef.current = window.requestAnimationFrame(tick)
    }

    subtitleAnimationFrameRef.current = window.requestAnimationFrame(tick)

    return clearSubtitleAnimationFrame
  }, [
    clearSubtitleAnimationFrame,
    isCasting,
    sourceUrl,
    subtitleCues,
    syncSubtitleOverlay,
  ])

  const showPriorityInfoMessage = useCallback(
    (info: PriorityInfo, options: { autoClearMs?: number | null } = {}) => {
      clearPriorityInfoTimer()
      setPriorityInfo(info)

      if (options.autoClearMs) {
        priorityInfoTimerRef.current = window.setTimeout(() => {
          setPriorityInfo(null)
          priorityInfoTimerRef.current = null
        }, options.autoClearMs)
      }

      showControls(true)
    },
    [clearPriorityInfoTimer, showControls]
  )

  const registerForcedDowngrade = useCallback(() => {
    const now = Date.now()
    const recentDowngrades = forcedDowngradeHistoryRef.current.filter(
      (entry) =>
        entry.playbackKey === playbackKey && now - entry.downgradedAt < 5 * 60_000
    )

    recentDowngrades.push({ playbackKey, downgradedAt: now })
    forcedDowngradeHistoryRef.current = recentDowngrades

    return recentDowngrades.length >= 2
  }, [playbackKey])

  const switchQualityFromPriority = useCallback(
    (nextQuality: PlaybackProfile) => {
      if (!liveTranscodeEnabled || (dataSaverBlockedByDirect && nextQuality === "dataSaver")) {
        return
      }

      const video = videoRef.current
      const wasPlaying =
        Boolean(video && !video.paused) || isPlayingRef.current || isCastingRef.current

      shouldAutoPlaySourceRef.current = wasPlaying
      pendingPrioritySwitchRef.current = true
      if (wasPlaying) {
        beginMediaWait(nextQuality !== "original" || statusRef.current === "transcoding")
      }
      setQuality(nextQuality)
      showControls(true)
    },
    [beginMediaWait, dataSaverBlockedByDirect, liveTranscodeEnabled, showControls]
  )

  const markDataSaverProtectionOnServer = useCallback(() => {
    void fetch("/api/stream/priority/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        clientId: clientStreamIdRef.current,
        protected: true,
      }),
    }).catch(() => undefined)
  }, [])

  const handleBandwidthRecheckStarted = useCallback(
    (action: StreamPriorityAction) => {
      const video = videoRef.current
      const wasCasting = isCastingRef.current || isCastLoadingRef.current
      const wasPlaying = wasCasting
        ? isPlayingRef.current
        : Boolean(video && !video.paused) || isPlayingRef.current
      const position = getPlaybackPosition()

      bandwidthRecheckHoldRef.current = true
      bandwidthRecheckSnapshotRef.current = {
        wasCasting,
        wasPlaying,
        position,
        sourceUrl: sourceUrlRef.current,
        status: statusRef.current,
      }
      shouldAutoPlaySourceRef.current = false

      if (wasCasting) {
        const session = getGoogleCastSession()

        if (session && wasPlaying) {
          void pauseGoogleCastMedia(session).catch((error) => {
            flashCastError(error)
            console.error(error)
          })
        }
      } else {
        video?.pause()
      }

      isPlayingRef.current = false
      setIsPlaying(false)
      currentTimeRef.current = position
      setCurrentTime(position)
      syncSubtitleOverlay(position)
      beginMediaWait(statusRef.current === "transcoding" || wasCasting)
      showPriorityInfoMessage({
        type: action.type,
        message: action.message,
        createdAt: action.createdAt,
      })
    },
    [
      beginMediaWait,
      flashCastError,
      getPlaybackPosition,
      showPriorityInfoMessage,
      syncSubtitleOverlay,
    ]
  )

  const handleBandwidthRecheckFinished = useCallback(
    (action: StreamPriorityAction) => {
      const snapshot = bandwidthRecheckSnapshotRef.current

      bandwidthRecheckHoldRef.current = false
      bandwidthRecheckSnapshotRef.current = null
      showPriorityInfoMessage(
        {
          type: action.type,
          message: action.message,
          createdAt: action.createdAt,
        },
        { autoClearMs: 15_000 }
      )

      if (!snapshot) {
        endMediaWait()
        return
      }

      currentTimeRef.current = snapshot.position
      setCurrentTime(snapshot.position)
      syncSubtitleOverlay(snapshot.position)
      shouldAutoPlaySourceRef.current = snapshot.wasPlaying

      if (snapshot.wasCasting) {
        const video = videoRef.current

        if (!video) {
          endMediaWait()
          return
        }

        beginMediaWait(true)
        void startGoogleCastingRef.current(
          video,
          snapshot.wasPlaying,
          snapshot.position
        ).catch(
          (error) => {
            flashCastError(error)
            console.error(error)
            endMediaWait()
          }
        )
        return
      }

      if (!snapshot.sourceUrl || snapshot.status === "blocked") {
        endMediaWait()
        return
      }

      if (snapshot.wasPlaying) {
        beginMediaWait(snapshot.status === "transcoding")
      }

      switchSourceRef.current(snapshot.sourceUrl, snapshot.status, {
        preservePosition: true,
        transcodeStartTime: snapshot.position,
        waitForMedia: snapshot.wasPlaying,
        forceReload: true,
      })
    },
    [
      beginMediaWait,
      endMediaWait,
      flashCastError,
      showPriorityInfoMessage,
      syncSubtitleOverlay,
    ]
  )

  const handleServerShutdownStarted = useCallback(
    (action: StreamPriorityAction) => {
      const session = getGoogleCastSession()

      bandwidthRecheckHoldRef.current = false
      bandwidthRecheckSnapshotRef.current = null
      shouldAutoPlaySourceRef.current = false

      if (session) {
        void pauseGoogleCastMedia(session).catch((error) => {
          flashCastError(error)
          console.error(error)
        })
      }

      blockLiveTranscodePlayback()
      showPriorityInfoMessage(
        {
          type: action.type,
          message: action.message,
          createdAt: action.createdAt,
        },
        { autoClearMs: 30_000 }
      )
    },
    [blockLiveTranscodePlayback, flashCastError, showPriorityInfoMessage]
  )


  const handlePriorityAction = useCallback(
    (action: StreamPriorityAction) => {
      const actionKey = `${action.type}:${action.createdAt}:${action.message}`
      const handledActions = handledPriorityActionsRef.current

      if (handledActions.has(actionKey)) {
        return
      }

      handledActions.add(actionKey)

      if (handledActions.size > 50) {
        const firstKey = handledActions.values().next().value

        if (firstKey) {
          handledActions.delete(firstKey)
        }
      }

      if (action.type === "bandwidthRecheckStarted") {
        handleBandwidthRecheckStarted(action)
        return
      }

      if (action.type === "bandwidthRecheckFinished") {
        handleBandwidthRecheckFinished(action)
        return
      }

      if (action.type === "serverShutdownStarted") {
        handleServerShutdownStarted(action)
        return
      }

      if (action.type === "forceDataSaver") {
        if (!automaticDataSaverSwitchingEnabled) {
          return
        }

        const protectionAlreadyActive = dataSaverProtectionKey === playbackKey
        const protectionEnabled = protectionAlreadyActive || registerForcedDowngrade()
        const message =
          protectionEnabled && !protectionAlreadyActive
            ? `${action.message} Data Saver will stay enabled for the rest of this episode because your stream was downgraded twice within 5 minutes.`
            : action.message

        if (protectionEnabled && !protectionAlreadyActive) {
          setDataSaverProtectionKey(playbackKey)
          markDataSaverProtectionOnServer()
        }

        showPriorityInfoMessage({
          type: protectionEnabled ? "protectedDataSaver" : action.type,
          message,
          createdAt: action.createdAt,
        })

        if (quality !== "dataSaver") {
          switchQualityFromPriority("dataSaver")
        }

        return
      }

      if (action.type === "restoreOriginal") {
        if (!automaticDataSaverSwitchingEnabled) {
          return
        }

        if (dataSaverProtectionKey === playbackKey) {
          markDataSaverProtectionOnServer()
          return
        }

        showPriorityInfoMessage(
          {
            type: action.type,
            message: action.message,
            createdAt: action.createdAt,
          },
          { autoClearMs: 15_000 }
        )

        if (quality === "dataSaver") {
          switchQualityFromPriority("original")
        }

        return
      }

      showPriorityInfoMessage(
        {
          type: action.type,
          message: action.message,
          createdAt: action.createdAt,
        },
        { autoClearMs: 12_000 }
      )
    },
    [
      automaticDataSaverSwitchingEnabled,
      dataSaverProtectionKey,
      handleBandwidthRecheckFinished,
      handleBandwidthRecheckStarted,
      handleServerShutdownStarted,
      markDataSaverProtectionOnServer,
      playbackKey,
      quality,
      registerForcedDowngrade,
      showPriorityInfoMessage,
      switchQualityFromPriority,
    ]
  )

  useEffect(() => {
    let cancelled = false
    let events: EventSource | null = null
    let staleConnectionTimer: number | null = null
    let reconnectTimer: number | null = null
    let lastEventAt = Date.now()
    const clientId = clientStreamIdRef.current
    const protectionActive =
      dataSaverProtectionKey === playbackKey && quality === "dataSaver"
    const priorityEventsUrl = new URL(
      "/api/stream/priority/events",
      window.location.origin
    )
    priorityEventsUrl.searchParams.set("clientId", clientId)
    priorityEventsUrl.searchParams.set("protected", protectionActive ? "1" : "0")
    const priorityEventsPath = `${priorityEventsUrl.pathname}${priorityEventsUrl.search}`

    function markAlive() {
      lastEventAt = Date.now()
    }

    function onPriorityEvent(event: Event) {
      if (cancelled) {
        return
      }

      markAlive()

      try {
        handlePriorityAction(JSON.parse((event as MessageEvent<string>).data))
      } catch {
        return
      }
    }

    function closeEvents() {
      if (!events) {
        return
      }

      events.removeEventListener("priority", onPriorityEvent)
      events.removeEventListener("ready", markAlive)
      events.removeEventListener("heartbeat", markAlive)
      events.onerror = null
      events.close()
      events = null
    }

    function connectEvents() {
      if (cancelled) {
        return
      }

      closeEvents()
      markAlive()
      events = new EventSource(priorityEventsPath)
      events.addEventListener("priority", onPriorityEvent)
      events.addEventListener("ready", markAlive)
      events.addEventListener("heartbeat", markAlive)
      events.onerror = () => {
        if (!cancelled && events?.readyState === EventSource.CLOSED) {
          scheduleReconnect()
        }
      }
    }

    function scheduleReconnect() {
      if (cancelled || reconnectTimer) {
        return
      }

      closeEvents()
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        connectEvents()
      }, 1_000)
    }

    connectEvents()
    staleConnectionTimer = window.setInterval(() => {
      if (Date.now() - lastEventAt <= 75_000) {
        return
      }

      scheduleReconnect()
    }, 15_000)

    return () => {
      cancelled = true
      closeEvents()

      if (staleConnectionTimer) {
        window.clearInterval(staleConnectionTimer)
      }

      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer)
      }
    }
  }, [
    dataSaverProtectionKey,
    handlePriorityAction,
    playbackKey,
    quality,
  ])

  function tryDirectPlay() {
    if (dataSaverProtectionKey === playbackKey) {
      showPriorityInfoMessage({
        type: "protectedDataSaver",
        message:
          "Data Saver protection is active for the rest of this episode because your stream was downgraded twice within 5 minutes.",
        createdAt: new Date().toISOString(),
      })
      return
    }

    setQuality("original")
    directFallbackAttemptedRef.current = false
    switchSource(getDirectUrl(), "direct", { preservePosition: true })
  }

  function restoreLocalSource(options: { preservePosition?: boolean } = {}) {
    const previousLocalPlayback = localPlaybackBeforeCastRef.current

    if (previousLocalPlayback?.sourceUrl) {
      const position = options.preservePosition ? previousLocalPlayback.position : 0
      const video = videoRef.current

      localPlaybackBeforeCastRef.current = null
      pendingSeekRef.current = position
      currentTimeRef.current = position
      setCurrentTime(position)
      setQuality(previousLocalPlayback.quality)
      setDirectPossible(previousLocalPlayback.directPossible)
      if (video) {
        video.muted = previousLocalPlayback.wasMuted
      }
      switchSource(previousLocalPlayback.sourceUrl, previousLocalPlayback.status, {
        preservePosition: false,
      })
      return
    }

    const video = videoRef.current
    const canUseDirect = video
      ? supportsDirectPlayback({
          video,
          fileName,
          media,
          selectedAudioStream: playbackAudioStream,
        })
      : false

    if (video) {
      video.muted = false
    }

    setDirectPossible(canUseDirect)

    if (quality === "original" && canUseDirect) {
      directFallbackAttemptedRef.current = false
      switchSource(getDirectUrl(), "direct", {
        preservePosition: options.preservePosition,
      })
      return
    }

    if (!liveTranscodeEnabled) {
      blockLiveTranscodePlayback()
      return
    }

    switchSource(getTranscodeUrl(quality), "transcoding", {
      preservePosition: options.preservePosition,
    })
  }

  function fallbackDirectToTranscode() {
    directFallbackAttemptedRef.current = true
    setDirectPossible(false)

    if (!liveTranscodeEnabled) {
      blockLiveTranscodePlayback()
      return
    }

    switchSource(getTranscodeUrl("original"), "transcoding", {
      preservePosition: true,
      waitForMedia: isPlaying || autoPlay,
    })
  }

  async function togglePlay() {
    if (isCastingRef.current) {
      await toggleGoogleCastPlayback()
      showControls()
      return
    }

    if (shouldBlockMobilePortraitPlayback && !isNativeRemoteCastingRef.current) {
      showControls(true)
      return
    }

    const video = videoRef.current

    if (!video || !sourceUrl) {
      return
    }

    if (video.paused) {
      beginMediaWait()
      await video.play().catch(() => {
        endMediaWait()
      })
    } else {
      video.pause()
    }

    showControls()
  }

  async function seekTo(seconds: number) {
    if (isCastingRef.current) {
      const target = clampTime(seconds, duration)

      currentTimeRef.current = target
      setCurrentTime(target)

      if (statusRef.current === "transcoding" || directAudioRemuxActive) {
        const video = videoRef.current

        if (!video) {
          flashCastError(new Error("Google Cast session is missing"))
          console.error("Google Cast session is missing")
          return
        }

        beginMediaWait(statusRef.current === "transcoding")

        try {
          await startGoogleCastingRef.current(video, isPlayingRef.current, target)
        } catch (error) {
          flashCastError(error)
          console.error(error)
        }

        showControls()
        return
      }

      const session = getGoogleCastSession()

      if (!session) {
        flashCastError(new Error("Google Cast session is missing"))
        console.error("Google Cast session is missing")
        return
      }

      try {
        await seekGoogleCastMedia(session, target)
      } catch (error) {
        flashCastError(error)
        console.error(error)
      }

      showControls()
      return
    }

    const video = videoRef.current

    if (!video || !Number.isFinite(seconds)) {
      return
    }

    const target = clampTime(seconds, duration)

    if (statusRef.current === "transcoding" || directAudioRemuxActive) {
      const wasPlaying = !video.paused || isPlayingRef.current
      const nextStatus = statusRef.current === "transcoding" ? "transcoding" : "direct"
      const nextSourceUrl =
        nextStatus === "transcoding" ? getTranscodeUrl(quality) : getDirectUrl(target)

      activeSourceStartRef.current = target
      currentTimeRef.current = target
      setCurrentTime(target)
      syncSubtitleOverlay(target)
      shouldAutoPlaySourceRef.current = wasPlaying
      if (wasPlaying) {
        beginMediaWait(nextStatus === "transcoding")
      }
      switchSource(nextSourceUrl, nextStatus, {
        transcodeStartTime: target,
        waitForMedia: wasPlaying,
      })
      showControls(true)
      return
    }

    activeSourceStartRef.current = 0
    video.currentTime = target
    currentTimeRef.current = video.currentTime
    setCurrentTime(video.currentTime)
    syncSubtitleOverlay(video.currentTime)
    showControls()
  }

  function getSeekPreviewFrameUrl(seconds: number) {
    if (!thumbnailUrl) {
      return null
    }

    const url = new URL(thumbnailUrl, window.location.href)
    url.searchParams.set("time", clampTime(seconds, duration).toFixed(1))

    return `${url.pathname}${url.search}${url.hash}`
  }

  function scheduleSeekPreviewFrame(seconds: number) {
    if (!duration) {
      return
    }

    const nextTime = clampTime(seconds, duration)
    const leftPercent = Math.min(Math.max((nextTime / duration) * 100, 0), 100)

    clearSeekPreviewFrameTimer()
    seekPreviewFrameTimerRef.current = setTimeout(() => {
      setSeekPreviewFrame({
        time: nextTime,
        leftPercent,
      })
      seekPreviewFrameTimerRef.current = null
    }, 140)
  }

  function getSeekTimeFromPointer(input: HTMLInputElement, clientX: number) {
    if (!duration) {
      return 0
    }

    const rect = input.getBoundingClientRect()
    const ratio =
      rect.width > 0
        ? Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
        : 0

    return ratio * duration
  }

  function updateSeekHoverPreview(input: HTMLInputElement, clientX: number) {
    const hoverTime = getSeekTimeFromPointer(input, clientX)
    scheduleSeekPreviewFrame(hoverTime)
  }

  function updateSeekDragPreview(value: string) {
    const nextValue = Number(value)

    if (!Number.isFinite(nextValue)) {
      return
    }

    setSeekPreview(nextValue)
    scheduleSeekPreviewFrame(nextValue)
  }

  function clearSeekPreviewFrame() {
    clearSeekPreviewFrameTimer()
    setSeekPreviewFrame(null)
  }

  function commitSeekInput(value: string) {
    const nextValue = Number(value)

    setSeekPreview(null)
    clearSeekPreviewFrame()

    if (Number.isFinite(nextValue)) {
      void seekTo(nextValue)
    }
  }

  function syncLocalVolumeState(video: HTMLVideoElement) {
    const nextVolume = Math.min(Math.max(video.volume, 0), 1)

    if (nextVolume > 0) {
      lastNonZeroVolumeRef.current = nextVolume
    }

    setVolume(nextVolume)
    setIsMuted(video.muted || nextVolume === 0)
  }

  function changeLocalVolume(value: string) {
    const video = videoRef.current
    const nextVolume = Math.min(Math.max(Number(value), 0), 1)

    if (!video || !Number.isFinite(nextVolume)) {
      return
    }

    video.volume = nextVolume
    video.muted = nextVolume === 0
    syncLocalVolumeState(video)
    showControls(true)
  }

  function toggleLocalMute() {
    const video = videoRef.current

    if (!video) {
      return
    }

    if (video.muted || video.volume === 0) {
      video.volume = video.volume === 0 ? lastNonZeroVolumeRef.current : video.volume
      video.muted = false
    } else {
      video.muted = true
    }

    syncLocalVolumeState(video)
    showControls(true)
  }

  function requestFullscreen() {
    const target = playerRef.current
    const video = videoRef.current

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
      return
    }

    if (isIosBrowser() && requestNativeVideoFullscreen(video)) {
      return
    }

    if (target && typeof target.requestFullscreen === "function") {
      void target.requestFullscreen().catch(() => undefined)
      return
    }

    requestNativeVideoFullscreen(video)
  }

  function getCastPreflightError() {
    const castUrls = [
      playback.castDirectUrl,
      playback.castTranscodeUrl,
      playback.castDataSaverUrl,
      playback.castSubtitleUrl,
    ]

    for (const castUrl of castUrls) {
      const reason = getGoogleCastReceiverUrlUnavailableReason(castUrl)

      if (reason) {
        return reason
      }
    }

    return null
  }

  function getCastReceiverUrl(castUrl: string) {
    return new URL(castUrl, window.location.href).toString()
  }

  function getSelectedCastTextTrack(offsetSeconds = 0) {
    if (!selectedSubtitleStream) {
      return undefined
    }

    const trackUrl = getCastReceiverUrl(
      withSubtitleStream(playback.castSubtitleUrl, selectedSubtitleStream.id, {
        offsetSeconds,
      })
    )

    return {
      id: selectedSubtitleStream.index + 1,
      language: selectedSubtitleStream.language,
      label: subtitleLanguageLabel(selectedSubtitleStream.language),
      url: trackUrl,
    }
  }

  async function loadGoogleCastMedia(input: {
    session: GoogleCastSessionHandle
    url: string
    contentType: string
    shouldResume: boolean
    startTime: number
    textTrack?: CastTextTrack
    timeoutMs?: number | null
  }) {
    if (input.textTrack) {
      assertGoogleCastReceiverUrlReachable(input.textTrack.url)
    }

    const request = createGoogleCastLoadRequest({
      url: input.url,
      contentType: input.contentType,
      autoplay: input.shouldResume,
      currentTime: input.startTime,
      textTrack: input.textTrack,
    })

    if (!request) {
      throw new Error("Google Cast media request could not be created")
    }

    await input.session.loadMedia(request)

    return await waitForGoogleCastMediaLoad({
      session: input.session,
      contentId: input.url,
      timeoutMs: input.timeoutMs,
    })
  }

  function syncCastMediaState(state: GoogleCastMediaState) {
    if (
      castContentIdRef.current &&
      state.contentId &&
      state.contentId !== castContentIdRef.current
    ) {
      return
    }

    if (!state.isAlive) {
      handleCastEndedRef.current()
      return
    }

    const knownDuration = getStableDuration(
      durationSeconds,
      state.durationSeconds,
      duration
    )
    const sourcePosition = clampTime(
      castSourceStartOffsetRef.current + state.positionSeconds,
      knownDuration
    )

    updateWatchedProgress(sourcePosition, knownDuration)

    if (state.playerState === "PLAYING" || state.playerState === "BUFFERING") {
      resumeLocalAfterCastEndRef.current = true
      setIsPlaying(true)
    } else if (state.playerState === "PAUSED") {
      resumeLocalAfterCastEndRef.current = false
      setIsPlaying(false)
    }

    if (state.playerState === "IDLE") {
      if (state.idleReason === "FINISHED" && !castFinishedHandledRef.current) {
        castFinishedHandledRef.current = true
        completePlayback(sourcePosition, knownDuration)
        return
      }

      if (state.idleReason === "ERROR") {
        flashCastError(new Error("Google Cast receiver stopped playback."))
      }

      handleCastEndedRef.current()
    }
  }

  function attachCastMediaSync(session: GoogleCastSessionHandle, contentId: string) {
    clearCastMediaSync()
    castContentIdRef.current = contentId
    castFinishedHandledRef.current = false

    const emitCurrentState = () => {
      const state = getGoogleCastMediaState(session)

      if (state) {
        syncCastMediaState(state)
      }
    }

    castMediaCleanupRef.current = addGoogleCastMediaStateListener(
      session,
      syncCastMediaState
    )
    castProgressTimerRef.current = setInterval(emitCurrentState, 1000)
    emitCurrentState()
  }

  function suspendLocalVideoForCast() {
    const video = videoRef.current

    if (!video) {
      return
    }

    video.pause()
    video.muted = true
    video.removeAttribute("src")
    video.load()
    sourceUrlRef.current = null
    setSourceUrl(null)
  }

  function activateGoogleCastPlayback(
    session: GoogleCastSessionHandle,
    contentId: string,
    nextStatus: PlaybackStatusState,
    sourceStartOffset = 0
  ) {
    castSourceStartOffsetRef.current = Math.max(sourceStartOffset, 0)
    isCastLoadingRef.current = false
    isCastingRef.current = true
    castSelectionKeyRef.current = castSelectionKey
    setIsCasting(true)
    setStatus(nextStatus)
    statusRef.current = nextStatus
    endMediaWait()
    suspendLocalVideoForCast()
    attachCastMediaSync(session, contentId)
  }

  async function toggleGoogleCastPlayback() {
    const session = getGoogleCastSession()

    if (!session) {
      flashCastError(new Error("Google Cast session is missing"))
      console.error("Google Cast session is missing")
      handleCastEnded()
      return
    }

    try {
      if (isPlaying) {
        await pauseGoogleCastMedia(session)
        resumeLocalAfterCastEndRef.current = false
        setIsPlaying(false)
      } else {
        await playGoogleCastMedia(session)
        resumeLocalAfterCastEndRef.current = true
        setIsPlaying(true)
      }
    } catch (error) {
      flashCastError(error)
      console.error(error)
    }
  }

  function keepLocalPausedAfterFailedCastStart() {
    isCastLoadingRef.current = false
    isCastingRef.current = false
    resumeLocalAfterCastEndRef.current = false
    shouldAutoPlaySourceRef.current = false
    endMediaWait()
    restoreLocalSource({ preservePosition: true })
    setIsCasting(false)
    setIsPlaying(false)
    isPlayingRef.current = false
    showControls(true)
  }

  function pauseLocalPlaybackForCastAttempt(video: HTMLVideoElement) {
    video.pause()
    setIsPlaying(false)
    isPlayingRef.current = false
    showControls(true)
  }

  async function startGoogleCasting(
    video: HTMLVideoElement,
    shouldResume: boolean,
    startTimeOverride?: number
  ) {
    const context = getGoogleCastContext()

    if (!context) {
      return false
    }

    const startTime = startTimeOverride ?? getPlaybackPosition()
    const alreadyCasting = isCastingRef.current || isCastLoadingRef.current
    const canLocalDirect = supportsDirectPlayback({
      video,
      fileName,
      media,
      selectedAudioStream: playbackAudioStream,
    })
    const canCastDirect = supportsCastDirectPlayback({
      fileName,
      media,
      selectedAudioStream: playbackAudioStream,
    })
    const directFirst = quality === "original" && canCastDirect
    const directCastUsesOffset = directAudioRemuxActive && startTime > 0.25
    const directCastStartOffset = directCastUsesOffset ? startTime : 0
    const directCastRequestTime = directCastUsesOffset ? 0 : startTime
    const directCastUrl = getCastReceiverUrl(
      withStreamParams(playback.castDirectUrl, {
        audioStreamId: selectedAudioStreamId,
        startTime: directCastUsesOffset ? startTime : null,
        clientId: clientStreamIdRef.current,
      })
    )
    const castTranscodeBaseUrl =
      quality === "dataSaver" ? playback.castDataSaverUrl : playback.castTranscodeUrl
    const transcodeCastStartOffset = startTime > 0.25 ? startTime : 0
    const transcodeCastUrl = getCastReceiverUrl(
      withStreamParams(castTranscodeBaseUrl, {
        audioStreamId: selectedAudioStreamId,
        startTime: transcodeCastStartOffset,
        clientId: clientStreamIdRef.current,
      })
    )
    const directTextTrack = getSelectedCastTextTrack(directCastStartOffset)
    const transcodeTextTrack = getSelectedCastTextTrack(transcodeCastStartOffset)
    const localFallbackStatus =
      quality === "original" && (canLocalDirect || !liveTranscodeEnabled)
        ? "direct"
        : "transcoding"
    const localFallbackSource =
      localFallbackStatus === "direct" ? getDirectUrl() : getTranscodeUrl(quality)

    if (!alreadyCasting) {
      localPlaybackBeforeCastRef.current = {
        sourceUrl: sourceUrlRef.current ?? localFallbackSource,
        status: localFallbackStatus,
        quality,
        directPossible: canLocalDirect,
        position: startTime,
        wasMuted: video.muted,
      }
      resumeLocalAfterCastEndRef.current = shouldResume
      video.muted = true
      video.pause()
      setIsPlaying(false)
      isPlayingRef.current = false
    }

    isCastLoadingRef.current = true
    beginMediaWait(false)
    showControls(true)

    const session = getGoogleCastSession() ?? (await requestGoogleCastSession())

    try {
      await setGoogleCastReceiverVolumeOnce(session, 1)
    } catch (error) {
      reportCastError(error)
      console.error(error)
    }

    if (directFirst) {
      try {
        assertGoogleCastReceiverUrlReachable(directCastUrl)
        const result = await loadGoogleCastMedia({
          session,
          url: directCastUrl,
          contentType: getCastDirectContentType(fileName, directAudioRemuxActive),
          shouldResume,
          startTime: directCastRequestTime,
          textTrack: directTextTrack,
          timeoutMs: 60_000,
        })
        if (result === "loaded") {
          activateGoogleCastPlayback(
            session,
            directCastUrl,
            "direct",
            directCastStartOffset
          )
          return true
        }

        if (result === "failed") {
          const fallbackError = new Error(
            liveTranscodeEnabled
              ? "Direct cast failed on the receiver. Switching to transcoded stream."
              : "Direct cast failed on the receiver, and live transcoding is disabled."
          )
          reportCastError(fallbackError)
          console.error(fallbackError)
        }
      } catch (error) {
        reportCastError(error)
        console.error(error)
      }
    }

    if (!liveTranscodeEnabled) {
      safeEndGoogleCastSession(session, true)
      flashCastError(
        new Error("Live transcoding is disabled when TRANSCODE_ACCEL=cpu.")
      )
      keepLocalPausedAfterFailedCastStart()
      return false
    }

    setStatus("transcoding")
    beginMediaWait(true)
    try {
      assertGoogleCastReceiverUrlReachable(transcodeCastUrl)
      const result = await loadGoogleCastMedia({
        session,
        url: transcodeCastUrl,
        contentType: "video/mp4",
        shouldResume,
        startTime: 0,
        textTrack: transcodeTextTrack,
        timeoutMs: null,
      })

      if (result === "loaded") {
        activateGoogleCastPlayback(
          session,
          transcodeCastUrl,
          "transcoding",
          transcodeCastStartOffset
        )
        return true
      }

      safeEndGoogleCastSession(session, true)
      flashCastError(new Error("Cast receiver could not load the stream."))
      console.error("Cast receiver could not load the stream.")
      keepLocalPausedAfterFailedCastStart()
      return false
    } catch (error) {
      safeEndGoogleCastSession(session, true)
      flashCastError(
        error instanceof Error && error.message === googleCastUnreachableUrlErrorCode
          ? new Error(googleCastMediaUrlMessage)
          : error
      )
      console.error(error)
      keepLocalPausedAfterFailedCastStart()
      return false
    }
  }

  useEffect(() => {
    startGoogleCastingRef.current = startGoogleCasting
  })

  useEffect(() => {
    if (!isCasting) {
      castSelectionKeyRef.current = castSelectionKey
      return
    }

    if (castSelectionKeyRef.current === castSelectionKey) {
      return
    }

    const video = videoRef.current

    if (!video) {
      return
    }

    castSelectionKeyRef.current = castSelectionKey
    void startGoogleCastingRef.current(video, isPlayingRef.current, getPlaybackPosition())
  }, [castSelectionKey, getPlaybackPosition, isCasting])

  function getNativeRemotePlaybackUrl(startTime: number) {
    const nativeRemoteBaseUrl = liveTranscodeEnabled
      ? quality === "dataSaver"
        ? playback.castDataSaverUrl
        : playback.castTranscodeUrl
      : playback.castDirectUrl

    return getCastReceiverUrl(
      withStreamParams(nativeRemoteBaseUrl, {
        audioStreamId: selectedAudioStreamId,
        startTime,
        clientId: clientStreamIdRef.current,
      })
    )
  }

  async function startNativeRemotePlayback(video: HTMLVideoElement) {
    const startTime = getPlaybackPosition()
    const nativeRemoteUrl = getNativeRemotePlaybackUrl(startTime)
    const canLocalDirect = supportsDirectPlayback({
      video,
      fileName,
      media,
      selectedAudioStream: playbackAudioStream,
    })
    const localFallbackStatus =
      quality === "original" && (canLocalDirect || !liveTranscodeEnabled)
        ? "direct"
        : "transcoding"
    const localFallbackSource =
      localFallbackStatus === "direct" ? getDirectUrl() : getTranscodeUrl(quality)
    const nextStatus: PlaybackStatusState = liveTranscodeEnabled ? "transcoding" : "direct"

    localPlaybackBeforeCastRef.current = {
      sourceUrl: sourceUrlRef.current ?? localFallbackSource,
      status: localFallbackStatus,
      quality,
      directPossible: canLocalDirect,
      position: startTime,
      wasMuted: video.muted,
    }
    resumeLocalAfterCastEndRef.current = true
    castContentIdRef.current = nativeRemoteUrl
    castSourceStartOffsetRef.current = startTime
    activeSourceStartRef.current = startTime
    currentTimeRef.current = startTime
    pendingSeekRef.current = null
    sourceSwitchPauseSuppressionUntilRef.current = Date.now() + 5000
    sourceUrlRef.current = nativeRemoteUrl
    statusRef.current = nextStatus
    setStatus(nextStatus)
    setSourceUrl(nativeRemoteUrl)
    setCurrentTime(startTime)
    setNativeRemoteCastingState(true)
    setIsCastStarting(true)
    isCastLoadingRef.current = true
    beginMediaWait(nextStatus === "transcoding")
    showControls(true)

    video.muted = false
    video.src = nativeRemoteUrl
    video.load()

    const playPromise = video.play()

    if (!requestNativeRemotePlayback(video)) {
      void playPromise.catch(() => undefined)
      video.pause()
      setNativeRemoteCastingState(false)
      setIsCastStarting(false)
      isCastLoadingRef.current = false
      endMediaWait()
      restoreLocalSource({ preservePosition: true })
      throw new Error("Native casting is not available right now.")
    }

    try {
      await playPromise
      setIsPlaying(true)
      isPlayingRef.current = true
      endMediaWait()
    } catch (error) {
      setNativeRemoteCastingState(false)
      setIsCastStarting(false)
      isCastLoadingRef.current = false
      endMediaWait()
      restoreLocalSource({ preservePosition: true })
      throw error
    }

    nativeRemoteFallbackTimerRef.current = setTimeout(() => {
      nativeRemoteFallbackTimerRef.current = null
      isCastLoadingRef.current = false
      setIsCastStarting(false)

      if (!isNativeRemotePlaybackConnected(video)) {
        return
      }

      setNativeRemoteCastingState(true)
    }, 3000)
  }

  async function startCasting() {
    const video = videoRef.current

    if (!video || !sourceUrl) {
      flashCastError(new Error("Casting cannot start until media is loaded."))
      console.error("Casting cannot start until media is loaded.")
      return
    }

    if (castStartPromiseRef.current || isCastLoadingRef.current) {
      showControls(true)
      return
    }

    if (isIosBrowser()) {
      if (!canUseNativeRemotePlaybackFallback(video, nativeRemotePlaybackAvailable)) {
        flashCastError(
          new Error(
            nativeRemotePlaybackSupported
              ? "No nearby playback target is available. Make sure Chrome has Local Network permission and the receiver is on the same Wi-Fi."
              : "Native casting is not available in this iPhone browser."
          )
        )
        return
      }

      try {
        await startNativeRemotePlayback(video)
      } catch (error) {
        flashCastError(error)
        console.error(error)
      } finally {
        setIsCastStarting(false)
        isCastLoadingRef.current = false
      }

      return
    }

    const startTime = getPlaybackPosition()
    const shouldResume = !video.paused || isPlayingRef.current || startTime <= 0.35
    const castPreflightError = getCastPreflightError()
    const senderPreflightError = getGoogleCastCurrentPageSenderUnavailableReason()
    const googleCastReady =
      !senderPreflightError &&
      !castPreflightError &&
      (Boolean(getGoogleCastContext()) || (await ensureGoogleCastFramework()))

    if (!googleCastReady) {
      flashCastError(
        new Error(
          getGoogleCastUnavailableMessage({
            castPreflightError,
            senderPreflightError,
          })
        )
      )
      return
    }

    pauseLocalPlaybackForCastAttempt(video)

    const startPromise = startGoogleCasting(video, shouldResume, startTime)
    castStartPromiseRef.current = startPromise
    setIsCastStarting(true)

    try {
      await startPromise
    } catch (error) {
      flashCastError(error)
      keepLocalPausedAfterFailedCastStart()
    } finally {
      if (castStartPromiseRef.current === startPromise) {
        castStartPromiseRef.current = null
      }
      setIsCastStarting(false)
    }
  }

  function handleNativeRemoteEnded() {
    const video = videoRef.current
    const castPosition = currentTimeRef.current
    const shouldResumeLocal = resumeLocalAfterCastEndRef.current

    clearNativeRemoteFallbackTimer()
    video?.pause()
    castContentIdRef.current = null
    castSourceStartOffsetRef.current = 0
    castFinishedHandledRef.current = false
    castStartPromiseRef.current = null
    setIsCastStarting(false)
    isCastLoadingRef.current = false
    setNativeRemoteCastingState(false)
    setIsPlaying(false)
    isPlayingRef.current = false
    endMediaWait()

    if (localPlaybackBeforeCastRef.current) {
      localPlaybackBeforeCastRef.current = {
        ...localPlaybackBeforeCastRef.current,
        position: castPosition,
      }
    }

    shouldAutoPlaySourceRef.current = shouldResumeLocal
    resumeLocalAfterCastEndRef.current = false
    restoreLocalSource({ preservePosition: true })
    showControls(true)
  }

  function handleCastEnded() {
    const video = videoRef.current
    const castPosition = currentTimeRef.current
    const shouldResumeLocal = resumeLocalAfterCastEndRef.current

    video?.pause()
    clearCastMediaSync()
    castContentIdRef.current = null
    castSourceStartOffsetRef.current = 0
    castFinishedHandledRef.current = false
    castStartPromiseRef.current = null
    setIsCastStarting(false)
    isCastLoadingRef.current = false
    isCastingRef.current = false
    setIsCasting(false)
    setNativeRemoteCastingState(false)
    setIsPlaying(false)
    isPlayingRef.current = false
    endMediaWait()

    if (localPlaybackBeforeCastRef.current) {
      localPlaybackBeforeCastRef.current = {
        ...localPlaybackBeforeCastRef.current,
        position: castPosition,
      }
    }

    shouldAutoPlaySourceRef.current = shouldResumeLocal
    resumeLocalAfterCastEndRef.current = false
    restoreLocalSource({ preservePosition: true })
    showControls(true)
  }

  useEffect(() => {
    handleCastEndedRef.current = handleCastEnded
  })

  function stopCasting() {
    const video = videoRef.current

    if (!video) {
      return
    }

    if (isNativeRemoteCastingRef.current) {
      handleNativeRemoteEnded()
      return
    }

    safeEndGoogleCastSession(getGoogleCastSession(), true)
    handleCastEnded()
  }

  function handleProgress(event: React.SyntheticEvent<HTMLVideoElement>) {
    const estimatedMbps = streamMbps

    if (!estimatedMbps || estimatedMbps <= 0) {
      streamStatsSampleRef.current = null
      return
    }

    const bufferedEnd = getBufferedEnd(event.currentTarget)
    const sampledAt = performance.now()
    const previousSample = streamStatsSampleRef.current

    streamStatsSampleRef.current = { bufferedEnd, sampledAt }

    if (!previousSample) {
      return
    }

    const elapsedSeconds = (sampledAt - previousSample.sampledAt) / 1000
    const bufferedSeconds = bufferedEnd - previousSample.bufferedEnd

    if (elapsedSeconds < 0.75 || bufferedSeconds <= 0) {
      return
    }
  }

  function handleTimeUpdate(event: React.SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget
    const sourceOffset = activeSourceStartRef.current
    const watchedSeconds = sourceOffset + video.currentTime
    const measuredDuration = Number.isFinite(video.duration)
      ? video.duration + sourceOffset
      : undefined

    updateWatchedProgress(watchedSeconds, measuredDuration)
  }

  function handlePause() {
    const video = videoRef.current

    if (
      shouldAutoPlaySourceRef.current &&
      Date.now() < sourceSwitchPauseSuppressionUntilRef.current
    ) {
      return
    }

    setIsPlaying(false)
    showControls(true)

    if (!video || video.ended) {
      return
    }

    void saveProgress(
      getPlaybackPosition(),
      getStableDuration(
        durationSeconds,
        Number.isFinite(video.duration) ? video.duration : undefined,
        duration
      ),
      false
    )
  }

  function handleEnded() {
    const video = videoRef.current
    const endedTime = video ? getPlaybackPosition() : currentTime
    const knownDuration = getStableDuration(
      durationSeconds,
      Number.isFinite(video?.duration) ? video?.duration : undefined,
      duration
    )

    completePlayback(endedTime, knownDuration)
  }

  function changeQuality(nextQuality: PlaybackProfile) {
    if (!liveTranscodeEnabled || (dataSaverBlockedByDirect && nextQuality === "dataSaver")) {
      setQuality("original")
      showControls(true)
      return
    }

    if (dataSaverProtectionKey === playbackKey && nextQuality !== "dataSaver") {
      setQuality("dataSaver")
      showPriorityInfoMessage({
        type: "protectedDataSaver",
        message:
          "Data Saver protection is active for the rest of this episode because your stream was downgraded twice within 5 minutes.",
        createdAt: new Date().toISOString(),
      })
      showControls(true)
      return
    }

    const video = videoRef.current
    const wasPlaying = Boolean(video && !video.paused) || isPlayingRef.current

    shouldAutoPlaySourceRef.current = wasPlaying
    if (wasPlaying) {
      beginMediaWait(nextQuality !== "original" || statusRef.current === "transcoding")
    }
    setQuality(nextQuality)
    showControls(true)
  }

  function changeAudio(nextAudioStreamId: string | null) {
    const nextAudioStream = media.audioStreams.find(
      (stream) => stream.id === nextAudioStreamId
    )
    const nextSubtitleStream = selectSubtitleForAudio(
      nextAudioStream,
      media.subtitleStreams
    )
    const video = videoRef.current
    const wasPlaying = Boolean(video && !video.paused) || isPlayingRef.current
    const nextDirectAudioRemuxActive = shouldUseDirectAudioRemux(
      nextAudioStreamId,
      media.directAudioStreamId
    )
    const sourceWillReload =
      statusRef.current === "transcoding" ||
      (statusRef.current === "direct" &&
        (directAudioRemuxActive || nextDirectAudioRemuxActive))

    shouldAutoPlaySourceRef.current = wasPlaying

    if (sourceWillReload && wasPlaying) {
      beginMediaWait(statusRef.current === "transcoding")
    }

    setSelectedAudioStreamId(nextAudioStreamId)
    setSelectedSubtitleStreamId(nextSubtitleStream?.id ?? null)

    if (video && statusRef.current === "direct" && !sourceWillReload) {
      const switchedTrack = applyDirectAudioTrack(
        video,
        nextAudioStream,
        media.audioStreams
      )

      if (!switchedTrack && nextDirectAudioRemuxActive && wasPlaying) {
        beginMediaWait(false)
      }
    }

    showControls(true)
  }

  function changeSubtitle(nextSubtitleStreamId: string | null) {
    setSelectedSubtitleStreamId(nextSubtitleStreamId)
    showControls(true)
  }

  function runTouchControlAction(
    event: React.PointerEvent<HTMLElement>,
    action: () => void
  ) {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    touchControlClickSuppressionRef.current = true
    action()

    window.setTimeout(() => {
      touchControlClickSuppressionRef.current = false
    }, 400)
  }

  function runClickControlAction(
    event: React.MouseEvent<HTMLElement>,
    action: () => void
  ) {
    event.stopPropagation()

    if (touchControlClickSuppressionRef.current) {
      event.preventDefault()
      touchControlClickSuppressionRef.current = false
      return
    }

    action()
  }

  const displayedCurrentTime = seekPreview ?? currentTime
  const currentPlaybackKey = `${animeId}:${seasonNumber}:${episodeNumber}`
  const playerAspectRatio =
    detectedPlayerAspectRatio?.playbackKey === currentPlaybackKey
      ? detectedPlayerAspectRatio.aspectRatio
      : getPreferredPlayerAspectRatio(media.videoWidth, media.videoHeight)
  const canSkipIntro = duration > 90 && currentTime < 90
  const canSkipOutro = duration > 0 && currentTime >= duration * 0.8 && currentTime < duration - 1
  const castSkipLabel = canSkipIntro ? "Skip intro" : canSkipOutro ? "Skip outro" : "Skip intro/outro"
  const isAnyCasting = isCasting || isNativeRemoteCasting
  const shouldBlockMobilePortraitPlayback =
    isMobilePortraitViewport && !isAnyCasting && !isFullscreen
  const controlsAreVisible =
    !shouldBlockMobilePortraitPlayback &&
    (controlsVisible || !isPlaying || isAnyCasting || settingsOpen)
  const castPreflightError = getCastPreflightError()
  const nativeCastUnavailableLabel = nativeRemotePlaybackSupported
    ? "No nearby playback target"
    : "Native casting is not available"
  const castButtonLabel = isIosDevice
    ? nativeRemotePlaybackAvailable
      ? "Cast / AirPlay"
      : nativeCastUnavailableLabel
    : castPreflightError ?? "Google Cast"
  const castButtonDisabled =
    !sourceUrl || isCastStarting || (isIosDevice && !nativeRemotePlaybackAvailable)
  const centerToggleVisible =
    !shouldBlockMobilePortraitPlayback &&
    !isWaitingForMedia &&
    !isAnyCasting &&
    (!isPlaying || controlsAreVisible)
  const settingsPanelClass = `fixed left-1/2 z-[100] w-[min(24rem,calc(100vw-1.5rem))] -translate-x-1/2 space-y-3 overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-zinc-950/95 p-3 text-xs shadow-2xl backdrop-blur lg:p-4 lg:text-sm ${
    isPortraitViewport
      ? "top-[20dvh] max-h-[calc(80dvh-1rem)]"
      : "top-1/2 max-h-[calc(100dvh-2rem)] -translate-y-1/2"
  }`
  const settingsSelectClass =
    "h-8 w-full rounded-md lg:h-10 border border-white/10 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-violet-400"
  return (
    <div className="space-y-3 lg:space-y-4">
      <div
        ref={playerRef}
        className={`group/player relative overflow-hidden rounded-xl border border-white/10 bg-black shadow-[0_28px_90px_rgba(0,0,0,0.45)] ${
          controlsAreVisible ? "" : "cursor-none"
        }`}
        style={{ aspectRatio: playerAspectRatio }}
        onClick={(event) => {
          if (isPlayerControlTarget(event.target)) {
            return
          }

          void togglePlay()
        }}
        onPointerDown={() => showControls(true)}
        onPointerMove={() => showControls()}
        onMouseLeave={() => {
          if (isPlaying && !isCasting) {
            setControlsVisible(false)
            setSettingsOpen(false)
          }
        }}
      >
        <video
          ref={videoRef}
          className={`yamibunko-player-video block h-full w-full bg-black object-cover transition-opacity ${
            isAnyCasting ? "opacity-0" : "opacity-100"
          }`}
          playsInline
          preload="none"
          poster={thumbnailUrl}
          src={sourceUrl ?? undefined}
          onDurationChange={(event) => {
            const nextDuration = getStableDuration(
              durationSeconds,
              event.currentTarget.duration,
              duration
            )

            if (nextDuration > 0) {
              setDuration(nextDuration)
            }
          }}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget
            const nextAspectRatio = getPreferredPlayerAspectRatio(
              video.videoWidth,
              video.videoHeight
            )

            setDetectedPlayerAspectRatio({
              playbackKey: currentPlaybackKey,
              aspectRatio: nextAspectRatio,
            })
            applyPendingSeek(video)
            applyDirectAudioTrack(video, selectedAudioStream, media.audioStreams)
          }}
          onEnded={handleEnded}
          onError={() => {
            if (
              isCastingRef.current ||
              isCastLoadingRef.current ||
              bandwidthRecheckHoldRef.current
            ) {
              return
            }

            setIsPlaying(false)
            endMediaWait()
            if (
              status === "direct" &&
              quality === "original" &&
              !directFallbackAttemptedRef.current
            ) {
              fallbackDirectToTranscode()
              return
            }

            setStatus("blocked")
            showControls(true)
          }}
          onLoadStart={() => {
            if (isPlaying || shouldAutoPlaySourceRef.current) {
              beginMediaWait()
            }
          }}
          onLoadedData={(event) => {
            applyPendingSeek(event.currentTarget)
            endMediaWait()
          }}
          onCanPlay={(event) => {
            applyPendingSeek(event.currentTarget)
            endMediaWait()
          }}
          onPause={handlePause}
          onPlay={(event) => {
            if (shouldBlockMobilePortraitPlayback && !isNativeRemoteCastingRef.current) {
              event.currentTarget.pause()
              setIsPlaying(false)
              endMediaWait()
              showControls(true)
              return
            }

            sourceSwitchPauseSuppressionUntilRef.current = 0
            setIsPlaying(true)
            showControls()
          }}
          onPlaying={(event) => {
            if (shouldBlockMobilePortraitPlayback && !isNativeRemoteCastingRef.current) {
              event.currentTarget.pause()
              setIsPlaying(false)
              endMediaWait()
              showControls(true)
              return
            }

            sourceSwitchPauseSuppressionUntilRef.current = 0
            setIsPlaying(true)
            endMediaWait()
            showControls()
          }}
          onWaiting={() => beginMediaWait()}
          onTimeUpdate={handleTimeUpdate}
          onProgress={handleProgress}
          onVolumeChange={(event) => syncLocalVolumeState(event.currentTarget)}
        />

        {shouldBlockMobilePortraitPlayback ? (
          <div
            className="absolute inset-0 z-40 grid place-items-center overflow-hidden bg-zinc-950 text-white"
            aria-live="polite"
          >
            <div className="absolute inset-0 animate-pulse bg-[radial-gradient(circle_at_50%_30%,rgba(168,85,247,0.18),transparent_34%),linear-gradient(180deg,rgba(24,24,27,0.85),rgba(0,0,0,0.98))]" />
            <div className="relative flex flex-col items-center gap-4 px-6 text-center">
              <div className="grid size-20 place-items-center rounded-full border border-violet-300/30 bg-white/[0.06] text-violet-200 shadow-2xl sm:size-24">
                <RefreshCw className="size-10 sm:size-12" />
              </div>
              <div className="text-2xl font-semibold tracking-wide text-zinc-100 sm:text-3xl">
                rotate to play
              </div>
              <Button
                type="button"
                variant="secondary"
                className={`h-11 rounded-2xl border border-white/15 bg-zinc-950/70 px-5 text-sm font-medium text-white shadow-xl hover:border-white/25 hover:bg-zinc-900 disabled:opacity-45 ${
                  castErrorFlash
                    ? "border-red-500/70 text-red-300 ring-2 ring-red-500/40"
                    : ""
                }`}
                aria-label={castButtonLabel}
                disabled={castButtonDisabled}
                onClick={(event) => {
                  event.stopPropagation()
                  void startCasting()
                }}
              >
                <Cast className="size-4" />
                <span>Cast</span>
              </Button>
              {castErrorMessage ? (
                <div className="max-w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-red-400/30 bg-red-950/90 px-4 py-3 text-sm font-semibold text-white shadow-2xl backdrop-blur">
                  {castErrorMessage}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {isAnyCasting ? (
          <div className="absolute inset-0 bg-black text-white">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_18%,rgba(127,29,29,0.2),transparent_36%),linear-gradient(180deg,rgba(24,24,27,0.32),rgba(0,0,0,0.82))]" />

            <div className="relative z-10 flex h-full flex-col items-center px-4 py-4 sm:px-6 lg:px-10 lg:py-8">
              <div className="flex w-full justify-center">
                <div className="flex w-full max-w-5xl flex-wrap items-center justify-center gap-3 rounded-3xl border border-white/10 bg-zinc-950/35 p-2 shadow-2xl backdrop-blur-md sm:w-auto sm:p-3">
                  <HoverHint label="Stop casting">
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-12 rounded-2xl border border-white/30 bg-zinc-950/70 px-4 text-sm font-medium text-white shadow-xl hover:border-white/45 hover:bg-zinc-900 disabled:opacity-45 lg:h-14 lg:px-5 lg:text-base"
                      aria-label="Stop casting"
                      onClick={(event) => {
                        event.stopPropagation()
                        stopCasting()
                      }}
                    >
                      <RadioOffIcon className="size-5 lg:size-6" />
                      <span>Stop casting</span>
                    </Button>
                  </HoverHint>

                  <Button
                    type="button"
                    variant="secondary"
                    className="h-12 rounded-2xl border border-white/30 bg-zinc-950/70 px-6 text-sm font-medium text-white shadow-xl hover:border-white/45 hover:bg-zinc-900 disabled:opacity-45 lg:h-14 lg:px-8 lg:text-base"
                    disabled={!canSkipIntro && !canSkipOutro}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (canSkipIntro) {
                        void seekTo(Math.min(currentTime + 90, duration))
                        return
                      }
                      if (canSkipOutro) {
                        void seekTo(duration)
                      }
                    }}
                  >
                    {castSkipLabel}
                  </Button>
                </div>
              </div>

              <div className="flex min-h-0 w-full flex-1 items-center justify-center py-4 lg:py-8">
                <div className="grid grid-cols-4 items-center gap-2 rounded-[2rem] border border-white/10 bg-zinc-950/35 p-3 shadow-2xl backdrop-blur-md sm:gap-4 sm:p-4 lg:gap-5 lg:p-5">
                  <HoverHint label="Previous episode">
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-14 rounded-2xl border border-white/10 bg-white/[0.06] text-white shadow-xl hover:border-white/20 hover:bg-white/10 disabled:opacity-35 sm:size-16 lg:size-20"
                      disabled={!previousEpisode}
                      aria-label="Previous episode"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (previousEpisode && onEpisodeChange) {
                          onEpisodeChange(previousEpisode, isPlayingRef.current)
                        }
                      }}
                    >
                      <SkipBack className="size-8 sm:size-9 lg:size-11" />
                    </Button>
                  </HoverHint>

                  <HoverHint label={isPlaying ? "Pause" : "Play"}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-14 rounded-2xl border border-white/10 bg-white/[0.06] text-white shadow-xl hover:border-white/20 hover:bg-white/10 disabled:opacity-35 sm:size-16 lg:size-20"
                      disabled={!isAnyCasting}
                      aria-label={isPlaying ? "Pause" : "Play"}
                      onClick={(event) => {
                        event.stopPropagation()
                        void togglePlay()
                      }}
                    >
                      {isPlaying ? (
                        <Pause className="size-8 sm:size-9 lg:size-11" />
                      ) : (
                        <Play className="ml-1 size-8 sm:size-9 lg:size-11" />
                      )}
                    </Button>
                  </HoverHint>

                  <HoverHint label="Next episode">
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-14 rounded-2xl border border-white/10 bg-white/[0.06] text-white shadow-xl hover:border-white/20 hover:bg-white/10 disabled:opacity-35 sm:size-16 lg:size-20"
                      disabled={!nextEpisode}
                      aria-label="Next episode"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (nextEpisode && onEpisodeChange) {
                          onEpisodeChange(nextEpisode, isPlayingRef.current)
                        }
                      }}
                    >
                      <SkipForward className="size-8 sm:size-9 lg:size-11" />
                    </Button>
                  </HoverHint>

                  <div ref={settingsButtonRef}>
                    <HoverHint label="Settings">
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        className="size-14 rounded-2xl border border-white/10 bg-white/[0.06] text-white shadow-xl hover:border-white/20 hover:bg-white/10 sm:size-16 lg:size-20"
                        onClick={(event) => {
                          event.stopPropagation()
                          setSettingsOpen((open) => !open)
                          showControls(true)
                        }}
                        aria-label="Settings"
                      >
                        <Settings className="size-8 sm:size-9 lg:size-11" />
                      </Button>
                    </HoverHint>
                  </div>
                </div>
              </div>

              <div className="w-full max-w-5xl pb-1 sm:pb-2 lg:pb-4">
                <div className="relative rounded-3xl border border-white/10 bg-zinc-950/35 px-4 py-4 shadow-2xl backdrop-blur-md sm:px-6 lg:px-8 lg:py-5">
                  {seekPreviewFrame ? (
                    <div
                      className="pointer-events-none absolute bottom-[5.7rem] z-10 w-48 -translate-x-1/2 overflow-hidden rounded-xl border border-white/15 bg-zinc-950 shadow-2xl lg:bottom-[6.5rem] lg:w-64"
                      style={{ left: `${seekPreviewFrame.leftPercent}%` }}
                    >
                      {getSeekPreviewFrameUrl(seekPreviewFrame.time) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={getSeekPreviewFrameUrl(seekPreviewFrame.time) ?? undefined}
                          alt=""
                          className="aspect-video w-full object-cover"
                        />
                      ) : null}
                      <div className="px-2 py-1.5 text-center text-xs font-medium text-zinc-200 tabular-nums lg:text-sm">
                        {formatTime(seekPreviewFrame.time)}
                      </div>
                    </div>
                  ) : null}

                  <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={0.25}
                    value={duration ? Math.min(displayedCurrentTime, duration) : 0}
                    onChange={(event) => updateSeekDragPreview(event.target.value)}
                    onPointerMove={(event) =>
                      updateSeekHoverPreview(event.currentTarget, event.clientX)
                    }
                    onPointerLeave={() => {
                      if (seekPreview === null) {
                        clearSeekPreviewFrame()
                      }
                    }}
                    onPointerUp={(event) => commitSeekInput(event.currentTarget.value)}
                    onPointerCancel={clearSeekPreviewFrame}
                    onKeyUp={(event) => commitSeekInput(event.currentTarget.value)}
                    onBlur={(event) => commitSeekInput(event.currentTarget.value)}
                    disabled={!duration}
                    className="h-4 w-full accent-red-600 lg:h-5"
                    aria-label="Seek cast playback"
                  />
                  {!isPhoneViewport ? (
                    <div className="mt-3 text-center text-2xl font-semibold tracking-wide text-zinc-100 tabular-nums lg:mt-4 lg:text-4xl">
                      {formatTime(displayedCurrentTime)} / {formatTime(duration)}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {isWaitingForMedia ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="size-12 animate-spin text-white/80" />
              {showHardwareWait ? (
                <div className="rounded-lg border border-orange-400/40 bg-orange-500/15 px-3 py-2 text-sm font-medium text-orange-100">
                  Waiting for available Hardware Slot
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {priorityInfo ? (
          <HoverHint
            label={priorityInfo.message}
            side="bottom"
            align="end"
            clickVisibleMs={null}
            className="absolute top-4 right-4 z-20"
            contentClassName="w-72 whitespace-normal border-violet-300/30 bg-violet-950/95 text-violet-50"
          >
            <button
              type="button"
              className="grid size-9 place-items-center rounded-full border border-violet-300/35 bg-violet-950/80 text-violet-100 shadow-2xl backdrop-blur transition hover:bg-violet-900/90 hover:text-white"
              onClick={(event) => event.stopPropagation()}
              aria-label="Playback priority info"
            >
              <Info className="size-4 lg:size-5" />
            </button>
          </HoverHint>
        ) : null}

        <HoverHint
          label={isPlaying ? "Pause" : "Play"}
          className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-150 ${
            centerToggleVisible ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <button
            type="button"
            className="grid size-20 place-items-center lg:size-24 rounded-full bg-black/45 text-white/70 hover:bg-black/60 hover:text-white"
            disabled={!sourceUrl}
            onPointerUp={(event) =>
              runTouchControlAction(event, () => {
                void togglePlay()
              })
            }
            onClick={(event) =>
              runClickControlAction(event, () => {
                void togglePlay()
              })
            }
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <Pause className="size-10 lg:size-12" />
            ) : (
              <Play className="ml-1 size-10 lg:size-12" />
            )}
          </button>
        </HoverHint>

        {controlsAreVisible && !isAnyCasting && canSkipIntro ? (
          <Button
            type="button"
            variant="secondary"
            className="absolute right-4 bottom-20 z-20 rounded-lg bg-zinc-950/60"
            onClick={(event) => {
              event.stopPropagation()
              void seekTo(Math.min(currentTime + 90, duration))
            }}
          >
            Skip intro
          </Button>
        ) : null}
        {controlsAreVisible && !isAnyCasting && !canSkipIntro && canSkipOutro ? (
          <Button
            type="button"
            variant="secondary"
            className="absolute right-4 bottom-20 z-20 rounded-lg bg-zinc-950/60"
            onClick={(event) => {
              event.stopPropagation()
              void seekTo(duration)
            }}
          >
            Skip outro
          </Button>
        ) : null}

        {activeSubtitleTexts.length && !isAnyCasting ? (
          <div className="pointer-events-none absolute inset-x-4 bottom-[5.25rem] z-10 flex justify-center px-4 text-center text-lg lg:bottom-24 font-semibold leading-snug text-white drop-shadow-[0_2px_5px_rgba(0,0,0,0.95)] sm:text-xl">
            <div className="max-w-[90%] whitespace-pre-line">
              {activeSubtitleTexts.join("\n")}
            </div>
          </div>
        ) : null}


        {castErrorMessage ? (
          <div className="pointer-events-none absolute inset-x-4 bottom-[5.25rem] z-30 flex justify-center lg:bottom-24">
            <div className="max-w-[min(34rem,calc(100vw-2rem))] rounded-xl border border-red-400/30 bg-red-950/90 px-4 py-3 text-sm font-semibold text-white shadow-2xl backdrop-blur">
              {castErrorMessage}
            </div>
          </div>
        ) : null}

        {settingsOpen && !shouldBlockMobilePortraitPlayback ? (
          <div
            ref={settingsPanelRef}
            className={settingsPanelClass}
            onClick={(event) => event.stopPropagation()}
          >
            {showQualityControl ? (
              <label className="grid gap-1 text-zinc-300">
                <span>Quality</span>
                <select
                  className={settingsSelectClass}
                  value={quality}
                  onChange={(event) =>
                    changeQuality(event.target.value as PlaybackProfile)
                  }
                >
                  <option value="original">Full Quality</option>
                  <option value="dataSaver">Data Saver</option>
                </select>
              </label>
            ) : null}

            {liveTranscodeEnabled ? (
              <div className="grid gap-1 text-zinc-300">
                <span>Display Method</span>
                <div className="rounded-md border border-white/10 bg-zinc-950 px-2 py-1.5 text-zinc-100 lg:px-3 lg:py-2">
                  {displayMethod}
                </div>
              </div>
            ) : null}

            <label className="grid gap-1 text-zinc-300">
              <span>Audio Language</span>
              <select
                className={settingsSelectClass}
                value={selectedAudioStreamId ?? ""}
                onChange={(event) => changeAudio(event.target.value || null)}
              >
                {media.audioStreams.length ? null : <option value="">Default</option>}
                {media.audioStreams.map((stream) => (
                  <option key={stream.id} value={stream.id}>
                    {stream.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-1 text-zinc-300">
              <span>Subtitle Language</span>
              <select
                className={settingsSelectClass}
                value={selectedSubtitleStreamId ?? ""}
                onChange={(event) => changeSubtitle(event.target.value || null)}
              >
                <option value="">Off</option>
                {subtitleLanguageOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {status === "blocked" && directPossible ? (
              <Button
                type="button"
                variant="secondary"
                className="w-full rounded-lg bg-zinc-900"
                onClick={tryDirectPlay}
              >
                Try Direct Play
              </Button>
            ) : null}
          </div>
        ) : null}

        {!isAnyCasting ? (
          <div
          className={`absolute inset-x-0 bottom-0 bg-zinc-950/40 p-3 backdrop-blur-md lg:p-4 transition-opacity duration-300 ${
            controlsAreVisible ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <div className="flex items-center gap-2 lg:gap-3">
            <HoverHint label={isPlaying ? "Pause" : "Play"}>
              <Button
                type="button"
                size="icon"
                onPointerUp={(event) =>
                  runTouchControlAction(event, () => {
                    void togglePlay()
                  })
                }
                onClick={(event) =>
                  runClickControlAction(event, () => {
                    void togglePlay()
                  })
                }
                disabled={!sourceUrl && !isCasting}
                aria-label={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? (
                  <Pause className="size-4 lg:size-5" />
                ) : (
                  <Play className="size-4 lg:size-5" />
                )}
              </Button>
            </HoverHint>
            <HoverHint label="Previous episode">
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="bg-zinc-950/70"
                onClick={() => {
                  if (previousEpisode && onEpisodeChange) {
                    onEpisodeChange(previousEpisode, isPlayingRef.current)
                  }
                }}
                disabled={!previousEpisode}
                aria-label="Previous episode"
              >
                <SkipBack className="size-4 lg:size-5" />
              </Button>
            </HoverHint>
            <HoverHint label="Next episode">
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="bg-zinc-950/70"
                onClick={() => {
                  if (nextEpisode && onEpisodeChange) {
                    onEpisodeChange(nextEpisode, isPlayingRef.current)
                  }
                }}
                disabled={!nextEpisode}
                aria-label="Next episode"
              >
                <SkipForward className="size-4 lg:size-5" />
              </Button>
            </HoverHint>

            {!isPhoneViewport ? (
              <span className="shrink-0 text-xs text-zinc-200 tabular-nums lg:text-base">
                {formatTime(displayedCurrentTime)} / {formatTime(duration)}
              </span>
            ) : null}

            <div className="relative min-w-0 flex-1">
              {seekPreviewFrame ? (
                <div
                  className="pointer-events-none absolute bottom-7 z-10 w-40 -translate-x-1/2 overflow-hidden rounded-md border border-white/15 bg-zinc-950 shadow-xl"
                  style={{ left: `${seekPreviewFrame.leftPercent}%` }}
                >
                  {getSeekPreviewFrameUrl(seekPreviewFrame.time) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={getSeekPreviewFrameUrl(seekPreviewFrame.time) ?? undefined}
                      alt=""
                      className="aspect-video w-full object-cover"
                    />
                  ) : null}
                  <div className="px-2 py-1 text-center text-[11px] text-zinc-200 tabular-nums">
                    {formatTime(seekPreviewFrame.time)}
                  </div>
                </div>
              ) : null}
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.25}
                value={duration ? Math.min(displayedCurrentTime, duration) : 0}
                onChange={(event) => updateSeekDragPreview(event.target.value)}
                onPointerMove={(event) =>
                  updateSeekHoverPreview(event.currentTarget, event.clientX)
                }
                onPointerLeave={() => {
                  if (seekPreview === null) {
                    clearSeekPreviewFrame()
                  }
                }}
                onPointerUp={(event) => commitSeekInput(event.currentTarget.value)}
                onPointerCancel={clearSeekPreviewFrame}
                onKeyUp={(event) => commitSeekInput(event.currentTarget.value)}
                onBlur={(event) => commitSeekInput(event.currentTarget.value)}
                disabled={!duration}
                className="h-2 w-full accent-red-600 lg:h-3"
              />
            </div>


            <div
              ref={volumeControlRef}
              className="group/volume relative flex shrink-0 items-center rounded-full border border-white/10 bg-zinc-950/60 px-1.5 py-1 text-zinc-200 shadow-lg"
              onClick={(event) => event.stopPropagation()}
              onPointerEnter={() => showControls(true)}
            >
              <div
                className={`absolute bottom-full left-1/2 z-30 -translate-x-1/2 rounded-2xl border border-white/10 bg-zinc-950/90 px-3 py-3 text-zinc-200 opacity-0 shadow-2xl backdrop-blur transition group-hover/volume:pointer-events-auto group-hover/volume:opacity-100 ${
                  volumeOpen ? "pointer-events-auto opacity-100" : "pointer-events-none"
                }`}
              >
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={isMuted ? 0 : volume}
                  onChange={(event) => changeLocalVolume(event.currentTarget.value)}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  aria-label="Volume"
                  className="h-28 w-2 accent-violet-500 lg:h-32"
                  style={{ writingMode: "vertical-lr", direction: "rtl" }}
                />
              </div>

              <HoverHint label={isMuted ? "Unmute" : "Mute"}>
                <button
                  type="button"
                  className="grid size-7 place-items-center rounded-full text-zinc-200 transition hover:bg-white/10 hover:text-white lg:size-8"
                  onPointerDown={(event) => {
                    lastVolumePointerTypeRef.current = event.pointerType
                  }}
                  onClick={(event) => {
                    event.stopPropagation()

                    if (
                      lastVolumePointerTypeRef.current === "touch" ||
                      lastVolumePointerTypeRef.current === "pen"
                    ) {
                      setVolumeOpen((open) => !open)
                      showControls(true)
                      return
                    }

                    toggleLocalMute()
                  }}
                  aria-label={isMuted ? "Unmute" : "Mute"}
                >
                  {isMuted ? (
                    <VolumeX className="size-4 lg:size-5" />
                  ) : (
                    <Volume2 className="size-4 lg:size-5" />
                  )}
                </button>
              </HoverHint>
            </div>

            <div ref={settingsButtonRef} className="relative">
              <HoverHint label="Settings">
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="bg-zinc-950/70"
                  onClick={(event) => {
                    event.stopPropagation()
                    setSettingsOpen((open) => !open)
                    showControls(true)
                  }}
                  aria-label="Settings"
                >
                  <Settings className="size-4 lg:size-5" />
                </Button>
              </HoverHint>

            </div>

            <HoverHint label={castButtonLabel}>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className={`bg-zinc-950/70 ${
                  castErrorFlash
                    ? "border-red-500/70 text-red-400 ring-2 ring-red-500/40"
                    : ""
                }`}
                aria-label={castButtonLabel}
                disabled={castButtonDisabled}
                onPointerUp={(event) =>
                  runTouchControlAction(event, () => {
                    void startCasting()
                  })
                }
                onClick={(event) =>
                  runClickControlAction(event, () => {
                    void startCasting()
                  })
                }
              >
                <Cast className="size-4 lg:size-5" />
              </Button>
            </HoverHint>

            <HoverHint label="Fullscreen">
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="bg-zinc-950/70"
                onPointerUp={(event) =>
                  runTouchControlAction(event, requestFullscreen)
                }
                onClick={(event) =>
                  runClickControlAction(event, requestFullscreen)
                }
                aria-label="Fullscreen"
              >
                <Maximize2 className="size-4 lg:size-5" />
              </Button>
            </HoverHint>
          </div>
        </div>
        ) : null}
      </div>

      <p className="sr-only">
        Player for {animeId} season {seasonNumber} episode {episodeNumber}
      </p>
    </div>
  )
}
