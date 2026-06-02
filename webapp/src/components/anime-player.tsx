"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Cast,
  Loader2,
  Maximize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
} from "lucide-react"

import { PlaybackStatus, type PlaybackStatusState } from "@/components/playback-status"
import { Button } from "@/components/ui/button"
import {
  addGoogleCastMediaStateListener,
  createGoogleCastLoadRequest,
  ensureGoogleCastFramework,
  getGoogleCastMediaState,
  getGoogleCastContext,
  getGoogleCastSession,
  pauseGoogleCastMedia,
  playGoogleCastMedia,
  seekGoogleCastMedia,
  waitForGoogleCastMediaLoad,
  type GoogleCastMediaState,
} from "@/lib/google-cast"
import type {
  Episode,
  PlaybackProfile,
  WatchPayload,
} from "@/lib/types"
import { error } from "next/dist/build/output/log"

type AnimePlayerProps = {
  animeId: string
  seasonNumber: number
  episodeNumber: number
  playback: WatchPayload["playback"]
  fileName: string
  previousEpisode?: Episode
  nextEpisode?: Episode
  durationSeconds?: number
  autoPlay?: boolean
  onEpisodeChange?: (episode: Episode, autoPlay: boolean) => void
}

type SwitchSourceOptions = {
  preservePosition?: boolean
  waitForMedia?: boolean
}

type LocalPlaybackSnapshot = {
  sourceUrl: string | null
  status: PlaybackStatusState
  quality: PlaybackProfile
  directPossible: boolean
  position: number
  wasMuted: boolean
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

function getCastDirectContentType(fileName: string) {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? ""

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

export function AnimePlayer({
  animeId,
  seasonNumber,
  episodeNumber,
  playback,
  fileName,
  previousEpisode,
  nextEpisode,
  durationSeconds,
  autoPlay = false,
  onEpisodeChange,
}: AnimePlayerProps) {
  const playerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const playbackKeyRef = useRef(`${animeId}:${seasonNumber}:${episodeNumber}`)
  const lastProgressSaveRef = useRef(0)
  const completedProgressRef = useRef(false)
  const directFallbackAttemptedRef = useRef(false)
  const currentTimeRef = useRef(0)
  const pendingSeekRef = useRef<number | null>(null)
  const sourceUrlRef = useRef<string | null>(null)
  const shouldAutoPlaySourceRef = useRef(autoPlay)
  const isCastingRef = useRef(false)
  const isCastLoadingRef = useRef(false)
  const isPlayingRef = useRef(false)
  const castContentIdRef = useRef<string | null>(null)
  const castErrorFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const castFinishedHandledRef = useRef(false)
  const castMediaCleanupRef = useRef<(() => void) | null>(null)
  const castProgressTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  )
  const localPlaybackBeforeCastRef = useRef<LocalPlaybackSnapshot | null>(null)
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
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hardwareWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const [quality, setQuality] = useState<PlaybackProfile>("original")
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<PlaybackStatusState>("checking")
  const [directPossible, setDirectPossible] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isWaitingForMedia, setIsWaitingForMedia] = useState(false)
  const [showHardwareWait, setShowHardwareWait] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(durationSeconds ?? 0)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [canCast, setCanCast] = useState(false)
  const [isCasting, setIsCasting] = useState(false)
  const [castErrorFlash, setCastErrorFlash] = useState(false)

  const labels = useMemo(
    () => ({
      original: "Original",
      dataSaver: "Data Saver",
    }),
    []
  )
  const playbackKey = `${animeId}:${seasonNumber}:${episodeNumber}`

  useEffect(() => {
    sourceUrlRef.current = sourceUrl
  }, [sourceUrl])

  useEffect(() => {
    isCastingRef.current = isCasting
  }, [isCasting])

  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  useEffect(() => {
    let cancelled = false

    void ensureGoogleCastFramework().then((available) => {
      if (!cancelled && available) {
        setCanCast(true)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    // Monitor session state to handle cast ending events
    const removeListener = (() => {
      if (isCastingRef.current || isCastLoadingRef.current) {
        handleCastEndedRef.current()
      }
    })

    return () => {
      removeListener?.()
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

  const beginMediaWait = useCallback((forceTranscodeWait = false) => {
    clearHardwareWaitTimer()
    setIsWaitingForMedia(true)
    setShowHardwareWait(false)

    if (forceTranscodeWait || status === "transcoding") {
      hardwareWaitTimerRef.current = setTimeout(() => {
        setShowHardwareWait(true)
      }, 5000)
    }
  }, [clearHardwareWaitTimer, status])

  const endMediaWait = useCallback(() => {
    clearHardwareWaitTimer()
    setIsWaitingForMedia(false)
    setShowHardwareWait(false)
  }, [clearHardwareWaitTimer])

  const showControls = useCallback(
    (keepVisible = false) => {
      clearControlsTimer()
      setControlsVisible(true)

      if (!keepVisible && isPlaying && !isCasting) {
        controlsTimerRef.current = setTimeout(() => {
          setControlsVisible(false)
        }, 2500)
      }
    },
    [clearControlsTimer, isCasting, isPlaying]
  )

  const saveProgress = useCallback(
    async (
      watchedSeconds: number,
      durationSeconds: number | undefined,
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
            durationSeconds,
            completed,
          }),
        }
      ).catch(() => undefined)
    },
    [animeId, episodeNumber, seasonNumber]
  )

  function updateWatchedProgress(
    watchedSeconds: number,
    measuredDuration?: number
  ) {
    const effectiveDuration = measuredDuration ?? durationSeconds

    currentTimeRef.current = watchedSeconds
    setCurrentTime(watchedSeconds)

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
      knownDuration && Number.isFinite(knownDuration)
        ? knownDuration
        : endedTime
    const completedEnough =
      knownDuration && knownDuration > 0
        ? endedTime / knownDuration >= 0.9
        : endedTime >= 60

    setIsPlaying(false)
    completedProgressRef.current = Boolean(completedEnough)
    showControls(true)
    void saveProgress(
      completedEnough ? finalTime : endedTime,
      knownDuration && Number.isFinite(knownDuration)
        ? knownDuration
        : undefined,
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
    },
    [
      clearControlsTimer,
      clearHardwareWaitTimer,
      clearCastErrorFlashTimer,
      clearCastMediaSync,
    ]
  )

  function getPlaybackPosition() {
    const video = videoRef.current
    const seconds =
      video && Number.isFinite(video.currentTime)
        ? video.currentTime
        : currentTimeRef.current

    return Math.max(seconds, 0)
  }

  function applyPendingSeek(video: HTMLVideoElement) {
    const pendingSeek = pendingSeekRef.current

    if (pendingSeek === null) {
      return
    }

    const target =
      Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(pendingSeek, video.duration)
        : pendingSeek

    if (Number.isFinite(target) && target > 0) {
      video.currentTime = target
      currentTimeRef.current = target
      setCurrentTime(target)
    }

    pendingSeekRef.current = null
  }

  function switchSource(
    nextSourceUrl: string,
    nextStatus: PlaybackStatusState,
    options: SwitchSourceOptions = {}
  ) {
    const video = videoRef.current

    if (options.preservePosition) {
      const position = getPlaybackPosition()
      pendingSeekRef.current = position
      currentTimeRef.current = position
      setCurrentTime(position)
    } else {
      pendingSeekRef.current = null
    }

    video?.pause()
    setIsPlaying(false)
    setStatus(nextStatus)

    if (sourceUrlRef.current !== nextSourceUrl) {
      sourceUrlRef.current = nextSourceUrl
      if (video) {
        video.src = nextSourceUrl
        video.load()
      }
      setSourceUrl(nextSourceUrl)
    }

    if (options.waitForMedia) {
      beginMediaWait(nextStatus === "transcoding")
    } else {
      endMediaWait()
    }

    showControls(true)
  }

  switchSourceRef.current = switchSource

  useEffect(() => {
    let cancelled = false

    async function selectSource() {
      const previousSourceUrl = sourceUrlRef.current
      const episodeChanged = playbackKeyRef.current !== playbackKey
      if (episodeChanged) {
        playbackKeyRef.current = playbackKey
        currentTimeRef.current = 0
        pendingSeekRef.current = null
        shouldAutoPlaySourceRef.current = autoPlay
        setCurrentTime(0)
        setDuration(durationSeconds ?? 0)
        setIsPlaying(false)
        setControlsVisible(true)
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
      const canDirect = video ? supportsDirectPlayback(video, fileName) : false
      setDirectPossible(canDirect)
      setStatus("checking")
      endMediaWait()

      if (quality === "original" && canDirect) {
        directFallbackAttemptedRef.current = false
        switchSourceRef.current(playback.directUrl, "direct", {
          preservePosition: Boolean(previousSourceUrl) && !episodeChanged,
        })
        return
      }

      if (cancelled) {
        return
      }

      switchSourceRef.current(
        quality === "dataSaver"
          ? playback.dataSaverUrl
          : playback.originalTranscodeUrl,
        "transcoding",
        {
          preservePosition: Boolean(previousSourceUrl) && !episodeChanged,
        }
      )
    }

    void selectSource()

    return () => {
      cancelled = true
    }
  }, [
    durationSeconds,
    endMediaWait,
    fileName,
    autoPlay,
    quality,
    playbackKey,
    playback.dataSaverUrl,
    playback.directUrl,
    playback.originalTranscodeUrl,
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
        void video.play().catch(() => undefined)
      }, 0)

      return () => window.clearTimeout(timer)
    }
  }, [beginMediaWait, sourceUrl])

  function tryDirectPlay() {
    setQuality("original")
    directFallbackAttemptedRef.current = false
    switchSource(playback.directUrl, "direct", { preservePosition: true })
  }

  function restoreLocalSource(options: { preservePosition?: boolean } = {}) {
    const previousLocalPlayback = localPlaybackBeforeCastRef.current

    if (previousLocalPlayback?.sourceUrl) {
      const position = options.preservePosition
        ? previousLocalPlayback.position
        : 0
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
    const canDirect = video ? supportsDirectPlayback(video, fileName) : false

    if (video) {
      video.muted = false
    }

    setDirectPossible(canDirect)

    if (quality === "original" && canDirect) {
      directFallbackAttemptedRef.current = false
      switchSource(playback.directUrl, "direct", {
        preservePosition: options.preservePosition,
      })
      return
    }

    switchSource(
      quality === "dataSaver"
        ? playback.dataSaverUrl
        : playback.originalTranscodeUrl,
      "transcoding",
      {
        preservePosition: options.preservePosition,
      }
    )
  }

  function fallbackDirectToTranscode() {
    directFallbackAttemptedRef.current = true
    setDirectPossible(false)
    switchSource(playback.originalTranscodeUrl, "transcoding", {
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

    video.currentTime = Math.min(Math.max(seconds, 0), duration || seconds)
    currentTimeRef.current = video.currentTime
    setCurrentTime(video.currentTime)
    showControls()
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

  async function loadGoogleCastMedia(input: {
    session: NonNullable<ReturnType<typeof getGoogleCastSession>>
    url: string
    contentType: string
    shouldResume: boolean
    startTime: number
    timeoutMs?: number | null
  }) {
    const request = createGoogleCastLoadRequest({
      url: input.url,
      contentType: input.contentType,
      autoplay: input.shouldResume,
      currentTime: input.startTime,
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

    const knownDuration = durationSeconds ?? duration
    updateWatchedProgress(state.positionSeconds)

    if (state.playerState === "PLAYING" || state.playerState === "BUFFERING") {
      setIsPlaying(true)
    } else if (state.playerState === "PAUSED") {
      setIsPlaying(false)
    }

    if (
      state.playerState === "IDLE" &&
      state.idleReason === "FINISHED" &&
      !castFinishedHandledRef.current
    ) {
      castFinishedHandledRef.current = true
      completePlayback(state.positionSeconds, knownDuration)
    }
  }

  function attachCastMediaSync(
    session: NonNullable<ReturnType<typeof getGoogleCastSession>>,
    contentId: string
  ) {
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
    session: NonNullable<ReturnType<typeof getGoogleCastSession>>,
    contentId: string,
    nextStatus: PlaybackStatusState
  ) {
    isCastLoadingRef.current = false
    isCastingRef.current = true
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
    const session = getGoogleCastSession() ?? (await context.requestSession())
    const directFirst = quality === "original"
    const directCastUrl = getCastReceiverUrl(playback.castDirectUrl)
    const transcodeCastUrl = getCastReceiverUrl(playback.castTranscodeUrl)
    const canLocalDirect = supportsDirectPlayback(video, fileName)
    const localFallbackStatus =
      quality === "original" && canLocalDirect ? "direct" : "transcoding"
    const localFallbackSource =
      localFallbackStatus === "direct"
        ? playback.directUrl
        : quality === "dataSaver"
          ? playback.dataSaverUrl
          : playback.originalTranscodeUrl

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
          contentType: getCastDirectContentType(fileName),
          shouldResume,
          startTime,
          timeoutMs: 60_000,
        })
        if (result === "loaded") {
          activateGoogleCastPlayback(session, directCastUrl, "direct")
          return true
        }

        if (result === "failed") {
          flashCastError(
            new Error(
              "Direct cast failed on the receiver. Switching to transcoded stream."
            )
          )
          console.error(
            "Direct cast failed on the receiver. Switching to transcoded stream."
          )
        }
      } catch (error) {
        flashCastError(error)
        console.error(error)
      }
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
        timeoutMs: null,
      })

      if (result === "loaded") {
        activateGoogleCastPlayback(session, transcodeCastUrl, "transcoding")
      } else {
        isCastLoadingRef.current = false
        endMediaWait()
        session.endSession(true)
        restoreLocalSource({ preservePosition: true })
        flashCastError(new Error("Cast receiver could not load the stream."))
        console.error("Cast receiver could not load the stream.")
      }
    } catch (error) {
      isCastLoadingRef.current = false
      endMediaWait()
      session.endSession(true)
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

  async function startCasting() {
    const video = videoRef.current

    if (!video || !sourceUrl) {
      flashCastError(new Error("Casting is not available in this browser."))
      console.error("Casting is not available in this browser.")
      return
    }

    const googleCastReady =
      Boolean(getGoogleCastContext()) || (await ensureGoogleCastFramework())

    if (!googleCastReady) {
      flashCastError(new Error("Casting is not available in this browser."))
      return
    }

    showControls(true)
    const shouldResume = !video.paused || isPlaying

    try {
      await startGoogleCasting(video, shouldResume)
    } catch (error) {
      flashCastError(error)
      handleCastEnded()
    }
  }

  function handleCastEnded() {
    const video = videoRef.current

    video?.pause()
    clearCastMediaSync()
    castContentIdRef.current = null
    castFinishedHandledRef.current = false
    isCastLoadingRef.current = false
    isCastingRef.current = false
    setIsCasting(false)
    setIsPlaying(false)
    endMediaWait()
    restoreLocalSource({ preservePosition: true })
    showControls(true)
  }

  handleCastEndedRef.current = handleCastEnded

  function stopCasting() {
    const video = videoRef.current

    if (!video) {
      return
    }

    getGoogleCastSession()?.endSession(true)
    handleCastEnded()
  }

  function handleTimeUpdate(event: React.SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget
    const watchedSeconds = video.currentTime
    const measuredDuration = Number.isFinite(video.duration)
      ? video.duration
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
      video.currentTime,
      Number.isFinite(video.duration) ? video.duration : durationSeconds,
      false
    )
  }

  function handleEnded() {
    const video = videoRef.current
    const endedTime = Number.isFinite(video?.currentTime)
      ? (video?.currentTime ?? currentTime)
      : currentTime
    const knownDuration = Number.isFinite(video?.duration)
      ? video?.duration
      : durationSeconds

    completePlayback(endedTime, knownDuration)
  }

  const canSkipIntro = duration > 90 && currentTime < 90
  const canSkipOutro = duration > 180 && duration - currentTime <= 120
  const controlsAreVisible = controlsVisible || !isPlaying || isCasting
  const centerToggleVisible =
    !isWaitingForMedia && !isCasting && (!isPlaying || controlsAreVisible)

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
          }
        }}
      >
        <video
          ref={videoRef}
          className={`aspect-video w-full bg-black transition-opacity ${
            isCasting ? "opacity-0" : "opacity-100"
          }`}
          playsInline
          preload="none"
          src={sourceUrl ?? undefined}
          onDurationChange={(event) => {
            const nextDuration = event.currentTarget.duration

            if (Number.isFinite(nextDuration)) {
              setDuration(nextDuration)
            }
          }}
          onLoadedMetadata={(event) => applyPendingSeek(event.currentTarget)}
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
        />

        {isCasting ? (
          <div className="absolute inset-0 grid place-items-center bg-black text-sm text-zinc-400">
            Casting
          </div>
        ) : null}
        {isWaitingForMedia ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="size-12 animate-spin text-white/70" />
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
          className={`absolute top-1/2 left-1/2 grid size-20 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white/60 transition-opacity duration-150 hover:bg-black/60 hover:text-white/80 ${
            centerToggleVisible
              ? "opacity-100"
              : "pointer-events-none opacity-0"
          }`}
          disabled={!sourceUrl}
          onClick={(event) => {
            event.stopPropagation()
            void togglePlay()
          }}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <Pause className="size-10" />
          ) : (
            <Play className="ml-1 size-10" />
          )}
        </button>

        <div
          className={`absolute inset-0 transition-opacity duration-300 ${
            controlsAreVisible ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 bg-gradient-to-b from-black/80 via-black/35 to-transparent p-3">
            <div className="flex flex-wrap items-center gap-2">
              {(["original", "dataSaver"] as const).map((item) => (
                <Button
                  key={item}
                  type="button"
                  size="sm"
                  variant={quality === item ? "default" : "secondary"}
                  onClick={() => {
                    setQuality(item)
                    showControls(true)
                  }}
                  className="rounded-lg bg-zinc-950/80"
                >
                  {labels[item]}
                </Button>
              ))}
              <PlaybackStatus state={status} />
              {status === "blocked" && directPossible ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="rounded-lg bg-zinc-950/80"
                  onClick={tryDirectPlay}
                >
                  Try Direct Play
                </Button>
              ) : null}
            </div>

            {isCasting ? (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className={`bg-zinc-950/80 ${
                  castErrorFlash
                    ? "border-red-500/70 text-red-400 ring-2 ring-red-500/40"
                    : ""
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
                className={`bg-zinc-950/80 ${
                  castErrorFlash
                    ? "border-red-500/70 text-red-400 ring-2 ring-red-500/40"
                    : ""
                }`}
                title={canCast ? "Cast" : "Try casting"}
                disabled={!sourceUrl && !isCasting}
                onClick={startCasting}
              >
                <Cast className="size-4" />
              </Button>
            )}
          </div>

          {canSkipIntro ? (
            <Button
              type="button"
              variant="secondary"
              className="absolute right-4 bottom-24 rounded-lg bg-zinc-950/90"
              onClick={() => void seekTo(90)}
            >
              Skip intro
            </Button>
          ) : null}
          {canSkipOutro ? (
            <Button
              type="button"
              variant="secondary"
              className="absolute right-4 bottom-24 rounded-lg bg-zinc-950/90"
              onClick={() => void seekTo(duration)}
            >
              Skip outro
            </Button>
          ) : null}

          <div className="absolute inset-x-0 bottom-0 space-y-3 bg-gradient-to-t from-black/85 via-black/45 to-transparent p-3">
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.25}
              value={duration ? Math.min(currentTime, duration) : 0}
              onChange={(event) => void seekTo(Number(event.target.value))}
              disabled={!duration}
              className="h-2 w-full accent-red-600"
            />

            <div className="grid gap-3 sm:grid-cols-[auto_1fr_auto] sm:items-center">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="bg-zinc-950/80"
                  onClick={() => {
                    if (previousEpisode && onEpisodeChange) {
                      onEpisodeChange(previousEpisode, true)
                    }
                  }}
                  disabled={!previousEpisode}
                  title="Previous episode"
                >
                  <SkipBack className="size-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  onClick={togglePlay}
                  disabled={!sourceUrl && !isCasting}
                  title={isPlaying ? "Pause" : "Play"}
                >
                  {isPlaying ? (
                    <Pause className="size-4" />
                  ) : (
                    <Play className="size-4" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="bg-zinc-950/80"
                  onClick={() => {
                    if (nextEpisode && onEpisodeChange) {
                      onEpisodeChange(nextEpisode, true)
                    }
                  }}
                  disabled={!nextEpisode}
                  title="Next episode"
                >
                  <SkipForward className="size-4" />
                </Button>
              </div>

              <span className="text-xs text-zinc-300 tabular-nums sm:text-center">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>

              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="bg-zinc-950/80"
                onClick={requestFullscreen}
                title="Fullscreen"
              >
                <Maximize2 className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <p className="sr-only">
        Player for {animeId} season {seasonNumber} episode {episodeNumber}
      </p>
    </div>
  )
}
