import { Anilist } from "@api-wrappers/anilist-wrapper"
import { isRateLimitError } from "@api-wrappers/api-core"

import { errorMessage } from "@/server/utils/format"
import { debugLog } from "@/server/utils/debugLog"

const clients = new Map<string, Anilist>()
const operationTimeoutMs = 30_000

let queue = Promise.resolve()
let queuedOperations = 0
let activeOperation = false
let pausedUntil = 0
let shuttingDown = false
let shutdownReason = "AniList operation was cancelled because shutdown started"

export class AniListOperationShutdownError extends Error {
  constructor(message = shutdownReason) {
    super(message)
    this.name = "AniListOperationShutdownError"
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

async function runWithTimeout<T>(operation: () => Promise<T>) {
  let timeout: NodeJS.Timeout | undefined

  try {
    return await Promise.race<T>([
      operation(),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `AniList operation timed out after ${operationTimeoutMs}ms`
            )
          )
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
  return {
    limit: null as number | null,
    remaining: null as number | null,
    resetAt: null as number | null,
    pausedUntil: pausedUntil > Date.now() ? pausedUntil : null,
    queued: queuedOperations,
    active: activeOperation,
  }
}

export function queueAniListOperation<T>(operation: () => Promise<T>) {
  if (shuttingDown) {
    return Promise.reject<T>(new AniListOperationShutdownError())
  }

  queuedOperations += 1
  debugLog(
    `[Debug] [Anilist] Queued AniList operation - Queue depth ${queuedOperations}`
  )

  const run = queue.then(async () => {
    const startedAt = Date.now()
    queuedOperations = Math.max(queuedOperations - 1, 0)

    throwIfAniListShutdownStarted()
    activeOperation = true

    debugLog(
      `[Debug] [Anilist] Starting AniList operation - Remaining queue ${queuedOperations}`
    )

    try {
      await waitForPause()
      throwIfAniListShutdownStarted()

      const result = await runWithTimeout(operation)
      debugLog(
        `[Debug] [Anilist] AniList operation completed - ${Date.now() - startedAt}ms`
      )
      return result
    } catch (error) {
      if (isAniListOperationShutdownError(error)) {
        debugLog(
          `[Debug] [Anilist] AniList operation skipped during shutdown - Remaining queue ${queuedOperations}`
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
        `[Error] [Anilist] AniList wrapper operation failed - transport.ts - ${errorMessage(error)}`
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

