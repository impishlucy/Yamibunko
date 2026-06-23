"use client"

import { type CSSProperties, useEffect, useState } from "react"
import { useRouter } from "next/navigation"

import { AnimePlayer } from "@/components/anime-player"
import { StreamLimitDialog } from "@/components/stream-limit-dialog"
import { useTvMode } from "@/components/tv-mode-provider"
import { Skeleton } from "@/components/ui/skeleton"
import { apiGet } from "@/lib/api"
import { cn } from "@/lib/utils"
import { formatWatchSeriesTitle } from "@/lib/anime-title"
import {
  formatEpisodeDisplayTitle,
  parseSeasonPartFromText,
} from "@/lib/media-labels"
import { DEFAULT_PLAYER_ASPECT_RATIO, getPreferredPlayerAspectRatio } from "@/lib/player-aspect-ratio"
import type { Episode, WatchPayload } from "@/lib/types"

function createClientStreamId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

type StreamSessionResponse = {
  ok: boolean
  hasActiveStream: boolean
}

type PhoneLandscapePlayerStyle = CSSProperties & {
  "--yami-phone-landscape-player-width"?: string
}

type ViewportSize = {
  width: number
  height: number
}

function readViewportSize(): ViewportSize | null {
  if (typeof window === "undefined") {
    return null
  }

  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  }
}

function useViewportSize() {
  const [viewportSize, setViewportSize] = useState<ViewportSize | null>(null)

  useEffect(() => {
    const updateViewportSize = () => setViewportSize(readViewportSize())

    updateViewportSize()
    window.addEventListener("resize", updateViewportSize)
    window.addEventListener("orientationchange", updateViewportSize)
    window.visualViewport?.addEventListener("resize", updateViewportSize)

    return () => {
      window.removeEventListener("resize", updateViewportSize)
      window.removeEventListener("orientationchange", updateViewportSize)
      window.visualViewport?.removeEventListener("resize", updateViewportSize)
    }
  }, [])

  return viewportSize
}

function getAspectRatioValue(aspectRatio: string) {
  const [width, height] = aspectRatio
    .split("/")
    .map((part) => Number.parseFloat(part.trim()))

  if (!width || !height || width <= 0 || height <= 0) {
    return 16 / 9
  }

  return width / height
}

function getPhoneLandscapePlayerStyle(
  aspectRatio: string,
  viewportSize: ViewportSize | null
): PhoneLandscapePlayerStyle {
  if (!viewportSize) {
    return {
      "--yami-phone-landscape-player-width": "min(calc(100vw - 1rem), calc(100dvh - 1rem))",
    }
  }

  const ratio = getAspectRatioValue(aspectRatio)
  const maxWidth = Math.max(viewportSize.width - 16, 0)
  const maxHeight = Math.max(viewportSize.height - 16, 0)
  const width = Math.max(Math.min(maxWidth, maxHeight * ratio), 0)

  return {
    "--yami-phone-landscape-player-width": `${Math.floor(width)}px`,
  }
}

function WatchSkeleton({
  aspectRatio = DEFAULT_PLAYER_ASPECT_RATIO,
  viewportSize,
  isTvLike,
}: {
  aspectRatio?: string
  viewportSize: ViewportSize | null
  isTvLike: boolean
}) {
  const playerStyle = getPhoneLandscapePlayerStyle(aspectRatio, viewportSize)

  return (
    <div
      className={cn(
        "yami-watch-view flex flex-col gap-4 lg:gap-6",
        isTvLike ? "yami-tv-watch-view" : null
      )}
    >
      <section className="yami-watch-heading mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-2 text-center lg:gap-3">
        <Skeleton className="h-8 w-64 max-w-full rounded-lg bg-zinc-900 sm:h-9 sm:w-80 lg:h-8 lg:w-[22rem]" />
        <Skeleton className="h-6 w-20 rounded-full bg-zinc-900 lg:h-6 lg:w-[5.5rem]" />
        <Skeleton className="h-6 w-24 rounded-full bg-zinc-900 lg:h-6 lg:w-[6.5rem]" />
      </section>

      <div
        className={cn(
          "yami-watch-player-shell yami-player-width mx-auto",
          isTvLike ? "yami-tv-watch-player-shell" : null
        )}
        style={playerStyle}
      >
        <div className="space-y-3">
          <div className="relative overflow-hidden rounded-lg border border-white/10 bg-black shadow-[0_28px_90px_rgba(0,0,0,0.45)]">
            <Skeleton
              className="w-full rounded-none bg-zinc-900"
              style={{ aspectRatio }}
            />
            <div className="absolute inset-x-0 bottom-0 bg-zinc-950/40 p-3 backdrop-blur-md">
              <div className="flex items-center gap-2">
                <Skeleton className="size-9 shrink-0 rounded-md lg:size-11 bg-zinc-800" />
                <Skeleton className="hidden size-9 shrink-0 rounded-md lg:size-11 bg-zinc-800 sm:block" />
                <Skeleton className="hidden size-9 shrink-0 rounded-md lg:size-11 bg-zinc-800 sm:block" />
                <Skeleton className="h-4 w-24 shrink-0 rounded lg:h-5 lg:w-36 bg-zinc-800" />
                <Skeleton className="h-2 min-w-0 flex-1 rounded-full lg:h-3 bg-zinc-800" />
                <Skeleton className="size-9 shrink-0 rounded-md lg:size-11 bg-zinc-800" />
                <Skeleton className="hidden size-9 shrink-0 rounded-md lg:size-11 bg-zinc-800 sm:block" />
                <Skeleton className="size-9 shrink-0 rounded-md lg:size-11 bg-zinc-800" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function WatchView({
  animeId,
  epNr,
  seasonNr,
}: {
  animeId: string
  epNr: string
  seasonNr: string
}) {
  const router = useRouter()
  const [current, setCurrent] = useState({ epNr, seasonNr })
  const [payload, setPayload] = useState<WatchPayload | null>(null)
  const [autoPlay, setAutoPlay] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [streamBlocked, setStreamBlocked] = useState<boolean | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [clientStreamId] = useState(createClientStreamId)
  const viewportSize = useViewportSize()
  const { isTvLike } = useTvMode()

  useEffect(() => {
    let cancelled = false

    async function loadWatchState() {
      try {
        const [data, streamSession] = await Promise.all([
          apiGet<WatchPayload>(
            `/api/watch/${animeId}/${current.epNr}?season=${current.seasonNr}`
          ),
          apiGet<StreamSessionResponse>(
            `/api/stream/session?clientId=${encodeURIComponent(clientStreamId)}`
          ),
        ])

        if (cancelled) {
          return
        }

        setPayload(data)
        setStreamBlocked(streamSession.hasActiveStream)
        setError(null)
      } catch {
        if (!cancelled) {
          setError("Episode unavailable")
        }
      }
    }

    void loadWatchState()

    return () => {
      cancelled = true
    }
  }, [animeId, clientStreamId, current.epNr, current.seasonNr])

  function openEpisode(episode: Episode, shouldAutoPlay: boolean) {
    const nextSeasonNr = String(episode.seasonNumber)
    const nextEpNr = String(episode.episodeNumber)

    setAutoPlay(shouldAutoPlay)
    setError(null)
    setPayload(null)
    setStreamBlocked(null)
    setCurrent({ seasonNr: nextSeasonNr, epNr: nextEpNr })
    window.history.replaceState(
      null,
      "",
      `/watch/${animeId}/${episode.episodeNumber}?season=${episode.seasonNumber}`
    )
  }

  async function replaceActiveStream() {
    setReplacing(true)

    try {
      const response = await fetch("/api/stream/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "replace" }),
      })

      if (!response.ok) {
        throw new Error(`Stream replacement failed: ${response.status}`)
      }

      setStreamBlocked(false)
    } catch {
      setError("Could not close the other stream")
    } finally {
      setReplacing(false)
    }
  }

  function leaveWatchPage() {
    if (payload?.anime.librarySlug) {
      router.replace(`/anime/${payload.anime.librarySlug}?media=${payload.anime.id}`)
      return
    }

    router.replace("/library")
  }

  if (error) {
    return <p className="text-sm text-red-300">{error}</p>
  }

  if (!payload || streamBlocked !== false) {
    return (
      <>
        <WatchSkeleton
          aspectRatio={
            payload
              ? getPreferredPlayerAspectRatio(
                  payload.media.videoWidth,
                  payload.media.videoHeight
                )
              : undefined
          }
          viewportSize={viewportSize}
          isTvLike={isTvLike}
        />
        <StreamLimitDialog
          open={Boolean(payload && streamBlocked)}
          onConfirm={replaceActiveStream}
          onCancel={leaveWatchPage}
          confirmLabel="Yes"
          cancelLabel="No"
          loading={replacing}
          dismissible={false}
        />
      </>
    )
  }

  const playerAspectRatio = getPreferredPlayerAspectRatio(
    payload.media.videoWidth,
    payload.media.videoHeight
  )
  const playerStyle = getPhoneLandscapePlayerStyle(playerAspectRatio, viewportSize)
  const episodeSeasonPart =
    parseSeasonPartFromText(payload.episode.fileName) ??
    parseSeasonPartFromText(payload.episode.filePath) ??
    { season: payload.episode.seasonNumber }
  const watchSeriesTitle = formatWatchSeriesTitle({
    mediaTitle: payload.anime.title,
    seasonPart: episodeSeasonPart,
  })
  const watchEpisodeTitle = formatEpisodeDisplayTitle({
    episodeNumber: payload.episode.episodeNumber,
    title: payload.episode.title,
  })

  return (
    <div
      className={cn(
        "yami-watch-view flex flex-col gap-4 lg:gap-6",
        isTvLike ? "yami-tv-watch-view" : null
      )}
    >
      <section className="yami-watch-heading mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-2 text-center lg:gap-3">
        <h1 className="min-w-0 truncate text-xl font-semibold text-zinc-50">
          {watchSeriesTitle} - {watchEpisodeTitle}
        </h1>
      </section>

      <div
        className={cn(
          "yami-watch-player-shell yami-player-width mx-auto",
          isTvLike ? "yami-tv-watch-player-shell" : null
        )}
        style={playerStyle}
      >
        <AnimePlayer
          animeId={animeId}
          seasonNumber={payload.episode.seasonNumber}
          episodeNumber={payload.episode.episodeNumber}
          playback={payload.playback}
          media={payload.media}
          fileName={payload.episode.fileName}
          previousEpisode={payload.previousEpisode}
          nextEpisode={payload.nextEpisode}
          durationSeconds={payload.episode.durationSeconds}
          thumbnailUrl={payload.episode.thumbnail}
          autoPlay={autoPlay}
          clientStreamId={clientStreamId}
          onEpisodeChange={openEpisode}
        />
      </div>
    </div>
  )
}
