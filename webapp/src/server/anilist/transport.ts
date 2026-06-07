import { Anilist } from "@api-wrappers/anilist-wrapper"
import { isRateLimitError } from "@api-wrappers/api-core"

import { errorMessage } from "@/server/utils/format"
import { debugLog } from "@/server/utils/debugLog"

const clients = new Map<string, Anilist>()
const operationTimeoutMs = 30_000
const maxOperationsPerMinute = 30
const minOperationStartIntervalMs = Math.ceil(60_000 / maxOperationsPerMinute)

let queue = Promise.resolve()
let queuedOperations = 0
let activeOperation = false
let pausedUntil = 0
let nextOperationStartAt = 0
let shuttingDown = false
let shutdownReason = "AniList operation was cancelled because shutdown started"

type AniListOperationOptions = {
  label?: string
}

export class AniListOperationShutdownError extends Error {
  constructor(message = shutdownReason) {
    super(message)
    this.name = "AniListOperationShutdownError"
  }
}

export class AniListOperationTimeoutError extends Error {
  constructor(
    readonly operationLabel: string,
    readonly timeoutMs: number
  ) {
    super(
      `${operationLabel} timed out after ${timeoutMs}ms (reason: AniList or the wrapper did not return a response before Yamibunko's timeout)`
    )
    this.name = "AniListOperationTimeoutError"
  }
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function throwIfAniListShutdownStarted() {
  if (shuttingDown) {
    throw new AniListOperationShutdownError()
  }
}

function getOperationLabel(options?: AniListOperationOptions) {
  return options?.label?.trim() || "AniList wrapper operation"
}

function describeRateLimitRetry(error: unknown) {
  if (!isRateLimitError(error)) {
    return null
  }

  const retryAfterMs = error.retryAfterMs ?? null

  if (typeof retryAfterMs !== "number" || retryAfterMs <= 0) {
    return "AniList rate limit was reached"
  }

  return `AniList rate limit was reached; retry allowed in ${Math.ceil(retryAfterMs / 1000)}s`
}

function getAniListFailureReason(error: unknown) {
  if (error instanceof AniListOperationTimeoutError) {
    return "Timeout while waiting for AniList or the wrapper to return a response"
  }

  const rateLimitReason = describeRateLimitRetry(error)

  if (rateLimitReason) {
    return rateLimitReason
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return "Request was aborted by Yamibunko after the operation timeout"
  }

  if (error instanceof TypeError) {
    return "Network or transport request failed"
  }

  if (error instanceof Error && error.name) {
    return error.name
  }

  return "Unknown AniList wrapper failure"
}

async function waitForPause() {
  for (;;) {
    throwIfAniListShutdownStarted()

    const waitMs = pausedUntil - Date.now()

    if (waitMs <= 0) {
      return
    }

    await sleep(Math.min(waitMs, 1000))
  }
}

async function waitForQueueRateLimitSlot() {
  for (;;) {
    throwIfAniListShutdownStarted()

    const now = Date.now()
    const waitMs = nextOperationStartAt - now

    if (waitMs <= 0) {
      nextOperationStartAt = now + minOperationStartIntervalMs
      return
    }

    await sleep(Math.min(waitMs, 1000))
  }
}

async function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  operationLabel: string
) {
  const abortController = new AbortController()
  let timeout: NodeJS.Timeout | undefined

  try {
    return await Promise.race<T>([
      operation(abortController.signal),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          abortController.abort()
          reject(new AniListOperationTimeoutError(operationLabel, operationTimeoutMs))
        }, operationTimeoutMs)
        timeout.unref?.()
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

export function beginAniListOperationShutdown(
  reason = "AniList operation was cancelled because shutdown started"
) {
  shutdownReason = reason

  if (shuttingDown) {
    return
  }

  shuttingDown = true

  if (queuedOperations > 0 || activeOperation) {
    console.log(
      `[Info] [Anilist] Shutdown requested; cancelling queued AniList operation(s) and waiting for the active lookup to finish - queued ${queuedOperations}, active ${activeOperation ? "yes" : "no"}.`
    )
  }
}

export function isAniListOperationShutdownActive() {
  return shuttingDown
}

export function isAniListOperationShutdownError(error: unknown) {
  return error instanceof AniListOperationShutdownError
}

export function getAniListClient(accessToken?: string) {
  const key = accessToken ?? ""
  const existing = clients.get(key)

  if (existing) {
    return existing
  }

  const client = new Anilist(accessToken)
  clients.set(key, client)
  return client
}

export function getAniListRateLimitState() {
  const now = Date.now()

  return {
    limit: maxOperationsPerMinute,
    remaining: null as number | null,
    resetAt: null as number | null,
    pausedUntil: Math.max(pausedUntil, nextOperationStartAt) > now ? Math.max(pausedUntil, nextOperationStartAt) : null,
    queued: queuedOperations,
    active: activeOperation,
  }
}

export function queueAniListOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options?: AniListOperationOptions
) {
  if (shuttingDown) {
    return Promise.reject<T>(new AniListOperationShutdownError())
  }

  const operationLabel = getOperationLabel(options)
  queuedOperations += 1
  debugLog(
    `[Debug] [Anilist] Queued AniList operation - ${operationLabel} - Queue depth ${queuedOperations}`
  )

  const run = queue.then(async () => {
    const startedAt = Date.now()
    queuedOperations = Math.max(queuedOperations - 1, 0)

    throwIfAniListShutdownStarted()
    activeOperation = true

    debugLog(
      `[Debug] [Anilist] Starting AniList operation - ${operationLabel} - Remaining queue ${queuedOperations}`
    )

    try {
      await waitForPause()
      await waitForQueueRateLimitSlot()
      throwIfAniListShutdownStarted()

      const result = await runWithTimeout(operation, operationLabel)
      debugLog(
        `[Debug] [Anilist] AniList operation completed - ${operationLabel} - ${Date.now() - startedAt}ms`
      )
      return result
    } catch (error) {
      if (isAniListOperationShutdownError(error)) {
        debugLog(
          `[Debug] [Anilist] AniList operation skipped during shutdown - ${operationLabel} - Remaining queue ${queuedOperations}`
        )
        throw error
      }

      const retryAfter = isRateLimitError(error)
        ? (error.retryAfterMs ?? 60_000)
        : null

      if (retryAfter) {
        pausedUntil = Math.max(pausedUntil, Date.now() + retryAfter)
      }

      console.error(
        `[Error] [Anilist] AniList operation failed - ${operationLabel} - Reason: ${getAniListFailureReason(error)} - Detail: ${errorMessage(error)} - transport.ts`
      )
      throw error
    } finally {
      activeOperation = false
    }
  })

  queue = run.then(
    () => undefined,
    () => undefined
  )

  return run
}
