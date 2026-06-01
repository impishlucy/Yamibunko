"use client"

import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"

type AniListTrackingState = {
  configured: boolean
  connected: boolean
  entry: {
    id: number
    status: string | null
    progress: number
  } | null
}

export function AniListTracking({ animeId }: { animeId: number }) {
  const [state, setState] = useState<AniListTrackingState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false

    fetch(`/api/anilist/status?animeId=${animeId}`, {
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: AniListTrackingState | null) => {
        if (!cancelled && payload) {
          setState(payload)
        }
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [animeId])

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
        const refreshed = await fetch(
          `/api/anilist/status?animeId=${animeId}`,
          {
            cache: "no-store",
          }
        )

        if (refreshed.ok) {
          setState((await refreshed.json()) as AniListTrackingState)
        }
      }
    } finally {
      setBusy(false)
    }
  }

  if (!state?.connected) {
    return null
  }

  return state.entry ? (
    <p className="text-sm text-zinc-400">
      AniList: {state.entry.status ?? "Tracked"} at episode{" "}
      {state.entry.progress}
    </p>
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
