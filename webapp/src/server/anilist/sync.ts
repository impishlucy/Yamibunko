import { randomUUID } from "node:crypto"

import { syncAniListLibraryProgress } from "@/server/anilist/client"
import { listAniListConnections } from "@/server/db/anilistConnections"
import { getAppStateValue, setAppStateValue } from "@/server/db/appState"
import { repairLibraryIntegrity } from "@/server/db/library"
import { refreshCachedAniListMetadata } from "@/server/metadata/anilist"
import { errorMessage } from "@/server/utils/format"

type AniListRefreshMode = "startup" | "daily" | "manual"

type FullAniListRefreshResult = {
  skipped: boolean
  reason?: string
  metadata: Awaited<ReturnType<typeof refreshCachedAniListMetadata>> | null
  repair: ReturnType<typeof repairLibraryIntegrity> | null
  users: Array<{
    username: string
    synced: boolean
    error?: string
  }>
}

const automaticFullRefreshIntervalMs = 24 * 60 * 60 * 1000
const automaticFullRefreshCompletedAtKey =
  "anilist.fullRefresh.automatic.completedAt"

let fullRefreshPromise: Promise<FullAniListRefreshResult> | null = null

const activeAniListRefreshes = new Map<string, Promise<unknown>>()

function trackAniListRefresh<T>(label: string, refresh: Promise<T>) {
  const id = `${label}:${randomUUID()}`
  activeAniListRefreshes.set(id, refresh)

  void refresh.then(
    () => activeAniListRefreshes.delete(id),
    () => activeAniListRefreshes.delete(id)
  )

  return refresh
}

export function hasActiveAniListRefreshes() {
  return activeAniListRefreshes.size > 0
}

export async function waitForActiveAniListRefreshes() {
  while (activeAniListRefreshes.size > 0) {
    await Promise.allSettled([...activeAniListRefreshes.values()])
  }
}

export async function refreshAniListTrackingData(username: string) {
  return trackAniListRefresh(
    `user:${username}`,
    syncAniListLibraryProgress(username)
  )
}

function getAutomaticFullRefreshRemainingMs() {
  const lastCompletedAt = getAppStateValue(automaticFullRefreshCompletedAtKey)
  const lastCompletedMs = lastCompletedAt ? Date.parse(lastCompletedAt) : Number.NaN

  if (!Number.isFinite(lastCompletedMs)) {
    return { lastCompletedAt, remainingMs: 0 }
  }

  return {
    lastCompletedAt,
    remainingMs: Math.max(
      lastCompletedMs + automaticFullRefreshIntervalMs - Date.now(),
      0
    ),
  }
}

function formatDuration(milliseconds: number) {
  const totalMinutes = Math.max(Math.ceil(milliseconds / 60000), 1)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours <= 0) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`
  }

  if (minutes <= 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`
  }

  return `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"}`
}

export async function runFullAniListRefresh(mode: AniListRefreshMode = "daily") {
  if (fullRefreshPromise) {
    return fullRefreshPromise
  }

  if (mode !== "manual") {
    const { lastCompletedAt, remainingMs } = getAutomaticFullRefreshRemainingMs()

    if (remainingMs > 0) {
      const reason = `Last automatic full AniList sync was ${lastCompletedAt}; next automatic full sync is allowed in ${formatDuration(remainingMs)}.`
      console.log(`[Info] [Anilist] Skipping ${mode} full AniList sync - ${reason}`)

      return {
        skipped: true,
        reason,
        metadata: null,
        repair: null,
        users: [],
      }
    }
  }

  const refresh = (async (): Promise<FullAniListRefreshResult> => {
    const metadata = await refreshCachedAniListMetadata(mode)
    const repair = repairLibraryIntegrity(`${mode} AniList metadata sync`)
    const users: Array<{
      username: string
      synced: boolean
      error?: string
    }> = []

    for (const connection of listAniListConnections()) {
      try {
        await refreshAniListTrackingData(connection.username)
        users.push({ username: connection.username, synced: true })
      } catch (error) {
        const message = errorMessage(error)
        console.error(
          `[Error] [Anilist] User sync failed - sync.ts - ${connection.username} - ${message}`
        )
        users.push({ username: connection.username, synced: false, error: message })
      }
    }

    if (mode !== "manual") {
      setAppStateValue(automaticFullRefreshCompletedAtKey, new Date().toISOString())
    }

    return { skipped: false, metadata, repair, users }
  })()

  fullRefreshPromise = trackAniListRefresh("full", refresh).finally(() => {
    fullRefreshPromise = null
  })

  return fullRefreshPromise
}
