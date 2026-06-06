"use client"

import { useEffect, useMemo, useRef } from "react"

import {
  libraryEventsPath,
  type LibraryChangeEvent,
} from "@/lib/library-events"

type AnimeLibraryRefreshListenerProps = {
  librarySlug: string
  animeIds: number[]
  onRefresh: () => void
}

function parseLibraryChangeEvent(event: Event) {
  const message = event as MessageEvent<string>

  try {
    return JSON.parse(message.data) as LibraryChangeEvent
  } catch {
    return null
  }
}

export function AnimeLibraryRefreshListener({
  librarySlug,
  animeIds,
  onRefresh,
}: AnimeLibraryRefreshListenerProps) {
  const pendingRefreshRef = useRef<number | null>(null)
  const animeIdKey = useMemo(
    () => [...new Set(animeIds)].sort((left, right) => left - right).join(","),
    [animeIds]
  )

  useEffect(() => {
    const knownAnimeIds = new Set(
      animeIdKey
        .split(",")
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )

    const scheduleRefresh = () => {
      if (pendingRefreshRef.current !== null) {
        return
      }

      pendingRefreshRef.current = window.setTimeout(() => {
        pendingRefreshRef.current = null
        onRefresh()
      }, 250)
    }

    const source = new EventSource(libraryEventsPath)
    const onLibraryChange = (event: Event) => {
      const payload = parseLibraryChangeEvent(event)

      if (!payload) {
        return
      }

      if (
        payload.librarySlug === librarySlug ||
        knownAnimeIds.has(payload.animeId) ||
        knownAnimeIds.has(payload.rootAnimeId)
      ) {
        scheduleRefresh()
      }
    }

    source.addEventListener("library-change", onLibraryChange)

    return () => {
      source.removeEventListener("library-change", onLibraryChange)
      source.close()

      if (pendingRefreshRef.current !== null) {
        window.clearTimeout(pendingRefreshRef.current)
        pendingRefreshRef.current = null
      }
    }
  }, [animeIdKey, librarySlug, onRefresh])

  return null
}
