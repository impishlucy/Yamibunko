"use client"

import { useEffect, useState } from "react"

import { AnimePlayer } from "@/components/anime-player"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { apiGet } from "@/lib/api"
import type { Episode, WatchPayload } from "@/lib/types"

export function WatchView({
  animeId,
  epNr,
  seasonNr,
}: {
  animeId: string
  epNr: string
  seasonNr: string
}) {
  const [current, setCurrent] = useState({ epNr, seasonNr })
  const [payload, setPayload] = useState<WatchPayload | null>(null)
  const [autoPlay, setAutoPlay] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    apiGet<WatchPayload>(
      `/api/watch/${animeId}/${current.epNr}?season=${current.seasonNr}`
    )
      .then((data) => {
        if (cancelled) {
          return
        }

        setPayload(data)
        setError(null)
      })
      .catch(() => {
        if (!cancelled) {
          setError("Episode unavailable")
        }
      })

    return () => {
      cancelled = true
    }
  }, [animeId, current.epNr, current.seasonNr])

  function openEpisode(episode: Episode, shouldAutoPlay: boolean) {
    const nextSeasonNr = String(episode.seasonNumber)
    const nextEpNr = String(episode.episodeNumber)

    setAutoPlay(shouldAutoPlay)
    setError(null)
    setCurrent({ seasonNr: nextSeasonNr, epNr: nextEpNr })
    window.history.replaceState(
      null,
      "",
      `/watch/${animeId}/${episode.episodeNumber}?season=${episode.seasonNumber}`
    )
  }

  if (error) {
    return <p className="text-sm text-red-300">{error}</p>
  }

  if (!payload) {
    return (
      <div className="space-y-4">
        <div className="flex justify-center">
          <Skeleton className="h-9 w-80 max-w-full rounded-lg bg-zinc-900" />
        </div>
        <Skeleton className="aspect-video rounded-lg bg-zinc-900" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <section className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-2 text-center">
        <h1 className="min-w-0 truncate text-xl font-semibold text-zinc-50 sm:text-2xl">
          {payload.anime.title}
        </h1>
        <Badge
          variant="outline"
          className="border-violet-400/30 bg-violet-400/10 text-violet-100"
        >
          Season {String(payload.episode.seasonNumber).padStart(2, "0")}
        </Badge>
        <Badge
          variant="outline"
          className="border-violet-400/30 bg-violet-400/10 text-violet-100"
        >
          Episode {String(payload.episode.episodeNumber).padStart(2, "0")}
        </Badge>
      </section>

      <div className="mx-auto w-full lg:max-w-[60vw]">
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
          onEpisodeChange={openEpisode}
        />
      </div>
    </div>
  )
}
