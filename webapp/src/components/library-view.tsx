"use client"

import { useEffect, useMemo, useState } from "react"
import { Search } from "lucide-react"

import { AnimeCard } from "@/components/anime-card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { apiGet } from "@/lib/api"
import type { AnimeSummary } from "@/lib/types"

export function LibraryView() {
  const [query, setQuery] = useState("")
  const [items, setItems] = useState<AnimeSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiGet<AnimeSummary[]>("/api/anime/library")
      .then((library) => {
        setItems(library)
        setError(null)
      })
      .catch(() => {
        setError("Library unavailable")
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase()

    if (!normalized) {
      return items
    }

    return items.filter((item) =>
      `${item.title} ${item.year ?? ""}`.toLowerCase().includes(normalized)
    )
  }, [items, query])

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-50">Library</h1>
          <p className="text-sm text-zinc-500">{items.length} titles</p>
        </div>
        <label className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-500" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title or year"
            className="h-9 rounded-lg border-white/10 bg-zinc-950/70 pl-8 text-zinc-100"
          />
        </label>
      </div>

      {error ? <p className="text-sm text-red-300">{error}</p> : null}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {loading
          ? Array.from({ length: 8 }).map((_, index) => (
              <Skeleton
                key={index}
                className="aspect-[3/4] rounded-lg bg-zinc-900"
              />
            ))
          : filteredItems.map((anime) => (
              <AnimeCard key={anime.id} anime={anime} />
            ))}
      </div>
    </div>
  )
}
