import type { PlaybackMode, PlaybackProfile } from "@/lib/types"
import { getMaxUploadKbps } from "@/server/bandwidth/uploadCapacity"

export type StreamPriorityAction = {
  type:
    | "waitingForBandwidth"
    | "bandwidthRecheckStarted"
    | "bandwidthRecheckFinished"
    | "serverShutdownStarted"
    | "liveTranscodeBitrateChanged"
    | "liveTranscodeFailed"
  message: string
  createdAt: string
  currentVideoBitrateKbps?: number
  nextVideoBitrateKbps?: number
}

export type StreamUploadLease = {
  id: string
  effectiveMode: PlaybackMode
  effectiveProfile: PlaybackProfile
  isMetered: boolean
  observeUploadBytes: (bytes: number) => void
  waitForUploadBytes: (bytes: number, signal?: AbortSignal) => Promise<void>
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
  startedAt: number
  observedUploadKbps: number | null
  uploadSamples: UploadSample[]
  forceClose: (() => void) | null
  animeId: string
  seasonNumber: number
  episodeNumber: number
  contentKey: string
  streamGroupKey: string
  throttle: StreamThrottleState
}

type StreamThrottleState = {
  availableBytes: number
  updatedAt: number
}

type ActiveStreamGroup = {
  streamGroupKey: string
  streamCount: number
  minimumUploadKbps: number
  weight: number
}

type UploadSample = {
  bytes: number
  sampledAt: number
}

type AcquireStreamUploadInput = {
  clientId: string | null
  username: string
  isVip: boolean
  mode: PlaybackMode
  profile: PlaybackProfile
  estimatedUploadKbps: number | null
  animeId: string
  seasonNumber: number
  episodeNumber: number
  signal?: AbortSignal
}

type StreamAdmissionInput = {
  username: string
  clientId: string | null
  isVip: boolean
  mode: PlaybackMode
  contentKey: string
}

type PendingStreamUploadRequest = {
  id: string
  username: string
  clientId: string | null
  isVip: boolean
  estimatedUploadKbps: number
  priority: number
  sequence: number
  signal?: AbortSignal
  admissionInput: StreamAdmissionInput
  createLease: () => StreamUploadLease
  resolve: (lease: StreamUploadLease) => void
  reject: (error: Error) => void
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

const capacityWaitMs = 1000
const liveTranscodeAudioUploadKbps = 320
const internetLiveTranscodeMinVideoKbps = 1_500
const internetLiveTranscodeMaxVideoKbps = 3_000
const lanLiveTranscodeMaxVideoKbps = 20_000
const liveTranscodeBitrateRestartThresholdKbps = 256
const minimumRegularStreamUploadKbps = 6_000
const minimumVipStreamUploadKbps = 8_000
const streamThrottleBucketSeconds = 1
const streamThrottleMinimumBucketBytes = 256 * 1024
const streamThrottleWaitMaxMs = 1000
const uploadObservationWindowMs = 12_000
const staleObservationMs = 18_000
const streamEstimateOverheadFactor = 1.06
const bandwidthRecheckClientPauseGraceMs = 1_500
const bandwidthRecheckStreamDrainTimeoutMs = 5_000
const bandwidthRecheckStreamDrainPollMs = 100
const serverShutdownClientPauseGraceMs = 750
const serverShutdownStreamDrainTimeoutMs = 5_000
const activeStreams = new Map<string, ActiveStream>()
const clientActions = new Map<string, StreamPriorityAction>()
const clientActionSubscribers = new Map<
  string,
  Set<(action: StreamPriorityAction) => void>
>()
const throttleWaiters = new Set<() => void>()
const bandwidthRecheckWaiters = new Set<() => void>()
const pendingStreamUploadRequests: PendingStreamUploadRequest[] = []
let pendingStreamUploadSequence = 0
let pendingStreamUploadDrainTimer: ReturnType<typeof setTimeout> | null = null
let drainingPendingStreamUploads = false
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

function getMinimumStreamUploadKbps(input: { isVip: boolean; mode: PlaybackMode }) {
  if (input.mode === "transcode") {
    return applyStreamEstimateOverhead(
      internetLiveTranscodeMinVideoKbps + liveTranscodeAudioUploadKbps
    )
  }

  return input.isVip ? minimumVipStreamUploadKbps : minimumRegularStreamUploadKbps
}

function getStreamGroupWeight(isVip: boolean) {
  return isVip ? 2 : 1
}

function getStreamGroupKey(input: {
  username: string
  clientId: string | null
  contentKey: string
}) {
  const clientKey = getClientKey(input.username, input.clientId)

  return `${clientKey ?? `user:${input.username}`}:${input.contentKey}`
}

function getActiveStreamGroups(
  options: { excludeClientKey?: string | null } = {}
) {
  const groups = new Map<string, ActiveStreamGroup>()

  for (const stream of activeStreams.values()) {
    if (options.excludeClientKey && stream.clientKey === options.excludeClientKey) {
      continue
    }

    const existing = groups.get(stream.streamGroupKey)
    const minimumUploadKbps = getMinimumStreamUploadKbps({
      isVip: stream.isVip,
      mode: stream.mode,
    })
    const weight = getStreamGroupWeight(stream.isVip)

    if (existing) {
      existing.streamCount += 1
      existing.minimumUploadKbps = Math.max(
        existing.minimumUploadKbps,
        minimumUploadKbps
      )
      existing.weight = Math.max(existing.weight, weight)
      continue
    }

    groups.set(stream.streamGroupKey, {
      streamGroupKey: stream.streamGroupKey,
      streamCount: 1,
      minimumUploadKbps,
      weight,
    })
  }

  return groups
}

function getProjectedStreamGroups(input: {
  username: string
  clientId: string | null
  isVip: boolean
  mode: PlaybackMode
  contentKey: string
}) {
  const clientKey = getClientKey(input.username, input.clientId)
  const groups = getActiveStreamGroups({ excludeClientKey: clientKey })
  const streamGroupKey = getStreamGroupKey(input)
  const minimumUploadKbps = getMinimumStreamUploadKbps({
    isVip: input.isVip,
    mode: input.mode,
  })
  const weight = getStreamGroupWeight(input.isVip)
  const existing = groups.get(streamGroupKey)

  if (existing) {
    existing.streamCount += 1
    existing.minimumUploadKbps = Math.max(
      existing.minimumUploadKbps,
      minimumUploadKbps
    )
    existing.weight = Math.max(existing.weight, weight)
  } else {
    groups.set(streamGroupKey, {
      streamGroupKey,
      streamCount: 1,
      minimumUploadKbps,
      weight,
    })
  }

  return groups
}

function getFairStreamUploadKbps(streamGroupCount: number) {
  const maxUploadKbps = getEffectiveMaxUploadKbps()

  if (!maxUploadKbps || streamGroupCount <= 0) {
    return null
  }

  return Math.max(Math.floor(maxUploadKbps / streamGroupCount), 1)
}

function getWeightedStreamUploadKbps(
  groups: Map<string, ActiveStreamGroup>,
  streamGroupKey: string
) {
  const maxUploadKbps = getEffectiveMaxUploadKbps()
  const group = groups.get(streamGroupKey)

  if (!maxUploadKbps || !group || groups.size <= 0) {
    return null
  }

  const totalWeight = [...groups.values()].reduce(
    (total, candidate) => total + Math.max(candidate.weight, 1),
    0
  )

  if (totalWeight <= 0) {
    return null
  }

  return Math.max(
    Math.floor((maxUploadKbps * Math.max(group.weight, 1)) / totalWeight),
    1
  )
}

function getProjectedFairUploadKbps(input: {
  username: string
  clientId: string | null
  isVip: boolean
  mode: PlaybackMode
  contentKey: string
}) {
  const groups = getProjectedStreamGroups(input)
  const fairUploadKbps = getFairStreamUploadKbps(groups.size)

  return { groups, fairUploadKbps }
}

function canFitMinimumStreamUpload(input: {
  username: string
  clientId: string | null
  isVip: boolean
  mode: PlaybackMode
  contentKey: string
}) {
  const maxUploadKbps = getEffectiveMaxUploadKbps()

  if (!maxUploadKbps) {
    return true
  }

  const { groups, fairUploadKbps } = getProjectedFairUploadKbps(input)

  if (!fairUploadKbps) {
    return true
  }

  return [...groups.values()].every((group) => {
    const weightedUploadKbps = getWeightedStreamUploadKbps(
      groups,
      group.streamGroupKey
    )

    return group.minimumUploadKbps <= (weightedUploadKbps ?? fairUploadKbps)
  })
}

function getActiveStreamGroupCount() {
  return getActiveStreamGroups().size
}

function getActiveStreamGroupConnectionCount(streamGroupKey: string) {
  return [...activeStreams.values()].filter(
    (stream) => stream.streamGroupKey === streamGroupKey
  ).length
}

function getActiveStreamThrottleKbps(stream: ActiveStream) {
  const groups = getActiveStreamGroups()
  const weightedUploadKbps = getWeightedStreamUploadKbps(
    groups,
    stream.streamGroupKey
  )
  const fairUploadKbps =
    weightedUploadKbps ?? getFairStreamUploadKbps(getActiveStreamGroupCount())

  if (!fairUploadKbps) {
    return null
  }

  const connectionCount = Math.max(
    getActiveStreamGroupConnectionCount(stream.streamGroupKey),
    1
  )

  return Math.max(Math.floor(fairUploadKbps / connectionCount), 1)
}

function getThrottleBucketCapacityBytes(
  bytesPerSecond: number,
  minimumBytes: number
) {
  return Math.max(
    Math.ceil(bytesPerSecond * streamThrottleBucketSeconds),
    streamThrottleMinimumBucketBytes,
    minimumBytes
  )
}

function refillStreamThrottle(
  stream: ActiveStream,
  bytesPerSecond: number,
  minimumBucketBytes: number,
  now = Date.now()
) {
  const elapsedSeconds = Math.max((now - stream.throttle.updatedAt) / 1000, 0)
  const bucketCapacityBytes = getThrottleBucketCapacityBytes(
    bytesPerSecond,
    minimumBucketBytes
  )

  stream.throttle.availableBytes = Math.min(
    bucketCapacityBytes,
    stream.throttle.availableBytes + elapsedSeconds * bytesPerSecond
  )
  stream.throttle.updatedAt = now
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

function notifyCapacityWaiters() {
  void drainPendingStreamUploadRequests()
}

function notifyThrottleWaiters() {
  for (const waiter of throttleWaiters) {
    waiter()
  }

  throttleWaiters.clear()
}

function waitForThrottle(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(finish, Math.max(Math.ceil(milliseconds), 1))

    timer.unref?.()

    function finish() {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      throttleWaiters.delete(finish)
      signal?.removeEventListener("abort", abort)
      resolve()
    }

    function abort() {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      throttleWaiters.delete(finish)
      signal?.removeEventListener("abort", abort)
      reject(new Error("Stream upload was cancelled"))
    }

    if (signal?.aborted) {
      abort()
      return
    }

    throttleWaiters.add(finish)
    signal?.addEventListener("abort", abort, { once: true })
  })
}

async function waitForStreamUploadBytes(
  id: string,
  bytes: number,
  signal?: AbortSignal
) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return
  }

  for (;;) {
    if (signal?.aborted) {
      throw new Error("Stream upload was cancelled")
    }

    const stream = activeStreams.get(id)

    if (!stream) {
      return
    }

    const throttleKbps = getActiveStreamThrottleKbps(stream)

    if (!throttleKbps) {
      return
    }

    const bytesPerSecond = Math.max((throttleKbps * 1000) / 8, 1)
    refillStreamThrottle(stream, bytesPerSecond, bytes)

    if (stream.throttle.availableBytes >= bytes) {
      stream.throttle.availableBytes -= bytes
      return
    }

    const missingBytes = bytes - stream.throttle.availableBytes
    const waitMs = Math.min(
      Math.max((missingBytes / bytesPerSecond) * 1000, 25),
      streamThrottleWaitMaxMs
    )

    await waitForThrottle(waitMs, signal)
  }
}

function getPendingStreamUploadPriority(isVip: boolean) {
  return isVip ? -1 : 0
}

function hasPendingStreamUploadRequests() {
  return pendingStreamUploadRequests.length > 0
}

function removePendingStreamUploadRequest(id: string) {
  const index = pendingStreamUploadRequests.findIndex(
    (request) => request.id === id
  )

  if (index >= 0) {
    pendingStreamUploadRequests.splice(index, 1)
  }
}

function sortPendingStreamUploadRequests() {
  pendingStreamUploadRequests.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority
    }

    return left.sequence - right.sequence
  })
}

function schedulePendingStreamUploadDrain() {
  if (pendingStreamUploadDrainTimer) {
    return
  }

  pendingStreamUploadDrainTimer = setTimeout(() => {
    pendingStreamUploadDrainTimer = null
    void drainPendingStreamUploadRequests()
  }, capacityWaitMs)
  pendingStreamUploadDrainTimer.unref?.()
}

async function drainPendingStreamUploadRequests() {
  if (drainingPendingStreamUploads) {
    return
  }

  drainingPendingStreamUploads = true

  try {
    for (;;) {
      sortPendingStreamUploadRequests()
      const request = pendingStreamUploadRequests[0]

      if (!request) {
        return
      }

      if (request.signal?.aborted) {
        removePendingStreamUploadRequest(request.id)
        request.reject(new Error("Stream upload reservation was cancelled"))
        continue
      }

      if (streamServerShutdownActive) {
        removePendingStreamUploadRequest(request.id)
        request.reject(new Error("Server is shutting down. New streams are disabled"))
        continue
      }


      if (!canFitMinimumStreamUpload(request.admissionInput)) {
        schedulePendingStreamUploadDrain()
        return
      }

      removePendingStreamUploadRequest(request.id)

      try {
        request.resolve(request.createLease())
      } catch (error) {
        request.reject(
          error instanceof Error
            ? error
            : new Error("Stream upload reservation failed")
        )
      }
    }
  } finally {
    drainingPendingStreamUploads = false
  }
}

function acquireQueuedStreamUpload(input: {
  username: string
  clientId: string | null
  isVip: boolean
  estimatedUploadKbps: number
  admissionInput: StreamAdmissionInput
  createLease: () => StreamUploadLease
  signal?: AbortSignal
}) {
  const id = createId()

  return new Promise<StreamUploadLease>((resolve, reject) => {
    const request: PendingStreamUploadRequest = {
      id,
      username: input.username,
      clientId: input.clientId,
      isVip: input.isVip,
      estimatedUploadKbps: input.estimatedUploadKbps,
      priority: getPendingStreamUploadPriority(input.isVip),
      sequence: pendingStreamUploadSequence++,
      signal: input.signal,
      admissionInput: input.admissionInput,
      createLease: input.createLease,
      resolve,
      reject,
    }

    const onAbort = () => {
      removePendingStreamUploadRequest(id)
      reject(new Error("Stream upload reservation was cancelled"))
      void drainPendingStreamUploadRequests()
    }

    if (input.signal?.aborted) {
      reject(new Error("Stream upload reservation was cancelled"))
      return
    }

    input.signal?.addEventListener("abort", onAbort, { once: true })
    pendingStreamUploadRequests.push(request)

    void drainPendingStreamUploadRequests().finally(() => {
      if (!pendingStreamUploadRequests.some((pending) => pending.id === id)) {
        input.signal?.removeEventListener("abort", onAbort)
      }
    })
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
  return "Server maintenance or upload bandwidth recheck is running. Playback is paused until it completes."
}

function getBandwidthRecheckFinishedMessage() {
  return "Server maintenance and upload bandwidth recheck finished. Playback can continue."
}

function getBandwidthRecheckFailedMessage() {
  return "Server maintenance finished, but the upload bandwidth measurement failed. Playback can continue with the previous bandwidth state."
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

function closeActiveStreamsMatching(predicate: (stream: ActiveStream) => boolean) {
  for (const stream of [...activeStreams.values()]) {
    if (predicate(stream)) {
      closeActiveStream(stream)
    }
  }

  notifyCapacityWaiters()
  notifyThrottleWaiters()
}

function closeAllActiveStreams() {
  closeActiveStreamsMatching(() => true)
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
  notifyThrottleWaiters()
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

function getBandwidthWaitMessage() {
  return "Server upload bandwidth is full. Waiting for a free slot."
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
    notifyCapacityWaiters()
    notifyThrottleWaiters()
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


  for (const key of [...clientActions.keys()]) {
    if (key.startsWith(`${username}:`)) {
      clientActions.delete(key)
    }
  }

  notifyCapacityWaiters()
  notifyThrottleWaiters()
}

async function waitForActiveStreamsToDrain(
  predicate: (stream: ActiveStream) => boolean = () => true,
  label = "scheduled upload capacity recheck"
) {
  const deadline = Date.now() + bandwidthRecheckStreamDrainTimeoutMs

  function remaining() {
    return [...activeStreams.values()].filter(predicate).length
  }

  let remainingStreams = remaining()

  while (remainingStreams > 0 && Date.now() < deadline) {
    await sleep(bandwidthRecheckStreamDrainPollMs)
    remainingStreams = remaining()
  }

  if (remainingStreams > 0) {
    console.warn(
      `[Warn] [Bandwidth] Continuing ${label} while ${remainingStreams} stream(s) are still closing.`
    )
  }
}

type UploadCapacityRecheckHoldOptions = {
  beforeMeasurement?: () => Promise<void>
  initialCloseModes?: PlaybackMode[]
}

function getActiveClientKeys(
  predicate: (stream: ActiveStream) => boolean = () => true
) {
  return new Set(
    [...activeStreams.values()]
      .filter(predicate)
      .map((stream) => stream.clientKey)
      .filter((clientKey): clientKey is string => Boolean(clientKey))
  )
}

async function pauseStreamsForBandwidthRecheck(input: {
  action: StreamPriorityAction
  predicate: (stream: ActiveStream) => boolean
  label: string
}) {
  const activeClientKeys = getActiveClientKeys(input.predicate)
  const activeStreamCount = [...activeStreams.values()].filter(input.predicate).length

  if (activeStreamCount <= 0) {
    return
  }

  console.log(
    `[Info] [Bandwidth] Pausing ${activeStreamCount} ${input.label} stream(s) before scheduled maintenance.`
  )

  for (const clientKey of activeClientKeys) {
    markBandwidthRecheckClient(clientKey)
    setClientActionByKey(clientKey, input.action)
  }

  await sleep(bandwidthRecheckClientPauseGraceMs)

  closeActiveStreamsMatching(input.predicate)
  await waitForActiveStreamsToDrain(input.predicate, input.label)
}

export async function runUploadCapacityRecheckWithStreamHold(
  measure: () => Promise<void>,
  options: UploadCapacityRecheckHoldOptions = {}
) {
  if (bandwidthRecheckActive) {
    await waitForBandwidthRecheck()
    return
  }

  bandwidthRecheckActive = true
  const startedAction = createBandwidthRecheckStartedAction()
  let failed = false

  try {
    const initialCloseModes = new Set(options.initialCloseModes ?? [])

    if (initialCloseModes.size > 0) {
      await pauseStreamsForBandwidthRecheck({
        action: startedAction,
        predicate: (stream) => initialCloseModes.has(stream.mode),
        label: [...initialCloseModes].join("/") || "selected",
      })
    }

    if (options.beforeMeasurement) {
      await options.beforeMeasurement()
    }

    await pauseStreamsForBandwidthRecheck({
      action: startedAction,
      predicate: () => true,
      label: "active",
    })

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
    notifyThrottleWaiters()
  }
}


function createLease(input: {
  clientId: string | null
  username: string
  isVip: boolean
  mode: PlaybackMode
  profile: PlaybackProfile
  estimatedUploadKbps: number
  animeId: string
  seasonNumber: number
  episodeNumber: number
}): StreamUploadLease {
  const id = createId()
  const clientKey = getClientKey(input.username, input.clientId)
  const contentKey = getContentKey(input)
  const streamGroupKey = getStreamGroupKey({
    username: input.username,
    clientId: input.clientId,
    contentKey,
  })
  let released = false

  closeActiveStreamsForClientKey(clientKey, { exceptContentKey: contentKey })

  clearClientAction(input.username, input.clientId)

  activeStreams.set(id, {
    id,
    clientKey,
    clientId: input.clientId,
    username: input.username,
    isVip: input.isVip,
    mode: input.mode,
    profile: input.profile,
    estimatedUploadKbps: input.estimatedUploadKbps,
    startedAt: Date.now(),
    animeId: input.animeId,
    seasonNumber: input.seasonNumber,
    episodeNumber: input.episodeNumber,
    contentKey,
    streamGroupKey,
    observedUploadKbps: null,
    uploadSamples: [],
    throttle: {
      availableBytes: Number.POSITIVE_INFINITY,
      updatedAt: Date.now(),
    },
    forceClose: null,
  })
  notifyThrottleWaiters()

  return {
    id,
    effectiveMode: input.mode,
    effectiveProfile: input.profile,
    isMetered: true,
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
    waitForUploadBytes(bytes: number, signal?: AbortSignal) {
      if (released) {
        return Promise.resolve()
      }

      return waitForStreamUploadBytes(id, bytes, signal)
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
      notifyCapacityWaiters()
      notifyThrottleWaiters()
    },
  }
}


export function createUnmeteredStreamUploadLease(input: {
  clientId: string | null
  username: string
  mode: PlaybackMode
  profile: PlaybackProfile
  animeId: string
  seasonNumber: number
  episodeNumber: number
}): StreamUploadLease {
  const clientKey = getClientKey(input.username, input.clientId)
  const contentKey = getContentKey(input)
  let released = false

  closeActiveStreamsForClientKey(clientKey, { exceptContentKey: contentKey })
  clearClientAction(input.username, input.clientId)

  return {
    id: createId(),
    effectiveMode: input.mode,
    effectiveProfile: input.profile,
    isMetered: false,
    observeUploadBytes() {},
    waitForUploadBytes() {
      return Promise.resolve()
    },
    setForceClose(handler: () => void) {
      if (released) {
        return
      }

      if (streamServerShutdownActive) {
        queueMicrotask(handler)
      }
    },
    release() {
      released = true
    },
  }
}

function applyStreamEstimateOverhead(kbps: number) {
  return Math.max(Math.ceil(kbps * streamEstimateOverheadFactor), 1)
}

function getSafeSourceVideoBitrateKbps(sourceBitrateKbps?: number) {
  return Math.max(Math.ceil(sourceBitrateKbps ?? 6000), 1)
}

function clampVideoBitrateToSource(
  sourceBitrateKbps: number | undefined,
  maxVideoBitrateKbps: number
) {
  return Math.max(
    Math.min(getSafeSourceVideoBitrateKbps(sourceBitrateKbps), maxVideoBitrateKbps),
    1
  )
}

function getUnmeteredLiveTranscodeVideoBitrateKbps(sourceBitrateKbps?: number) {
  return clampVideoBitrateToSource(sourceBitrateKbps, lanLiveTranscodeMaxVideoKbps)
}

function getMeteredLiveTranscodeVideoBitrateKbps(input: {
  sourceBitrateKbps?: number
  activeStream?: ActiveStream | null
}) {
  const streamUploadKbps = input.activeStream
    ? getActiveStreamThrottleKbps(input.activeStream)
    : getEffectiveMaxUploadKbps()
  const uploadLimitedVideoKbps = streamUploadKbps
    ? Math.max(streamUploadKbps - liveTranscodeAudioUploadKbps, internetLiveTranscodeMinVideoKbps)
    : internetLiveTranscodeMaxVideoKbps

  return Math.max(
    clampVideoBitrateToSource(
      input.sourceBitrateKbps,
      Math.min(uploadLimitedVideoKbps, internetLiveTranscodeMaxVideoKbps)
    ),
    Math.min(
      internetLiveTranscodeMinVideoKbps,
      getSafeSourceVideoBitrateKbps(input.sourceBitrateKbps)
    )
  )
}

function estimateOriginalUploadKbps(input: {
  bypassUploadBandwidth?: boolean
  mode?: PlaybackMode
  sourceBitrateKbps: number
}) {
  if (input.mode === "transcode") {
    const videoBitrateKbps = input.bypassUploadBandwidth
      ? getUnmeteredLiveTranscodeVideoBitrateKbps(input.sourceBitrateKbps)
      : getMeteredLiveTranscodeVideoBitrateKbps({
          sourceBitrateKbps: input.sourceBitrateKbps,
        })

    return applyStreamEstimateOverhead(videoBitrateKbps + liveTranscodeAudioUploadKbps)
  }

  return applyStreamEstimateOverhead(input.sourceBitrateKbps)
}

export function estimateUploadKbps(input: {
  bypassUploadBandwidth?: boolean
  sourceBitrateKbps?: number
  profile: PlaybackProfile
  mode?: PlaybackMode
}) {
  const sourceBitrateKbps = getSafeSourceVideoBitrateKbps(input.sourceBitrateKbps)

  return estimateOriginalUploadKbps({
    bypassUploadBandwidth: input.bypassUploadBandwidth,
    mode: input.mode,
    sourceBitrateKbps,
  })
}

export function getLiveTranscodeVideoBitrateKbps(input: {
  bypassUploadBandwidth: boolean
  sourceBitrateKbps?: number
  uploadLease?: StreamUploadLease | null
}) {
  if (input.bypassUploadBandwidth || !input.uploadLease?.isMetered) {
    return getUnmeteredLiveTranscodeVideoBitrateKbps(input.sourceBitrateKbps)
  }

  return getMeteredLiveTranscodeVideoBitrateKbps({
    sourceBitrateKbps: input.sourceBitrateKbps,
    activeStream: activeStreams.get(input.uploadLease.id) ?? null,
  })
}

export function shouldRestartLiveTranscodeForBitrate(input: {
  bypassUploadBandwidth: boolean
  currentVideoBitrateKbps: number
  sourceBitrateKbps?: number
  uploadLease?: StreamUploadLease | null
}) {
  if (input.bypassUploadBandwidth || !input.uploadLease?.isMetered) {
    return false
  }

  const nextVideoBitrateKbps = getLiveTranscodeVideoBitrateKbps({
    bypassUploadBandwidth: input.bypassUploadBandwidth,
    sourceBitrateKbps: input.sourceBitrateKbps,
    uploadLease: input.uploadLease,
  })

  return (
    Math.abs(nextVideoBitrateKbps - input.currentVideoBitrateKbps) >=
    liveTranscodeBitrateRestartThresholdKbps
  )
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
  const admissionInput = {
    username: input.username,
    clientId: input.clientId,
    isVip: input.isVip,
    mode: input.mode,
    contentKey,
  }

  if (!input.estimatedUploadKbps || input.estimatedUploadKbps <= 0) {
    return createLease({
      clientId: input.clientId,
      username: input.username,
      isVip: input.isVip,
      mode: input.mode,
      profile: input.profile,
      estimatedUploadKbps: 0,
      animeId: input.animeId,
      seasonNumber: input.seasonNumber,
      episodeNumber: input.episodeNumber,
    })
  }

  const createAdmittedLease = () =>
    createLease({
      clientId: input.clientId,
      username: input.username,
      isVip: input.isVip,
      mode: input.mode,
      profile: input.profile,
      estimatedUploadKbps: input.estimatedUploadKbps!,
      animeId: input.animeId,
      seasonNumber: input.seasonNumber,
      episodeNumber: input.episodeNumber,
    })

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

  if (
    !hasPendingStreamUploadRequests() &&
    canFitMinimumStreamUpload(admissionInput)
  ) {
    return createAdmittedLease()
  }

  setClientAction(input.username, input.clientId, {
    type: "waitingForBandwidth",
    message: getBandwidthWaitMessage(),
    createdAt: nowIso(),
  })

  try {
    return await acquireQueuedStreamUpload({
      username: input.username,
      clientId: input.clientId,
      isVip: input.isVip,
      estimatedUploadKbps: input.estimatedUploadKbps,
      admissionInput,
      createLease: createAdmittedLease,
      signal: input.signal,
    })
  } catch (error) {
    clearClientAction(input.username, input.clientId)
    throw error
  }
}


export function publishStreamPriorityAction(input: {
  username: string
  clientId: string | null
  action: StreamPriorityAction
}) {
  setClientAction(input.username, input.clientId, input.action)
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
  notifyThrottleWaiters()

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
  const activeStreamGroups = getActiveStreamGroups()
  const fairUploadKbps = getFairStreamUploadKbps(activeStreamGroups.size)

  return {
    baseMaxUploadKbps,
    maxUploadKbps,
    usedUploadKbps,
    reservedUploadKbps,
    availableUploadKbps: maxUploadKbps
      ? Math.max(maxUploadKbps - usedUploadKbps, 0)
      : null,
    activeStreams: activeStreamGroups.size,
    activeStreamConnections: activeStreams.size,
    fairUploadKbps,
    minimumRegularStreamUploadKbps,
    minimumVipStreamUploadKbps,
    internetLiveTranscodeMinVideoKbps,
    internetLiveTranscodeMaxVideoKbps,
    lanLiveTranscodeMaxVideoKbps,
    temporaryUploadLimit: {
      active: temporaryUploadLimit.active,
      expiresAt: temporaryUploadLimit.expiresAt
        ? new Date(temporaryUploadLimit.expiresAt).toISOString()
        : null,
      factor: temporaryUploadLimitFactor,
    },
  }
}
