"use client"

import { useCallback, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { clientLibraryRefreshEvent } from "@/lib/library-events"
import { isLocalNonAnimeId } from "@/lib/local-media"

type AniListTrackingState = {
  configured: boolean
  connected: boolean
  ratingScale: 5 | 10
  entry: {
    id: number
    status: string | null
    progress: number
    rating: number | null
  } | null
}

const statusLabels: Record<string, string> = {
  CURRENT: "Watching",
  REPEATING: "Rewatching",
  COMPLETED: "Completed",
  PLANNING: "Planning",
  PAUSED: "Paused",
  DROPPED: "Dropped",
}

function shouldShowProgress(status: string | null) {
  return status === "CURRENT" || status === "REPEATING"
}

export function AniListTracking({ animeId }: { animeId: number }) {
  const isLocalMedia = isLocalNonAnimeId(animeId)
  const [state, setState] = useState<AniListTrackingState | null>(null)
  const [busy, setBusy] = useState(false)

  const loadTrackingState = useCallback(async (signal?: AbortSignal) => {
    if (isLocalMedia) {
      setState(null)
      return
    }

    const response = await fetch(`/api/anilist/status?animeId=${animeId}`, {
      cache: "no-store",
      signal,
    }).catch(() => null)

    if (!response?.ok) {
      return
    }

    const payload = (await response.json().catch(() => null)) as
      | AniListTrackingState
      | null

    if (payload) {
      setState(payload)
    }
  }, [animeId, isLocalMedia])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void loadTrackingState(controller.signal)
    }, 0)

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [loadTrackingState])

  useEffect(() => {
    const onRefresh = () => {
      void loadTrackingState()
    }

    window.addEventListener(clientLibraryRefreshEvent, onRefresh)

    return () => {
      window.removeEventListener(clientLibraryRefreshEvent, onRefresh)
    }
  }, [loadTrackingState])

  async function track() {
    setBusy(true)

    try {
      const response = await fetch("/api/anilist/track", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          animeId,
          progress: state?.entry?.progress ?? 0,
        }),
      })

      if (response.ok) {
        await loadTrackingState()
      }
    } finally {
      setBusy(false)
    }
  }

  async function rate(rating: number) {
    setBusy(true)

    try {
      const response = await fetch("/api/anilist/track", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          animeId,
          rating,
        }),
      })

      if (response.ok) {
        setState((current) =>
          current
            ? {
                ...current,
                entry: current.entry
                  ? {
                      ...current.entry,
                      rating,
                    }
                  : current.entry,
              }
            : current
        )
      }
    } finally {
      setBusy(false)
    }
  }

  if (isLocalMedia || !state?.connected) {
    return null
  }

  return state.entry ? (
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded-full border border-violet-400/25 bg-violet-500/15 px-3 py-1 text-xs font-medium text-violet-100">
        AniList: {statusLabels[state.entry.status ?? ""] ?? "Tracked"}
        {shouldShowProgress(state.entry.status)
          ? `, episode ${state.entry.progress}`
          : ""}
      </span>
      <select
        value={state.entry.rating ?? ""}
        disabled={busy}
        onChange={(event) => {
          const rating = Number(event.target.value)

          if (Number.isInteger(rating) && rating > 0) {
            void rate(rating)
          }
        }}
        className="h-8 rounded-full border border-white/10 bg-zinc-950/80 px-3 text-xs text-zinc-100 outline-none"
      >
        <option value="">No rating</option>
        {Array.from({ length: state.ratingScale }, (_, index) => index + 1).map(
          (rating) => (
            <option key={rating} value={rating}>
              {rating}/{state.ratingScale}
            </option>
          )
        )}
      </select>
    </div>
  ) : (
    <Button
      type="button"
      size="sm"
      className="rounded-lg"
      onClick={track}
      disabled={busy}
    >
      {busy ? "Tracking..." : "Track on AniList"}
    </Button>
  )
}
