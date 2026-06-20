export type AnimeSummary = {
  id: number
  slug: string
  title: string
  coverImage?: string
  bannerImage?: string
  episodeCount: number
  mediaCount?: number
  year?: number
  isLocalNonAnime?: boolean
}

export type AnimeVariant = {
  id: number
  title: string
  format?: string
  year?: number
  episodeCount: number
  seasonNumber?: number
  sortGroup?: "mainline" | "related"
}

export type AnimeInfo = AnimeSummary & {
  librarySlug: string
  format?: string
  relationKind?: string
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
  isLocalNonAnime?: boolean
  tags: Array<{
    id: number
    name: string
    description?: string | null
    category?: string | null
    rank?: number | null
    isAdult?: boolean | null
  }>
  seasons: number[]
  variants?: AnimeVariant[]
}

export type AnimeLibraryEntry = {
  slug: string
  title: string
  variants: AnimeVariant[]
  selected: AnimeInfo & {
    variants: AnimeVariant[]
  }
}

export type SpoilerSettings = {
  blurEpisodeThumbnails: boolean
  removeUnwatchedEpisodeTitles: boolean
}

export const defaultSpoilerSettings: SpoilerSettings = {
  blurEpisodeThumbnails: false,
  removeUnwatchedEpisodeTitles: false,
}

export type AnimeDetailPayload = {
  libraryEntry: AnimeLibraryEntry
  episodes: Episode[]
  spoilers: SpoilerSettings
}

export type Episode = {
  animeId: number
  seasonNumber: number
  episodeNumber: number
  title?: string
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
  queued: number
}

export type PlaybackProfile = "original"
export type PlaybackMode = "direct" | "transcode"

export type MediaStreamInfo = {
  id: string
  index: number
  codec?: string
  profile?: string
  channels?: number
  language?: string
  label: string
  isDefault: boolean
}

export type SubtitleStreamInfo = MediaStreamInfo & {
  isForced: boolean
  isSupported: boolean
}

export type WatchPayload = {
  anime: AnimeInfo
  episode: Episode
  previousEpisode?: Episode
  nextEpisode?: Episode
  playback: {
    directUrl: string
    originalTranscodeUrl: string
    castDirectUrl: string
    castTranscodeUrl: string
    liveTranscodeEnabled: boolean
    importEnabled: boolean
    subtitleUrl: string
    castSubtitleUrl: string
  }
  media: {
    audioStreams: MediaStreamInfo[]
    subtitleStreams: SubtitleStreamInfo[]
    defaultAudioStreamId: string | null
    defaultSubtitleStreamId: string | null
    directAudioStreamId: string | null
    videoCodec?: string
    videoWidth?: number
    videoHeight?: number
    container?: string
    sourceBitrateMbps?: number
  }
}

export type SafeSettings = {
  account: {
    userName: string
    isAdmin: boolean
    disableUpdateBadges: boolean
  }
  spoilers: SpoilerSettings
}
