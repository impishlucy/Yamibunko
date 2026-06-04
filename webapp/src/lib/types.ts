export type AnimeSummary = {
  id: number
  slug: string
  title: string
  coverImage?: string
  bannerImage?: string
  episodeCount: number
  mediaCount?: number
  year?: number
}

export type AnimeVariant = {
  id: number
  title: string
  format?: string
  year?: number
  episodeCount: number
  seasonNumber?: number
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

export type PlaybackProfile = "original" | "dataSaver"
export type PlaybackMode = "direct" | "transcode"

export type MediaStreamInfo = {
  id: string
  index: number
  codec?: string
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
    dataSaverUrl: string
    castDirectUrl: string
    castTranscodeUrl: string
    castDataSaverUrl: string
    liveTranscodeEnabled: boolean
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
  }
}
