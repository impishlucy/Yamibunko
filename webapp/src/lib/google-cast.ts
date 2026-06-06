type GoogleCastLoadRequest = {
  activeTrackIds?: number[]
  autoplay: boolean
  currentTime: number
}

type GoogleCastMediaCommandRequest = {
  customData?: unknown
}

type GoogleCastSeekRequest = GoogleCastMediaCommandRequest & {
  currentTime?: number
  resumeState?: string
}

type GoogleCastTextTrack = {
  language?: string
  name: string
  subtype: string
  trackContentId: string
  trackContentType: string
  trackId: number
  type: string
}

type GoogleCastMediaInfo = {
  contentId?: string
  duration?: number
  streamType?: string
  tracks?: GoogleCastTextTrack[]
}

type GoogleCastMediaSession = {
  currentTime?: number
  playerState?: string
  idleReason?: string
  media?: {
    contentId?: string
    duration?: number
  }
  addUpdateListener(listener: (isAlive: boolean) => void): void
  removeUpdateListener(listener: (isAlive: boolean) => void): void
  getEstimatedTime?: () => number
  play(
    request: GoogleCastMediaCommandRequest,
    successCallback: () => void,
    errorCallback: (error: unknown) => void
  ): void
  pause(
    request: GoogleCastMediaCommandRequest,
    successCallback: () => void,
    errorCallback: (error: unknown) => void
  ): void
  seek(
    request: GoogleCastSeekRequest,
    successCallback: () => void,
    errorCallback: (error: unknown) => void
  ): void
}

type GoogleCastSession = {
  addEventListener(
    type: string,
    listener: (event: GoogleCastMediaSessionEvent) => void
  ): void
  removeEventListener(
    type: string,
    listener: (event: GoogleCastMediaSessionEvent) => void
  ): void
  loadMedia(request: GoogleCastLoadRequest): Promise<GoogleCastMediaSession | null | undefined>
  setVolume?: (volume: number) => Promise<void>
  endSession(stopCasting: boolean): void
  getMediaSession(): GoogleCastMediaSession | null
}

type GoogleCastContext = {
  setOptions(options: {
    receiverApplicationId: string
    autoJoinPolicy: string
    resumeSavedSession?: boolean
  }): void
  requestSession(): Promise<GoogleCastSession | null | undefined>
  getCurrentSession(): GoogleCastSession | null
  addEventListener(
    type: string,
    listener: (event: GoogleCastSessionEvent) => void
  ): void
  removeEventListener(
    type: string,
    listener: (event: GoogleCastSessionEvent) => void
  ): void
}

type GoogleCastSessionEvent = {
  sessionState?: string
}

type GoogleCastMediaSessionEvent = {
  mediaSession?: GoogleCastMediaSession
}

type GoogleCastFramework = {
  CastContext: {
    getInstance(): GoogleCastContext
  }
  CastContextEventType: {
    SESSION_STATE_CHANGED: string
  }
  SessionEventType?: {
    MEDIA_SESSION?: string
  }
  SessionState: {
    SESSION_STARTED?: string
    SESSION_STARTING?: string
    SESSION_RESUMED?: string
    SESSION_RESUME_FAILED?: string
    SESSION_START_FAILED?: string
    SESSION_ENDED: string
    SESSION_ENDING: string
  }
}

type ChromeCastApi = {
  AutoJoinPolicy: {
    ORIGIN_SCOPED: string
  }
  media: {
    DEFAULT_MEDIA_RECEIVER_APP_ID?: string
    StreamType?: {
      BUFFERED: string
    }
    MediaInfo: new (
      contentId: string,
      contentType: string
    ) => GoogleCastMediaInfo
    Track?: new (trackId: number, type: string) => GoogleCastTextTrack
    TrackType?: {
      TEXT: string
    }
    TextTrackType?: {
      SUBTITLES: string
    }
    LoadRequest: new (mediaInfo: GoogleCastMediaInfo) => GoogleCastLoadRequest
    PauseRequest: new () => GoogleCastMediaCommandRequest
    PlayRequest: new () => GoogleCastMediaCommandRequest
    SeekRequest: new () => GoogleCastSeekRequest
  }
}

type CastWindow = Window &
  typeof globalThis & {
    __onGCastApiAvailable?: (isAvailable: boolean) => void
    cast?: {
      framework?: GoogleCastFramework
    }
    chrome?: {
      cast?: ChromeCastApi
    }
  }

const defaultMediaReceiverAppId = "CC1AD845"
export const googleCastUnreachableUrlErrorCode = "CAST_RECEIVER_URL_NOT_REACHABLE"
export const googleCastMediaUrlMessage =
  "Google Cast media URLs need HTTPS or an HTTP LAN IPv4 address the TV can reach. Set BASE_URL to your device IPv4 address, for example http://192.168.1.101:3000."
export const googleCastSenderUrlMessage =
  "Google Cast sender pages need HTTPS, http://localhost, or an HTTP LAN IPv4 address. Set BASE_URL to your device IPv4 address, for example http://192.168.1.101:3000."
let castFrameworkPromise: Promise<boolean> | null = null
let castFrameworkInitialized = false
const castVolumeInitializedSessions = new WeakSet<object>()

export type GoogleCastMediaLoadResult = "loaded" | "failed" | "timeout"

export type GoogleCastMediaState = {
  contentId?: string
  durationSeconds?: number
  idleReason?: string
  isAlive: boolean
  playerState?: string
  positionSeconds: number
}

export type GoogleCastSessionHandle = GoogleCastSession

function castWindow() {
  return window as CastWindow
}

function getCastApis() {
  const win = castWindow()
  const framework = win.cast?.framework
  const chromeCast = win.chrome?.cast

  if (!framework || !chromeCast) {
    return null
  }

  return {
    framework,
    chromeCast,
  }
}

function parseIpv4(hostname: string) {
  const parts = hostname.split(".")

  if (parts.length !== 4) {
    return null
  }

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return null
    }

    const value = Number(part)

    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null
  })

  if (octets.some((octet) => octet === null)) {
    return null
  }

  return octets as [number, number, number, number]
}

function isDeviceLocalHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase()

  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  ) {
    return true
  }

  const octets = parseIpv4(normalized)

  return octets?.[0] === 127 || normalized === "0.0.0.0"
}

function isLocalhostName(hostname: string) {
  return hostname.trim().toLowerCase() === "localhost"
}

function isIpv6Host(hostname: string) {
  const normalized = hostname.trim().toLowerCase()

  return normalized.includes(":") || normalized.startsWith("[")
}

function isValidDomainName(hostname: string) {
  const normalized = hostname.trim().toLowerCase()

  if (
    !normalized ||
    normalized.length > 253 ||
    normalized === "localhost" ||
    isIpv6Host(normalized) ||
    parseIpv4(normalized)
  ) {
    return false
  }

  const labels = normalized.split(".")

  if (labels.length < 2) {
    return false
  }

  return labels.every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  )
}

function isAllowedHttpsHost(hostname: string) {
  if (isDeviceLocalHost(hostname) || isIpv6Host(hostname)) {
    return false
  }

  return Boolean(parseIpv4(hostname.trim())) || isValidDomainName(hostname)
}

export function isPrivateLanIpv4Host(hostname: string) {
  const octets = parseIpv4(hostname.trim())

  if (!octets) {
    return false
  }

  const [first, second] = octets

  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}

export function getGoogleCastReceiverUrlUnavailableReason(value: string) {
  let url: URL

  try {
    url = new URL(value)
  } catch {
    return googleCastMediaUrlMessage
  }

  if (url.protocol === "https:") {
    return isAllowedHttpsHost(url.hostname) ? null : googleCastMediaUrlMessage
  }

  if (url.protocol !== "http:") {
    return googleCastMediaUrlMessage
  }

  if (isIpv6Host(url.hostname)) {
    return "Google Cast LAN media URLs need IPv4. Set BASE_URL to your device IPv4 address, for example http://192.168.1.101:3000."
  }

  if (isDeviceLocalHost(url.hostname)) {
    return googleCastMediaUrlMessage
  }

  return isPrivateLanIpv4Host(url.hostname) ? null : googleCastMediaUrlMessage
}

export function isGoogleCastReceiverUrlReachable(value: string) {
  return getGoogleCastReceiverUrlUnavailableReason(value) === null
}

export function assertGoogleCastReceiverUrlReachable(value: string) {
  if (!isGoogleCastReceiverUrlReachable(value)) {
    throw new Error(googleCastUnreachableUrlErrorCode)
  }
}

export function getGoogleCastSenderOriginUnavailableReason(value: string) {
  let url: URL

  try {
    url = new URL(value)
  } catch {
    return googleCastSenderUrlMessage
  }

  if (url.protocol === "https:") {
    return isAllowedHttpsHost(url.hostname) ? null : googleCastSenderUrlMessage
  }

  if (url.protocol !== "http:") {
    return googleCastSenderUrlMessage
  }

  if (isIpv6Host(url.hostname)) {
    return "Google Cast local sender pages need http://localhost or HTTPS. LAN casting still needs BASE_URL to use an IPv4 address."
  }

  return isLocalhostName(url.hostname) || isPrivateLanIpv4Host(url.hostname)
    ? null
    : googleCastSenderUrlMessage
}

export function isGoogleCastSenderOriginAllowed(value: string) {
  return getGoogleCastSenderOriginUnavailableReason(value) === null
}

export function getGoogleCastCurrentPageSenderUnavailableReason() {
  if (typeof window === "undefined") {
    return "Google Cast is only available in a browser."
  }

  return getGoogleCastSenderOriginUnavailableReason(window.location.href)
}

function isAllowedCastSenderOrigin() {
  return getGoogleCastCurrentPageSenderUnavailableReason() === null
}

function initializeCastFramework() {
  if (castFrameworkInitialized) {
    return true
  }

  if (!isAllowedCastSenderOrigin()) {
    return false
  }

  const apis = getCastApis()

  if (!apis) {
    return false
  }

  apis.framework.CastContext.getInstance().setOptions({
    receiverApplicationId:
      apis.chromeCast.media.DEFAULT_MEDIA_RECEIVER_APP_ID ??
      defaultMediaReceiverAppId,
    autoJoinPolicy: apis.chromeCast.AutoJoinPolicy.ORIGIN_SCOPED,
    resumeSavedSession: true,
  })
  castFrameworkInitialized = true
  return true
}

export function getGoogleCastContext() {
  if (!initializeCastFramework()) {
    return null
  }

  return getCastApis()?.framework.CastContext.getInstance() ?? null
}

export function getGoogleCastSession() {
  return getGoogleCastContext()?.getCurrentSession() ?? null
}

export function getGoogleCastUnavailableReason() {
  return (
    getGoogleCastCurrentPageSenderUnavailableReason() ??
    "Google Cast is not available in this browser."
  )
}

export async function ensureGoogleCastFramework() {
  if (typeof window === "undefined") {
    return false
  }

  if (!isAllowedCastSenderOrigin()) {
    return false
  }

  if (initializeCastFramework()) {
    return true
  }

  if (castFrameworkPromise) {
    return castFrameworkPromise
  }

  castFrameworkPromise = new Promise((resolve) => {
    const win = castWindow()
    let settled = false
    let checkTimer: number | null = null
    let timeoutTimer: number | null = null

    const cleanup = () => {
      if (checkTimer) {
        window.clearInterval(checkTimer)
        checkTimer = null
      }

      if (timeoutTimer) {
        window.clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
    }

    const finish = (available: boolean) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      resolve(available ? initializeCastFramework() : false)
    }

    const checkReady = () => {
      if (getCastApis()) {
        finish(true)
      }
    }

    if (getCastApis()) {
      finish(true)
      return
    }

    const existingCallback = win.__onGCastApiAvailable

    win.__onGCastApiAvailable = (isAvailable: boolean) => {
      existingCallback?.(isAvailable)
      finish(isAvailable)
    }

    checkTimer = window.setInterval(checkReady, 100)
    timeoutTimer = window.setTimeout(() => finish(false), 10000)

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src*="cast_sender.js"]'
    )

    if (existingScript) {
      existingScript.addEventListener("error", () => finish(false), {
        once: true,
      })
      return
    }

    const script = document.createElement("script")
    script.src =
      "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"
    script.async = true
    script.onerror = () => finish(false)
    document.head.appendChild(script)
  })

  return castFrameworkPromise
}

export function createGoogleCastLoadRequest(input: {
  url: string
  contentType: string
  autoplay: boolean
  currentTime: number
  textTrack?: {
    id: number
    language?: string
    label: string
    url: string
  }
}) {
  const apis = getCastApis()

  if (!apis) {
    return null
  }

  const mediaInfo = new apis.chromeCast.media.MediaInfo(
    input.url,
    input.contentType
  )
  mediaInfo.streamType =
    apis.chromeCast.media.StreamType?.BUFFERED ?? "BUFFERED"

  if (input.textTrack) {
    const trackType = apis.chromeCast.media.TrackType?.TEXT ?? "TEXT"
    const subtitleType =
      apis.chromeCast.media.TextTrackType?.SUBTITLES ?? "SUBTITLES"
    const textTrack: GoogleCastTextTrack = apis.chromeCast.media.Track
      ? new apis.chromeCast.media.Track(input.textTrack.id, trackType)
      : {
          name: input.textTrack.label,
          subtype: subtitleType,
          trackContentId: input.textTrack.url,
          trackContentType: "text/vtt",
          trackId: input.textTrack.id,
          type: trackType,
        }

    textTrack.language = input.textTrack.language
    textTrack.name = input.textTrack.label
    textTrack.subtype = subtitleType
    textTrack.trackContentId = input.textTrack.url
    textTrack.trackContentType = "text/vtt"
    mediaInfo.tracks = [textTrack]
  }

  const request = new apis.chromeCast.media.LoadRequest(mediaInfo)
  request.autoplay = input.autoplay
  request.currentTime = input.currentTime
  request.activeTrackIds = input.textTrack ? [input.textTrack.id] : []
  return request
}

function isMatchingMediaSession(
  mediaSession: GoogleCastMediaSession | null,
  contentId: string
) {
  return mediaSession?.media?.contentId === contentId
}

function isFailedMediaSession(mediaSession: GoogleCastMediaSession | null) {
  return (
    mediaSession?.playerState === "IDLE" && mediaSession.idleReason === "ERROR"
  )
}

function isLoadedMediaSession(mediaSession: GoogleCastMediaSession | null) {
  return (
    mediaSession?.playerState === "PLAYING" ||
    mediaSession?.playerState === "PAUSED" ||
    mediaSession?.playerState === "BUFFERING" ||
    mediaSession?.playerState === "IDLE"
  )
}

function getMediaSessionPosition(mediaSession: GoogleCastMediaSession) {
  const estimatedTime = mediaSession.getEstimatedTime?.()

  if (Number.isFinite(estimatedTime)) {
    return Math.max(estimatedTime ?? 0, 0)
  }

  return Math.max(mediaSession.currentTime ?? 0, 0)
}

export function getGoogleCastMediaState(
  session: GoogleCastSession,
  isAlive = true
): GoogleCastMediaState | null {
  const mediaSession = session.getMediaSession()

  if (!isAlive) {
    return {
      isAlive: false,
      positionSeconds: 0,
      playerState: "IDLE",
      idleReason: "CANCELLED",
    }
  }

  if (!mediaSession) {
    return null
  }

  return {
    contentId: mediaSession.media?.contentId,
    durationSeconds: mediaSession.media?.duration,
    idleReason: mediaSession.idleReason,
    isAlive: true,
    playerState: mediaSession.playerState,
    positionSeconds: getMediaSessionPosition(mediaSession),
  }
}

export function addGoogleCastMediaStateListener(
  session: GoogleCastSession,
  listener: (state: GoogleCastMediaState) => void
) {
  let mediaSession = session.getMediaSession()
  let updateListener: ((isAlive: boolean) => void) | null = null

  const emit = (isAlive = true) => {
    const state = getGoogleCastMediaState(session, isAlive)

    if (state) {
      listener(state)
    }
  }

  if (mediaSession) {
    updateListener = (isAlive) => emit(isAlive)
    mediaSession.addUpdateListener(updateListener)
    emit()
  }

  const mediaSessionEventType =
    getCastApis()?.framework.SessionEventType?.MEDIA_SESSION
  const mediaSessionListener = (event: GoogleCastMediaSessionEvent) => {
    if (mediaSession && updateListener) {
      mediaSession.removeUpdateListener(updateListener)
    }

    mediaSession = event.mediaSession ?? session.getMediaSession()

    if (!mediaSession) {
      emit(false)
      return
    }

    updateListener = (isAlive) => emit(isAlive)
    mediaSession.addUpdateListener(updateListener)
    emit(true)
  }

  if (mediaSessionEventType) {
    session.addEventListener(mediaSessionEventType, mediaSessionListener)
  }

  return () => {
    if (mediaSession && updateListener) {
      mediaSession.removeUpdateListener(updateListener)
    }

    if (mediaSessionEventType) {
      session.removeEventListener(mediaSessionEventType, mediaSessionListener)
    }
  }
}

function runGoogleCastMediaCommand(
  session: GoogleCastSession,
  command: (
    mediaSession: GoogleCastMediaSession,
    successCallback: () => void,
    errorCallback: (error: unknown) => void
  ) => void
) {
  const mediaSession = session.getMediaSession()

  if (!mediaSession) {
    return Promise.reject(new Error("Google Cast media session is missing"))
  }

  return new Promise<void>((resolve, reject) => {
    command(mediaSession, resolve, reject)
  })
}

export function playGoogleCastMedia(session: GoogleCastSession) {
  const apis = getCastApis()

  if (!apis) {
    return Promise.reject(new Error("Google Cast SDK is not available"))
  }

  const request = new apis.chromeCast.media.PlayRequest()
  return runGoogleCastMediaCommand(session, (mediaSession, resolve, reject) => {
    mediaSession.play(request, resolve, reject)
  })
}

export function pauseGoogleCastMedia(session: GoogleCastSession) {
  const apis = getCastApis()

  if (!apis) {
    return Promise.reject(new Error("Google Cast SDK is not available"))
  }

  const request = new apis.chromeCast.media.PauseRequest()
  return runGoogleCastMediaCommand(session, (mediaSession, resolve, reject) => {
    mediaSession.pause(request, resolve, reject)
  })
}

export function seekGoogleCastMedia(
  session: GoogleCastSession,
  seconds: number
) {
  const apis = getCastApis()

  if (!apis) {
    return Promise.reject(new Error("Google Cast SDK is not available"))
  }

  const request = new apis.chromeCast.media.SeekRequest()
  request.currentTime = Math.max(seconds, 0)

  return runGoogleCastMediaCommand(session, (mediaSession, resolve, reject) => {
    mediaSession.seek(request, resolve, reject)
  })
}

export function waitForGoogleCastMediaLoad(input: {
  session: GoogleCastSession
  contentId: string
  timeoutMs?: number | null
}) {
  const timeoutMs = input.timeoutMs === undefined ? 12_000 : input.timeoutMs

  return new Promise<GoogleCastMediaLoadResult>((resolve) => {
    let settled = false
    let mediaSession: GoogleCastMediaSession | null = null
    let updateListener: ((isAlive: boolean) => void) | null = null
    let mediaSessionListener:
      | ((event: GoogleCastMediaSessionEvent) => void)
      | null = null

    const finish = (result: GoogleCastMediaLoadResult) => {
      if (settled) {
        return
      }

      settled = true

      if (mediaSession && updateListener) {
        mediaSession.removeUpdateListener(updateListener)
      }

      const mediaSessionEventType =
        getCastApis()?.framework.SessionEventType?.MEDIA_SESSION
      if (mediaSessionEventType && mediaSessionListener) {
        input.session.removeEventListener(
          mediaSessionEventType,
          mediaSessionListener
        )
      }

      clearInterval(pollTimer)
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
      }
      resolve(result)
    }

    const inspect = (nextMediaSession?: GoogleCastMediaSession | null) => {
      mediaSession = nextMediaSession ?? input.session.getMediaSession()

      if (!mediaSession) {
        return
      }

      if (!isMatchingMediaSession(mediaSession, input.contentId)) {
        return
      }

      if (isFailedMediaSession(mediaSession)) {
        finish("failed")
        return
      }

      if (isLoadedMediaSession(mediaSession)) {
        finish("loaded")
      }
    }

    const attachMediaListener = () => {
      const nextMediaSession = input.session.getMediaSession()

      if (!nextMediaSession || nextMediaSession === mediaSession) {
        return
      }

      if (mediaSession && updateListener) {
        mediaSession.removeUpdateListener(updateListener)
      }

      mediaSession = nextMediaSession
      updateListener = () => inspect()
      mediaSession.addUpdateListener(updateListener)
      inspect()
    }

    const mediaSessionEventType =
      getCastApis()?.framework.SessionEventType?.MEDIA_SESSION
    if (mediaSessionEventType) {
      mediaSessionListener = (event) => inspect(event.mediaSession)
      input.session.addEventListener(
        mediaSessionEventType,
        mediaSessionListener
      )
    }

    const pollTimer = setInterval(attachMediaListener, 250)
    const timeoutTimer =
      timeoutMs === null ? null : setTimeout(() => finish("timeout"), timeoutMs)

    attachMediaListener()
  })
}

export function isGoogleCastEndingState(sessionState: string | undefined) {
  const framework = getCastApis()?.framework

  return (
    Boolean(sessionState) &&
    (sessionState === framework?.SessionState.SESSION_ENDING ||
      sessionState === framework?.SessionState.SESSION_ENDED ||
      sessionState === framework?.SessionState.SESSION_START_FAILED ||
      sessionState === framework?.SessionState.SESSION_RESUME_FAILED)
  )
}

export function isGoogleCastConnectedState(sessionState: string | undefined) {
  const framework = getCastApis()?.framework

  return (
    Boolean(sessionState) &&
    (sessionState === framework?.SessionState.SESSION_STARTED ||
      sessionState === framework?.SessionState.SESSION_RESUMED)
  )
}


export async function setGoogleCastReceiverVolumeOnce(
  session: GoogleCastSession,
  volume = 1
) {
  if (castVolumeInitializedSessions.has(session)) {
    return
  }

  if (typeof session.setVolume !== "function") {
    return
  }

  const normalizedVolume = Math.min(Math.max(volume, 0), 1)
  castVolumeInitializedSessions.add(session)

  try {
    await session.setVolume(normalizedVolume)
  } catch (error) {
    castVolumeInitializedSessions.delete(session)
    throw error
  }
}

export async function requestGoogleCastSession() {
  const context = getGoogleCastContext()

  if (!context) {
    throw new Error(getGoogleCastUnavailableReason())
  }

  const requestedSession = await context.requestSession()
  const session = requestedSession ?? context.getCurrentSession()

  if (!session) {
    throw new Error("Google Cast session was not created.")
  }

  return session
}

export function safeEndGoogleCastSession(
  session: GoogleCastSession | null | undefined,
  stopCasting = true
) {
  if (!session) {
    return
  }

  try {
    session.endSession(stopCasting)
  } catch {
    // The Cast SDK can throw while a session is already ending. Treat that as
    // best-effort cleanup so callers do not mask the original failure.
  }
}

export function addGoogleCastSessionStateListener(
  listener: (event: GoogleCastSessionEvent) => void
) {
  let cleanedUp = false
  let actualCleanup: (() => void) | null = null

  void ensureGoogleCastFramework().then((isAvailable) => {
    if (cleanedUp || !isAvailable) {
      return
    }

    const context = getGoogleCastContext()
    const eventType =
      getCastApis()?.framework.CastContextEventType.SESSION_STATE_CHANGED

    if (!context || !eventType) {
      return
    }

    context.addEventListener(eventType, listener)

    actualCleanup = () => {
      context.removeEventListener(eventType, listener)
    }
  })

  return () => {
    cleanedUp = true
    if (actualCleanup) {
      actualCleanup()
    }
  }
}
