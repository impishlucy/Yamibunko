import { syncAniListLibraryProgress } from "@/server/anilist/client"
import { listAniListConnections } from "@/server/db/anilistConnections"
import { refreshCachedAniListMetadata } from "@/server/metadata/anilist"
import { errorMessage } from "@/server/utils/format"

let fullRefreshPromise: Promise<{
  metadata: Awaited<ReturnType<typeof refreshCachedAniListMetadata>>
  users: Array<{
    username: string
    synced: boolean
    error?: string
  }>
}> | null = null

export async function refreshAniListTrackingData(username: string) {
  return syncAniListLibraryProgress(username)
}

export async function runFullAniListRefresh() {
  if (fullRefreshPromise) {
    return fullRefreshPromise
  }

  fullRefreshPromise = (async () => {
    const metadata = await refreshCachedAniListMetadata()
    const users: Array<{
      username: string
      synced: boolean
      error?: string
    }> = []

    for (const connection of listAniListConnections()) {
      try {
        await syncAniListLibraryProgress(connection.username)
        users.push({ username: connection.username, synced: true })
      } catch (error) {
        const message = errorMessage(error)
        console.error(
          `[Error] [Anilist] User sync failed - sync.ts - ${connection.username} - ${message}`
        )
        users.push({ username: connection.username, synced: false, error: message })
      }
    }

    return { metadata, users }
  })().finally(() => {
    fullRefreshPromise = null
  })

  return fullRefreshPromise
}
