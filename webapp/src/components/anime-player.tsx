"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ComponentPropsWithoutRef, CSSProperties } from "react"
import { createPortal } from "react-dom"
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
import { episodeCompletionRatio } from "@/lib/watch-progress"
import {
  serverCastControlApiPath,
  serverCastDevicesApiPath,
  serverCastStartApiPath,
  serverCastStatusApiPath,
  type ServerCastCandidate,
  type ServerCastDevice,
  type ServerCastDevicesResponse,
  type ServerCastMediaState,
  type ServerCastStartResponse,
  type ServerCastStatusResponse,
} from "@/lib/server-cast"
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
  isPrivateLanIpv4Host,
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
  SubtitleStreamInfo,
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

type BufferedSeekBarProps = Omit<
  ComponentPropsWithoutRef<"input">,
  "className" | "max" | "min" | "step" | "type"
> & {
  durationSeconds: number
  currentTimeSeconds: number
  bufferedSeconds: number
  trackClassName: string
  trackHeight: string
  inputClassName?: string
}

type SeekRangeStyle = CSSProperties & {
  "--yamibunko-seek-track-height"?: string
}

function getProgressPercent(value: number, durationSeconds: number) {
  if (!durationSeconds || durationSeconds <= 0) {
    return 0
  }

  return Math.min(Math.max((value / durationSeconds) * 100, 0), 100)
}

function BufferedSeekBar({
  durationSeconds,
  currentTimeSeconds,
  bufferedSeconds,
  trackClassName,
  trackHeight,
  inputClassName = "",
  style,
  ...inputProps
}: BufferedSeekBarProps) {
  const playedPercent = getProgressPercent(currentTimeSeconds, durationSeconds)
  const bufferedPercent = getProgressPercent(
    Math.max(bufferedSeconds, currentTimeSeconds),
    durationSeconds
  )
  const visibleBufferedPercent = Math.max(bufferedPercent, playedPercent)
  const inputStyle: SeekRangeStyle = {
    ...style,
    "--yamibunko-seek-track-height": trackHeight,
  }

  return (
    <div className={`relative ${trackClassName}`}>
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-full bg-zinc-950/95">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-zinc-300/60"
          style={{ width: `${visibleBufferedPercent}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-red-600"
          style={{ width: `${playedPercent}%` }}
        />
      </div>
      <div
        className="pointer-events-none absolute top-1/2 z-[5] size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/90 bg-red-600"
        style={{ left: `${playedPercent}%` }}
      />
      <input
        {...inputProps}
        type="range"
        min={0}
        max={durationSeconds || 0}
        step={0.25}
        style={inputStyle}
        className={`yamibunko-seek-range absolute -inset-y-3 left-0 z-10 h-[calc(100%+1.5rem)] w-full bg-transparent ${inputClassName}`}
      />
    </div>
  )
}


type StreamPriorityAction = {
  type:
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
    | "waitingForBandwidth"
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

type SubtitleCue = {
  start: number
  end: number
  text: string
}

type CastClockSnapshot = {
  durationSeconds?: number
  playerState?: string
  positionSeconds: number
}

type PreloadRangeProbe = {
  contentLength: number
  rangeable: boolean
}

type PlaybackStatsSnapshot = {
  playbackType: string
  container: string
  videoCodec: string
  audioCodec: string
  subtitleFormat: string
  downloadBitrateMbps: number | null
  preloadedMegabytes: number | null
}

const hevcMp4Checks = [
  'video/mp4; codecs="hvc1.1.6.L93.B0"',
  'video/mp4; codecs="hev1.1.6.L93.B0"',
  'video/mp4; codecs="hvc1"',
  'video/mp4; codecs="hev1"',
]

const mediaErrorDecodeCode = 3
const mediaErrorSourceNotSupportedCode = 4
const introSkipVisibleSeconds = 4 * 60
const introSkipSeekSeconds = 90
const preloadRampInitialRatio = 0.4
const preloadRampMaxAheadSeconds = 10 * 60
const preloadRampMaxSeconds = 60
const preloadRampTickMs = 250
const preloadRangeProbeTimeoutMs = 4_000
const preloadRangeWarmupMinChunkBytes = 96 * 1024 * 1024
const preloadRangeWarmupMaxChunkBytes = 1024 * 1024 * 1024
const preloadRangeWarmupMinimumMissingSeconds = 0.5
const castClockTickMs = 1_000
const serverCastStatusPollMs = 1_000
const maxServerCastStatusFailures = 8

const iosExternalCastAppName = "Web Video Caster"
const iosExternalCastAppStoreUrl =
  "https://apps.apple.com/app/web-video-cast-browser-to-tv/id1400866497"
const iosExternalCastOpenTimeoutMs = 1600
const iosExternalCastBrowserMarkerParam = "yamibunko_wvc"
const iosExternalCastBrowserMarkerValue = "1"

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

function getWebVideoCasterSourceFileName(
  source: "direct" | "transcode",
  inputFileName: string
) {
  const baseName = inputFileName.replace(/\.[^.]+$/, "") || "Episode"
  const extension =
    source === "transcode" ? "mp4" : inputFileName.split(".").at(-1) ?? "mp4"
  const label =
    source === "transcode"
      ? "Yamibunko Compatibility Transcode"
      : "Yamibunko Direct Play"

  return `${label} - ${baseName}.${extension}`
}

const containerByExtension = new Map<string, string>([
  ["mp4", "mp4"],
  ["m4v", "mp4"],
  ["mov", "mov"],
  ["mkv", "matroska"],
  ["webm", "webm"],
  ["avi", "avi"],
])

const directMimeTypesByContainer: Record<string, string[]> = {
  mp4: ["video/mp4"],
  mov: ["video/quicktime", "video/mp4"],
  webm: ["video/webm"],
  matroska: ["video/x-matroska"],
  avi: ["video/x-msvideo"],
}

const fallbackDirectMimeTypes = ["video/mp4", "video/webm", "video/x-matroska"]

const h264CodecChecks = ["avc1.640028", "avc1.4D401F", "avc1.42E01E", "avc1"]
const hevcMatroskaCodecChecks = ["hvc1", "hev1", "hevc"]
const hevcCodecChecks = ["hvc1.1.6.L93.B0", "hev1.1.6.L93.B0", "hvc1", "hev1"]

function getMediaContainer(fileName: string, container: string | undefined) {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? ""
  const extensionContainer = containerByExtension.get(extension)

  if (extensionContainer) {
    return extensionContainer
  }

  const normalizedContainer = container?.trim().toLowerCase() ?? ""

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
  return directMimeTypesByContainer[container] ?? fallbackDirectMimeTypes
}

function getVideoCodecChecks(codec: string | undefined, mimeType: string) {
  switch (normalizeCodecName(codec)) {
    case "h264":
    case "avc1":
      return h264CodecChecks
    case "hevc":
    case "h265":
    case "hvc1":
    case "hev1":
      return mimeType === "video/x-matroska"
        ? hevcMatroskaCodecChecks
        : hevcCodecChecks
    case "vp9":
    case "vp09":
      return ["vp09.00.10.08", "vp9"]
    case "vp8":
      return ["vp8"]
    case "av1":
    case "av01":
      return ["av01.0.05M.08", "av01"]
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
      return getAacCodecChecks(audioStream.profile)
    case "mp3":
    case "mp2":
    case "mp1":
      return ["mp4a.40.34", "mp4a.69", "mp4a.6B", "mp3"]
    case "opus":
      return ["opus"]
    case "vorbis":
      return ["vorbis"]
    case "flac":
      return ["flac"]
    case "ac3":
      return ["ac-3"]
    case "eac3":
      return ["ec-3"]
    default:
      return []
  }
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

function getDirectAudioRemuxContainer(fileName: string) {
  return getMediaContainer(fileName, undefined) === "webm" ? "webm" : "mp4"
}

function isOptimisticLocalDirectPlaybackCandidate(input: {
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
  directAudioRemuxActive: boolean
}) {
  const container = input.directAudioRemuxActive
    ? getDirectAudioRemuxContainer(input.fileName)
    : getMediaContainer(input.fileName, input.media.container)

  if (container !== "mp4" && container !== "mov") {
    return false
  }

  const videoCodec = normalizeCodecName(input.media.videoCodec)
  const videoSupported =
    videoCodec === "h264" ||
    videoCodec === "avc1" ||
    videoCodec === "hevc" ||
    videoCodec === "h265" ||
    videoCodec === "hvc1" ||
    videoCodec === "hev1"

  if (!videoSupported) {
    return false
  }

  if (!input.media.audioStreams.length) {
    return true
  }

  const audioCodec = normalizeCodecName(input.selectedAudioStream?.codec)

  return (
    audioCodec === "aac" ||
    audioCodec === "mp3" ||
    audioCodec === "mp2" ||
    audioCodec === "mp1" ||
    audioCodec === "ac3" ||
    audioCodec === "eac3"
  )
}

function supportsLocalDirectPlayback(input: {
  video: HTMLVideoElement
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
  directAudioRemuxActive: boolean
}) {
  if (supportsDirectPlayback(input)) {
    return true
  }

  return isOptimisticLocalDirectPlaybackCandidate(input)
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

function isIphoneBrowser() {
  if (typeof navigator === "undefined") {
    return false
  }

  return /iPhone|iPod/i.test(navigator.userAgent)
}

function isWebVideoCasterMarkedUrl() {
  if (typeof window === "undefined") {
    return false
  }

  const params = new URLSearchParams(window.location.search)

  if (params.get(iosExternalCastBrowserMarkerParam) === iosExternalCastBrowserMarkerValue) {
    return true
  }

  return window.location.hash.includes(
    `${iosExternalCastBrowserMarkerParam}=${iosExternalCastBrowserMarkerValue}`
  )
}

function isWebVideoCasterBrowser() {
  if (isWebVideoCasterMarkedUrl()) {
    return true
  }

  if (typeof navigator === "undefined") {
    return false
  }

  return /Web\s*Video\s*Cast(?:er)?|WebVideoCast(?:er)?|WebVideoCaster|WVC|InstantBits|instantbits|wvc/i.test(navigator.userAgent)
}

function getIosExternalCastPageUrl() {
  if (typeof window === "undefined") {
    return ""
  }

  const url = new URL(window.location.href)
  url.searchParams.set(iosExternalCastBrowserMarkerParam, iosExternalCastBrowserMarkerValue)
  return url.toString()
}

function isCurrentPageHttpsOrigin() {
  if (typeof window === "undefined") {
    return false
  }

  return window.location.protocol === "https:"
}

function isCurrentPageHttpPrivateLanOrigin() {
  if (typeof window === "undefined") {
    return false
  }

  return window.location.protocol === "http:" && isPrivateLanIpv4Host(window.location.hostname)
}

function getCurrentPageLanOrigin() {
  if (typeof window === "undefined") {
    return null
  }

  if (!isCurrentPageHttpPrivateLanOrigin()) {
    return null
  }

  return window.location.origin
}

function shouldOpenIosExternalCastApp() {
  if (!isIosBrowser() || isWebVideoCasterBrowser()) {
    return false
  }

  if (typeof window === "undefined") {
    return true
  }

  return !isCurrentPageHttpPrivateLanOrigin()
}

function shouldUseIosServerCastBridge() {
  return isIosBrowser() && !isWebVideoCasterBrowser() && isCurrentPageHttpPrivateLanOrigin()
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

  if (isWebVideoCasterBrowser()) {
    return "Google Cast did not become available inside Web Video Caster. Use Web Video Caster's own cast controls if its embedded browser does not expose the Google Cast Sender SDK."
  }

  return "Casting is not available in this browser."
}

function requestNativeVideoFullscreen(video: HTMLVideoElement | null) {
  if (!video) {
    return false
  }

  const nativeVideo = video as HtmlVideoElementWithNativePlayback

  if (typeof nativeVideo.webkitEnterFullscreen === "function") {
    try {
      nativeVideo.webkitEnterFullscreen()
      return true
    } catch {
      if (isIphoneBrowser()) {
        return false
      }
    }
  }

  if (
    typeof nativeVideo.webkitSupportsPresentationMode === "function" &&
    typeof nativeVideo.webkitSetPresentationMode === "function" &&
    nativeVideo.webkitSupportsPresentationMode("fullscreen")
  ) {
    nativeVideo.webkitSetPresentationMode("fullscreen")
    return true
  }

  return false
}

function getIosExternalCastDeepLink(input: { url: string; title: string }) {
  const deepLink = new URL("wvc-x-callback://open")

  deepLink.searchParams.set("url", input.url)
  deepLink.searchParams.set("title", input.title)
  deepLink.searchParams.set("secure_uri", "true")

  return deepLink.toString()
}

function isLcAacAudioProfile(profile: string | undefined) {
  const normalized = profile?.trim().toLowerCase()

  return !normalized || normalized === "lc" || normalized === "aac lc"
}

function isCastDirectAudioSafe(stream: MediaStreamInfo | undefined) {
  if (!stream) {
    return false
  }

  const audioCodec = normalizeCodecName(stream.codec)
  const channels = stream.channels
  const hasSafeChannelLayout =
    typeof channels !== "number" || channels <= 0 || channels <= 2

  if (!hasSafeChannelLayout) {
    return false
  }

  if (audioCodec === "aac") {
    return isLcAacAudioProfile(stream.profile)
  }

  return audioCodec === "mp3"
}

function supportsCastDirectPlayback(input: {
  fileName: string
  media: WatchPayload["media"]
  selectedAudioStream: MediaStreamInfo | undefined
}) {
  const container = getMediaContainer(input.fileName, input.media.container)
  const videoCodec = normalizeCodecName(input.media.videoCodec)

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

  return isCastDirectAudioSafe(input.selectedAudioStream)
}

function isPlayerControlTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest("button,input,a,select,textarea,label"))
  )
}

const castDirectContentTypesByExtension = new Map<string, string>([
  ["mp4", "video/mp4"],
  ["m4v", "video/mp4"],
  ["webm", "video/webm"],
  ["mkv", "video/x-matroska"],
])

function getCastDirectContentType(fileName: string, usesAudioRemux = false) {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? ""

  if (usesAudioRemux) {
    return extension === "webm" ? "video/webm" : "video/mp4"
  }

  return (
    castDirectContentTypesByExtension.get(extension) ??
    "application/octet-stream"
  )
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

function urlsPointToSameResource(left: string, right: string) {
  try {
    const leftUrl = new URL(left, getUrlBase())
    const rightUrl = new URL(right, getUrlBase())

    return (
      leftUrl.origin === rightUrl.origin &&
      leftUrl.pathname === rightUrl.pathname &&
      leftUrl.search === rightUrl.search
    )
  } catch {
    return left === right
  }
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

function getSourceClockSeconds(mediaSeconds: number, sourceOffsetSeconds: number) {
  const offset = Number.isFinite(sourceOffsetSeconds) ? Math.max(sourceOffsetSeconds, 0) : 0

  if (!Number.isFinite(mediaSeconds)) {
    return offset
  }

  return Math.max(offset + mediaSeconds, 0)
}

function parseContentRangeTotal(value: string | null) {
  const total = value?.match(/\/(\d+)$/)?.[1]

  if (!total) {
    return undefined
  }

  const size = Number(total)

  return Number.isFinite(size) && size > 0 ? size : undefined
}

async function drainResponseBody(
  response: Response,
  onBytesRead?: (byteLength: number) => void
) {
  if (!response.body) {
    const body = await response.arrayBuffer()
    onBytesRead?.(body.byteLength)
    return
  }

  const reader = response.body.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        return
      }

      if (value) {
        onBytesRead?.(value.byteLength)
      }
    }
  } finally {
    reader.releaseLock()
  }
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

function decodeSubtitleEntity(entity: string) {
  const normalized = entity.toLowerCase()

  if (normalized === "nbsp") {
    return " "
  }

  if (normalized === "amp") {
    return "&"
  }

  if (normalized === "lt") {
    return "<"
  }

  if (normalized === "gt") {
    return ">"
  }

  if (normalized === "quot") {
    return '"'
  }

  if (normalized === "apos" || normalized === "#39") {
    return "'"
  }

  const decimalMatch = /^#(\d+)$/.exec(normalized)

  if (decimalMatch) {
    const codePoint = Number(decimalMatch[1])
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : ""
  }

  const hexMatch = /^#x([0-9a-f]+)$/.exec(normalized)

  if (hexMatch) {
    const codePoint = Number.parseInt(hexMatch[1], 16)
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : ""
  }

  return ""
}

function removeBracketedSubtitleText(value: string) {
  let output = value

  for (let pass = 0; pass < 4; pass += 1) {
    const nextOutput = output
      .replace(/\s*\([^()\n]*\)\s*/g, " ")
      .replace(/\s*\[[^[\]\n]*]\s*/g, " ")
      .replace(/\s*\{[^{}\n]*}\s*/g, " ")

    if (nextOutput === output) {
      break
    }

    output = nextOutput
  }

  return output
}

function stripSubtitleFormatting(value: string) {
  return value
    .replace(/\\[Nn]/g, "\n")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/\{\\[^}]*}/g, "")
    .replace(/<\/?(?:c|v|lang|ruby|rt|b|i|u)(?:\.[^>\s]+)*(?:\s+[^>]*)?>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&([^;\s]+);/g, (_match, entity: string) => decodeSubtitleEntity(entity))
    .split("\n")
    .map((line) => removeBracketedSubtitleText(line).replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
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

function formatStatsLabel(value: string | undefined | null) {
  const trimmed = value?.trim()

  if (!trimmed) {
    return "Unknown"
  }

  return trimmed
}

function formatContainerForStats(input: {
  status: PlaybackStatusState
  fileName: string
  media: WatchPayload["media"]
  directAudioRemuxActive: boolean
}) {
  if (input.status === "transcoding") {
    return "MP4"
  }

  const container = input.directAudioRemuxActive
    ? getDirectAudioRemuxContainer(input.fileName)
    : getMediaContainer(input.fileName, input.media.container)

  if (container === "mp4") {
    return "MP4"
  }

  if (container === "mov") {
    return "MOV"
  }

  if (container === "webm") {
    return "WebM"
  }

  if (container === "matroska") {
    return "Matroska / MKV"
  }

  if (container === "avi") {
    return "AVI"
  }

  return formatStatsLabel(input.media.container)
}

function formatVideoCodecForStats(input: {
  status: PlaybackStatusState
  videoCodec?: string
}) {
  if (input.status === "transcoding") {
    return "AVC / H.264"
  }

  const normalizedCodec = normalizeCodecName(input.videoCodec)

  if (normalizedCodec === "h264" || normalizedCodec === "avc1") {
    return "AVC / H.264"
  }

  if (
    normalizedCodec === "hevc" ||
    normalizedCodec === "h265" ||
    normalizedCodec === "hvc1" ||
    normalizedCodec === "hev1"
  ) {
    return "HEVC / H.265"
  }

  if (normalizedCodec === "av1" || normalizedCodec === "av01") {
    return "AV1"
  }

  if (normalizedCodec === "vp9" || normalizedCodec === "vp09") {
    return "VP9"
  }

  if (normalizedCodec === "vp8") {
    return "VP8"
  }

  return formatStatsLabel(input.videoCodec)
}

function formatAudioCodecForStats(input: {
  status: PlaybackStatusState
  audioStream: MediaStreamInfo | undefined
}) {
  if (input.status === "transcoding") {
    return "AAC-LC"
  }

  const codec = normalizeCodecName(input.audioStream?.codec)
  const profile = input.audioStream?.profile?.trim()

  if (codec === "aac") {
    return profile && /lc/i.test(profile) ? "AAC-LC" : "AAC"
  }

  if (codec === "opus") {
    return "Opus"
  }

  if (codec === "vorbis") {
    return "Vorbis"
  }

  if (codec === "ac3") {
    return "AC-3"
  }

  if (codec === "eac3") {
    return "E-AC-3"
  }

  if (codec === "flac") {
    return "FLAC"
  }

  if (codec === "mp3") {
    return "MP3"
  }

  return formatStatsLabel(input.audioStream?.codec)
}

function formatSubtitleCodec(codec: string | undefined) {
  const normalizedCodec = normalizeCodecName(codec)

  const labels: Record<string, string> = {
    webvtt: "WebVTT",
    ass: "ASS",
    ssa: "SSA",
    srt: "SRT",
    subrip: "SRT",
    movtext: "mov_text",
    text: "Text",
    subviewer: "SubViewer",
    subviewer1: "SubViewer 1",
    sami: "SAMI",
    microdvd: "MicroDVD",
    mpl2: "MPL2",
    jacosub: "JACOsub",
    realtext: "RealText",
    stl: "STL",
    vplayer: "VPlayer",
    pjs: "PJS",
    aqtitle: "AQTitle",
    ttml: "TTML",
    dfxp: "TTML",
    sbv: "SBV",
    scc: "SCC",
    eia608: "EIA-608",
    cea608: "EIA-608",
    hdmvpgssubtitle: "PGS",
    dvdsubtitle: "DVD Subtitle",
    dvbsubtitle: "DVB Subtitle",
    xsub: "XSUB",
  }

  return labels[normalizedCodec] ?? formatStatsLabel(codec)
}

function formatSubtitleFormatForStats(stream: SubtitleStreamInfo | null) {
  if (!stream) {
    return "Off"
  }

  const sourceFormat = formatSubtitleCodec(stream.codec)

  if (sourceFormat === "WebVTT") {
    return "WebVTT"
  }

  if (sourceFormat === "Unknown") {
    return "WebVTT"
  }

  return `WebVTT (from ${sourceFormat})`
}

function getPreloadedMegabytes(input: {
  currentTimeSeconds: number
  bufferedSeconds: number
  streamMbps?: number
}) {
  if (!input.streamMbps || input.streamMbps <= 0) {
    return null
  }

  const preloadedSeconds = Math.max(input.bufferedSeconds - input.currentTimeSeconds, 0)

  if (preloadedSeconds <= 0) {
    return 0
  }

  return Number(((preloadedSeconds * input.streamMbps) / 8).toFixed(1))
}

function formatStatsBitrate(value: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "N/A"
  }

  if (value < 0.1) {
    return "<0.1 Mbps"
  }

  return `${value.toFixed(1)} Mbps`
}

function formatStatsMegabytes(value: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "N/A"
  }

  if (value < 0.1) {
    return "<0.1 MB"
  }

  return `${value.toFixed(1)} MB`
}

function DisplayMethodStatsBadge({
  stats,
}: {
  stats: PlaybackStatsSnapshot
}) {
  const rows = [
    ["Video container", stats.container],
    ["Video codec", stats.videoCodec],
    ["Audio codec", stats.audioCodec],
    ["Subtitle format", stats.subtitleFormat],
    ["Current download bitrate", formatStatsBitrate(stats.downloadBitrateMbps)],
    ["Preloaded", formatStatsMegabytes(stats.preloadedMegabytes)],
  ]

  return (
    <HoverHint
      side="bottom"
      align="start"
      clickVisibleMs={null}
      className="w-full"
      contentClassName="w-72 max-w-[calc(100vw-1rem)] border-violet-300/25 bg-zinc-950/95 px-0 py-0 text-zinc-100 shadow-2xl"
      label={
        <span className="block p-3 text-left">
          <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-violet-200">
            Stats for nerds
          </span>
          <span className="mt-2 grid gap-1.5">
            {rows.map(([label, value]) => (
              <span key={label} className="grid grid-cols-[1fr_auto] gap-3 text-xs">
                <span className="text-zinc-400">{label}</span>
                <span className="max-w-36 truncate text-right font-medium text-zinc-100" title={value}>
                  {value}
                </span>
              </span>
            ))}
          </span>
        </span>
      }
    >
      <button
        type="button"
        className="w-full cursor-help rounded-md border border-white/10 bg-zinc-950 px-2 py-1.5 text-left text-zinc-100 transition hover:border-violet-300/35 hover:bg-zinc-900 lg:px-3 lg:py-2"
        onClick={(event) => event.stopPropagation()}
      >
        {stats.playbackType}
      </button>
    </HoverHint>
  )
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
  const [stableClientStreamId] = useState(() => clientStreamId ?? createClientStreamId())
  const clientStreamIdRef = useRef(stableClientStreamId)
  const castSelectionKeyRef = useRef("")
  const lastProgressSavePositionRef = useRef(0)
  const lastNonZeroVolumeRef = useRef(1)
  const lastVolumePointerTypeRef = useRef<string | null>(null)
  const touchControlClickSuppressionRef = useRef(false)
  const touchControlActionSuppressedRef = useRef(false)
  const touchControlActionSuppressionTimerRef = useRef<number | null>(null)
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
  const sourceSwitchPauseSuppressedRef = useRef(false)
  const sourceSwitchPauseSuppressionTimerRef = useRef<number | null>(null)
  const isCastingRef = useRef(false)
  const isNativeRemoteCastingRef = useRef(false)
  const isServerCastingRef = useRef(false)
  const serverCastSessionIdRef = useRef<string | null>(null)
  const serverCastDeviceIdRef = useRef<string | null>(null)
  const serverCastProgressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const serverCastStatusGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const serverCastStatusGraceActiveRef = useRef(false)
  const serverCastStatusFailureCountRef = useRef(0)
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
  const castClockTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const castClockRef = useRef<CastClockSnapshot | null>(null)
  const castClockElapsedSecondsRef = useRef(0)
  const preloadRampTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const preloadRampElapsedSecondsRef = useRef(0)
  const preloadRangeAbortRef = useRef<AbortController | null>(null)
  const preloadRangeProbeRef = useRef<PreloadRangeProbe | null>(null)
  const preloadRangeProbePromiseRef = useRef<Promise<PreloadRangeProbe | null> | null>(null)
  const preloadRangeProbeSourceRef = useRef<string | null>(null)
  const preloadRangeFetchingRef = useRef(false)
  const preloadRangeRequestedByteEndRef = useRef(-1)
  const preloadRangeWarmedUntilRef = useRef(0)
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
  const startServerCastingToDeviceRef = useRef<
    (
      deviceId: string,
      shouldResume: boolean,
      startTimeOverride?: number
    ) => Promise<void>
  >(async () => undefined)
  const switchSourceRef = useRef<
    (
      nextSourceUrl: string,
      nextStatus: PlaybackStatusState,
      options?: SwitchSourceOptions
    ) => void
  >(() => undefined)
  const handlePlayRequestFailureRef = useRef<(error: unknown) => boolean>(() => false)
  const handleCastEndedRef = useRef<() => void>(() => undefined)
  const emitCastClockProgressRef = useRef<() => void>(() => undefined)
  const loadServerCastStatusRef = useRef<() => Promise<void>>(async () => undefined)
  const handleServerCastStatusErrorRef = useRef<(error: unknown) => void>(() => undefined)
  const syncCastMediaStateRef = useRef<(state: GoogleCastMediaState) => void>(() => undefined)
  const applyLocalPreloadRampRef = useRef<(video: HTMLVideoElement) => void>(() => undefined)
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
  const [currentTime, setCurrentTime] = useState(0)
  const [seekPreview, setSeekPreview] = useState<number | null>(null)
  const [seekPreviewFrame, setSeekPreviewFrame] = useState<SeekPreviewFrame | null>(null)
  const [duration, setDuration] = useState(getStableDuration(durationSeconds))
  const [bufferedTime, setBufferedTime] = useState(0)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [isPortraitViewport, setIsPortraitViewport] = useState(false)
  const [isMobilePortraitViewport, setIsMobilePortraitViewport] = useState(false)
  const [isPhoneViewport, setIsPhoneViewport] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isCasting, setIsCasting] = useState(false)
  const [isNativeRemoteCasting, setIsNativeRemoteCasting] = useState(false)
  const [isServerCasting, setIsServerCasting] = useState(false)
  const [serverCastDevices, setServerCastDevices] = useState<ServerCastDevice[]>([])
  const [serverCastDeviceModalOpen, setServerCastDeviceModalOpen] = useState(false)
  const [serverCastOverlayPortalRoot] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : document.body
  )
  const [serverCastDevicesLoading, setServerCastDevicesLoading] = useState(false)
  const [iosExternalCastAppUnavailable, setIosExternalCastAppUnavailable] = useState(false)
  const [isCastStarting, setIsCastStarting] = useState(false)
  const [castErrorFlash, setCastErrorFlash] = useState(false)
  const [castErrorMessage, setCastErrorMessage] = useState<string | null>(null)
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([])
  const [activeSubtitleTexts, setActiveSubtitleTexts] = useState<string[]>([])
  const [currentDownloadBitrateMbps, setCurrentDownloadBitrateMbps] = useState<number | null>(null)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [volumeOpen, setVolumeOpen] = useState(false)

  const playbackKey = `${animeId}:${seasonNumber}:${episodeNumber}`
  const castProgressTracking = useMemo(() => {
    const parsedAnimeId = Number(animeId)

    if (!Number.isInteger(parsedAnimeId) || parsedAnimeId <= 0) {
      return undefined
    }

    return {
      animeId: parsedAnimeId,
      seasonNumber,
      episodeNumber,
    }
  }, [animeId, episodeNumber, seasonNumber])
  const isIosDevice = isIosBrowser()
  const isInsideWebVideoCaster = isWebVideoCasterBrowser()
  const canExposeWebVideoCasterSources =
    isIphoneBrowser() && isInsideWebVideoCaster && isCurrentPageHttpsOrigin()
  const liveTranscodeEnabled = playback.liveTranscodeEnabled !== false
  const showQualityControl = false
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
  const localDirectAudioRemuxActive = directAudioRemuxActive
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
  const playbackStats = useMemo<PlaybackStatsSnapshot>(
    () => ({
      playbackType: displayMethod,
      container: formatContainerForStats({
        status,
        fileName,
        media,
        directAudioRemuxActive,
      }),
      videoCodec: formatVideoCodecForStats({
        status,
        videoCodec: media.videoCodec,
      }),
      audioCodec: formatAudioCodecForStats({
        status,
        audioStream: playbackAudioStream,
      }),
      subtitleFormat: formatSubtitleFormatForStats(selectedSubtitleStream),
      downloadBitrateMbps: currentDownloadBitrateMbps,
      preloadedMegabytes: getPreloadedMegabytes({
        currentTimeSeconds: currentTime,
        bufferedSeconds: bufferedTime,
        streamMbps,
      }),
    }),
    [
      bufferedTime,
      currentDownloadBitrateMbps,
      currentTime,
      directAudioRemuxActive,
      displayMethod,
      fileName,
      media,
      playbackAudioStream,
      selectedSubtitleStream,
      status,
      streamMbps,
    ]
  )
  const castSelectionKey = `${playbackKey}:${quality}:${selectedAudioStreamId ?? ""}:${selectedSubtitleStreamId ?? ""}`

  function resetStreamStats() {
    streamStatsSampleRef.current = null
    setCurrentDownloadBitrateMbps((previousBitrate) =>
      previousBitrate === null ? previousBitrate : null
    )
  }

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
    const timer = window.setTimeout(() => {
      setSelectedAudioStreamId(media.defaultAudioStreamId)
      setSelectedSubtitleStreamId(defaultSubtitle?.id ?? null)
    }, 0)

    return () => window.clearTimeout(timer)
  }, [
    media.defaultAudioStreamId,
    media.defaultSubtitleStreamId,
    playbackKey,
    supportedSubtitleStreams,
  ])

  useEffect(() => {
    if (!selectedSubtitleStreamId) {
      return
    }

    const selectedStreamExists = supportedSubtitleStreams.some(
      (stream) => stream.id === selectedSubtitleStreamId
    )

    if (selectedStreamExists) {
      return
    }

    const timer = window.setTimeout(() => {
      setSelectedSubtitleStreamId(null)
    }, 0)

    return () => window.clearTimeout(timer)
  }, [selectedSubtitleStreamId, supportedSubtitleStreams])

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


  function clearCastClock() {
    if (castClockTimerRef.current) {
      clearInterval(castClockTimerRef.current)
      castClockTimerRef.current = null
    }

    castClockRef.current = null
    castClockElapsedSecondsRef.current = 0
  }

  function estimateCastClockPosition() {
    const snapshot = castClockRef.current

    if (!snapshot) {
      return currentTimeRef.current
    }

    const elapsedSeconds =
      snapshot.playerState === "PLAYING" || snapshot.playerState === "BUFFERING"
        ? castClockElapsedSecondsRef.current
        : 0

    return clampTime(
      castSourceStartOffsetRef.current + snapshot.positionSeconds + elapsedSeconds,
      getStableDuration(durationSeconds, snapshot.durationSeconds, duration)
    )
  }

  function emitCastClockProgress() {
    const snapshot = castClockRef.current

    if (!snapshot) {
      return
    }

    const knownDuration = getStableDuration(
      durationSeconds,
      snapshot.durationSeconds,
      duration
    )

    updateWatchedProgress(estimateCastClockPosition(), knownDuration)
  }

  function startCastClock() {
    if (castClockTimerRef.current) {
      return
    }

    castClockTimerRef.current = setInterval(() => {
      const snapshot = castClockRef.current

      if (snapshot?.playerState === "PLAYING" || snapshot?.playerState === "BUFFERING") {
        castClockElapsedSecondsRef.current += castClockTickMs / 1000
      }

      emitCastClockProgressRef.current()
    }, castClockTickMs)
  }

  function syncCastClock(state: GoogleCastMediaState) {
    castClockRef.current = {
      durationSeconds: state.durationSeconds,
      playerState: state.playerState,
      positionSeconds: Math.max(state.positionSeconds, 0),
    }
    castClockElapsedSecondsRef.current = 0

    startCastClock()
  }

  function clearPreloadRamp() {
    if (preloadRampTimerRef.current) {
      clearInterval(preloadRampTimerRef.current)
      preloadRampTimerRef.current = null
    }

    preloadRangeAbortRef.current?.abort()
    preloadRangeAbortRef.current = null
    preloadRangeProbeRef.current = null
    preloadRangeProbePromiseRef.current = null
    preloadRangeProbeSourceRef.current = null
    preloadRangeFetchingRef.current = false
    preloadRangeRequestedByteEndRef.current = -1
    preloadRangeWarmedUntilRef.current = Math.max(currentTimeRef.current, 0)
  }

  function getPreloadRampRatio() {
    const elapsedSeconds = Math.max(preloadRampElapsedSecondsRef.current, 0)
    const rampProgress = Math.min(
      elapsedSeconds / Math.max(preloadRampMaxSeconds, 1),
      1
    )

    return preloadRampInitialRatio + (1 - preloadRampInitialRatio) * rampProgress
  }

  function getPreloadAheadTargetSeconds() {
    return Math.round(preloadRampMaxAheadSeconds * getPreloadRampRatio())
  }

  function getPreloadWarmupChunkBytes() {
    return Math.round(
      preloadRangeWarmupMinChunkBytes +
        (preloadRangeWarmupMaxChunkBytes - preloadRangeWarmupMinChunkBytes) *
          getPreloadRampRatio()
    )
  }

  function resetPreloadRangeProbe(sourceUrl: string | null) {
    preloadRangeAbortRef.current?.abort()
    preloadRangeAbortRef.current = null
    preloadRangeProbeRef.current = null
    preloadRangeProbePromiseRef.current = null
    preloadRangeProbeSourceRef.current = sourceUrl
    preloadRangeFetchingRef.current = false
    preloadRangeRequestedByteEndRef.current = -1
    preloadRangeWarmedUntilRef.current = Math.max(currentTimeRef.current, 0)
  }

  function getPreloadRangeProbe(sourceUrl: string) {
    if (preloadRangeProbeSourceRef.current !== sourceUrl) {
      resetPreloadRangeProbe(sourceUrl)
    }

    if (preloadRangeProbeRef.current) {
      return Promise.resolve(preloadRangeProbeRef.current)
    }

    if (preloadRangeProbePromiseRef.current) {
      return preloadRangeProbePromiseRef.current
    }

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), preloadRangeProbeTimeoutMs)

    preloadRangeProbePromiseRef.current = fetch(sourceUrl, {
      headers: {
        Range: "bytes=0-0",
      },
      credentials: "same-origin",
      cache: "force-cache",
      signal: controller.signal,
    })
      .then(async (response) => {
        await response.body?.cancel().catch(() => undefined)

        if (response.status === 206) {
          const rangedContentLength = parseContentRangeTotal(
            response.headers.get("content-range")
          )

          if (rangedContentLength) {
            return {
              contentLength: rangedContentLength,
              rangeable: true,
            } satisfies PreloadRangeProbe
          }
        }

        const contentLength = Number(response.headers.get("content-length"))
        const acceptRanges = response.headers.get("accept-ranges")?.toLowerCase() ?? ""

        if (!response.ok || !Number.isFinite(contentLength) || contentLength <= 0) {
          return null
        }

        return {
          contentLength,
          rangeable: acceptRanges.includes("bytes"),
        } satisfies PreloadRangeProbe
      })
      .catch(() => null)
      .finally(() => {
        window.clearTimeout(timeout)
      })
      .then((probe) => {
        if (preloadRangeProbeSourceRef.current === sourceUrl) {
          preloadRangeProbeRef.current = probe
          preloadRangeProbePromiseRef.current = null
        }

        return probe
      })

    return preloadRangeProbePromiseRef.current
  }

  function warmLocalDirectBuffer(video: HTMLVideoElement, targetAheadSeconds: number) {
    const sourceUrl = sourceUrlRef.current

    if (
      !sourceUrl ||
      statusRef.current !== "direct" ||
      localDirectAudioRemuxActive ||
      preloadRangeFetchingRef.current
    ) {
      return
    }

    void getPreloadRangeProbe(sourceUrl).then((probe) => {
      if (
        !probe?.rangeable ||
        sourceUrlRef.current !== sourceUrl ||
        statusRef.current !== "direct" ||
        localDirectAudioRemuxActive ||
        isAnyCastingRef() ||
        preloadRangeFetchingRef.current
      ) {
        return
      }

      const knownDuration = getStableDuration(durationSeconds, video.duration, duration)

      if (!knownDuration || knownDuration <= 0) {
        return
      }

      const currentSeconds = Math.max(video.currentTime, currentTimeRef.current, 0)
      const bufferedEndSeconds = Math.max(
        getBufferedEnd(video),
        preloadRangeWarmedUntilRef.current - activeSourceStartRef.current,
        currentSeconds
      )
      const targetSeconds = Math.min(currentSeconds + targetAheadSeconds, knownDuration)
      const missingSeconds = targetSeconds - bufferedEndSeconds

      if (missingSeconds < preloadRangeWarmupMinimumMissingSeconds) {
        return
      }

      const bytesPerSecond = probe.contentLength / knownDuration
      const bufferedByteEnd = Math.max(
        Math.floor(bufferedEndSeconds * bytesPerSecond),
        0
      )
      const targetByteEnd = Math.min(
        Math.max(Math.floor(targetSeconds * bytesPerSecond), 0),
        probe.contentLength - 1
      )
      const byteStart = Math.max(
        bufferedByteEnd,
        preloadRangeRequestedByteEndRef.current + 1,
        0
      )

      if (byteStart >= targetByteEnd) {
        return
      }

      const byteEnd = Math.min(
        targetByteEnd,
        byteStart + getPreloadWarmupChunkBytes() - 1,
        probe.contentLength - 1
      )
      const controller = new AbortController()

      preloadRangeAbortRef.current?.abort()
      preloadRangeAbortRef.current = controller
      preloadRangeFetchingRef.current = true
      preloadRangeRequestedByteEndRef.current = byteEnd

      void fetch(sourceUrl, {
        headers: {
          Range: `bytes=${byteStart}-${byteEnd}`,
        },
        credentials: "same-origin",
        cache: "force-cache",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (response.status !== 206) {
            preloadRangeProbeRef.current = {
              ...probe,
              rangeable: false,
            }
            return
          }

          const requestedByteLength = byteEnd - byteStart + 1
          const visualUpdateStepBytes = 4 * 1024 * 1024
          let loadedByteLength = 0
          let lastVisualByteLength = 0
          const updateWarmupDisplay = (force = false) => {
            if (
              !force &&
              loadedByteLength - lastVisualByteLength < visualUpdateStepBytes
            ) {
              return
            }

            lastVisualByteLength = loadedByteLength

            const loadedByteEndExclusive = Math.min(
              byteStart + loadedByteLength,
              byteEnd + 1
            )
            const warmedUntilSeconds =
              activeSourceStartRef.current +
              Math.min(loadedByteEndExclusive / bytesPerSecond, knownDuration)

            preloadRangeWarmedUntilRef.current = Math.max(
              preloadRangeWarmedUntilRef.current,
              warmedUntilSeconds
            )
            setBufferedTime((previousBufferedTime) => {
              const nextBufferedTime = Math.max(
                previousBufferedTime,
                preloadRangeWarmedUntilRef.current
              )

              return Math.abs(previousBufferedTime - nextBufferedTime) >= 0.25
                ? nextBufferedTime
                : previousBufferedTime
            })
          }

          const downloadStartedAt = performance.now()

          await drainResponseBody(response, (byteLength) => {
            loadedByteLength = Math.min(
              loadedByteLength + byteLength,
              requestedByteLength
            )

            const elapsedSeconds = Math.max(
              (performance.now() - downloadStartedAt) / 1000,
              0.001
            )
            const estimatedDownloadBitrateMbps = Number(
              ((loadedByteLength * 8) / elapsedSeconds / 1_000_000).toFixed(1)
            )

            setCurrentDownloadBitrateMbps((previousBitrate) =>
              previousBitrate !== estimatedDownloadBitrateMbps
                ? estimatedDownloadBitrateMbps
                : previousBitrate
            )
            updateWarmupDisplay()
          })

          loadedByteLength = requestedByteLength
          updateWarmupDisplay(true)
        })
        .catch(() => undefined)
        .finally(() => {
          if (preloadRangeAbortRef.current === controller) {
            preloadRangeAbortRef.current = null
          }

          preloadRangeFetchingRef.current = false

          const activeVideo = videoRef.current

          if (
            activeVideo &&
            sourceUrlRef.current === sourceUrl &&
            !isAnyCastingRef()
          ) {
            applyLocalPreloadRampRef.current(activeVideo)
          }
        })
    })
  }

  function applyLocalPreloadRamp(video: HTMLVideoElement) {
    video.preload = "auto"

    if (!sourceUrlRef.current || isAnyCastingRef()) {
      return
    }

    const targetAheadSeconds = getPreloadAheadTargetSeconds()
    const bufferedAhead = Math.max(getBufferedEnd(video) - video.currentTime, 0)

    if (bufferedAhead >= targetAheadSeconds) {
      return
    }

    warmLocalDirectBuffer(video, targetAheadSeconds)
  }

  function isAnyCastingRef() {
    return isCastingRef.current || isServerCastingRef.current || isNativeRemoteCastingRef.current
  }

  useEffect(() => {
    emitCastClockProgressRef.current = emitCastClockProgress
    loadServerCastStatusRef.current = loadServerCastStatus
    handleServerCastStatusErrorRef.current = handleServerCastStatusError
    syncCastMediaStateRef.current = syncCastMediaState
    applyLocalPreloadRampRef.current = applyLocalPreloadRamp
  })

  const clearCastMediaSync = useCallback(() => {
    clearCastClock()
    castMediaCleanupRef.current?.()
    castMediaCleanupRef.current = null

    if (castProgressTimerRef.current) {
      clearInterval(castProgressTimerRef.current)
      castProgressTimerRef.current = null
    }
  }, [])

  const clearServerCastStatusGrace = useCallback(() => {
    if (serverCastStatusGraceTimerRef.current) {
      clearTimeout(serverCastStatusGraceTimerRef.current)
      serverCastStatusGraceTimerRef.current = null
    }

    serverCastStatusGraceActiveRef.current = false
  }, [])

  const startServerCastStatusGrace = useCallback(() => {
    clearServerCastStatusGrace()
    serverCastStatusGraceActiveRef.current = true
    serverCastStatusGraceTimerRef.current = setTimeout(() => {
      serverCastStatusGraceActiveRef.current = false
      serverCastStatusGraceTimerRef.current = null
    }, 10_000)
  }, [clearServerCastStatusGrace])

  const clearServerCastMediaSync = useCallback(() => {
    clearCastClock()

    if (serverCastProgressTimerRef.current) {
      clearInterval(serverCastProgressTimerRef.current)
      serverCastProgressTimerRef.current = null
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

  function clearSourceSwitchPauseSuppression() {
    if (sourceSwitchPauseSuppressionTimerRef.current) {
      window.clearTimeout(sourceSwitchPauseSuppressionTimerRef.current)
      sourceSwitchPauseSuppressionTimerRef.current = null
    }

    sourceSwitchPauseSuppressedRef.current = false
  }

  function startSourceSwitchPauseSuppression() {
    clearSourceSwitchPauseSuppression()
    sourceSwitchPauseSuppressedRef.current = true

    sourceSwitchPauseSuppressionTimerRef.current = window.setTimeout(() => {
      sourceSwitchPauseSuppressedRef.current = false
      sourceSwitchPauseSuppressionTimerRef.current = null
    }, 5000)
  }

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
    [clearControlsTimer, setControlsVisible, setSettingsOpen]
  )

  useEffect(() => {
    return () => {
      clearNativeRemoteFallbackTimer()
    }
  }, [clearNativeRemoteFallbackTimer])

  useEffect(() => {
    if (isIosBrowser()) {
      return
    }

    void ensureGoogleCastFramework().catch(() => undefined)
  }, [])

  useEffect(() => {
    const removeListener = addGoogleCastSessionStateListener((event) => {
      if (isGoogleCastConnectedState(event.sessionState)) {
        showControls(true)
      }

      if (
        isGoogleCastEndingState(event.sessionState) &&
        (isCastingRef.current || isCastLoadingRef.current)
      ) {
        if (document.visibilityState === "hidden") {
          return
        }

        handleCastEndedRef.current()
      }
    })

    return () => {
      removeListener()
    }
  }, [showControls])

  useEffect(() => {
    function resyncActiveCast() {
      if (!isAnyCastingRef()) {
        return
      }

      emitCastClockProgressRef.current()

      if (isServerCastingRef.current) {
        void loadServerCastStatusRef.current().catch(handleServerCastStatusErrorRef.current)
        return
      }

      const session = getGoogleCastSession()

      if (session) {
        const state = getGoogleCastMediaState(session)

        if (state) {
          syncCastMediaStateRef.current(state)
        }
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        resyncActiveCast()
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("focus", resyncActiveCast)
    window.addEventListener("pageshow", resyncActiveCast)

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("focus", resyncActiveCast)
      window.removeEventListener("pageshow", resyncActiveCast)
    }
  }, [])

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
    const video = videoRef.current

    clearPreloadRamp()

    if (!video || !sourceUrl || isCasting || isServerCasting || isNativeRemoteCasting) {
      return
    }

    preloadRampElapsedSecondsRef.current = 0
    applyLocalPreloadRampRef.current(video)
    preloadRampTimerRef.current = setInterval(() => {
      const activeVideo = videoRef.current

      preloadRampElapsedSecondsRef.current += preloadRampTickMs / 1000

      if (activeVideo) {
        applyLocalPreloadRampRef.current(activeVideo)
      }
    }, preloadRampTickMs)

    return clearPreloadRamp
  }, [
    isCasting,
    isNativeRemoteCasting,
    isServerCasting,
    localDirectAudioRemuxActive,
    sourceUrl,
    status,
  ])

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
      watchedSeconds / effectiveDuration >= episodeCompletionRatio &&
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
      knownDuration && knownDuration > 0 ? endedTime / knownDuration >= episodeCompletionRatio : endedTime >= 60

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
      return true
    }

    return false
  }

  useEffect(
    () => () => {
      clearControlsTimer()
      clearHardwareWaitTimer()
      clearPriorityInfoTimer()
      clearCastErrorFlashTimer()
      clearCastMediaSync()
      clearServerCastMediaSync()
      clearServerCastStatusGrace()
      clearPreloadRamp()
      clearSeekPreviewFrameTimer()
      clearSubtitleAnimationFrame()
    },
    [
      clearControlsTimer,
      clearHardwareWaitTimer,
      clearPriorityInfoTimer,
      clearCastErrorFlashTimer,
      clearCastMediaSync,
      clearServerCastMediaSync,
      clearServerCastStatusGrace,
      clearSeekPreviewFrameTimer,
      clearSubtitleAnimationFrame,
    ]
  )

  const getPlaybackClockPosition = useCallback((video: HTMLVideoElement | null) => {
    const mediaSeconds =
      video && Number.isFinite(video.currentTime)
        ? video.currentTime
        : currentTimeRef.current

    return getSourceClockSeconds(mediaSeconds, activeSourceStartRef.current)
  }, [])

  const getPlaybackPosition = useCallback(() => {
    return getPlaybackClockPosition(videoRef.current)
  }, [getPlaybackClockPosition])

  const syncBufferedTime = useCallback(
    (video: HTMLVideoElement | null) => {
      if (!video) {
        return
      }

      const sourceOffset = activeSourceStartRef.current
      const bufferedEnd = getSourceClockSeconds(getBufferedEnd(video), sourceOffset)
      const nextBufferedTime = Math.max(
        bufferedEnd,
        preloadRangeWarmedUntilRef.current,
        currentTimeRef.current,
        0
      )
      const measuredDuration = Number.isFinite(video.duration)
        ? video.duration + sourceOffset
        : undefined
      const knownDuration = getStableDuration(durationSeconds, measuredDuration, duration)
      const clampedBufferedTime =
        knownDuration > 0 ? Math.min(nextBufferedTime, knownDuration) : nextBufferedTime

      setBufferedTime((previousBufferedTime) => {
        const nextBufferedTime = Math.max(previousBufferedTime, clampedBufferedTime)

        return Math.abs(previousBufferedTime - nextBufferedTime) >= 0.25
          ? nextBufferedTime
          : previousBufferedTime
      })
    },
    [duration, durationSeconds]
  )

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
        clientId: stableClientStreamId,
      }),
    [directAudioRemuxActive, playback.directUrl, selectedAudioStreamId, stableClientStreamId]
  )

  const getTranscodeUrl = useCallback(
    (_profile: PlaybackProfile, startTime?: number) =>
      withStreamParams(playback.originalTranscodeUrl, {
        audioStreamId: selectedAudioStreamId,
        startTime,
        clientId: stableClientStreamId,
      }),
    [playback.originalTranscodeUrl, selectedAudioStreamId, stableClientStreamId]
  )

  const getWebVideoCasterDirectUrl = useCallback(() => {
    const url = new URL(
      withStreamParams(playback.castDirectUrl, {
        audioStreamId: null,
        startTime: null,
        clientId: stableClientStreamId,
      }),
      window.location.href
    )

    url.searchParams.set("wvc", "direct")

    return url.toString()
  }, [playback.castDirectUrl, stableClientStreamId])

  const getWebVideoCasterTranscodeUrl = useCallback(() => {
    const url = new URL(
      withStreamParams(playback.castTranscodeUrl, {
        audioStreamId: selectedAudioStreamId,
        startTime: null,
        clientId: stableClientStreamId,
      }),
      window.location.href
    )

    url.searchParams.set("wvc", "transcode")

    return url.toString()
  }, [playback.castTranscodeUrl, selectedAudioStreamId, stableClientStreamId])

  function switchSource(
    nextSourceUrl: string,
    nextStatus: PlaybackStatusState,
    options: SwitchSourceOptions = {}
  ) {
    const video = videoRef.current
    const previousPosition = options.preservePosition ? getPlaybackPosition() : 0
    const useWebVideoCasterSourceList = canExposeWebVideoCasterSources
    const sourceUsesOffset =
      nextStatus === "transcoding" ||
      (!useWebVideoCasterSourceList && localDirectAudioRemuxActive)
    const sourceStartTime = sourceUsesOffset
      ? options.transcodeStartTime ?? previousPosition
      : 0
    const sourceAudioStreamId =
      nextStatus !== "direct"
        ? selectedAudioStreamId
        : useWebVideoCasterSourceList
          ? null
          : sourceUsesOffset
            ? selectedAudioStreamId
            : isIosDevice
              ? null
              : selectedAudioStreamId
    const sourceToLoad = sourceUsesOffset
      ? withStreamParams(nextSourceUrl, {
          audioStreamId: sourceAudioStreamId,
          startTime: sourceStartTime,
          clientId: clientStreamIdRef.current,
        })
      : withStreamParams(nextSourceUrl, {
          audioStreamId: sourceAudioStreamId,
          startTime: null,
          clientId: clientStreamIdRef.current,
        })
    const shouldResume =
      Boolean(video && !video.paused) ||
      isPlayingRef.current ||
      shouldAutoPlaySourceRef.current

    const previousStatus = statusRef.current
    const preservedBufferedTime =
      options.preservePosition && previousStatus === "direct" && nextStatus === "direct"
        ? Math.max(bufferedTime, previousPosition, sourceStartTime)
        : sourceStartTime

    activeSourceStartRef.current = sourceStartTime
    resetStreamStats()
    preloadRangeWarmedUntilRef.current = preservedBufferedTime
    setBufferedTime(preservedBufferedTime)

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
      startSourceSwitchPauseSuppression()
    } else if (sourceChanged) {
      clearSourceSwitchPauseSuppression()
    }

    setStatus(nextStatus)
    statusRef.current = nextStatus

    if (sourceChanged) {
      sourceUrlRef.current = sourceToLoad
      if (video) {
        if (useWebVideoCasterSourceList && nextStatus === "direct") {
          video.removeAttribute("src")
          video.load()
        } else {
          video.src = sourceToLoad
          video.load()
        }
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
    resetStreamStats()
    preloadRangeWarmedUntilRef.current = 0
    setBufferedTime(0)
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
        preloadRangeWarmedUntilRef.current = 0
        setBufferedTime(0)
        setControlsVisible(!isPlayingRef.current)
        setSettingsOpen(false)
        endMediaWait()
        lastProgressSavePositionRef.current = 0
        completedProgressRef.current = false
        directFallbackAttemptedRef.current = false
      }

      if (isCastingRef.current || isServerCastingRef.current) {
        const video = videoRef.current

        if (episodeChanged && video) {
          if (isServerCastingRef.current && serverCastDeviceIdRef.current) {
            void startServerCastingToDeviceRef.current(
              serverCastDeviceIdRef.current,
              autoPlay || isPlayingRef.current,
              0
            ).catch((error) => {
              flashCastError(error)
              console.error(error)
            })
          } else {
            void startGoogleCastingRef.current(
              video,
              autoPlay || isPlayingRef.current,
              0
            )
          }
        }

        return
      }

      const video = videoRef.current
      const useWebVideoCasterSources = canExposeWebVideoCasterSources
      const canUseDirect = useWebVideoCasterSources
        ? true
        : video
          ? supportsLocalDirectPlayback({
              video,
              fileName,
              media,
              selectedAudioStream: playbackAudioStream,
              directAudioRemuxActive: localDirectAudioRemuxActive,
            })
          : false
      const waitForPrioritySwitch = pendingPrioritySwitchRef.current
      pendingPrioritySwitchRef.current = false

      setDirectPossible(canUseDirect)
      setStatus("checking")
      endMediaWait()

      if (useWebVideoCasterSources) {
        directFallbackAttemptedRef.current = false
        switchSourceRef.current(getWebVideoCasterDirectUrl(), "direct", {
          preservePosition: Boolean(previousSourceUrl) && !episodeChanged,
          waitForMedia: waitForPrioritySwitch,
        })
        return
      }

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
    getWebVideoCasterDirectUrl,
    canExposeWebVideoCasterSources,
    isInsideWebVideoCaster,
    isIosDevice,
    liveTranscodeEnabled,
    media,
    playbackKey,
    quality,
    playbackAudioStream,
    localDirectAudioRemuxActive,
    flashCastError,
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
        void video.play().catch((error: unknown) => {
          handlePlayRequestFailureRef.current(error)
        })
      }, 0)

      return () => window.clearTimeout(timer)
    }
  }, [beginMediaWait, sourceUrl])

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

          if (!cues.length && subtitleCuesRef.current.length) {
            return
          }

          subtitleCuesRef.current = cues
          setSubtitleCues(cues)
          syncSubtitleOverlay()
        }
      })
      .catch((error) => {
        if (!cancelled) {
          if (!subtitleCuesRef.current.length) {
            activeSubtitleKeyRef.current = ""
            setSubtitleCues([])
            setActiveSubtitleTexts([])
          }

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

  const handleBandwidthRecheckStarted = useCallback(
    (action: StreamPriorityAction) => {
      const video = videoRef.current
      const wasCasting = isCastingRef.current || isServerCastingRef.current || isCastLoadingRef.current
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

        if (isServerCastingRef.current && wasPlaying) {
          const sessionId = serverCastSessionIdRef.current

          if (sessionId) {
            void fetch(serverCastControlApiPath, {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: JSON.stringify({
                action: "pause",
                sessionId,
              }),
            }).catch((error) => {
              flashCastError(error)
              console.error(error)
            })
          }
        } else if (session && wasPlaying) {
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

        if (isServerCastingRef.current && serverCastDeviceIdRef.current) {
          void startServerCastingToDeviceRef.current(
            serverCastDeviceIdRef.current,
            snapshot.wasPlaying,
            snapshot.position
          ).catch((error) => {
            flashCastError(error)
            console.error(error)
            endMediaWait()
          })
          return
        }

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

      if (isServerCastingRef.current) {
        const sessionId = serverCastSessionIdRef.current

        if (sessionId) {
          void fetch(serverCastControlApiPath, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              action: "pause",
              sessionId,
            }),
          }).catch((error) => {
            flashCastError(error)
            console.error(error)
          })
        }
      } else if (session) {
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
      handleBandwidthRecheckFinished,
      handleBandwidthRecheckStarted,
      handleServerShutdownStarted,
      showPriorityInfoMessage,
    ]
  )

  useEffect(() => {
    let cancelled = false
    let events: EventSource | null = null
    let staleConnectionTimer: number | null = null
    let reconnectTimer: number | null = null
    let lastEventAt = Date.now()
    const clientId = clientStreamIdRef.current
    const priorityEventsUrl = new URL(
      "/api/stream/priority/events",
      window.location.origin
    )
    priorityEventsUrl.searchParams.set("clientId", clientId)
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
  }, [handlePriorityAction])

  function tryDirectPlay() {
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
      ? supportsLocalDirectPlayback({
          video,
          fileName,
          media,
          selectedAudioStream: playbackAudioStream,
          directAudioRemuxActive: localDirectAudioRemuxActive,
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

  function shouldFallbackDirectPlaybackFailure() {
    return (
      statusRef.current === "direct" &&
      quality === "original" &&
      !directFallbackAttemptedRef.current &&
      !canExposeWebVideoCasterSources
    )
  }

  function fallbackDirectToTranscode() {
    directFallbackAttemptedRef.current = true

    if (!liveTranscodeEnabled) {
      blockLiveTranscodePlayback()
      return
    }

    switchSourceRef.current(
      canExposeWebVideoCasterSources
        ? getWebVideoCasterTranscodeUrl()
        : getTranscodeUrl("original"),
      "transcoding",
      {
        preservePosition: true,
        waitForMedia: isPlaying || autoPlay || isPlayingRef.current,
      }
    )
  }

  function handleLocalPlaybackFailure() {
    setIsPlaying(false)
    endMediaWait()

    if (!shouldFallbackDirectPlaybackFailure()) {
      return false
    }

    fallbackDirectToTranscode()
    return true
  }

  function isCurrentLocalVideoSource(video: HTMLVideoElement) {
    const expectedSourceUrl = sourceUrlRef.current
    const currentSourceUrl = video.currentSrc || video.src

    if (!expectedSourceUrl || !currentSourceUrl) {
      return true
    }

    return urlsPointToSameResource(currentSourceUrl, expectedSourceUrl)
  }

  function shouldFallbackFromPlayRejection(error: unknown, video: HTMLVideoElement) {
    if (!isCurrentLocalVideoSource(video)) {
      return false
    }

    const errorName = error instanceof DOMException ? error.name : undefined

    if (errorName === "NotAllowedError" || errorName === "AbortError") {
      return false
    }

    if (errorName === "NotSupportedError") {
      return true
    }

    const mediaError = video.error

    return Boolean(
      mediaError &&
        (mediaError.code === mediaErrorDecodeCode ||
          mediaError.code === mediaErrorSourceNotSupportedCode)
    )
  }

  function handlePlayRequestFailure(error: unknown) {
    const video = videoRef.current

    setIsPlaying(false)
    endMediaWait()
    showControls(true)

    if (!video || !shouldFallbackFromPlayRejection(error, video)) {
      return false
    }

    return handleLocalPlaybackFailure()
  }

  useEffect(() => {
    handlePlayRequestFailureRef.current = handlePlayRequestFailure
  })

  async function togglePlay() {
    if (isServerCastingRef.current) {
      await toggleServerCastPlayback()
      showControls()
      return
    }

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
      await video.play().catch((error: unknown) => {
        handlePlayRequestFailure(error)
      })
    } else {
      video.pause()
    }

    showControls()
  }

  async function seekTo(seconds: number) {
    if (isServerCastingRef.current) {
      const target = clampTime(seconds, duration)

      currentTimeRef.current = target
      setCurrentTime(target)

      if (statusRef.current === "transcoding" || directAudioRemuxActive) {
        const deviceId = serverCastDeviceIdRef.current

        if (!deviceId) {
          flashCastError(new Error("Server-side Chromecast device is missing"))
          return
        }

        beginMediaWait(statusRef.current === "transcoding")

        try {
          await startServerCastingToDeviceRef.current(deviceId, isPlayingRef.current, target)
        } catch (error) {
          flashCastError(error)
          console.error(error)
        }

        showControls()
        return
      }

      try {
        await sendServerCastControl({
          action: "seek",
          currentTime: target,
        })
      } catch (error) {
        flashCastError(error)
        console.error(error)
      }

      showControls()
      return
    }

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

    if (isIosBrowser()) {
      if (video && video.readyState === 0) {
        video.load()
      }

      if (requestNativeVideoFullscreen(video)) {
        return
      }
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

  function waitForGoogleCastSessionWarmup() {
    const delayMs = isAndroidBrowser() ? 1200 : 650

    return new Promise<void>((resolve) => {
      window.setTimeout(resolve, delayMs)
    })
  }

  function waitForGoogleCastLoadRetryDelay() {
    return new Promise<void>((resolve) => {
      window.setTimeout(resolve, isAndroidBrowser() ? 900 : 500)
    })
  }

  async function loadGoogleCastMedia(input: {
    session: GoogleCastSessionHandle
    url: string
    contentType: string
    shouldResume: boolean
    startTime: number
    durationSeconds?: number
    textTrack?: CastTextTrack
    timeoutMs?: number | null
    bufferingIsLoaded?: boolean
  }) {
    if (input.textTrack) {
      assertGoogleCastReceiverUrlReachable(input.textTrack.url)
    }

    const request = createGoogleCastLoadRequest({
      url: input.url,
      contentType: input.contentType,
      autoplay: input.shouldResume,
      currentTime: input.startTime,
      durationSeconds: input.durationSeconds,
      textTrack: input.textTrack,
    })

    if (!request) {
      throw new Error("Google Cast media request could not be created")
    }

    const mediaSession = await input.session.loadMedia(request)

    const result = await waitForGoogleCastMediaLoad({
      session: input.session,
      contentId: input.url,
      initialMediaSession: mediaSession,
      timeoutMs: input.timeoutMs,
      bufferingIsLoaded: input.bufferingIsLoaded,
    })

    if (result === "loaded" && input.shouldResume) {
      await playGoogleCastMedia(input.session).catch(() => undefined)
    }

    return result
  }

  async function loadGoogleCastMediaWithRetry(input: Parameters<typeof loadGoogleCastMedia>[0] & {
    retryOnce: boolean
  }) {
    const { retryOnce, ...loadInput } = input
    const firstResult = await loadGoogleCastMedia(loadInput)

    if (!retryOnce || firstResult === "loaded") {
      return firstResult
    }

    await waitForGoogleCastLoadRetryDelay()
    return loadGoogleCastMedia(loadInput)
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
      if (typeof document !== "undefined" && document.visibilityState === "hidden" && isAnyCastingRef()) {
        return
      }

      handleCastEndedRef.current()
      return
    }

    syncCastClock(state)

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
        const autoAdvanced = completePlayback(sourcePosition, knownDuration)

        if (!autoAdvanced) {
          handleCastEndedRef.current()
        }

        return
      }

      if (state.idleReason === "ERROR") {
        flashCastError(new Error("Google Cast receiver stopped playback."))
      }

      handleCastEndedRef.current()
    }
  }

  function syncServerCastMediaState(state: GoogleCastMediaState) {
    if (
      serverCastStatusGraceActiveRef.current &&
      (!state.isAlive || state.playerState === "IDLE")
    ) {
      return
    }

    syncCastMediaState(state)
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

  async function loadServerCastStatus() {
    const sessionId = serverCastSessionIdRef.current

    if (!sessionId) {
      return
    }

    const url = new URL(serverCastStatusApiPath, window.location.href)
    url.searchParams.set("sessionId", sessionId)

    const response = await fetch(url)

    if (!response.ok) {
      throw new Error("Server-side Chromecast status failed.")
    }

    const payload = (await response.json()) as ServerCastStatusResponse
    serverCastStatusFailureCountRef.current = 0
    syncServerCastMediaState(payload.state)
  }

  function handleServerCastStatusError(error: unknown) {
    serverCastStatusFailureCountRef.current += 1

    if (document.visibilityState === "hidden") {
      return
    }

    if (serverCastStatusFailureCountRef.current < maxServerCastStatusFailures) {
      return
    }

    flashCastError(error)
    handleCastEndedRef.current()
  }

  function attachServerCastMediaSync(contentId: string) {
    clearServerCastMediaSync()
    castContentIdRef.current = contentId
    castFinishedHandledRef.current = false
    serverCastStatusFailureCountRef.current = 0

    serverCastProgressTimerRef.current = setInterval(() => {
      void loadServerCastStatus().catch(handleServerCastStatusError)
    }, serverCastStatusPollMs)

    void loadServerCastStatus().catch(handleServerCastStatusError)
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
    resetStreamStats()
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
    setIsCastStarting(false)
    setIsCasting(true)
    setStatus(nextStatus)
    statusRef.current = nextStatus
    endMediaWait()
    suspendLocalVideoForCast()
    attachCastMediaSync(session, contentId)
  }

  function activateServerCastPlayback(input: {
    candidate: ServerCastCandidate
    sessionId: string
    deviceId: string
  }) {
    castSourceStartOffsetRef.current = Math.max(input.candidate.sourceStartOffset, 0)
    isCastLoadingRef.current = false
    isServerCastingRef.current = true
    serverCastSessionIdRef.current = input.sessionId
    serverCastDeviceIdRef.current = input.deviceId
    castSelectionKeyRef.current = castSelectionKey
    startServerCastStatusGrace()
    setIsCastStarting(false)
    setIsServerCasting(true)
    setServerCastDeviceModalOpen(false)
    setStatus(input.candidate.id === "direct" ? "direct" : "transcoding")
    statusRef.current = input.candidate.id === "direct" ? "direct" : "transcoding"
    endMediaWait()
    suspendLocalVideoForCast()
    attachServerCastMediaSync(input.candidate.url)
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

  async function sendServerCastControl(input: {
    action: "pause" | "play" | "seek" | "stop"
    currentTime?: number
  }) {
    const sessionId = serverCastSessionIdRef.current

    if (!sessionId) {
      throw new Error("Server-side Chromecast session is missing")
    }

    const response = await fetch(serverCastControlApiPath, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...input,
        sessionId,
      }),
    })

    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; state?: ServerCastMediaState }
      | null

    if (!response.ok || !payload?.ok || !payload.state) {
      throw new Error(payload?.error ?? "Server-side Chromecast command failed.")
    }

    syncCastMediaState(payload.state)
  }

  async function toggleServerCastPlayback() {
    try {
      if (isPlaying) {
        await sendServerCastControl({ action: "pause" })
        resumeLocalAfterCastEndRef.current = false
        setIsPlaying(false)
      } else {
        await sendServerCastControl({ action: "play" })
        resumeLocalAfterCastEndRef.current = true
        setIsPlaying(true)
      }
    } catch (error) {
      flashCastError(error)
      console.error(error)
      handleCastEnded()
    }
  }

  function keepLocalPausedAfterFailedCastStart() {
    isCastLoadingRef.current = false
    isCastingRef.current = false
    isServerCastingRef.current = false
    serverCastSessionIdRef.current = null
    serverCastDeviceIdRef.current = null
    clearServerCastMediaSync()
    clearServerCastStatusGrace()
    resumeLocalAfterCastEndRef.current = false
    shouldAutoPlaySourceRef.current = false
    endMediaWait()
    restoreLocalSource({ preservePosition: true })
    setIsCasting(false)
    setIsServerCasting(false)
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
    const castTranscodeBaseUrl = playback.castTranscodeUrl
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

    const existingSession = getGoogleCastSession()
    const isFreshCastSession = !existingSession
    const session = existingSession ?? (await requestGoogleCastSession())

    if (isFreshCastSession) {
      await waitForGoogleCastSessionWarmup()
    }

    try {
      await setGoogleCastReceiverVolumeOnce(session, 1)
    } catch (error) {
      reportCastError(error)
      console.error(error)
    }

    if (directFirst) {
      try {
        assertGoogleCastReceiverUrlReachable(directCastUrl)
        const result = await loadGoogleCastMediaWithRetry({
          session,
          url: directCastUrl,
          contentType: getCastDirectContentType(fileName, directAudioRemuxActive),
          shouldResume,
          startTime: directCastRequestTime,
          durationSeconds,
          textTrack: directTextTrack,
          timeoutMs: 20_000,
          bufferingIsLoaded: !isAndroidBrowser(),
          retryOnce: isFreshCastSession && isAndroidBrowser(),
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
        new Error("Live transcoding is unavailable for this episode.")
      )
      keepLocalPausedAfterFailedCastStart()
      return false
    }

    setStatus("transcoding")
    beginMediaWait(true)
    try {
      assertGoogleCastReceiverUrlReachable(transcodeCastUrl)
      const result = await loadGoogleCastMediaWithRetry({
        session,
        url: transcodeCastUrl,
        contentType: "video/mp4",
        shouldResume,
        startTime: 0,
        durationSeconds,
        textTrack: transcodeTextTrack,
        timeoutMs: 90_000,
        bufferingIsLoaded: !isAndroidBrowser(),
        retryOnce: isFreshCastSession && isAndroidBrowser(),
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



  function buildServerCastCandidates(video: HTMLVideoElement, startTime: number) {
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
    const castTranscodeBaseUrl = playback.castTranscodeUrl
    const transcodeCastStartOffset = startTime > 0.25 ? startTime : 0
    const transcodeCastUrl = getCastReceiverUrl(
      withStreamParams(castTranscodeBaseUrl, {
        audioStreamId: selectedAudioStreamId,
        startTime: transcodeCastStartOffset,
        clientId: clientStreamIdRef.current,
      })
    )
    const title = document.title || `${animeId} S${seasonNumber.toString().padStart(2, "0")}E${episodeNumber
      .toString()
      .padStart(2, "0")}`
    const candidates: ServerCastCandidate[] = []

    if (directFirst) {
      candidates.push({
        id: "direct",
        url: directCastUrl,
        contentType: getCastDirectContentType(fileName, directAudioRemuxActive),
        currentTime: directCastRequestTime,
        sourceStartOffset: directCastStartOffset,
        durationSeconds,
        textTrack: getSelectedCastTextTrack(directCastStartOffset),
        title,
        tracking: castProgressTracking,
      })
    }

    if (liveTranscodeEnabled) {
      candidates.push({
        id: "transcode",
        url: transcodeCastUrl,
        contentType: "video/mp4",
        currentTime: 0,
        sourceStartOffset: transcodeCastStartOffset,
        durationSeconds,
        textTrack: getSelectedCastTextTrack(transcodeCastStartOffset),
        title,
        tracking: castProgressTracking,
      })
    }

    return {
      candidates,
      localFallbackSource:
        quality === "original" && (canLocalDirect || !liveTranscodeEnabled)
          ? getDirectUrl()
          : getTranscodeUrl(quality),
      localFallbackStatus:
        quality === "original" && (canLocalDirect || !liveTranscodeEnabled)
          ? "direct"
          : "transcoding",
      canLocalDirect,
    } satisfies {
      candidates: ServerCastCandidate[]
      localFallbackSource: string
      localFallbackStatus: PlaybackStatusState
      canLocalDirect: boolean
    }
  }

  async function startServerCastingToDevice(deviceId: string, shouldResume: boolean, startTimeOverride?: number) {
    const video = videoRef.current

    if (!video) {
      throw new Error("Video player is not ready.")
    }

    const startTime = startTimeOverride ?? getPlaybackPosition()
    const built = buildServerCastCandidates(video, startTime)

    if (!built.candidates.length) {
      throw new Error("Live transcoding is disabled and this file cannot be cast directly.")
    }

    localPlaybackBeforeCastRef.current = {
      sourceUrl: sourceUrlRef.current ?? built.localFallbackSource,
      status: built.localFallbackStatus,
      quality,
      directPossible: built.canLocalDirect,
      position: startTime,
      wasMuted: video.muted,
    }
    resumeLocalAfterCastEndRef.current = shouldResume
    video.muted = true
    video.pause()
    setIsPlaying(false)
    isPlayingRef.current = false
    isCastLoadingRef.current = true
    beginMediaWait(false)
    showControls(true)

    const response = await fetch(serverCastStartApiPath, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        autoplay: shouldResume,
        candidates: built.candidates,
        deviceId,
        receiverBaseUrl: getCurrentPageLanOrigin(),
      }),
    })
    const payload = (await response.json().catch(() => null)) as
      | ({ ok?: boolean; error?: string } & Partial<ServerCastStartResponse>)
      | null

    if (!response.ok || !payload?.ok || !payload.candidate || !payload.sessionId) {
      keepLocalPausedAfterFailedCastStart()
      throw new Error(payload?.error ?? "Server-side Chromecast failed to start.")
    }

    activateServerCastPlayback({
      candidate: payload.candidate,
      deviceId,
      sessionId: payload.sessionId,
    })
    syncServerCastMediaState(payload.state ?? {
      contentId: payload.candidate.url,
      isAlive: true,
      playerState: shouldResume ? "PLAYING" : "PAUSED",
      positionSeconds: 0,
    })
  }

  async function loadServerCastDevices() {
    setServerCastDeviceModalOpen(true)
    setServerCastDevicesLoading(true)
    setServerCastDevices([])

    try {
      const receiverBaseUrl = getCurrentPageLanOrigin()
      const devicesUrl = new URL(serverCastDevicesApiPath, window.location.href)

      if (receiverBaseUrl) {
        devicesUrl.searchParams.set("receiverBaseUrl", receiverBaseUrl)
      }

      const response = await fetch(devicesUrl)

      if (!response.ok) {
        throw new Error("Server-side Chromecast discovery failed.")
      }

      const payload = (await response.json()) as ServerCastDevicesResponse
      setServerCastDevices(payload.devices)

      if (!payload.devices.length) {
        flashCastError(new Error("No Chromecast / Google TV devices were found on the server network."))
      }
    } catch (error) {
      flashCastError(error)
      console.error(error)
    } finally {
      setServerCastDevicesLoading(false)
    }
  }

  async function startSelectedServerCastDevice(deviceId: string) {
    const video = videoRef.current

    if (!video) {
      flashCastError(new Error("Video player is not ready."))
      return
    }

    const startTime = getPlaybackPosition()
    const shouldResume = !video.paused || isPlayingRef.current || startTime <= 0.35
    const startPromise = startServerCastingToDevice(deviceId, shouldResume, startTime)

    setServerCastDeviceModalOpen(false)
    castStartPromiseRef.current = startPromise.then(() => true)
    setIsCastStarting(true)

    try {
      await startPromise
    } catch (error) {
      flashCastError(error)
      console.error(error)
    } finally {
      castStartPromiseRef.current = null
      setIsCastStarting(false)
    }
  }

  useEffect(() => {
    startServerCastingToDeviceRef.current = startServerCastingToDevice
  })

  useEffect(() => {
    startGoogleCastingRef.current = startGoogleCasting
  })

  useEffect(() => {
    const receiverCastActive = isCasting || isServerCasting

    if (!receiverCastActive) {
      castSelectionKeyRef.current = castSelectionKey
      return
    }

    if (castSelectionKeyRef.current === castSelectionKey) {
      return
    }

    castSelectionKeyRef.current = castSelectionKey

    if (isServerCasting) {
      const deviceId = serverCastDeviceIdRef.current

      if (!deviceId) {
        handleCastEndedRef.current()
        return
      }

      void startServerCastingToDeviceRef.current(
        deviceId,
        isPlayingRef.current,
        getPlaybackPosition()
      ).catch((error) => {
        flashCastError(error)
        console.error(error)
      })
      return
    }

    const video = videoRef.current

    if (!video) {
      return
    }

    void startGoogleCastingRef.current(video, isPlayingRef.current, getPlaybackPosition())
  }, [castSelectionKey, getPlaybackPosition, isCasting, isServerCasting, flashCastError])

  function startIosExternalCastHandoff(video: HTMLVideoElement) {
    const pageUrl = getIosExternalCastPageUrl()
    const deepLink = getIosExternalCastDeepLink({
      url: pageUrl,
      title: document.title || `${animeId} S${seasonNumber.toString().padStart(2, "0")}E${episodeNumber
        .toString()
        .padStart(2, "0")}`,
    })
    let appOpened = false
    let finished = false

    function markOpened() {
      appOpened = true
    }

    function cleanup() {
      window.removeEventListener("pagehide", markOpened)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        markOpened()
      }
    }

    window.addEventListener("pagehide", markOpened)
    document.addEventListener("visibilitychange", handleVisibilityChange)

    video.pause()
    setIsPlaying(false)
    isPlayingRef.current = false
    setIosExternalCastAppUnavailable(false)
    showControls(true)

    try {
      window.location.assign(deepLink)
    } catch (error) {
      finished = true
      cleanup()
      setIosExternalCastAppUnavailable(true)
      throw error
    }

    window.setTimeout(() => {
      if (finished) {
        return
      }

      finished = true
      cleanup()

      if (appOpened || document.visibilityState === "hidden") {
        return
      }

      setIosExternalCastAppUnavailable(true)
      flashCastError(
        new Error(
          `Install ${iosExternalCastAppName} from the App Store (${iosExternalCastAppStoreUrl}), then reload this page and tap Cast again. Yamibunko opens this watch page in that app because iPhone browsers cannot use the normal Google Cast Web Sender path.`
        )
      )
    }, iosExternalCastOpenTimeoutMs)
  }

  async function startCasting() {
    const video = videoRef.current

    if (!video || !sourceUrl) {
      flashCastError(new Error("Casting cannot start until media is loaded."))
      console.error("Casting cannot start until media is loaded.")
      return
    }

    if (isIosBrowser() && isWebVideoCasterBrowser()) {
      flashCastError(new Error("Use Web Video Caster's own cast controls on iOS."))
      return
    }

    if (castStartPromiseRef.current || isCastLoadingRef.current) {
      showControls(true)
      return
    }

    if (shouldOpenIosExternalCastApp()) {
      try {
        startIosExternalCastHandoff(video)
      } catch (error) {
        flashCastError(error)
        console.error(error)
      }
      return
    }

    if (shouldUseIosServerCastBridge()) {
      await loadServerCastDevices()
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
    clearServerCastMediaSync()
    clearServerCastStatusGrace()
    castContentIdRef.current = null
    castSourceStartOffsetRef.current = 0
    castFinishedHandledRef.current = false
    castStartPromiseRef.current = null
    setIsCastStarting(false)
    isCastLoadingRef.current = false
    isCastingRef.current = false
    isServerCastingRef.current = false
    serverCastSessionIdRef.current = null
    serverCastDeviceIdRef.current = null
    setIsCasting(false)
    setIsServerCasting(false)
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
    if (isNativeRemoteCastingRef.current) {
      handleNativeRemoteEnded()
      return
    }

    if (serverCastSessionIdRef.current || isServerCastingRef.current || isServerCasting) {
      void sendServerCastControl({ action: "stop" })
        .catch((error) => {
          flashCastError(error)
          console.error(error)
        })
        .finally(() => {
          handleCastEnded()
        })
      return
    }

    safeEndGoogleCastSession(getGoogleCastSession(), true)
    handleCastEnded()
  }

  function handleProgress(event: React.SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget

    syncBufferedTime(video)

    const estimatedMbps = streamMbps

    if (!estimatedMbps || estimatedMbps <= 0) {
      streamStatsSampleRef.current = null
      return
    }

    const bufferedEnd = getBufferedEnd(video)
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

    const estimatedDownloadBitrateMbps = Number(
      ((bufferedSeconds * estimatedMbps) / elapsedSeconds).toFixed(1)
    )

    setCurrentDownloadBitrateMbps((previousBitrate) =>
      previousBitrate !== estimatedDownloadBitrateMbps
        ? estimatedDownloadBitrateMbps
        : previousBitrate
    )
  }

  function handleTimeUpdate(event: React.SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget
    const sourceOffset = activeSourceStartRef.current
    const watchedSeconds = getSourceClockSeconds(video.currentTime, sourceOffset)
    const measuredDuration = Number.isFinite(video.duration)
      ? video.duration + sourceOffset
      : undefined

    syncBufferedTime(video)
    updateWatchedProgress(watchedSeconds, measuredDuration)
  }

  function handlePause() {
    const video = videoRef.current

    if (
      shouldAutoPlaySourceRef.current &&
      sourceSwitchPauseSuppressedRef.current
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

    if (knownDuration > 0) {
      setBufferedTime(knownDuration)
    }

    completePlayback(endedTime, knownDuration)
  }

  function changeQuality(nextQuality: PlaybackProfile) {
    if (!liveTranscodeEnabled) {
      setQuality("original")
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

  function markTouchControlActionHandled() {
    if (touchControlActionSuppressionTimerRef.current) {
      window.clearTimeout(touchControlActionSuppressionTimerRef.current)
    }

    touchControlActionSuppressedRef.current = true
    touchControlClickSuppressionRef.current = true

    touchControlActionSuppressionTimerRef.current = window.setTimeout(() => {
      touchControlActionSuppressedRef.current = false
      touchControlClickSuppressionRef.current = false
      touchControlActionSuppressionTimerRef.current = null
    }, 520)
  }

  function wasTouchControlActionRecentlyHandled() {
    return touchControlActionSuppressedRef.current
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

    if (wasTouchControlActionRecentlyHandled()) {
      return
    }

    markTouchControlActionHandled()
    action()
  }

  function runTouchEndControlAction(
    event: React.TouchEvent<HTMLElement>,
    action: () => void
  ) {
    event.preventDefault()
    event.stopPropagation()

    if (wasTouchControlActionRecentlyHandled()) {
      return
    }

    markTouchControlActionHandled()
    action()
  }

  function runClickControlAction(
    event: React.MouseEvent<HTMLElement>,
    action: () => void
  ) {
    event.stopPropagation()

    if (touchControlClickSuppressionRef.current || wasTouchControlActionRecentlyHandled()) {
      event.preventDefault()
      return
    }

    action()
  }

  const displayedCurrentTime = seekPreview ?? currentTime
  const displayedSubtitleText = activeSubtitleTexts.join("\n")
  const displayedSubtitleLineCount = displayedSubtitleText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length
  const currentPlaybackKey = `${animeId}:${seasonNumber}:${episodeNumber}`
  const playerAspectRatio =
    detectedPlayerAspectRatio?.playbackKey === currentPlaybackKey
      ? detectedPlayerAspectRatio.aspectRatio
      : getPreferredPlayerAspectRatio(media.videoWidth, media.videoHeight)
  const canSkipIntro = duration > introSkipSeekSeconds && currentTime < introSkipVisibleSeconds
  const canSkipOutro = duration > 0 && currentTime >= duration * 0.8 && currentTime < duration - 1
  const castSkipLabel = canSkipIntro ? "Skip intro" : canSkipOutro ? "Skip outro" : "Skip intro/outro"
  const receiverCastActive = isCasting || isServerCasting
  const isAnyCasting = receiverCastActive || isNativeRemoteCasting
  const usePhonePortraitCastLayout = isPhoneViewport && isPortraitViewport
  const usePhoneLandscapeCastLayout = isPhoneViewport && !isPortraitViewport
  const shouldShowCastOverlay = isAnyCasting || isCastStarting
  const shouldShowCastLoadingOverlay = isCastStarting && !isAnyCasting
  const canControlActiveCast = receiverCastActive || isNativeRemoteCasting
  const castControlSubtitle = isServerCasting
    ? "Yamibunko is controlling this Chromecast through the server."
    : "Yamibunko is controlling this Chromecast / Google TV."
  const shouldBlockMobilePortraitPlayback =
    isMobilePortraitViewport && !isAnyCasting && !isFullscreen
  const controlsAreVisible =
    !shouldBlockMobilePortraitPlayback &&
    (controlsVisible || !isPlaying || isAnyCasting || settingsOpen)
  const castPreflightError = getCastPreflightError()
  const shouldDisableIosWebVideoCasterCast = isIosDevice && isInsideWebVideoCaster
  const shouldUseIosExternalCastHandoff = isIosDevice && !isInsideWebVideoCaster && shouldOpenIosExternalCastApp()
  const shouldUseIosServerCast = isIosDevice && !isInsideWebVideoCaster && shouldUseIosServerCastBridge()
  const shouldShowIosExternalCastEpisodeNav =
    shouldBlockMobilePortraitPlayback && canExposeWebVideoCasterSources
  const castButtonLabel = shouldDisableIosWebVideoCasterCast
    ? "Use Web Video Caster's cast controls"
    : shouldUseIosExternalCastHandoff
    ? `Open in ${iosExternalCastAppName}`
    : shouldUseIosServerCast
      ? "Chromecast"
      : castPreflightError ?? "Google Cast"
  const castButtonDisabled =
    !sourceUrl ||
    isCastStarting ||
    shouldDisableIosWebVideoCasterCast ||
    (shouldUseIosExternalCastHandoff && iosExternalCastAppUnavailable)
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
  const webVideoCasterSources = canExposeWebVideoCasterSources
    ? {
        directUrl: getWebVideoCasterDirectUrl(),
        transcodeUrl: liveTranscodeEnabled ? getWebVideoCasterTranscodeUrl() : null,
        directContentType: getCastDirectContentType(fileName, false),
        directFileName: getWebVideoCasterSourceFileName("direct", fileName),
        transcodeFileName: getWebVideoCasterSourceFileName("transcode", fileName),
        durationSeconds,
      }
    : null

  const shouldShowCastErrorPortal = Boolean(castErrorMessage && serverCastOverlayPortalRoot && (shouldUseIosServerCast || serverCastDeviceModalOpen))

  const castOverlayContentClass = usePhonePortraitCastLayout
    ? "relative z-10 flex h-full flex-col items-center justify-center gap-2 px-3 py-3"
    : usePhoneLandscapeCastLayout
      ? "relative z-10 flex h-full flex-col items-center justify-between gap-1.5 px-3 py-2"
      : "relative z-10 flex h-full flex-col items-center px-3 py-3 sm:px-6 lg:px-10 lg:py-8"
  const castTopControlsClass = usePhonePortraitCastLayout
    ? "gap-2 rounded-2xl p-1.5"
    : usePhoneLandscapeCastLayout
      ? "gap-2 rounded-2xl p-1.5"
      : "gap-3 rounded-3xl p-2 sm:p-3"
  const castActionButtonClass = usePhonePortraitCastLayout
    ? "h-10 rounded-xl px-3 text-xs"
    : usePhoneLandscapeCastLayout
      ? "h-9 rounded-xl px-3 text-xs"
      : "h-12 rounded-2xl px-4 text-sm lg:h-14 lg:px-5 lg:text-base"
  const castSkipButtonClass = usePhonePortraitCastLayout
    ? "h-10 rounded-xl px-3 text-xs"
    : usePhoneLandscapeCastLayout
      ? "h-9 rounded-xl px-4 text-xs"
      : "h-12 rounded-2xl px-6 text-sm lg:h-14 lg:px-8 lg:text-base"
  const castSmallIconClass = usePhonePortraitCastLayout || usePhoneLandscapeCastLayout
    ? "size-4"
    : "size-5 lg:size-6"
  const castSubtitleClass = usePhonePortraitCastLayout
    ? "text-[0.68rem] leading-snug"
    : usePhoneLandscapeCastLayout
      ? "text-[0.68rem] leading-tight"
      : "text-xs sm:text-sm"
  const castControlRowWrapperClass = usePhonePortraitCastLayout
    ? "py-0"
    : usePhoneLandscapeCastLayout
      ? "flex-1 py-1"
      : "flex-1 py-4 lg:py-8"
  const castControlPanelClass = usePhonePortraitCastLayout
    ? "gap-1.5 rounded-2xl p-2"
    : usePhoneLandscapeCastLayout
      ? "gap-2 rounded-2xl p-2"
      : "gap-2 rounded-[2rem] p-3 sm:gap-4 sm:p-4 lg:gap-5 lg:p-5"
  const castControlButtonClass = usePhonePortraitCastLayout
    ? "size-11"
    : usePhoneLandscapeCastLayout
      ? "size-12"
      : "size-14 sm:size-16 lg:size-20"
  const castControlIconClass = usePhonePortraitCastLayout
    ? "size-6"
    : usePhoneLandscapeCastLayout
      ? "size-6"
      : "size-8 sm:size-9 lg:size-11"
  const castPlayIconClass = usePhonePortraitCastLayout
    ? "ml-0.5 size-6"
    : usePhoneLandscapeCastLayout
      ? "ml-0.5 size-6"
      : "ml-1 size-8 sm:size-9 lg:size-11"
  const castProgressWrapperClass = usePhonePortraitCastLayout
    ? "w-full max-w-md pb-0"
    : usePhoneLandscapeCastLayout
      ? "w-full max-w-3xl pb-0"
      : "w-full max-w-5xl pb-1 sm:pb-2 lg:pb-4"
  const castProgressPanelClass = usePhonePortraitCastLayout
    ? "rounded-2xl px-3 py-2"
    : usePhoneLandscapeCastLayout
      ? "rounded-2xl px-3 py-2"
      : "rounded-3xl px-4 py-4 sm:px-6 lg:px-8 lg:py-5"
  const castTimeClass = usePhoneLandscapeCastLayout
    ? "mt-1 text-center text-base font-semibold tracking-wide text-zinc-100 tabular-nums"
    : "mt-3 text-center text-2xl font-semibold tracking-wide text-zinc-100 tabular-nums lg:mt-4 lg:text-4xl"
  const castSeekPreviewClass = usePhoneLandscapeCastLayout
    ? "pointer-events-none absolute bottom-[4.8rem] z-10 w-44 -translate-x-1/2 overflow-hidden rounded-xl border border-white/15 bg-zinc-950 shadow-2xl"
    : "pointer-events-none absolute bottom-[5.7rem] z-10 w-48 -translate-x-1/2 overflow-hidden rounded-xl border border-white/15 bg-zinc-950 shadow-2xl lg:bottom-[6.5rem] lg:w-64"

  return (
    <div className="yami-anime-player space-y-3 lg:space-y-4">
      <div
        ref={playerRef}
        className={`yami-anime-player-frame group/player relative overflow-hidden rounded-xl border border-white/10 bg-black shadow-[0_28px_90px_rgba(0,0,0,0.45)] ${
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
          {...({
            disableRemotePlayback: false,
            "x-webkit-airplay": "allow",
            "webkit-playsinline": "true",
          } as Record<string, string | boolean>)}
          preload="auto"
          {...({ fetchPriority: "high" } as Record<string, string>)}
          poster={thumbnailUrl}
          src={webVideoCasterSources ? webVideoCasterSources.directUrl : sourceUrl ?? undefined}
          onDurationChange={(event) => {
            const nextDuration = getStableDuration(
              durationSeconds,
              event.currentTarget.duration,
              duration
            )

            if (nextDuration > 0) {
              setDuration(nextDuration)
            }

            syncBufferedTime(event.currentTarget)
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
            syncBufferedTime(video)
          }}
          onEnded={handleEnded}
          onError={(event) => {
            if (
              isCastingRef.current ||
              isCastLoadingRef.current ||
              bandwidthRecheckHoldRef.current
            ) {
              return
            }

            if (!webVideoCasterSources && !isCurrentLocalVideoSource(event.currentTarget)) {
              return
            }

            if (handleLocalPlaybackFailure()) {
              return
            }

            setStatus("blocked")
            statusRef.current = "blocked"
            showControls(true)
          }}
          onLoadStart={() => {
            if (isPlaying || shouldAutoPlaySourceRef.current) {
              beginMediaWait()
            }
          }}
          onLoadedData={(event) => {
            applyPendingSeek(event.currentTarget)
            syncBufferedTime(event.currentTarget)
            endMediaWait()
          }}
          onCanPlay={(event) => {
            applyPendingSeek(event.currentTarget)
            syncBufferedTime(event.currentTarget)
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

            clearSourceSwitchPauseSuppression()
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

            clearSourceSwitchPauseSuppression()
            setIsPlaying(true)
            endMediaWait()
            showControls()
          }}
          onWaiting={() => beginMediaWait()}
          onTimeUpdate={handleTimeUpdate}
          onProgress={handleProgress}
          onVolumeChange={(event) => syncLocalVolumeState(event.currentTarget)}
        >
        </video>

        {shouldBlockMobilePortraitPlayback ? (
          <div
            className="absolute inset-0 z-40 grid place-items-center overflow-hidden bg-zinc-950 text-white"
            aria-live="polite"
          >
            <div className="absolute inset-0 animate-pulse bg-[radial-gradient(circle_at_50%_30%,rgba(168,85,247,0.18),transparent_34%),linear-gradient(180deg,rgba(24,24,27,0.85),rgba(0,0,0,0.98))]" />
            <div className="relative flex w-full max-w-md flex-col items-center gap-4 px-6 text-center">
              <div className="grid w-full grid-cols-[3.25rem_minmax(0,1fr)_3.25rem] items-center gap-3 sm:grid-cols-[4rem_minmax(0,1fr)_4rem] sm:gap-4">
                {shouldShowIosExternalCastEpisodeNav ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="size-14 rounded-2xl border border-white/15 bg-zinc-950/70 text-white shadow-xl hover:border-white/25 hover:bg-zinc-900 disabled:opacity-35 sm:size-16"
                    disabled={!previousEpisode || !onEpisodeChange}
                    aria-label="Previous episode"
                    onTouchEnd={(event) =>
                      runTouchEndControlAction(event, () => {
                        if (previousEpisode && onEpisodeChange) {
                          onEpisodeChange(previousEpisode, false)
                        }
                      })
                    }
                    onPointerUp={(event) =>
                      runTouchControlAction(event, () => {
                        if (previousEpisode && onEpisodeChange) {
                          onEpisodeChange(previousEpisode, false)
                        }
                      })
                    }
                    onClick={(event) =>
                      runClickControlAction(event, () => {
                        if (previousEpisode && onEpisodeChange) {
                          onEpisodeChange(previousEpisode, false)
                        }
                      })
                    }
                  >
                    <SkipBack className="size-6 sm:size-8" />
                  </Button>
                ) : (
                  <div />
                )}

                <div className="flex min-w-0 flex-col items-center gap-3">
                  <div className="grid size-20 place-items-center rounded-full border border-violet-300/30 bg-white/[0.06] text-violet-200 shadow-2xl sm:size-24">
                    <RefreshCw className="size-10 sm:size-12" />
                  </div>
                  <div className="text-2xl font-semibold tracking-wide text-zinc-100 sm:text-3xl">
                    rotate to play
                  </div>
                </div>

                {shouldShowIosExternalCastEpisodeNav ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="size-14 rounded-2xl border border-white/15 bg-zinc-950/70 text-white shadow-xl hover:border-white/25 hover:bg-zinc-900 disabled:opacity-35 sm:size-16"
                    disabled={!nextEpisode || !onEpisodeChange}
                    aria-label="Next episode"
                    onTouchEnd={(event) =>
                      runTouchEndControlAction(event, () => {
                        if (nextEpisode && onEpisodeChange) {
                          onEpisodeChange(nextEpisode, false)
                        }
                      })
                    }
                    onPointerUp={(event) =>
                      runTouchControlAction(event, () => {
                        if (nextEpisode && onEpisodeChange) {
                          onEpisodeChange(nextEpisode, false)
                        }
                      })
                    }
                    onClick={(event) =>
                      runClickControlAction(event, () => {
                        if (nextEpisode && onEpisodeChange) {
                          onEpisodeChange(nextEpisode, false)
                        }
                      })
                    }
                  >
                    <SkipForward className="size-6 sm:size-8" />
                  </Button>
                ) : (
                  <div />
                )}
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
                onTouchEnd={(event) =>
                  runTouchEndControlAction(event, () => {
                    void startCasting()
                  })
                }
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
                <Cast className="size-4" />
                <span>Cast</span>
              </Button>
              {castErrorMessage && !shouldShowCastErrorPortal ? (
                <div className="max-w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-red-400/30 bg-red-950/90 px-4 py-3 text-sm font-semibold text-white shadow-2xl backdrop-blur">
                  {castErrorMessage}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {shouldShowCastErrorPortal && serverCastOverlayPortalRoot ? (
          createPortal(
            <div
              className="pointer-events-none fixed inset-x-0 z-[130] flex justify-center px-4 text-white"
              style={{
                bottom: "max(1rem, env(safe-area-inset-bottom))",
              }}
            >
              <div className="max-h-[min(14rem,45dvh)] max-w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-red-400/30 bg-red-950/95 px-4 py-3 text-sm font-semibold shadow-2xl backdrop-blur">
                {castErrorMessage}
              </div>
            </div>,
            serverCastOverlayPortalRoot
          )
        ) : null}

        {serverCastDeviceModalOpen && serverCastOverlayPortalRoot ? (
          createPortal(
            <div
            className="fixed inset-0 z-[120] flex items-start justify-center overflow-y-auto bg-black/75 px-4 text-white backdrop-blur-sm"
            style={{
              paddingTop: "max(1rem, env(safe-area-inset-top))",
              paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-3xl border border-white/10 bg-zinc-950/95 p-4 shadow-2xl sm:p-5">
              <div className="space-y-1">
                <div className="text-lg font-semibold">Choose Chromecast</div>
                <div className="text-sm text-zinc-300">
                  Yamibunko will cast from the server LAN address, so this also works when iPhone browsers cannot use the normal Google Cast button.
                </div>
              </div>

              <div className="mt-4 max-h-64 space-y-2 overflow-y-auto pr-1">
                {serverCastDevicesLoading ? (
                  <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-sm text-zinc-200">
                    <Loader2 className="size-4 animate-spin" />
                    Searching for Chromecast / Google TV devices…
                  </div>
                ) : serverCastDevices.length ? (
                  serverCastDevices.map((device) => (
                    <button
                      key={device.id}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-left transition hover:border-violet-300/40 hover:bg-violet-500/10 disabled:opacity-50"
                      disabled={isCastStarting}
                      onClick={() => {
                        void startSelectedServerCastDevice(device.id)
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-zinc-100">
                          {device.name}
                        </span>
                        <span className="block truncate text-xs text-zinc-400">
                          {device.modelName ? `${device.modelName} · ` : ""}{device.host}:{device.port}
                        </span>
                      </span>
                      {isCastStarting ? (
                        <Loader2 className="size-4 shrink-0 animate-spin text-violet-200" />
                      ) : (
                        <Cast className="size-4 shrink-0 text-violet-200" />
                      )}
                    </button>
                  ))
                ) : (
                  <div className="rounded-2xl border border-yellow-400/20 bg-yellow-950/30 px-3 py-3 text-sm text-yellow-50">
                    No Chromecast / Google TV devices were found by the Yamibunko server. Your phone is using the server LAN address; make sure the TV is on the same subnet and the server PC/firewall allows local Cast discovery.
                  </div>
                )}
              </div>

              <div className="mt-4 flex flex-wrap justify-end gap-2">
                {shouldUseIosExternalCastHandoff ? (
                  <Button
                    type="button"
                    variant="secondary"
                    className="rounded-2xl bg-zinc-900"
                    disabled={iosExternalCastAppUnavailable}
                    onClick={() => {
                      const video = videoRef.current

                      if (!video) {
                        return
                      }

                      try {
                        startIosExternalCastHandoff(video)
                        setServerCastDeviceModalOpen(false)
                      } catch (error) {
                        flashCastError(error)
                        console.error(error)
                      }
                    }}
                  >
                    Open in {iosExternalCastAppName}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="secondary"
                  className="rounded-2xl bg-zinc-900"
                  onClick={() => {
                    setServerCastDeviceModalOpen(false)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>,
            serverCastOverlayPortalRoot
          )
        ) : null}

        {shouldShowCastOverlay ? (
          <div className="absolute inset-0 z-30 bg-black text-white">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_18%,rgba(127,29,29,0.2),transparent_36%),linear-gradient(180deg,rgba(24,24,27,0.32),rgba(0,0,0,0.82))]" />


            {shouldShowCastLoadingOverlay ? (
              <div className="relative z-10 flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
                <div className="grid size-20 place-items-center rounded-full border border-violet-300/25 bg-violet-500/10 shadow-2xl shadow-violet-950/30">
                  <Loader2 className="size-9 animate-spin text-violet-100" />
                </div>
                <div className="space-y-1">
                  <div className="text-xl font-semibold text-white">Starting Cast</div>
                  <div className="max-w-sm text-sm text-zinc-300">
                    Loading the episode on your Chromecast / Google TV.
                  </div>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  className="rounded-2xl border border-white/20 bg-zinc-950/70 px-4 text-white hover:bg-zinc-900"
                  onClick={(event) => {
                    event.stopPropagation()
                    stopCasting()
                  }}
                >
                  Cancel cast
                </Button>
              </div>
            ) : (
            <div className={castOverlayContentClass}>
              <div className="flex w-full flex-col items-center gap-2 text-center">
                <div
                  className={`flex w-full max-w-5xl flex-wrap items-center justify-center border border-white/10 bg-zinc-950/35 shadow-2xl backdrop-blur-md sm:w-auto ${castTopControlsClass}`}
                >
                  <HoverHint label="Stop casting">
                    <Button
                      type="button"
                      variant="secondary"
                      className={`border border-white/30 bg-zinc-950/70 font-medium text-white shadow-xl hover:border-white/45 hover:bg-zinc-900 disabled:opacity-45 ${castActionButtonClass}`}
                      aria-label="Stop casting"
                      onClick={(event) => {
                        event.stopPropagation()
                        stopCasting()
                      }}
                    >
                      <RadioOffIcon className={castSmallIconClass} />
                      <span>Stop casting</span>
                    </Button>
                  </HoverHint>

                  <Button
                    type="button"
                    variant="secondary"
                    className={`border border-white/30 bg-zinc-950/70 font-medium text-white shadow-xl hover:border-white/45 hover:bg-zinc-900 disabled:opacity-45 ${castSkipButtonClass}`}
                    disabled={!canSkipIntro && !canSkipOutro}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (canSkipIntro) {
                        void seekTo(Math.min(currentTime + introSkipSeekSeconds, duration))
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
                <div
                  className={`max-w-md text-zinc-300 ${castSubtitleClass}`}
                >
                  {castControlSubtitle}
                </div>
              </div>


              <div
                className={`flex min-h-0 w-full items-center justify-center ${castControlRowWrapperClass}`}
              >
                <div
                  className={`grid grid-cols-4 items-center border border-white/10 bg-zinc-950/35 shadow-2xl backdrop-blur-md ${castControlPanelClass}`}
                >
                  <HoverHint label="Previous episode">
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className={`rounded-2xl border border-white/10 bg-white/[0.06] text-white shadow-xl hover:border-white/20 hover:bg-white/10 disabled:opacity-35 ${
                        castControlButtonClass
                      }`}
                      disabled={!previousEpisode}
                      aria-label="Previous episode"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (previousEpisode && onEpisodeChange) {
                          onEpisodeChange(previousEpisode, isPlayingRef.current)
                        }
                      }}
                    >
                      <SkipBack className={castControlIconClass} />
                    </Button>
                  </HoverHint>

                  <HoverHint label={isPlaying ? "Pause" : "Play"}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className={`rounded-2xl border border-white/10 bg-white/[0.06] text-white shadow-xl hover:border-white/20 hover:bg-white/10 disabled:opacity-35 ${
                        castControlButtonClass
                      }`}
                      disabled={!canControlActiveCast}
                      aria-label={isPlaying ? "Pause" : "Play"}
                      onClick={(event) => {
                        event.stopPropagation()
                        void togglePlay()
                      }}
                    >
                      {isPlaying ? (
                        <Pause className={castControlIconClass} />
                      ) : (
                        <Play className={castPlayIconClass} />
                      )}
                    </Button>
                  </HoverHint>

                  <HoverHint label="Next episode">
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className={`rounded-2xl border border-white/10 bg-white/[0.06] text-white shadow-xl hover:border-white/20 hover:bg-white/10 disabled:opacity-35 ${
                        castControlButtonClass
                      }`}
                      disabled={!nextEpisode}
                      aria-label="Next episode"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (nextEpisode && onEpisodeChange) {
                          onEpisodeChange(nextEpisode, isPlayingRef.current)
                        }
                      }}
                    >
                      <SkipForward className={castControlIconClass} />
                    </Button>
                  </HoverHint>

                  <div ref={settingsButtonRef}>
                    <HoverHint label="Settings">
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        className={`rounded-2xl border border-white/10 bg-white/[0.06] text-white shadow-xl hover:border-white/20 hover:bg-white/10 ${
                          castControlButtonClass
                        }`}
                        onClick={(event) => {
                          event.stopPropagation()
                          setSettingsOpen((open) => !open)
                          showControls(true)
                        }}
                        aria-label="Settings"
                      >
                        <Settings className={castControlIconClass} />
                      </Button>
                    </HoverHint>
                  </div>
                </div>
              </div>

              <div className={castProgressWrapperClass}>
                <div
                  className={`relative border border-white/10 bg-zinc-950/35 shadow-2xl backdrop-blur-md ${castProgressPanelClass}`}
                >
                  {seekPreviewFrame ? (
                    <div
                      className={castSeekPreviewClass}
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

                  <BufferedSeekBar
                    durationSeconds={duration}
                    currentTimeSeconds={displayedCurrentTime}
                    bufferedSeconds={bufferedTime}
                    trackClassName="h-4 w-full lg:h-5"
                    trackHeight="1rem"
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
                    aria-label="Seek cast playback"
                  />
                  {!usePhonePortraitCastLayout ? (
                    <div className={castTimeClass}>
                      {formatTime(displayedCurrentTime)} / {formatTime(duration)}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
            )}
          </div>
        ) : null}

        {isWaitingForMedia && !shouldShowCastLoadingOverlay ? (
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
          className={`absolute top-1/2 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-150 ${
            centerToggleVisible ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <button
            type="button"
            className="grid size-20 place-items-center lg:size-24 rounded-full bg-black/45 text-white/70 hover:bg-black/60 hover:text-white"
            disabled={!sourceUrl}
            onClick={(event) => {
              event.stopPropagation()
              void togglePlay()
            }}
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
              void seekTo(Math.min(currentTime + introSkipSeekSeconds, duration))
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

        {!isAnyCasting ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-[5.75rem] z-10 flex justify-center overflow-hidden px-4 text-center text-xl font-semibold leading-snug text-white drop-shadow-[0_2px_5px_rgba(0,0,0,0.95)] sm:text-2xl lg:bottom-[6.75rem]">
            {displayedSubtitleText ? (
              <div
                className="max-w-[70%] whitespace-pre-line break-words [overflow-wrap:anywhere]"
                style={{
                  transform:
                    displayedSubtitleLineCount > 1
                      ? `translateY(-${Math.min(displayedSubtitleLineCount - 1, 3) * 0.45}rem)`
                      : undefined,
                }}
              >
                {displayedSubtitleText}
              </div>
            ) : null}
          </div>
        ) : null}


        {castErrorMessage && !shouldShowCastErrorPortal ? (
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
                </select>
              </label>
            ) : null}

            {liveTranscodeEnabled ? (
              <div className="grid gap-1 text-zinc-300">
                <span>Display Method</span>
                <DisplayMethodStatsBadge stats={playbackStats} />
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
          className={`absolute inset-x-0 bottom-0 z-20 bg-zinc-950/40 p-3 backdrop-blur-md lg:p-4 transition-opacity duration-300 ${
            controlsAreVisible ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <div className="flex items-center gap-2 lg:gap-3">
            <HoverHint label={isPlaying ? "Pause" : "Play"}>
              <Button
                type="button"
                size="icon"
                onClick={(event) => {
                  event.stopPropagation()
                  void togglePlay()
                }}
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
              <BufferedSeekBar
                durationSeconds={duration}
                currentTimeSeconds={displayedCurrentTime}
                bufferedSeconds={bufferedTime}
                trackClassName="h-2 w-full lg:h-3"
                trackHeight="0.5rem"
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
                aria-label="Seek playback"
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
                onTouchEnd={(event) =>
                  runTouchEndControlAction(event, () => {
                    void startCasting()
                  })
                }
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
                onClick={(event) => {
                  event.stopPropagation()
                  requestFullscreen()
                }}
                aria-label="Fullscreen"
              >
                <Maximize2 className="size-4 lg:size-5" />
              </Button>
            </HoverHint>
          </div>
        </div>
        ) : null}
      </div>

      {webVideoCasterSources ? (
        <div className="rounded-2xl border border-violet-300/20 bg-violet-950/20 p-3 text-sm text-violet-50 shadow-lg">
          <div className="font-semibold">Web Video Caster sources</div>
          <p className="mt-1 text-xs text-violet-100/80">
            Yamibunko exposes both receiver-safe video URLs. Use Web Video Caster&apos;s own cast controls and let it choose a source; transcoding only starts if that transcode URL is actually opened.
          </p>
          <div className="mt-3 grid gap-3">
            <div className="rounded-xl border border-white/10 bg-zinc-950/55 p-2">
              <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                <span className="font-medium text-white">Direct Play</span>
                <a
                  href={webVideoCasterSources.directUrl}
                  type={webVideoCasterSources.directContentType}
                  download={webVideoCasterSources.directFileName}
                  title={webVideoCasterSources.directFileName}
                  data-yamibunko-wvc-source="direct-link"
                  data-yamibunko-wvc-label="Direct Play"
                  data-yamibunko-wvc-filename={webVideoCasterSources.directFileName}
                  data-yamibunko-duration-seconds={webVideoCasterSources.durationSeconds ?? undefined}
                  className="rounded-full border border-white/10 bg-zinc-950/70 px-3 py-1 text-[11px] font-medium text-white transition hover:border-violet-300/50 hover:bg-violet-500/20"
                >
                  Open Direct
                </a>
              </div>
              <video
                controls
                playsInline
                preload="auto"
                poster={thumbnailUrl}
                src={webVideoCasterSources.directUrl}
                title={webVideoCasterSources.directFileName}
                aria-label={webVideoCasterSources.directFileName}
                data-yamibunko-wvc-source="direct-video"
                data-yamibunko-wvc-label="Direct Play"
                data-yamibunko-wvc-filename={webVideoCasterSources.directFileName}
                data-yamibunko-duration-seconds={webVideoCasterSources.durationSeconds ?? undefined}
                onEnded={handleEnded}
                onTimeUpdate={handleTimeUpdate}
                onProgress={handleProgress}
                className="h-16 w-full rounded-lg bg-black object-cover"
              />
            </div>
            {webVideoCasterSources.transcodeUrl ? (
              <div className="rounded-xl border border-white/10 bg-zinc-950/55 p-2">
                <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                  <span className="font-medium text-white">Compatibility Transcode</span>
                  <a
                    href={webVideoCasterSources.transcodeUrl}
                    type="video/mp4"
                    download={webVideoCasterSources.transcodeFileName}
                    title={webVideoCasterSources.transcodeFileName}
                    data-yamibunko-wvc-source="transcode-link"
                    data-yamibunko-wvc-label="Compatibility Transcode"
                    data-yamibunko-wvc-filename={webVideoCasterSources.transcodeFileName}
                    data-yamibunko-duration-seconds={webVideoCasterSources.durationSeconds ?? undefined}
                    className="rounded-full border border-white/10 bg-zinc-950/70 px-3 py-1 text-[11px] font-medium text-white transition hover:border-violet-300/50 hover:bg-violet-500/20"
                  >
                    Open Transcode
                  </a>
                </div>
                <video
                  controls
                  playsInline
                  preload="auto"
                  poster={thumbnailUrl}
                  src={webVideoCasterSources.transcodeUrl}
                  title={webVideoCasterSources.transcodeFileName}
                  aria-label={webVideoCasterSources.transcodeFileName}
                  data-yamibunko-wvc-source="transcode-video"
                  data-yamibunko-wvc-label="Compatibility Transcode"
                  data-yamibunko-wvc-filename={webVideoCasterSources.transcodeFileName}
                  data-yamibunko-duration-seconds={webVideoCasterSources.durationSeconds ?? undefined}
                  onEnded={handleEnded}
                  onTimeUpdate={handleTimeUpdate}
                  onProgress={handleProgress}
                  className="h-16 w-full rounded-lg bg-black object-cover"
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
