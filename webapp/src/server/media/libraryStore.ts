import type { AnimeInfo, AnimeSummary, Episode } from "@/lib/types"
import {
  getAnime,
  getStoredEpisode,
  listAnime,
  listEpisodes,
} from "@/server/db/library"

export function getLibrary(): AnimeSummary[] {
  return listAnime()
}

export function getAnimeInfo(animeId: string | number): AnimeInfo | null {
  return getAnime(animeId)
}

export function getEpisodes(animeId: string | number): Episode[] {
  return listEpisodes(animeId)
}

export function getEpisode(
  animeId: string | number,
  epNr: string | number
): Episode | null {
  const episodeNumber =
    typeof epNr === "number" ? epNr : Number.parseInt(epNr, 10)

  if (!Number.isInteger(episodeNumber) || episodeNumber < 1) {
    return null
  }

  return getStoredEpisode(animeId, episodeNumber)
}
