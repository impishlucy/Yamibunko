"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  PlaybackStatus,
  type PlaybackStatusState,
} from "@/components/playback-status"
import type {
  PlaybackProfile,
  TranscodeStatus,
  WatchPayload,
} from "@/lib/types"

type AnimePlayerProps = {
  animeId: string
  episodeNumber: number
  playback: WatchPayload["playback"]
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

export function AnimePlayer({
  animeId,
  episodeNumber,
  playback,
}: AnimePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [quality, setQuality] = useState<PlaybackProfile>("original")
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<PlaybackStatusState>("checking")
  const [directPossible, setDirectPossible] = useState(false)

  const labels = useMemo(
    () => ({
      original: "Original",
      dataSaver: "Data Saver",
    }),
    []
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

    selectSource()

    return () => {
      cancelled = true

      if (retryTimer) {
        clearTimeout(retryTimer)
      }
    }
  }, [
    quality,
    playback.dataSaverUrl,
    playback.directUrl,
    playback.originalTranscodeUrl,
  ])

  function tryDirectPlay() {
    setQuality("original")
    setSourceUrl(playback.directUrl)
    setStatus("direct")
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-white/10 bg-black shadow-[0_28px_90px_rgba(0,0,0,0.45)]">
        <video
          key={sourceUrl ?? "checking"}
          ref={videoRef}
          className="aspect-video w-full bg-black"
          controls
          playsInline
          preload="none"
          src={sourceUrl ?? undefined}
        />
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

      <p className="sr-only">
        Player for {animeId} episode {episodeNumber}
      </p>
    </div>
  )
}
