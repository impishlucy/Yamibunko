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
  loadMedia(request: GoogleCastLoadRequest): Promise<unknown>
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
let castFrameworkPromise: Promise<boolean> | null = null
let castFrameworkInitialized = false

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

function isSecureCastSenderOrigin() {
  if (typeof window === "undefined") {
    return false
  }

  if (window.isSecureContext) {
    return true
  }

  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    window.location.hostname
  )
}

function initializeCastFramework() {
  if (castFrameworkInitialized) {
    return true
  }

  if (!isSecureCastSenderOrigin()) {
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
  if (typeof window === "undefined") {
    return "Google Cast is only available in a browser."
  }

  if (!isSecureCastSenderOrigin()) {
    return "Google Cast requires HTTPS, or localhost during development. Use https://192.168.1.101 or open the app on localhost."
  }

  return "Google Cast is not available in this browser."
}

export async function ensureGoogleCastFramework() {
  if (typeof window === "undefined") {
    return false
  }

  if (!isSecureCastSenderOrigin()) {
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

    if (win.cast?.framework) {
      resolve(initializeCastFramework())
      return
    }

    const existingCallback = win.__onGCastApiAvailable
    const finish = (available: boolean) => {
      if (available) {
        resolve(initializeCastFramework())
        return
      }

      resolve(false)
    }

    win.__onGCastApiAvailable = (isAvailable: boolean) => {
      if (isAvailable) {
        initializeCastFramework()
      }
      existingCallback?.(isAvailable)
      finish(isAvailable)
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src*="cast_sender.js"]'
    )

    if (existingScript) {
      existingScript.addEventListener("error", () => resolve(false), {
        once: true,
      })
      return
    }

    const script = document.createElement("script")
    script.src =
      "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"
    script.async = true
    script.onerror = () => resolve(false)
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
    mediaInfo.tracks = [
      {
        language: input.textTrack.language,
        name: input.textTrack.label,
        subtype: "SUBTITLES",
        trackContentId: input.textTrack.url,
        trackContentType: "text/vtt",
        trackId: input.textTrack.id,
        type: "TEXT",
      },
    ]
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
