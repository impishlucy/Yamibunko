"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Maximize2, Pause, Play, SkipBack, SkipForward } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  PlaybackStatus,
  type PlaybackStatusState,
} from "@/components/playback-status"
import type {
  Episode,
  PlaybackProfile,
  TranscodeStatus,
  WatchPayload,
} from "@/lib/types"

type AnimePlayerProps = {
  animeId: string
  seasonNumber: number
  episodeNumber: number
  playback: WatchPayload["playback"]
  previousEpisode?: Episode
  nextEpisode?: Episode
  autoPlay?: boolean
  onEpisodeChange?: (episode: Episode, autoPlay: boolean) => void
}

function supportsHevc(video: HTMLVideoElement) {
  const checks = [
    'video/mp4; codecs="hvc1.1.6.L93.B0"',
    'video/mp4; codecs="hev1.1.6.L93.B0"',
    'video/mp4; codecs="hvc1"',
    'video/mp4; codecs="hev1"',
  ]

  return checks.some((codec) => {
    const result = video.canPlayType(codec)
    return result === "probably" || result === "maybe"
  })
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
  previousEpisode,
  nextEpisode,
  autoPlay = false,
  onEpisodeChange,
}: AnimePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const playbackKeyRef = useRef(`${animeId}:${seasonNumber}:${episodeNumber}`)
  const lastProgressSaveRef = useRef(0)
  const completedProgressRef = useRef(false)
  const [quality, setQuality] = useState<PlaybackProfile>("original")
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<PlaybackStatusState>("checking")
  const [directPossible, setDirectPossible] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  const labels = useMemo(
    () => ({
      original: "Original",
      dataSaver: "Data Saver",
    }),
    []
  )
  const playbackKey = `${animeId}:${seasonNumber}:${episodeNumber}`

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

  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    async function readTranscodeStatus() {
      const response = await fetch("/api/transcode/status", {
        cache: "no-store",
      })

      if (!response.ok) {
        return { max: 0, active: 0, available: 0 } satisfies TranscodeStatus
      }

      return response.json() as Promise<TranscodeStatus>
    }

    async function selectSource() {
      if (playbackKeyRef.current !== playbackKey) {
        playbackKeyRef.current = playbackKey
        setCurrentTime(0)
        setDuration(0)
        setIsPlaying(false)
        lastProgressSaveRef.current = 0
        completedProgressRef.current = false
      }

      const video = videoRef.current
      const canDirect = video ? supportsHevc(video) : false
      setDirectPossible(canDirect)
      setStatus("checking")
      setSourceUrl(null)

      if (quality === "original" && canDirect) {
        setSourceUrl(playback.directUrl)
        setStatus("direct")
        return
      }

      const transcodeStatus = await readTranscodeStatus()

      if (cancelled) {
        return
      }

      if (transcodeStatus.available > 0) {
        setSourceUrl(
          quality === "dataSaver"
            ? playback.dataSaverUrl
            : playback.originalTranscodeUrl
        )
        setStatus("transcoding")
        return
      }

      if (canDirect) {
        setStatus("blocked")
        return
      }

      setStatus("waiting")
      retryTimer = setTimeout(selectSource, 20_000)
    }

    void selectSource()

    return () => {
      cancelled = true

      if (retryTimer) {
        clearTimeout(retryTimer)
      }
    }
  }, [
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

    video.load()

    if (autoPlay) {
      void video.play().catch(() => undefined)
    }
  }, [autoPlay, sourceUrl])

  function tryDirectPlay() {
    setQuality("original")
    setSourceUrl(playback.directUrl)
    setStatus("direct")
  }

  function togglePlay() {
    const video = videoRef.current

    if (!video || !sourceUrl) {
      return
    }

    if (video.paused) {
      void video.play().catch(() => undefined)
    } else {
      video.pause()
    }
  }

  function seekTo(seconds: number) {
    const video = videoRef.current

    if (!video || !Number.isFinite(seconds)) {
      return
    }

    video.currentTime = Math.min(Math.max(seconds, 0), duration || seconds)
    setCurrentTime(video.currentTime)
  }

  function handleTimeUpdate(event: React.SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget
    const watchedSeconds = video.currentTime
    const durationSeconds = Number.isFinite(video.duration)
      ? video.duration
      : undefined

    setCurrentTime(watchedSeconds)

    if (durationSeconds) {
      setDuration(durationSeconds)
    }

    if (
      durationSeconds &&
      watchedSeconds / durationSeconds >= 0.8 &&
      !completedProgressRef.current
    ) {
      completedProgressRef.current = true
      void saveProgress(watchedSeconds, durationSeconds, true)
      return
    }

    if (Date.now() - lastProgressSaveRef.current > 15_000) {
      void saveProgress(watchedSeconds, durationSeconds, false)
    }
  }

  function handlePause() {
    const video = videoRef.current
    setIsPlaying(false)

    if (!video || video.ended) {
      return
    }

    void saveProgress(
      video.currentTime,
      Number.isFinite(video.duration) ? video.duration : undefined,
      false
    )
  }

  function handleEnded() {
    const video = videoRef.current
    const durationSeconds = video?.duration

    setIsPlaying(false)
    completedProgressRef.current = true
    void saveProgress(
      durationSeconds && Number.isFinite(durationSeconds)
        ? durationSeconds
        : currentTime,
      durationSeconds && Number.isFinite(durationSeconds)
        ? durationSeconds
        : undefined,
      true
    )

    if (nextEpisode && onEpisodeChange) {
      onEpisodeChange(nextEpisode, true)
    }
  }

  const canSkipIntro = duration > 90 && currentTime < 90
  const canSkipOutro = duration > 180 && duration - currentTime <= 120

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-lg border border-white/10 bg-black shadow-[0_28px_90px_rgba(0,0,0,0.45)]">
        <video
          ref={videoRef}
          className="aspect-video w-full bg-black"
          playsInline
          preload="none"
          src={sourceUrl ?? undefined}
          onDurationChange={(event) => {
            const nextDuration = event.currentTarget.duration

            if (Number.isFinite(nextDuration)) {
              setDuration(nextDuration)
            }
          }}
          onEnded={handleEnded}
          onPause={handlePause}
          onPlay={() => setIsPlaying(true)}
          onTimeUpdate={handleTimeUpdate}
        />
        {canSkipIntro ? (
          <Button
            type="button"
            variant="secondary"
            className="absolute right-4 bottom-16 rounded-lg bg-zinc-950/90"
            onClick={() => seekTo(90)}
          >
            Skip intro
          </Button>
        ) : null}
        {canSkipOutro ? (
          <Button
            type="button"
            variant="secondary"
            className="absolute right-4 bottom-16 rounded-lg bg-zinc-950/90"
            onClick={() => seekTo(duration)}
          >
            Skip outro
          </Button>
        ) : null}
      </div>

      <div className="space-y-3 rounded-lg border border-white/10 bg-zinc-950/70 p-3">
        <div className="grid gap-3 sm:grid-cols-[auto_1fr_auto] sm:items-center">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="icon"
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
              disabled={!sourceUrl}
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

          <div className="flex min-w-0 items-center gap-3">
            <span className="w-28 shrink-0 text-xs text-zinc-400 tabular-nums">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.25}
              value={duration ? Math.min(currentTime, duration) : 0}
              onChange={(event) => seekTo(Number(event.target.value))}
              disabled={!duration}
              className="h-2 min-w-0 flex-1 accent-red-600"
            />
          </div>

          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={() => videoRef.current?.requestFullscreen()}
            title="Fullscreen"
          >
            <Maximize2 className="size-4" />
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {(["original", "dataSaver"] as const).map((item) => (
              <Button
                key={item}
                type="button"
                variant={quality === item ? "default" : "outline"}
                onClick={() => setQuality(item)}
                className="rounded-lg"
              >
                {labels[item]}
              </Button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <PlaybackStatus state={status} />
            {status === "blocked" && directPossible ? (
              <Button type="button" variant="secondary" onClick={tryDirectPlay}>
                Try Direct Play
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <p className="sr-only">
        Player for {animeId} season {seasonNumber} episode {episodeNumber}
      </p>
    </div>
  )
}
