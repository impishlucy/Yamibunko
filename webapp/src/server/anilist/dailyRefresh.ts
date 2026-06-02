import { isAniListConfigured, syncAniListUserList } from "@/server/anilist/client"
import { listAniListConnections } from "@/server/db/anilistConnections"
import {
  listAnimeIdsForAniListRefresh,
  upsertAnime,
} from "@/server/db/library"
import { findAnimeMetadataById } from "@/server/metadata/anilist"
import { errorMessage } from "@/server/utils/format"

let running = false

export async function runDailyAniListRefresh() {
  if (running) {
    console.warn("[Warn] [Anilist] Daily refresh skipped because it is already running.")
    return
  }

  running = true
  console.log("[Info] [Anilist] Daily refresh started.")

  try {
    const animeIds = listAnimeIdsForAniListRefresh()
    let refreshedAnime = 0

    for (const animeId of animeIds) {
      try {
        const metadata = await findAnimeMetadataById(animeId)

        if (metadata) {
          upsertAnime(metadata)
          refreshedAnime += 1
        }
      } catch (error) {
        console.error(
          `[Error] [Anilist] Daily anime metadata refresh failed - dailyRefresh.ts - Anime id ${animeId} - ${errorMessage(error)}`
        )
      }
    }

    let refreshedUsers = 0

    if (isAniListConfigured()) {
      for (const connection of listAniListConnections()) {
        try {
          const result = await syncAniListUserList(connection.username)

          if (result.synced) {
            refreshedUsers += 1
          }
        } catch (error) {
          console.error(
            `[Error] [Anilist] Daily user media list refresh failed - dailyRefresh.ts - User ${connection.username} - ${errorMessage(error)}`
          )
        }
      }
    }

    console.log(
      `[Info] [Anilist] Daily refresh completed - Anime: ${refreshedAnime}/${animeIds.length}, Users: ${refreshedUsers}`
    )
  } finally {
    running = false
  }
}
