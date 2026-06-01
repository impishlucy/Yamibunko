export type AnimeSummary = {
  id: number
  title: string
  coverImage?: string
  bannerImage?: string
  episodeCount: number
  year?: number
}

export type AnimeInfo = AnimeSummary & {
  titles: {
    romaji?: string
    english?: string
    native?: string
    userPreferred: string
  }
  status?: string
  description?: string
  genres?: string[]
  averageScore?: number
  durationMinutes?: number
  tags: Array<{
    id: number
    name: string
    description?: string | null
    category?: string | null
    rank?: number | null
    isAdult?: boolean | null
  }>
  seasons: number[]
}

export type Episode = {
  animeId: number
  seasonNumber: number
  episodeNumber: number
  fileName: string
  filePath: string
  thumbnail?: string
  durationSeconds?: number
  progress?: {
    watchedSeconds: number
    durationSeconds?: number
    completed: boolean
    ratio: number
  }
}

export type TranscodeStatus = {
  max: number
  active: number
  available: number
}

export type PlaybackProfile = "original" | "dataSaver"
export type PlaybackMode = "direct" | "transcode"

export type WatchPayload = {
  anime: AnimeInfo
  episode: Episode
  previousEpisode?: Episode
  nextEpisode?: Episode
  playback: {
    directUrl: string
    originalTranscodeUrl: string
    dataSaverUrl: string
  }
}

export type SafeSettings = {
  account: {
    userName: string
    isAdmin: boolean
  }
}
