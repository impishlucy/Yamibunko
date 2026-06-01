"use client"

import { useEffect, useState } from "react"

import { AnimePlayer } from "@/components/anime-player"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
        <Skeleton className="aspect-video rounded-lg bg-zinc-900" />
        <Skeleton className="h-8 w-64 rounded-lg bg-zinc-900" />
      </div>
    )
  }

  const nearbyEpisodes = [payload.previousEpisode, payload.nextEpisode].filter(
    (episode): episode is Episode => Boolean(episode)
  )

  return (
    <div className="space-y-5">
      <AnimePlayer
        animeId={animeId}
        seasonNumber={payload.episode.seasonNumber}
        episodeNumber={payload.episode.episodeNumber}
        playback={payload.playback}
        previousEpisode={payload.previousEpisode}
        nextEpisode={payload.nextEpisode}
        autoPlay={autoPlay}
        onEpisodeChange={openEpisode}
      />

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="border-violet-400/30 text-violet-200"
          >
            S{String(payload.episode.seasonNumber).padStart(2, "0")} E
            {String(payload.episode.episodeNumber).padStart(2, "0")}
          </Badge>
          <span className="text-sm text-zinc-500">{payload.anime.title}</span>
        </div>
        <h1 className="text-xl font-semibold text-zinc-50">
          {payload.episode.fileName}
        </h1>
      </section>

      {nearbyEpisodes.length ? (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-400">Episodes</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {nearbyEpisodes.map((episode) => (
              <Button
                key={`${episode.seasonNumber}-${episode.episodeNumber}`}
                type="button"
                variant="outline"
                className="h-auto justify-start rounded-lg border-white/10 bg-zinc-950/70 px-3 py-2 text-left"
                onClick={() => openEpisode(episode, false)}
              >
                <span className="min-w-0 truncate">
                  S{String(episode.seasonNumber).padStart(2, "0")} E
                  {String(episode.episodeNumber).padStart(2, "0")} -{" "}
                  {episode.fileName}
                </span>
              </Button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
