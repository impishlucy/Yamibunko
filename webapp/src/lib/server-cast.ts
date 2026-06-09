export const serverCastDevicesApiPath = "/api/cast/server/devices"
export const serverCastStartApiPath = "/api/cast/server/start"
export const serverCastControlApiPath = "/api/cast/server/control"
export const serverCastStatusApiPath = "/api/cast/server/status"

export type ServerCastDevice = {
  id: string
  name: string
  host: string
  port: number
  modelName?: string
}

export type ServerCastTextTrack = {
  id: number
  language?: string
  label: string
  url: string
}

export type ServerCastTrackingTarget = {
  animeId: number
  seasonNumber: number
  episodeNumber: number
}

export type ServerCastCandidate = {
  id: string
  url: string
  contentType: string
  currentTime: number
  durationSeconds?: number
  sourceStartOffset: number
  textTrack?: ServerCastTextTrack
  title?: string
  tracking?: ServerCastTrackingTarget
}

export type ServerCastMediaState = {
  contentId?: string
  durationSeconds?: number
  idleReason?: string
  isAlive: boolean
  mediaSessionId?: number
  playerState?: string
  positionSeconds: number
}

export type ServerCastDevicesResponse = {
  devices: ServerCastDevice[]
}

export type ServerCastStartResponse = {
  candidate: ServerCastCandidate
  sessionId: string
  state: ServerCastMediaState
}

export type ServerCastStatusResponse = {
  state: ServerCastMediaState
}
