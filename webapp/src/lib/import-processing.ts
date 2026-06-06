export const importProcessingStatusPath = "/api/media/import/status"
export const importProcessingEventsPath = "/api/media/import/events"

export type MediaImportProcessingKind =
  | "direct-move"
  | "video-transcode"
  | "audio-transcode"
  | "container-remux"

export type MediaImportProcessingStatus = "queued" | "active"

export type MediaImportProcessingItem = {
  id: string
  kind: MediaImportProcessingKind
  status: MediaImportProcessingStatus
  animeTitle: string
  subtitle?: string | null
  seasonNumber: number
  episodeNumber: number
  fileName: string
  queuedAt: string
  startedAt?: string | null
}

export type MediaImportProcessingState = {
  count: number
  items: MediaImportProcessingItem[]
  updatedAt: string
}
