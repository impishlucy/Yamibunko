import type { AnimeInfo, AnimeSummary, Episode } from "@/lib/types"
import {
  getAdjacentEpisodes,
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

export function getEpisodes(
  animeId: string | number,
  username?: string
): Episode[] {
  return listEpisodes(animeId, username)
}

export function getEpisode(
  animeId: string | number,
  seasonNr: string | number,
  epNr?: string | number,
  username?: string
): Episode | null {
  const seasonNumber =
    epNr === undefined
      ? 1
      : typeof seasonNr === "number"
        ? seasonNr
        : Number.parseInt(seasonNr, 10)
  const episodeNumber =
    epNr === undefined
      ? typeof seasonNr === "number"
        ? seasonNr
        : Number.parseInt(seasonNr, 10)
      : typeof epNr === "number"
        ? epNr
        : Number.parseInt(epNr, 10)

  if (
    !Number.isInteger(seasonNumber) ||
    !Number.isInteger(episodeNumber) ||
    seasonNumber < 1 ||
    episodeNumber < 1
  ) {
    return null
  }

  return getStoredEpisode(animeId, seasonNumber, episodeNumber, username)
}

export function getEpisodeNeighbors(input: {
  animeId: number
  seasonNr: number
  epNr: number
  username?: string
}) {
  return getAdjacentEpisodes(input)
}
