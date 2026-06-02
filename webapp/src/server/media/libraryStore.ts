import type { AnimeInfo, AnimeSummary, Episode } from "@/lib/types"
import {
  getAdjacentEpisodes,
  getAnime,
  getLibraryEntry as getStoredLibraryEntry,
  getStoredEpisode,
  listAnime,
  listEpisodes,
} from "@/server/db/library"
import { parsePositiveInt } from "@/server/utils/format"

export function getLibrary(): AnimeSummary[] {
  return listAnime()
}

export function getAnimeInfo(animeId: string | number): AnimeInfo | null {
  return getAnime(animeId)
}

export function getLibraryEntry(
  identifier: string,
  selectedAnimeId?: string | number
) {
  return getStoredLibraryEntry(identifier, selectedAnimeId)
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
  const seasonNumber = epNr === undefined ? 1 : parsePositiveInt(seasonNr)
  const episodeNumber =
    epNr === undefined ? parsePositiveInt(seasonNr) : parsePositiveInt(epNr)

  if (!seasonNumber || !episodeNumber) {
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
