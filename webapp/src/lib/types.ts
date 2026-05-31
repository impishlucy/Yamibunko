export type AnimeSummary = {
  id: string
  title: string
  coverImage?: string
  bannerImage?: string
  episodeCount: number
  year?: number
}

export type AnimeInfo = AnimeSummary & {
  description?: string
  genres?: string[]
}

export type Episode = {
  animeId: string
  episodeNumber: number
  title?: string
  fileName: string
  mediaId: string
  thumbnail?: string
  durationSeconds?: number
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
  playback: {
    directUrl: string
    originalTranscodeUrl: string
    dataSaverUrl: string
  }
}

export type SafeSettings = {
  account: {
    userName: string
  }
  paths: {
    inputDir: string
    mediaDir: string
    cacheDir: string
  }
  transcoding: {
    acceleration: "nvenc" | "qsv" | "cpu"
    backgroundConcurrency: number
    liveSlots: number
  }
  appearance: {
    theme: "dark"
  }
}
