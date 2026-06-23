"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Search } from "lucide-react"

import { AnimeCard } from "@/components/anime-card"
import { useTvMode } from "@/components/tv-mode-provider"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { apiGet } from "@/lib/api"
import {
  clientLibraryRefreshEvent,
  libraryEventsPath,
  type LibraryChangeEvent,
} from "@/lib/library-events"
import type { AnimeSummary } from "@/lib/types"

function AnimeCardSkeleton({ index }: { index: number }) {
  return (
    <Card className="rounded-lg border-white/10 bg-zinc-900/80 py-0">
      <Skeleton className="aspect-[3/4] rounded-none bg-zinc-800" />
      <CardContent className="space-y-1.5 p-2">
        <Skeleton className="h-3.5 w-full rounded bg-zinc-800" />
        <Skeleton
          className={`h-3.5 rounded bg-zinc-800 ${
            index % 3 === 0 ? "w-2/3" : "w-5/6"
          }`}
        />
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <Skeleton className="h-3 w-12 rounded bg-zinc-800" />
          <Skeleton className="h-3 w-10 rounded bg-zinc-800" />
        </div>
      </CardContent>
    </Card>
  )
}

function parseLibraryChangeEvent(event: Event) {
  const message = event as MessageEvent<string>

  try {
    return JSON.parse(message.data) as LibraryChangeEvent
  } catch {
    return null
  }
}

export function LibraryView() {
  const { isTvLike } = useTvMode()
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState("")
  const [tvSearchEditing, setTvSearchEditing] = useState(false)
  const [items, setItems] = useState<AnimeSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadLibrary = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setLoading(true)
    }

    try {
      const library = await apiGet<AnimeSummary[]>("/api/anime/library")
      setItems(library)
      setError(null)
    } catch {
      setError("Library unavailable")
    } finally {
      if (showLoading) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadLibrary(true)
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadLibrary])

  useEffect(() => {
    let refreshTimer: number | null = null

    const scheduleRefresh = () => {
      if (refreshTimer !== null) {
        return
      }

      refreshTimer = window.setTimeout(() => {
        refreshTimer = null
        void loadLibrary()
      }, 250)
    }

    const onLibraryChange = (event: Event) => {
      const payload = parseLibraryChangeEvent(event)

      if (!payload?.type) {
        return
      }

      scheduleRefresh()
    }

    const onClientRefresh = () => {
      scheduleRefresh()
    }

    const source = new EventSource(libraryEventsPath)
    source.addEventListener("library-change", onLibraryChange)
    window.addEventListener(clientLibraryRefreshEvent, onClientRefresh)

    return () => {
      source.removeEventListener("library-change", onLibraryChange)
      source.close()
      window.removeEventListener(clientLibraryRefreshEvent, onClientRefresh)

      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer)
      }
    }
  }, [loadLibrary])


  const activateTvSearch = useCallback(() => {
    if (!isTvLike) {
      return
    }

    setTvSearchEditing(true)
    window.setTimeout(() => searchInputRef.current?.focus(), 0)
  }, [isTvLike])

  const deactivateTvSearch = useCallback(() => {
    if (isTvLike) {
      setTvSearchEditing(false)
    }
  }, [isTvLike])

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
          <h1 className="text-2xl font-semibold text-zinc-50 lg:text-3xl">Library</h1>
          <p className="text-sm text-zinc-500">{items.length} Series total.</p>
        </div>
        <label className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-500" />
          <Input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClick={() => {
              if (isTvLike && !tvSearchEditing) {
                activateTvSearch()
              }
            }}
            onKeyDown={(event) => {
              if (!isTvLike) {
                return
              }

              if (!tvSearchEditing && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault()
                activateTvSearch()
                return
              }

              if (tvSearchEditing && event.key === "Escape") {
                event.preventDefault()
                deactivateTvSearch()
                searchInputRef.current?.blur()
              }
            }}
            onBlur={deactivateTvSearch}
            readOnly={isTvLike && !tvSearchEditing}
            inputMode={isTvLike && !tvSearchEditing ? "none" : "search"}
            enterKeyHint="search"
            placeholder="Search title or year"
            className="h-9 rounded-lg border-white/10 bg-zinc-950/70 pl-8 text-zinc-100"
          />
        </label>
      </div>

      {error ? <p className="text-sm text-red-300">{error}</p> : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
        {loading
          ? Array.from({ length: 18 }).map((_, index) => (
              <AnimeCardSkeleton key={index} index={index} />
            ))
          : filteredItems.map((anime, index) => (
              <AnimeCard key={anime.id} anime={anime} priority={index === 0} />
            ))}
      </div>
    </div>
  )
}
