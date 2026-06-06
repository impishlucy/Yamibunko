export const libraryEventsPath = "/api/anime/library/events"
export const clientLibraryRefreshEvent = "yamibunko:library-refresh"

export type LibraryChangeEventType =
  | "anime-updated"
  | "episode-added"
  | "episode-removed"

export type LibraryChangeEvent = {
  type: LibraryChangeEventType
  animeId: number
  rootAnimeId: number
  librarySlug: string
  seasonNumber?: number
  episodeNumber?: number
  changedAt: string
}
