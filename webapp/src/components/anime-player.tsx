"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Cast,
  Loader2,
  Maximize2,
  Pause,
  Play,
  Settings,
  SkipBack,
  SkipForward,
  Square,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  addGoogleCastMediaStateListener,
  addGoogleCastSessionStateListener,
  createGoogleCastLoadRequest,
  ensureGoogleCastFramework,
  getGoogleCastMediaState,
  getGoogleCastContext,
  getGoogleCastSession,
  getGoogleCastUnavailableReason,
  isGoogleCastConnectedState,
  isGoogleCastEndingState,
  pauseGoogleCastMedia,
  playGoogleCastMedia,
  requestGoogleCastSession,
  safeEndGoogleCastSession,
  seekGoogleCastMedia,
  waitForGoogleCastMediaLoad,
  type GoogleCastMediaState,
  type GoogleCastSessionHandle,
} from "@/lib/google-cast"
import type { Episode, MediaStreamInfo, PlaybackProfile, WatchPayload } from "@/lib/types"

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
  onEpisodeChange?: (episode: Episode, autoPlay: boolean) => void
}

type PlaybackStatusState = "checking" | "direct" | "transcoding" | "blocked"

type SwitchSourceOptions = {
  preservePosition?: boolean
  waitForMedia?: boolean
  transcodeStartTime?: number
}

type SeekPreviewFrame = {
  time: number
  leftPercent: number
}

type LocalPlaybackSnapshot = {
  sourceUrl: string | null
  status: PlaybackStatusState
  quality: PlaybackProfile
  directPossible: boolean
  position: number
  wasMuted: boolean
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

function canPlayAny(video: HTMLVideoElement, checks: string[]) {
  return checks.some((codec) => {
    const result = video.canPlayType(codec)
    return result === "probably" || result === "maybe"
  })
}

function supportsHevcDecode(video: HTMLVideoElement) {
  return canPlayAny(video, hevcMp4Checks)
}

function supportsDirectPlayback(video: HTMLVideoElement, fileName: string) {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? ""
  const hevcMatroskaChecks = [
    'video/x-matroska; codecs="hvc1"',
    'video/x-matroska; codecs="hev1"',
    'video/x-matroska; codecs="hevc"',
  ]

  if (extension === "mp4" || extension === "m4v") {
    return supportsHevcDecode(video)
  }

  if (extension === "mkv") {
    return supportsHevcDecode(video) || canPlayAny(video, hevcMatroskaChecks)
  }

  if (extension === "webm") {
    return canPlayAny(video, ['video/webm; codecs="vp9"', "video/webm"])
  }

  return canPlayAny(video, [...hevcMp4Checks, ...hevcMatroskaChecks])
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

function isLoopbackHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
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
  return typeof window === "undefined" ? "http://localhost" : window.location.href
}

function withStreamParams(
  sourceUrl: string,
  input: { audioStreamId?: string | null; startTime?: number | null }
) {
  const url = new URL(sourceUrl, getUrlBase())

  if (input.audioStreamId) {
    url.searchParams.set("audio", input.audioStreamId)
  } else {
    url.searchParams.delete("audio")
  }

  const startTime = input.startTime

  if (typeof startTime === "number" && Number.isFinite(startTime) && startTime > 0.25) {
    url.searchParams.set("start", startTime.toFixed(3))
  } else {
    url.searchParams.delete("start")
  }

  return serializeUrl(sourceUrl, url)
}

function withSubtitleStream(sourceUrl: string, streamId: string) {
  const url = new URL(sourceUrl, getUrlBase())
  url.searchParams.set("stream", streamId)
  return serializeUrl(sourceUrl, url)
}

function estimateStreamMbps(input: {
  quality: PlaybackProfile
  sourceBitrateMbps?: number
  status: PlaybackStatusState
}) {
  const source = input.sourceBitrateMbps

  if (!source || source <= 0) {
    return undefined
  }

  if (input.status === "direct") {
    return source
  }

  return input.quality === "dataSaver"
    ? Math.max(Number((source / 2).toFixed(2)), 0.5)
    : source
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
  onEpisodeChange,
}: AnimePlayerProps) {
  const playerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const playbackKeyRef = useRef(`${animeId}:${seasonNumber}:${episodeNumber}`)
  const castSelectionKeyRef = useRef("")
  const lastProgressSaveRef = useRef(0)
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
  const isCastingRef = useRef(false)
  const isCastLoadingRef = useRef(false)
  const isPlayingRef = useRef(false)
  const castContentIdRef = useRef<string | null>(null)
  const castErrorFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const castFinishedHandledRef = useRef(false)
  const castMediaCleanupRef = useRef<(() => void) | null>(null)
  const castProgressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const castStartPromiseRef = useRef<Promise<boolean> | null>(null)
  const localPlaybackBeforeCastRef = useRef<LocalPlaybackSnapshot | null>(null)
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hardwareWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  const [currentTime, setCurrentTime] = useState(0)
  const [seekPreview, setSeekPreview] = useState<number | null>(null)
  const [seekPreviewFrame, setSeekPreviewFrame] = useState<SeekPreviewFrame | null>(null)
  const [duration, setDuration] = useState(getStableDuration(durationSeconds))
  const [controlsVisible, setControlsVisible] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [canCast, setCanCast] = useState(false)
  const [isCasting, setIsCasting] = useState(false)
  const [isCastStarting, setIsCastStarting] = useState(false)
  const [castErrorFlash, setCastErrorFlash] = useState(false)
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([])
  const [activeSubtitleTexts, setActiveSubtitleTexts] = useState<string[]>([])
  const [measuredStreamMbps, setMeasuredStreamMbps] = useState<number | null>(null)

  const playbackKey = `${animeId}:${seasonNumber}:${episodeNumber}`
  const liveTranscodeEnabled = playback.liveTranscodeEnabled !== false
  const selectedAudioStream = useMemo(
    () => media.audioStreams.find((stream) => stream.id === selectedAudioStreamId),
    [media.audioStreams, selectedAudioStreamId]
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
      setMeasuredStreamMbps(null)
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

  useEffect(() => {
    let cancelled = false

    void ensureGoogleCastFramework().then((available) => {
      if (!cancelled) {
        setCanCast(available)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const removeListener = addGoogleCastSessionStateListener((event) => {
      if (isGoogleCastConnectedState(event.sessionState)) {
        setCanCast(true)
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
  }, [])

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
  }, [])

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

  const showControls = useCallback(
    (keepVisible = false) => {
      clearControlsTimer()
      setControlsVisible(true)

      if (!keepVisible && isPlayingRef.current && !isCastingRef.current) {
        controlsTimerRef.current = setTimeout(() => {
          setControlsVisible(false)
          setSettingsOpen(false)
        }, 2500)
      }
    },
    [clearControlsTimer]
  )

  const saveProgress = useCallback(
    async (
      watchedSeconds: number,
      knownDurationSeconds: number | undefined,
      completed: boolean
    ) => {
      lastProgressSaveRef.current = Date.now()

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

    if (Date.now() - lastProgressSaveRef.current > 15_000) {
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
      clearCastErrorFlashTimer()
      clearCastMediaSync()
      clearSeekPreviewFrameTimer()
      clearSubtitleAnimationFrame()
    },
    [
      clearControlsTimer,
      clearHardwareWaitTimer,
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
        })
      : withStreamParams(nextSourceUrl, {
          audioStreamId: selectedAudioStreamId,
          startTime: null,
        })

    activeSourceStartRef.current = sourceStartTime

    if (options.preservePosition) {
      currentTimeRef.current = previousPosition
      setCurrentTime(previousPosition)
      pendingSeekRef.current = sourceUsesOffset ? null : previousPosition
    } else {
      pendingSeekRef.current = null

      if (sourceUsesOffset && sourceStartTime > 0) {
        currentTimeRef.current = sourceStartTime
        setCurrentTime(sourceStartTime)
      }
    }

    const sourceChanged = sourceUrlRef.current !== sourceToLoad

    if (sourceChanged) {
      video?.pause()
      setIsPlaying(false)
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

    if (options.waitForMedia) {
      beginMediaWait(nextStatus === "transcoding")
    } else {
      endMediaWait()
    }

    showControls(true)
  }

  switchSourceRef.current = switchSource

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
        lastProgressSaveRef.current = 0
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
      const canUseDirect = video ? supportsDirectPlayback(video, fileName) : false
      setDirectPossible(canUseDirect)
      setStatus("checking")
      endMediaWait()

      if (quality === "original" && canUseDirect) {
        directFallbackAttemptedRef.current = false
        switchSourceRef.current(getDirectUrl(), "direct", {
          preservePosition: Boolean(previousSourceUrl) && !episodeChanged,
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
    fileName,
    getDirectUrl,
    getTranscodeUrl,
    liveTranscodeEnabled,
    playbackKey,
    quality,
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
    const canUseDirect = video ? supportsDirectPlayback(video, fileName) : false

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
      const session = getGoogleCastSession()

      if (!session) {
        flashCastError(new Error("Google Cast session is missing"))
        console.error("Google Cast session is missing")
        return
      }

      try {
        await seekGoogleCastMedia(session, seconds)
        currentTimeRef.current = seconds
        setCurrentTime(seconds)
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
      setIsPlaying(false)
      shouldAutoPlaySourceRef.current = wasPlaying
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

  function requestFullscreen() {
    const target = playerRef.current ?? videoRef.current

    if (!target) {
      return
    }

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
      return
    }

    void target.requestFullscreen().catch(() => undefined)
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

  function flashCastError(error: unknown) {
    reportCastError(error)
    clearCastErrorFlashTimer()
    setCastErrorFlash(true)
    castErrorFlashTimerRef.current = setTimeout(() => {
      setCastErrorFlash(false)
      castErrorFlashTimerRef.current = null
    }, 1800)
  }

  function getCastReceiverUrl(castUrl: string) {
    const configuredUrl = new URL(castUrl, window.location.href)
    const currentOriginUrl = new URL(
      `${configuredUrl.pathname}${configuredUrl.search}`,
      window.location.href
    )

    if (!isLoopbackHost(currentOriginUrl.hostname)) {
      return currentOriginUrl.toString()
    }

    return configuredUrl.toString()
  }

  function assertCastReceiverUrlReachable(url: string) {
    const parsed = new URL(url)

    if (isLoopbackHost(parsed.hostname)) {
      throw new Error("CAST_RECEIVER_URL_IS_LOCALHOST")
    }
  }

  function getSelectedCastTextTrack() {
    if (!selectedSubtitleStream) {
      return undefined
    }

    const trackUrl = getCastReceiverUrl(
      withSubtitleStream(playback.castSubtitleUrl, selectedSubtitleStream.id)
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
      assertCastReceiverUrlReachable(input.textTrack.url)
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

    const loadResult = await input.session.loadMedia(request)

    if (loadResult) {
      throw new Error(`Google Cast loadMedia failed: ${String(loadResult)}`)
    }

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
    updateWatchedProgress(state.positionSeconds, state.durationSeconds)

    if (state.playerState === "PLAYING" || state.playerState === "BUFFERING") {
      setIsPlaying(true)
    } else if (state.playerState === "PAUSED") {
      setIsPlaying(false)
    }

    if (state.playerState === "IDLE") {
      if (state.idleReason === "FINISHED" && !castFinishedHandledRef.current) {
        castFinishedHandledRef.current = true
        completePlayback(state.positionSeconds, knownDuration)
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
    nextStatus: PlaybackStatusState
  ) {
    isCastLoadingRef.current = false
    isCastingRef.current = true
    castSelectionKeyRef.current = castSelectionKey
    setIsCasting(true)
    setStatus(nextStatus)
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
        setIsPlaying(false)
      } else {
        await playGoogleCastMedia(session)
        setIsPlaying(true)
      }
    } catch (error) {
      flashCastError(error)
      console.error(error)
    }
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
    const session = getGoogleCastSession() ?? (await requestGoogleCastSession())
    const canLocalDirect = supportsDirectPlayback(video, fileName)
    const directFirst = quality === "original" && canLocalDirect
    const directCastUrl = getCastReceiverUrl(
      withStreamParams(playback.castDirectUrl, {
        audioStreamId: selectedAudioStreamId,
      })
    )
    const castTranscodeBaseUrl =
      quality === "dataSaver" ? playback.castDataSaverUrl : playback.castTranscodeUrl
    const transcodeCastUrl = getCastReceiverUrl(
      withStreamParams(castTranscodeBaseUrl, {
        audioStreamId: selectedAudioStreamId,
      })
    )
    const textTrack = getSelectedCastTextTrack()
    const localFallbackStatus =
      directFirst || !liveTranscodeEnabled ? "direct" : "transcoding"
    const localFallbackSource =
      localFallbackStatus === "direct" ? getDirectUrl() : getTranscodeUrl(quality)

    localPlaybackBeforeCastRef.current = {
      sourceUrl: sourceUrlRef.current ?? localFallbackSource,
      status: localFallbackStatus,
      quality,
      directPossible: canLocalDirect,
      position: startTime,
      wasMuted: video.muted,
    }
    isCastLoadingRef.current = true
    video.muted = true
    video.pause()
    setIsPlaying(false)
    beginMediaWait(false)
    showControls(true)

    if (directFirst) {
      try {
        assertCastReceiverUrlReachable(directCastUrl)
        const result = await loadGoogleCastMedia({
          session,
          url: directCastUrl,
          contentType: getCastDirectContentType(fileName, directAudioRemuxActive),
          shouldResume,
          startTime,
          textTrack,
          timeoutMs: 60_000,
        })
        if (result === "loaded") {
          activateGoogleCastPlayback(session, directCastUrl, "direct")
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
      isCastLoadingRef.current = false
      endMediaWait()
      safeEndGoogleCastSession(session, true)
      restoreLocalSource({ preservePosition: true })
      flashCastError(
        new Error("Live transcoding is disabled when TRANSCODE_ACCEL=cpu.")
      )
      return true
    }

    setStatus("transcoding")
    beginMediaWait(true)
    try {
      assertCastReceiverUrlReachable(transcodeCastUrl)
      const result = await loadGoogleCastMedia({
        session,
        url: transcodeCastUrl,
        contentType: "video/mp4",
        shouldResume,
        startTime,
        textTrack,
        timeoutMs: null,
      })

      if (result === "loaded") {
        activateGoogleCastPlayback(session, transcodeCastUrl, "transcoding")
      } else {
        isCastLoadingRef.current = false
        endMediaWait()
        safeEndGoogleCastSession(session, true)
        restoreLocalSource({ preservePosition: true })
        flashCastError(new Error("Cast receiver could not load the stream."))
        console.error("Cast receiver could not load the stream.")
      }
    } catch (error) {
      isCastLoadingRef.current = false
      endMediaWait()
      safeEndGoogleCastSession(session, true)
      restoreLocalSource({ preservePosition: true })
      flashCastError(
        error instanceof Error && error.message === "CAST_RECEIVER_URL_IS_LOCALHOST"
          ? new Error(
              "Casting needs BASE_URL or the current page URL to be reachable from the TV."
            )
          : error
      )
      console.error(error)
    }

    return true
  }

  startGoogleCastingRef.current = startGoogleCasting

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

    const googleCastReady =
      Boolean(getGoogleCastContext()) || (await ensureGoogleCastFramework())

    if (!googleCastReady) {
      flashCastError(new Error(getGoogleCastUnavailableReason()))
      return
    }

    showControls(true)
    const shouldResume = !video.paused || isPlayingRef.current
    const startPromise = startGoogleCasting(video, shouldResume)
    castStartPromiseRef.current = startPromise
    setIsCastStarting(true)

    try {
      await startPromise
    } catch (error) {
      flashCastError(error)
      handleCastEnded()
    } finally {
      if (castStartPromiseRef.current === startPromise) {
        castStartPromiseRef.current = null
      }
      setIsCastStarting(false)
    }
  }

  function handleCastEnded() {
    const video = videoRef.current
    const castPosition = currentTimeRef.current

    video?.pause()
    clearCastMediaSync()
    castContentIdRef.current = null
    castFinishedHandledRef.current = false
    castStartPromiseRef.current = null
    setIsCastStarting(false)
    isCastLoadingRef.current = false
    isCastingRef.current = false
    setIsCasting(false)
    setIsPlaying(false)
    endMediaWait()

    if (localPlaybackBeforeCastRef.current) {
      localPlaybackBeforeCastRef.current = {
        ...localPlaybackBeforeCastRef.current,
        position: castPosition,
      }
    }

    restoreLocalSource({ preservePosition: true })
    showControls(true)
  }

  handleCastEndedRef.current = handleCastEnded

  function stopCasting() {
    const video = videoRef.current

    if (!video) {
      return
    }

    safeEndGoogleCastSession(getGoogleCastSession(), true)
    handleCastEnded()
  }

  function handleProgress(event: React.SyntheticEvent<HTMLVideoElement>) {
    const estimatedMbps = streamMbps

    if (!estimatedMbps || estimatedMbps <= 0) {
      streamStatsSampleRef.current = null
      setMeasuredStreamMbps(null)
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

    const nextMeasuredMbps = Number(
      ((bufferedSeconds / elapsedSeconds) * estimatedMbps).toFixed(2)
    )

    if (Number.isFinite(nextMeasuredMbps) && nextMeasuredMbps > 0) {
      setMeasuredStreamMbps(nextMeasuredMbps)
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
    if (!liveTranscodeEnabled) {
      setQuality("original")
      showControls(true)
      return
    }

    const video = videoRef.current
    const wasPlaying = Boolean(video && !video.paused) || isPlayingRef.current

    shouldAutoPlaySourceRef.current = wasPlaying
    setIsPlaying(false)
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

    if (sourceWillReload) {
      setIsPlaying(false)
      if (wasPlaying) {
        beginMediaWait(statusRef.current === "transcoding")
      }
    }

    setSelectedAudioStreamId(nextAudioStreamId)
    setSelectedSubtitleStreamId(nextSubtitleStream?.id ?? null)

    if (video && statusRef.current === "direct" && !sourceWillReload) {
      const switchedTrack = applyDirectAudioTrack(
        video,
        nextAudioStream,
        media.audioStreams
      )

      if (!switchedTrack && nextDirectAudioRemuxActive) {
        setIsPlaying(false)
      }
    }

    showControls(true)
  }

  function changeSubtitle(nextSubtitleStreamId: string | null) {
    setSelectedSubtitleStreamId(nextSubtitleStreamId)
    showControls(true)
  }

  const displayedCurrentTime = seekPreview ?? currentTime
  const canSkipIntro = duration > 90 && currentTime < 90
  const canSkipOutro = duration > 180 && duration - currentTime <= 120
  const controlsAreVisible = controlsVisible || !isPlaying || isCasting || settingsOpen
  const centerToggleVisible =
    !isWaitingForMedia && !isCasting && (!isPlaying || controlsAreVisible)
  const settingsSelectClass =
    "h-8 w-full rounded-md border border-white/10 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-violet-400"
  const selectedSubtitleLabel = selectedSubtitleStream
    ? subtitleLanguageLabel(selectedSubtitleStream.language)
    : "Off"
  const selectedAudioLabel = selectedAudioStream?.label ?? "Default"
  const streamMbpsLabel = measuredStreamMbps
    ? `${measuredStreamMbps.toFixed(2)} Mb/s current`
    : streamMbps
      ? `${streamMbps.toFixed(2)} Mb/s estimated`
      : "unknown"
  return (
    <div className="space-y-3">
      <div
        ref={playerRef}
        className={`group/player relative overflow-hidden rounded-lg border border-white/10 bg-black shadow-[0_28px_90px_rgba(0,0,0,0.45)] ${
          controlsAreVisible ? "" : "cursor-none"
        }`}
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
          className={`yamibunko-player-video aspect-video w-full bg-black transition-opacity ${
            isCasting ? "opacity-0" : "opacity-100"
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
            applyPendingSeek(event.currentTarget)
            applyDirectAudioTrack(
              event.currentTarget,
              selectedAudioStream,
              media.audioStreams
            )
          }}
          onEnded={handleEnded}
          onError={() => {
            if (isCastingRef.current || isCastLoadingRef.current) {
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
          onPlay={() => {
            setIsPlaying(true)
            showControls()
          }}
          onPlaying={() => {
            setIsPlaying(true)
            endMediaWait()
            showControls()
          }}
          onWaiting={() => beginMediaWait()}
          onTimeUpdate={handleTimeUpdate}
          onProgress={handleProgress}
        />

        {isCasting ? (
          <div className="absolute inset-0 grid place-items-center bg-black text-sm text-zinc-400">
            Casting
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

        <button
          type="button"
          className={`absolute top-1/2 left-1/2 grid size-20 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white/70 transition-opacity duration-150 hover:bg-black/60 hover:text-white ${
            centerToggleVisible ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          disabled={!sourceUrl}
          onClick={(event) => {
            event.stopPropagation()
            void togglePlay()
          }}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <Pause className="size-10" /> : <Play className="ml-1 size-10" />}
        </button>

        {canSkipIntro ? (
          <Button
            type="button"
            variant="secondary"
            className="absolute right-4 bottom-20 rounded-lg bg-zinc-950/90"
            onClick={() => void seekTo(90)}
          >
            Skip intro
          </Button>
        ) : null}
        {canSkipOutro ? (
          <Button
            type="button"
            variant="secondary"
            className="absolute right-4 bottom-20 rounded-lg bg-zinc-950/90"
            onClick={() => void seekTo(duration)}
          >
            Skip outro
          </Button>
        ) : null}

        {activeSubtitleTexts.length ? (
          <div className="pointer-events-none absolute inset-x-4 bottom-[5.25rem] z-10 flex justify-center px-4 text-center text-lg font-semibold leading-snug text-white drop-shadow-[0_2px_5px_rgba(0,0,0,0.95)] sm:text-xl">
            <div className="max-w-[90%] whitespace-pre-line">
              {activeSubtitleTexts.join("\n")}
            </div>
          </div>
        ) : null}

        <div
          className={`absolute inset-x-0 bottom-0 bg-zinc-950/40 p-3 backdrop-blur-md transition-opacity duration-300 ${
            controlsAreVisible ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="icon"
              onClick={togglePlay}
              disabled={!sourceUrl && !isCasting}
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
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
              title="Previous episode"
            >
              <SkipBack className="size-4" />
            </Button>
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
              title="Next episode"
            >
              <SkipForward className="size-4" />
            </Button>

            <span className="shrink-0 text-xs text-zinc-200 tabular-nums">
              {formatTime(displayedCurrentTime)} / {formatTime(duration)}
            </span>

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
                className="h-2 w-full accent-red-600"
              />
            </div>


            <div className="relative">
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
                title="Settings"
              >
                <Settings className="size-4" />
              </Button>

              {settingsOpen ? (
                <div className="absolute right-0 bottom-12 z-20 max-h-[min(70vh,23rem)] w-72 space-y-3 overflow-y-auto rounded-xl border border-white/10 bg-zinc-950/95 p-3 text-xs shadow-2xl">
                  {liveTranscodeEnabled ? (
                    <>
                      <label className="grid gap-1 text-zinc-300">
                        <span>Quality</span>
                        <select
                          className={settingsSelectClass}
                          value={quality}
                          onChange={(event) =>
                            changeQuality(event.target.value as PlaybackProfile)
                          }
                        >
                          <option value="original">Default</option>
                          <option value="dataSaver">Data Saver</option>
                        </select>
                      </label>

                      <div className="grid gap-1 text-zinc-300">
                        <span>Display Method</span>
                        <div className="rounded-md border border-white/10 bg-zinc-950 px-2 py-1.5 text-zinc-100">
                          {displayMethod}
                        </div>
                      </div>
                    </>
                  ) : null}

                  <label className="grid gap-1 text-zinc-300">
                    <span>Audio Language</span>
                    <select
                      className={settingsSelectClass}
                      value={selectedAudioStreamId ?? ""}
                      onChange={(event) => changeAudio(event.target.value || null)}
                    >
                      {media.audioStreams.length ? null : (
                        <option value="">Default</option>
                      )}
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

                  <div className="group/stats relative grid gap-1 text-zinc-300">
                    <span>Stats for Nerds</span>
                    <div className="rounded-md border border-white/10 bg-zinc-950 px-2 py-1.5 text-zinc-100">
                      Hover for stream info
                    </div>
                    <div className="pointer-events-none absolute right-0 bottom-full mb-2 hidden w-64 rounded-lg border border-white/10 bg-black/95 p-3 text-[11px] leading-relaxed text-zinc-200 shadow-xl group-hover/stats:block">
                      <div>Video: {media.videoCodec ?? "unknown"}</div>
                      <div>Container: {media.container ?? "unknown"}</div>
                      <div>Audio: {selectedAudioLabel}{selectedAudioStream?.codec ? ` (${selectedAudioStream.codec})` : ""}</div>
                      <div>Subtitles: {selectedSubtitleLabel}</div>
                      <div>
                        Stream: {streamMbpsLabel}
                      </div>
                    </div>
                  </div>

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
            </div>

            {isCasting ? (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className={`bg-zinc-950/70 ${
                  castErrorFlash ? "border-red-500/70 text-red-400 ring-2 ring-red-500/40" : ""
                }`}
                title="Stop casting"
                onClick={stopCasting}
              >
                <Square className="size-4" />
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className={`bg-zinc-950/70 ${
                  castErrorFlash ? "border-red-500/70 text-red-400 ring-2 ring-red-500/40" : ""
                }`}
                title={canCast ? "Cast" : getGoogleCastUnavailableReason()}
                disabled={(!sourceUrl && !isCasting) || isCastStarting}
                onClick={startCasting}
              >
                <Cast className="size-4" />
              </Button>
            )}

            <Button
              type="button"
              variant="secondary"
              size="icon"
              className="bg-zinc-950/70"
              onClick={requestFullscreen}
              title="Fullscreen"
            >
              <Maximize2 className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      <p className="sr-only">
        Player for {animeId} season {seasonNumber} episode {episodeNumber}
      </p>
    </div>
  )
}
