import type { PlaybackMode, PlaybackProfile } from "@/lib/types"
import { getMaxUploadKbps } from "@/server/bandwidth/uploadCapacity"

export type StreamPriorityAction = {
  type:
    | "forceDataSaver"
    | "restoreOriginal"
    | "waitingForBandwidth"
    | "bandwidthRecheckStarted"
    | "bandwidthRecheckFinished"
    | "serverShutdownStarted"
  message: string
  createdAt: string
}

export type StreamUploadLease = {
  id: string
  effectiveMode: PlaybackMode
  effectiveProfile: PlaybackProfile
  downgraded: boolean
  observeUploadBytes: (bytes: number) => void
  setForceClose: (handler: () => void) => void
  release: () => void
}

type ActiveStream = {
  id: string
  clientKey: string | null
  clientId: string | null
  username: string
  isVip: boolean
  mode: PlaybackMode
  profile: PlaybackProfile
  estimatedUploadKbps: number
  dataSaverUploadKbps: number | null
  canTranscodeDataSaver: boolean
  startedAt: number
  observedUploadKbps: number | null
  uploadSamples: UploadSample[]
  forceClose: (() => void) | null
  animeId: string
  seasonNumber: number
  episodeNumber: number
  contentKey: string
}

type UploadSample = {
  bytes: number
  sampledAt: number
}

type ForcedDowngradeState = {
  clientKey: string
  username: string
  clientId: string
  contentKey: string
  originalMode: PlaybackMode
  originalProfile: PlaybackProfile
  originalUploadKbps: number
  dataSaverUploadKbps: number
  canTranscodeDataSaver: boolean
  restoreBlocked: boolean
  downgradedAt: number
}

type AcquireStreamUploadInput = {
  clientId: string | null
  username: string
  isVip: boolean
  mode: PlaybackMode
  profile: PlaybackProfile
  estimatedUploadKbps: number | null
  dataSaverUploadKbps: number | null
  canTranscodeDataSaver: boolean
  animeId: string
  seasonNumber: number
  episodeNumber: number
  signal?: AbortSignal
}

type TemporaryUploadLimitState = {
  active: boolean
  expiresAt: number | null
}

type StreamBandwidthStore = {
  temporaryUploadLimit: TemporaryUploadLimitState
}

const temporaryUploadLimitFactor = 0.7
const temporaryUploadLimitDurationMs = 3 * 60 * 60 * 1000
const streamBandwidthGlobal = globalThis as typeof globalThis & {
  __yamibunkoStreamBandwidthStore?: StreamBandwidthStore
}
const streamBandwidthStore = streamBandwidthGlobal.__yamibunkoStreamBandwidthStore ??= {
  temporaryUploadLimit: {
    active: false,
    expiresAt: null,
  },
}

const admissionOverageFactor = 1.08
const restoreOverageFactor = 1.02
const capacityWaitMs = 1000
const uploadObservationWindowMs = 12_000
const staleObservationMs = 18_000
const streamEstimateOverheadFactor = 1.06
const bandwidthRecheckClientPauseGraceMs = 1_500
const bandwidthRecheckStreamDrainTimeoutMs = 5_000
const bandwidthRecheckStreamDrainPollMs = 100
const serverShutdownClientPauseGraceMs = 750
const serverShutdownStreamDrainTimeoutMs = 5_000
const activeStreams = new Map<string, ActiveStream>()
const forcedDowngrades = new Map<string, ForcedDowngradeState>()
const clientActions = new Map<string, StreamPriorityAction>()
const clientActionSubscribers = new Map<
  string,
  Set<(action: StreamPriorityAction) => void>
>()
const capacityWaiters = new Set<() => void>()
const bandwidthRecheckWaiters = new Set<() => void>()
const bandwidthRecheckClients = new Set<string>()
let bandwidthRecheckActive = false
let streamServerShutdownActive = false
let streamServerShutdownAction: StreamPriorityAction | null = null

function nowIso() {
  return new Date().toISOString()
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

function getBaseMaxUploadKbps() {
  return getMaxUploadKbps()
}

function getTemporaryUploadLimitState(now = Date.now()) {
  const state = streamBandwidthStore.temporaryUploadLimit

  if (state.active && state.expiresAt !== null && state.expiresAt <= now) {
    state.active = false
    state.expiresAt = null
  }

  return state
}

function getEffectiveMaxUploadKbps() {
  const baseMaxUploadKbps = getBaseMaxUploadKbps()

  if (!baseMaxUploadKbps) {
    return null
  }

  return getTemporaryUploadLimitState().active
    ? Math.max(Math.floor(baseMaxUploadKbps * temporaryUploadLimitFactor), 1)
    : baseMaxUploadKbps
}

function getClientActionKey(username: string, clientId: string) {
  return `${username}:${clientId}`
}

function getClientKey(username: string, clientId: string | null) {
  return clientId ? getClientActionKey(username, clientId) : null
}

function getContentKey(input: {
  animeId: string
  seasonNumber: number
  episodeNumber: number
}) {
  return `${input.animeId}:${input.seasonNumber}:${input.episodeNumber}`
}

export type ActiveStreamConflict = {
  username: string
  clientId: string | null
  animeId: string
  seasonNumber: number
  episodeNumber: number
  startedAt: string
}

function toActiveStreamConflict(stream: ActiveStream): ActiveStreamConflict {
  return {
    username: stream.username,
    clientId: stream.clientId,
    animeId: stream.animeId,
    seasonNumber: stream.seasonNumber,
    episodeNumber: stream.episodeNumber,
    startedAt: new Date(stream.startedAt).toISOString(),
  }
}

function pruneUploadSamples(stream: ActiveStream, now = Date.now()) {
  stream.uploadSamples = stream.uploadSamples.filter(
    (sample) => now - sample.sampledAt <= uploadObservationWindowMs
  )
}

function getObservedUploadKbps(stream: ActiveStream, now = Date.now()) {
  pruneUploadSamples(stream, now)

  if (stream.uploadSamples.length < 2) {
    return stream.observedUploadKbps
  }

  const firstSample = stream.uploadSamples[0]
  const elapsedSeconds = (now - firstSample.sampledAt) / 1000

  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    return stream.observedUploadKbps
  }

  const bytes = stream.uploadSamples.reduce((total, sample) => total + sample.bytes, 0)
  const observedUploadKbps = Math.floor((bytes * 8) / elapsedSeconds / 1000)

  stream.observedUploadKbps = Number.isFinite(observedUploadKbps) && observedUploadKbps > 0
    ? observedUploadKbps
    : stream.observedUploadKbps

  return stream.observedUploadKbps
}

function getAccountingUploadKbps(stream: ActiveStream, now = Date.now()) {
  const observedUploadKbps = getObservedUploadKbps(stream, now)
  const lastSampledAt = stream.uploadSamples.at(-1)?.sampledAt ?? 0

  if (!observedUploadKbps || now - lastSampledAt > staleObservationMs) {
    return stream.estimatedUploadKbps
  }

  return Math.max(stream.estimatedUploadKbps, observedUploadKbps)
}

function getUsedUploadKbps(
  options: { excludeClientKey?: string | null; measured?: boolean } = {}
) {
  let used = 0
  const now = Date.now()

  for (const stream of activeStreams.values()) {
    if (options.excludeClientKey && stream.clientKey === options.excludeClientKey) {
      continue
    }

    used += options.measured
      ? getAccountingUploadKbps(stream, now)
      : stream.estimatedUploadKbps
  }

  return used
}

function canFitUpload(
  requiredKbps: number,
  options: {
    excludeClientKey?: string | null
    overageFactor?: number
    measured?: boolean
  } = {}
) {
  const maxUploadKbps = getEffectiveMaxUploadKbps()

  if (!maxUploadKbps) {
    return true
  }

  const overageFactor = options.overageFactor ?? admissionOverageFactor
  const allowedUploadKbps = Math.floor(maxUploadKbps * overageFactor)

  return (
    getUsedUploadKbps({
      excludeClientKey: options.excludeClientKey,
      measured: options.measured ?? false,
    }) + requiredKbps <=
    allowedUploadKbps
  )
}

function notifyCapacityWaiters() {
  for (const waiter of capacityWaiters) {
    waiter()
  }

  capacityWaiters.clear()
}

function waitForCapacity(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(finish, capacityWaitMs)

    timer.unref?.()

    function finish() {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      capacityWaiters.delete(finish)
      signal?.removeEventListener("abort", abort)
      resolve()
    }

    function abort() {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      capacityWaiters.delete(finish)
      signal?.removeEventListener("abort", abort)
      reject(new Error("Stream upload reservation was cancelled"))
    }

    if (signal?.aborted) {
      abort()
      return
    }

    capacityWaiters.add(finish)
    signal?.addEventListener("abort", abort, { once: true })
  })
}

function clearClientAction(username: string, clientId: string | null) {
  if (!clientId) {
    return
  }

  clientActions.delete(getClientActionKey(username, clientId))
}

function publishClientAction(key: string, action: StreamPriorityAction) {
  const subscribers = clientActionSubscribers.get(key)

  if (!subscribers?.size) {
    return false
  }

  for (const subscriber of subscribers) {
    subscriber(action)
  }

  return true
}

function setClientActionByKey(key: string, action: StreamPriorityAction) {
  clientActions.set(key, action)

  if (publishClientAction(key, action)) {
    clientActions.delete(key)
  }
}

function getBandwidthRecheckStartedMessage() {
  return "Server upload bandwidth is being rechecked. Playback is paused until the test completes."
}

function getBandwidthRecheckFinishedMessage() {
  return "Server upload bandwidth recheck finished. Playback can continue."
}

function getBandwidthRecheckFailedMessage() {
  return "Server upload bandwidth recheck finished, but the new measurement failed. Playback can continue with the previous bandwidth state."
}

function createBandwidthRecheckStartedAction(): StreamPriorityAction {
  return {
    type: "bandwidthRecheckStarted",
    message: getBandwidthRecheckStartedMessage(),
    createdAt: nowIso(),
  }
}

function createBandwidthRecheckFinishedAction(failed: boolean): StreamPriorityAction {
  return {
    type: "bandwidthRecheckFinished",
    message: failed
      ? getBandwidthRecheckFailedMessage()
      : getBandwidthRecheckFinishedMessage(),
    createdAt: nowIso(),
  }
}

function getServerShutdownMessage() {
  return "Server is shutting down. Playback was stopped and new streams are disabled until the server starts again."
}

function createServerShutdownStartedAction(): StreamPriorityAction {
  return {
    type: "serverShutdownStarted",
    message: getServerShutdownMessage(),
    createdAt: nowIso(),
  }
}

function getKnownClientKeys() {
  return new Set([
    ...[...activeStreams.values()]
      .map((stream) => stream.clientKey)
      .filter((clientKey): clientKey is string => Boolean(clientKey)),
    ...clientActionSubscribers.keys(),
  ])
}

function publishServerShutdownAction() {
  const action = streamServerShutdownAction ?? createServerShutdownStartedAction()
  streamServerShutdownAction = action

  for (const clientKey of getKnownClientKeys()) {
    setClientActionByKey(clientKey, action)
  }
}

function closeAllActiveStreams() {
  for (const stream of [...activeStreams.values()]) {
    closeActiveStream(stream)
  }

  notifyCapacityWaiters()
}

async function waitForServerShutdownStreamsToDrain() {
  const deadline = Date.now() + serverShutdownStreamDrainTimeoutMs

  while (activeStreams.size > 0 && Date.now() < deadline) {
    await sleep(bandwidthRecheckStreamDrainPollMs)
  }

  if (activeStreams.size > 0) {
    console.warn(
      `[Warn] [Stream] Continuing server shutdown while ${activeStreams.size} client stream(s) are still closing.`
    )
  }
}

export function isStreamServerShutdownActive() {
  return streamServerShutdownActive
}

export async function beginStreamServerShutdown() {
  if (streamServerShutdownActive) {
    publishServerShutdownAction()
    closeAllActiveStreams()
    await waitForServerShutdownStreamsToDrain()
    return
  }

  streamServerShutdownActive = true
  streamServerShutdownAction = createServerShutdownStartedAction()
  const activeStreamCount = activeStreams.size

  if (activeStreamCount > 0) {
    console.log(
      `[Info] [Stream] Stopping ${activeStreamCount} active client stream(s) for server shutdown.`
    )
  }

  publishServerShutdownAction()
  notifyCapacityWaiters()
  notifyBandwidthRecheckWaiters()

  if (activeStreamCount > 0) {
    await sleep(serverShutdownClientPauseGraceMs)
  }

  closeAllActiveStreams()
  await waitForServerShutdownStreamsToDrain()
}


function markBandwidthRecheckClient(clientKey: string | null) {
  if (clientKey) {
    bandwidthRecheckClients.add(clientKey)
  }
}

function notifyBandwidthRecheckWaiters() {
  for (const waiter of bandwidthRecheckWaiters) {
    waiter()
  }

  bandwidthRecheckWaiters.clear()
}

function waitForBandwidthRecheck(signal?: AbortSignal) {
  if (!bandwidthRecheckActive) {
    return Promise.resolve()
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false

    function finish() {
      if (settled) {
        return
      }

      settled = true
      bandwidthRecheckWaiters.delete(finish)
      signal?.removeEventListener("abort", abort)
      resolve()
    }

    function abort() {
      if (settled) {
        return
      }

      settled = true
      bandwidthRecheckWaiters.delete(finish)
      signal?.removeEventListener("abort", abort)
      reject(new Error("Stream upload reservation was cancelled"))
    }

    if (signal?.aborted) {
      abort()
      return
    }

    bandwidthRecheckWaiters.add(finish)
    signal?.addEventListener("abort", abort, { once: true })
  })
}

function setClientAction(
  username: string,
  clientId: string | null,
  action: StreamPriorityAction
) {
  if (!clientId) {
    return
  }

  setClientActionByKey(getClientActionKey(username, clientId), action)
}

function getDataSaverMessage() {
  return "You were changed to Data Saver automatically because the server ran out of bandwidth. Talk to the admin if you want VIP priority to see this less often."
}

function getRestoreMessage() {
  return "Enough server upload bandwidth is available again. Playback was restored to your previous quality."
}

function getBandwidthWaitMessage() {
  return "Server upload bandwidth is full. Waiting for a free slot."
}

function rememberForcedDowngrade(input: {
  username: string
  clientId: string | null
  contentKey: string
  originalMode: PlaybackMode
  originalProfile: PlaybackProfile
  originalUploadKbps: number
  dataSaverUploadKbps: number | null
  canTranscodeDataSaver: boolean
}) {
  if (
    !input.clientId ||
    input.originalProfile === "dataSaver" ||
    !input.dataSaverUploadKbps ||
    input.dataSaverUploadKbps >= input.originalUploadKbps
  ) {
    return
  }

  const clientKey = getClientActionKey(input.username, input.clientId)
  const previousState = forcedDowngrades.get(clientKey)

  forcedDowngrades.set(clientKey, {
    clientKey,
    username: input.username,
    clientId: input.clientId,
    contentKey: input.contentKey,
    originalMode:
      previousState?.contentKey === input.contentKey
        ? previousState.originalMode
        : input.originalMode,
    originalProfile:
      previousState?.contentKey === input.contentKey
        ? previousState.originalProfile
        : input.originalProfile,
    originalUploadKbps:
      previousState?.contentKey === input.contentKey
        ? Math.max(previousState.originalUploadKbps, input.originalUploadKbps)
        : input.originalUploadKbps,
    dataSaverUploadKbps: input.dataSaverUploadKbps,
    canTranscodeDataSaver: input.canTranscodeDataSaver,
    restoreBlocked:
      previousState?.contentKey === input.contentKey
        ? previousState.restoreBlocked
        : false,
    downgradedAt: Date.now(),
  })
}

function clearForcedDowngrade(username: string, clientId: string | null) {
  const clientKey = getClientKey(username, clientId)

  if (!clientKey) {
    return
  }

  forcedDowngrades.delete(clientKey)
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)

    timer.unref?.()
  })
}

export function getActiveStreamConflict(input: {
  username: string
  clientId?: string | null
}): ActiveStreamConflict | null {
  const currentClientKey = getClientKey(input.username, input.clientId ?? null)

  for (const stream of activeStreams.values()) {
    if (stream.username !== input.username) {
      continue
    }

    if (currentClientKey && stream.clientKey === currentClientKey) {
      continue
    }

    return toActiveStreamConflict(stream)
  }

  return null
}

function closeActiveStream(stream: ActiveStream) {
  try {
    stream.forceClose?.()
  } finally {
    activeStreams.delete(stream.id)
  }
}

function closeActiveStreamsForClientKey(
  clientKey: string | null,
  options: { exceptContentKey?: string } = {}
) {
  if (!clientKey) {
    return
  }

  for (const stream of [...activeStreams.values()]) {
    if (stream.clientKey !== clientKey) {
      continue
    }

    if (
      options.exceptContentKey &&
      stream.contentKey === options.exceptContentKey
    ) {
      continue
    }

    closeActiveStream(stream)
  }
}

export function closeActiveStreamsForUser(username: string) {
  for (const stream of [...activeStreams.values()]) {
    if (stream.username === username) {
      closeActiveStream(stream)
    }
  }

  for (const [clientKey, state] of forcedDowngrades) {
    if (state.username === username) {
      forcedDowngrades.delete(clientKey)
    }
  }

  for (const key of [...clientActions.keys()]) {
    if (key.startsWith(`${username}:`)) {
      clientActions.delete(key)
    }
  }

  notifyCapacityWaiters()
}

async function waitForActiveStreamsToDrain() {
  const deadline = Date.now() + bandwidthRecheckStreamDrainTimeoutMs

  while (activeStreams.size > 0 && Date.now() < deadline) {
    await sleep(bandwidthRecheckStreamDrainPollMs)
  }

  if (activeStreams.size > 0) {
    console.warn(
      `[Warn] [Bandwidth] Continuing scheduled upload capacity recheck while ${activeStreams.size} stream(s) are still closing.`
    )
  }
}

export async function runUploadCapacityRecheckWithStreamHold(
  measure: () => Promise<void>
) {
  if (bandwidthRecheckActive) {
    await waitForBandwidthRecheck()
    return
  }

  bandwidthRecheckActive = true
  const startedAction = createBandwidthRecheckStartedAction()
  const activeClientKeys = new Set(
    [...activeStreams.values()]
      .map((stream) => stream.clientKey)
      .filter((clientKey): clientKey is string => Boolean(clientKey))
  )
  const hadActiveStreams = activeStreams.size > 0

  if (hadActiveStreams) {
    console.log(
      `[Info] [Bandwidth] Pausing ${activeStreams.size} active stream(s) before scheduled upload capacity recheck.`
    )
  }

  for (const clientKey of activeClientKeys) {
    markBandwidthRecheckClient(clientKey)
    setClientActionByKey(clientKey, startedAction)
  }

  if (hadActiveStreams) {
    await sleep(bandwidthRecheckClientPauseGraceMs)
  }

  for (const stream of [...activeStreams.values()]) {
    stream.forceClose?.()
  }

  if (hadActiveStreams) {
    await waitForActiveStreamsToDrain()
  }

  let failed = false

  try {
    await measure()
  } catch (error) {
    failed = true
    throw error
  } finally {
    const finishedAction = createBandwidthRecheckFinishedAction(failed)

    bandwidthRecheckActive = false

    for (const clientKey of bandwidthRecheckClients) {
      setClientActionByKey(clientKey, finishedAction)
    }

    bandwidthRecheckClients.clear()
    notifyBandwidthRecheckWaiters()
    notifyCapacityWaiters()
    evaluateForcedDowngradeRestores()
  }
}

export function protectCurrentForcedDowngrade(
  username: string,
  clientId: string
) {
  const clientKey = getClientActionKey(username, clientId)
  const state = forcedDowngrades.get(clientKey)

  if (!state) {
    return
  }

  state.restoreBlocked = true

  const activeStream = getActiveStreamForClient(clientKey)

  if (activeStream) {
    activeStream.mode = "transcode"
    activeStream.profile = "dataSaver"
    activeStream.estimatedUploadKbps = state.dataSaverUploadKbps
    activeStream.dataSaverUploadKbps = state.dataSaverUploadKbps
    activeStream.canTranscodeDataSaver = state.canTranscodeDataSaver
  }

  const action = clientActions.get(clientKey)
  if (action?.type === "restoreOriginal") {
    clientActions.delete(clientKey)
  }
}

function getActiveStreamForClient(clientKey: string) {
  return [...activeStreams.values()].find((stream) => stream.clientKey === clientKey)
}

function evaluateForcedDowngradeRestores() {
  if (bandwidthRecheckActive) {
    return
  }

  const maxUploadKbps = getEffectiveMaxUploadKbps()

  if (!maxUploadKbps) {
    return
  }

  for (const [clientKey, state] of forcedDowngrades) {
    if (state.restoreBlocked) {
      continue
    }

    const activeStream = getActiveStreamForClient(clientKey)

    if (!activeStream) {
      if (Date.now() - state.downgradedAt > 60_000) {
        forcedDowngrades.delete(clientKey)
      }

      continue
    }

    if (activeStream.contentKey !== state.contentKey) {
      forcedDowngrades.delete(clientKey)
      continue
    }

    if (activeStream.profile !== "dataSaver") {
      forcedDowngrades.delete(clientKey)
      continue
    }

    if (
      !canFitUpload(state.originalUploadKbps, {
        excludeClientKey: clientKey,
        overageFactor: restoreOverageFactor,
      })
    ) {
      continue
    }

    activeStream.mode = state.originalMode
    activeStream.profile = state.originalProfile
    activeStream.estimatedUploadKbps = state.originalUploadKbps
    activeStream.dataSaverUploadKbps = state.dataSaverUploadKbps
    activeStream.canTranscodeDataSaver = state.canTranscodeDataSaver

    setClientAction(state.username, state.clientId, {
      type: "restoreOriginal",
      message: getRestoreMessage(),
      createdAt: nowIso(),
    })
  }
}

function downgradeBlockingStreams(
  requiredKbps: number,
  requesterClientId: string | null
) {
  if (bandwidthRecheckActive) {
    return
  }

  const maxUploadKbps = getEffectiveMaxUploadKbps()

  if (!maxUploadKbps) {
    return
  }

  const candidates = [...activeStreams.values()]
    .filter(
      (stream) =>
        !stream.isVip &&
        stream.clientId !== requesterClientId &&
        stream.profile !== "dataSaver" &&
        stream.canTranscodeDataSaver &&
        stream.dataSaverUploadKbps !== null &&
        stream.dataSaverUploadKbps < stream.estimatedUploadKbps
    )
    .sort((left, right) => left.startedAt - right.startedAt)

  let projectedUsage = getUsedUploadKbps()
  const allowedUploadKbps = Math.floor(maxUploadKbps * admissionOverageFactor)

  for (const stream of candidates) {
    if (projectedUsage + requiredKbps <= allowedUploadKbps) {
      return
    }

    const dataSaverUploadKbps = stream.dataSaverUploadKbps

    if (dataSaverUploadKbps === null) {
      continue
    }

    rememberForcedDowngrade({
      username: stream.username,
      clientId: stream.clientId,
      contentKey: stream.contentKey,
      originalMode: stream.mode,
      originalProfile: stream.profile,
      originalUploadKbps: stream.estimatedUploadKbps,
      dataSaverUploadKbps,
      canTranscodeDataSaver: stream.canTranscodeDataSaver,
    })

    projectedUsage -= stream.estimatedUploadKbps - dataSaverUploadKbps
    stream.estimatedUploadKbps = dataSaverUploadKbps
    stream.mode = "transcode"
    stream.profile = "dataSaver"
    stream.uploadSamples = []
    stream.observedUploadKbps = null
    setClientAction(stream.username, stream.clientId, {
      type: "forceDataSaver",
      message: getDataSaverMessage(),
      createdAt: nowIso(),
    })
    stream.forceClose?.()
  }
}

function createLease(input: {
  clientId: string | null
  username: string
  isVip: boolean
  mode: PlaybackMode
  profile: PlaybackProfile
  estimatedUploadKbps: number
  dataSaverUploadKbps: number | null
  canTranscodeDataSaver: boolean
  animeId: string
  seasonNumber: number
  episodeNumber: number
  downgraded: boolean
}): StreamUploadLease {
  const id = createId()
  const clientKey = getClientKey(input.username, input.clientId)
  const contentKey = getContentKey(input)
  let released = false

  closeActiveStreamsForClientKey(clientKey, { exceptContentKey: contentKey })

  if (!input.downgraded) {
    clearClientAction(input.username, input.clientId)
  }

  if (input.profile !== "dataSaver") {
    clearForcedDowngrade(input.username, input.clientId)
  }

  activeStreams.set(id, {
    id,
    clientKey,
    clientId: input.clientId,
    username: input.username,
    isVip: input.isVip,
    mode: input.mode,
    profile: input.profile,
    estimatedUploadKbps: input.estimatedUploadKbps,
    dataSaverUploadKbps: input.dataSaverUploadKbps,
    canTranscodeDataSaver: input.canTranscodeDataSaver,
    startedAt: Date.now(),
    animeId: input.animeId,
    seasonNumber: input.seasonNumber,
    episodeNumber: input.episodeNumber,
    contentKey,
    observedUploadKbps: null,
    uploadSamples: [],
    forceClose: null,
  })

  return {
    id,
    effectiveMode: input.mode,
    effectiveProfile: input.profile,
    downgraded: input.downgraded,
    observeUploadBytes(bytes: number) {
      if (released || !Number.isFinite(bytes) || bytes <= 0) {
        return
      }

      const stream = activeStreams.get(id)

      if (!stream) {
        return
      }

      const sampledAt = Date.now()
      stream.uploadSamples.push({ bytes, sampledAt })
      getObservedUploadKbps(stream, sampledAt)
    },
    setForceClose(handler: () => void) {
      if (released) {
        return
      }

      const stream = activeStreams.get(id)

      if (!stream) {
        queueMicrotask(handler)
        return
      }

      stream.forceClose = handler

      if (streamServerShutdownActive) {
        queueMicrotask(handler)
      }
    },
    release() {
      if (released) {
        return
      }

      released = true
      activeStreams.delete(id)
      evaluateForcedDowngradeRestores()
      notifyCapacityWaiters()
    },
  }
}

function applyStreamEstimateOverhead(kbps: number) {
  return Math.max(Math.ceil(kbps * streamEstimateOverheadFactor), 1)
}

function estimateDataSaverUploadKbps(sourceBitrateKbps: number) {
  return applyStreamEstimateOverhead(
    Math.max(Math.floor(sourceBitrateKbps / 2), 628)
  )
}

function estimateOriginalUploadKbps(input: {
  mode?: PlaybackMode
  sourceBitrateKbps: number
}) {
  if (input.mode === "transcode") {
    const videoKbps = Math.min(Math.max(input.sourceBitrateKbps, 1500), 50_000)
    return applyStreamEstimateOverhead(videoKbps + 192)
  }

  return applyStreamEstimateOverhead(input.sourceBitrateKbps)
}

export function estimateUploadKbps(input: {
  sourceBitrateKbps?: number
  profile: PlaybackProfile
  mode?: PlaybackMode
}) {
  const sourceBitrateKbps = Math.max(input.sourceBitrateKbps ?? 6000, 1)

  if (input.profile === "dataSaver") {
    return estimateDataSaverUploadKbps(sourceBitrateKbps)
  }

  return estimateOriginalUploadKbps({
    mode: input.mode,
    sourceBitrateKbps,
  })
}

export async function acquireStreamUpload(input: AcquireStreamUploadInput) {
  const clientKey = getClientKey(input.username, input.clientId)

  if (streamServerShutdownActive) {
    if (clientKey) {
      setClientActionByKey(
        clientKey,
        streamServerShutdownAction ?? createServerShutdownStartedAction()
      )
    }

    throw new Error("Server is shutting down. New streams are disabled")
  }

  while (bandwidthRecheckActive) {
    markBandwidthRecheckClient(clientKey)

    if (clientKey) {
      setClientActionByKey(clientKey, createBandwidthRecheckStartedAction())
    }

    await waitForBandwidthRecheck(input.signal)

    if (streamServerShutdownActive) {
      if (clientKey) {
        setClientActionByKey(
          clientKey,
          streamServerShutdownAction ?? createServerShutdownStartedAction()
        )
      }

      throw new Error("Server is shutting down. New streams are disabled")
    }
  }

  const contentKey = getContentKey(input)
  const forcedDowngrade = clientKey ? forcedDowngrades.get(clientKey) : null

  if (forcedDowngrade && forcedDowngrade.contentKey !== contentKey) {
    forcedDowngrades.delete(forcedDowngrade.clientKey)
  }

  const matchingForcedDowngrade =
    forcedDowngrade?.contentKey === contentKey ? forcedDowngrade : null

  if (
    matchingForcedDowngrade &&
    input.profile !== "dataSaver" &&
    matchingForcedDowngrade.canTranscodeDataSaver &&
    (matchingForcedDowngrade.restoreBlocked ||
      !canFitUpload(matchingForcedDowngrade.originalUploadKbps, {
        excludeClientKey: clientKey,
        overageFactor: restoreOverageFactor,
      }))
  ) {
    setClientAction(input.username, input.clientId, {
      type: "forceDataSaver",
      message: matchingForcedDowngrade.restoreBlocked
        ? "Data Saver protection is active for the rest of this episode because your stream was downgraded twice within 5 minutes."
        : getDataSaverMessage(),
      createdAt: nowIso(),
    })

    return acquireStreamUpload({
      ...input,
      mode: "transcode",
      profile: "dataSaver",
      estimatedUploadKbps: matchingForcedDowngrade.dataSaverUploadKbps,
      dataSaverUploadKbps: matchingForcedDowngrade.dataSaverUploadKbps,
    })
  }

  const fitOptions = {
    excludeClientKey: clientKey,
  }

  if (!input.estimatedUploadKbps || input.estimatedUploadKbps <= 0) {
    return createLease({
      clientId: input.clientId,
      username: input.username,
      isVip: input.isVip,
      mode: input.mode,
      profile: input.profile,
      estimatedUploadKbps: 0,
      dataSaverUploadKbps: input.dataSaverUploadKbps,
      canTranscodeDataSaver: input.canTranscodeDataSaver,
      animeId: input.animeId,
      seasonNumber: input.seasonNumber,
      episodeNumber: input.episodeNumber,
      downgraded: false,
    })
  }

  for (;;) {
    if (streamServerShutdownActive) {
      if (clientKey) {
        setClientActionByKey(
          clientKey,
          streamServerShutdownAction ?? createServerShutdownStartedAction()
        )
      }

      throw new Error("Server is shutting down. New streams are disabled")
    }

    if (input.signal?.aborted) {
      throw new Error("Stream upload reservation was cancelled")
    }

    evaluateForcedDowngradeRestores()

    if (canFitUpload(input.estimatedUploadKbps, fitOptions)) {
      return createLease({
        clientId: input.clientId,
        username: input.username,
        isVip: input.isVip,
        mode: input.mode,
        profile: input.profile,
        estimatedUploadKbps: input.estimatedUploadKbps,
        dataSaverUploadKbps: input.dataSaverUploadKbps,
        canTranscodeDataSaver: input.canTranscodeDataSaver,
        animeId: input.animeId,
        seasonNumber: input.seasonNumber,
        episodeNumber: input.episodeNumber,
        downgraded: false,
      })
    }

    if (input.isVip) {
      downgradeBlockingStreams(input.estimatedUploadKbps, input.clientId)

      if (canFitUpload(input.estimatedUploadKbps, fitOptions)) {
        return createLease({
          clientId: input.clientId,
          username: input.username,
          isVip: input.isVip,
          mode: input.mode,
          profile: input.profile,
          estimatedUploadKbps: input.estimatedUploadKbps,
          dataSaverUploadKbps: input.dataSaverUploadKbps,
          canTranscodeDataSaver: input.canTranscodeDataSaver,
          animeId: input.animeId,
          seasonNumber: input.seasonNumber,
          episodeNumber: input.episodeNumber,
          downgraded: false,
        })
      }
    }

    if (
      input.profile !== "dataSaver" &&
      input.canTranscodeDataSaver &&
      input.dataSaverUploadKbps &&
      canFitUpload(input.dataSaverUploadKbps, fitOptions)
    ) {
      rememberForcedDowngrade({
        username: input.username,
        clientId: input.clientId,
        contentKey: getContentKey(input),
        originalMode: input.mode,
        originalProfile: input.profile,
        originalUploadKbps: input.estimatedUploadKbps,
        dataSaverUploadKbps: input.dataSaverUploadKbps,
        canTranscodeDataSaver: input.canTranscodeDataSaver,
      })

      setClientAction(input.username, input.clientId, {
        type: "forceDataSaver",
        message: getDataSaverMessage(),
        createdAt: nowIso(),
      })

      return createLease({
        clientId: input.clientId,
        username: input.username,
        isVip: input.isVip,
        mode: "transcode",
        profile: "dataSaver",
        estimatedUploadKbps: input.dataSaverUploadKbps,
        dataSaverUploadKbps: input.dataSaverUploadKbps,
        canTranscodeDataSaver: input.canTranscodeDataSaver,
        animeId: input.animeId,
        seasonNumber: input.seasonNumber,
        episodeNumber: input.episodeNumber,
        downgraded: true,
      })
    }

    setClientAction(input.username, input.clientId, {
      type: "waitingForBandwidth",
      message: getBandwidthWaitMessage(),
      createdAt: nowIso(),
    })

    try {
      await waitForCapacity(input.signal)
    } catch (error) {
      clearClientAction(input.username, input.clientId)
      throw error
    }
  }
}

export function subscribeStreamPriorityActions(input: {
  username: string
  clientId: string
  onAction: (action: StreamPriorityAction) => void
}) {
  const key = getClientActionKey(input.username, input.clientId)
  const subscribers = clientActionSubscribers.get(key) ?? new Set()

  subscribers.add(input.onAction)
  clientActionSubscribers.set(key, subscribers)
  evaluateForcedDowngradeRestores()

  if (streamServerShutdownActive) {
    input.onAction(streamServerShutdownAction ?? createServerShutdownStartedAction())
  }

  const pendingAction = clientActions.get(key)
  if (pendingAction) {
    input.onAction(pendingAction)
    clientActions.delete(key)
  }

  return () => {
    const currentSubscribers = clientActionSubscribers.get(key)

    if (!currentSubscribers) {
      return
    }

    currentSubscribers.delete(input.onAction)

    if (!currentSubscribers.size) {
      clientActionSubscribers.delete(key)
    }
  }
}

export function setTemporaryUploadLimit(active: boolean) {
  const state = streamBandwidthStore.temporaryUploadLimit

  if (active) {
    state.active = true
    state.expiresAt = Date.now() + temporaryUploadLimitDurationMs
  } else {
    state.active = false
    state.expiresAt = null
  }

  notifyCapacityWaiters()
  evaluateForcedDowngradeRestores()

  return getActiveStreamBandwidthSnapshot()
}

export function toggleTemporaryUploadLimit() {
  return setTemporaryUploadLimit(!getTemporaryUploadLimitState().active)
}

export function getActiveStreamBandwidthSnapshot() {
  const baseMaxUploadKbps = getBaseMaxUploadKbps()
  const maxUploadKbps = getEffectiveMaxUploadKbps()
  const usedUploadKbps = getUsedUploadKbps({ measured: true })
  const reservedUploadKbps = getUsedUploadKbps()
  const temporaryUploadLimit = getTemporaryUploadLimitState()

  return {
    baseMaxUploadKbps,
    maxUploadKbps,
    usedUploadKbps,
    reservedUploadKbps,
    availableUploadKbps: maxUploadKbps
      ? Math.max(maxUploadKbps - usedUploadKbps, 0)
      : null,
    activeStreams: activeStreams.size,
    temporaryUploadLimit: {
      active: temporaryUploadLimit.active,
      expiresAt: temporaryUploadLimit.expiresAt
        ? new Date(temporaryUploadLimit.expiresAt).toISOString()
        : null,
      factor: temporaryUploadLimitFactor,
    },
  }
}
