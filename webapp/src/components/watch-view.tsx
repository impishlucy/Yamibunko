"use client"

import { useEffect, useState } from "react"

import { AnimePlayer } from "@/components/anime-player"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { apiGet } from "@/lib/api"
import type { WatchPayload } from "@/lib/types"

export function WatchView({
  animeId,
  epNr,
}: {
  animeId: string
  epNr: string
}) {
  const [payload, setPayload] = useState<WatchPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiGet<WatchPayload>(`/api/watch/${animeId}/${epNr}`)
      .then((data) => {
        setPayload(data)
        setError(null)
      })
      .catch(() => {
        setError("Episode unavailable")
      })
  }, [animeId, epNr])

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

  return (
    <div className="space-y-5">
      <AnimePlayer
        animeId={animeId}
        episodeNumber={payload.episode.episodeNumber}
        playback={payload.playback}
      />

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="border-violet-400/30 text-violet-200"
          >
            Episode {payload.episode.episodeNumber}
          </Badge>
          <span className="text-sm text-zinc-500">{payload.anime.title}</span>
        </div>
        <h1 className="text-xl font-semibold text-zinc-50">
          {payload.episode.title ?? payload.episode.fileName}
        </h1>
      </section>
    </div>
  )
}
