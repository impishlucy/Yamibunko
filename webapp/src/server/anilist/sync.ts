import { randomUUID } from "node:crypto"

import { syncAniListLibraryProgress } from "@/server/anilist/client"
import { listAniListConnections } from "@/server/db/anilistConnections"
import { repairLibraryIntegrity } from "@/server/db/library"
import { refreshCachedAniListMetadata } from "@/server/metadata/anilist"
import { errorMessage } from "@/server/utils/format"

type AniListRefreshMode = "startup" | "daily" | "manual"

let fullRefreshPromise: Promise<{
  metadata: Awaited<ReturnType<typeof refreshCachedAniListMetadata>>
  repair: ReturnType<typeof repairLibraryIntegrity>
  users: Array<{
    username: string
    synced: boolean
    error?: string
  }>
}> | null = null

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

export async function runFullAniListRefresh(mode: AniListRefreshMode = "daily") {
  if (fullRefreshPromise) {
    return fullRefreshPromise
  }

  const refresh = (async () => {
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

    return { metadata, repair, users }
  })()

  fullRefreshPromise = trackAniListRefresh("full", refresh).finally(() => {
    fullRefreshPromise = null
  })

  return fullRefreshPromise
}
