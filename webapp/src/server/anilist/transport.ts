import { Anilist } from "@api-wrappers/anilist-wrapper"
import { isRateLimitError } from "@api-wrappers/api-core"

import { errorMessage } from "@/server/utils/format"

const clients = new Map<string, Anilist>()
const operationTimeoutMs = 30_000

let queue = Promise.resolve()
let queuedOperations = 0
let activeOperation = false
let pausedUntil = 0

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForPause() {
  const waitMs = pausedUntil - Date.now()

  if (waitMs > 0) {
    await sleep(waitMs)
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
  queuedOperations += 1
  console.log(
    `[Debug] [Anilist] Queued AniList operation - Queue depth ${queuedOperations}`
  )

  const run = queue.then(async () => {
    const startedAt = Date.now()
    queuedOperations = Math.max(queuedOperations - 1, 0)
    activeOperation = true

    console.log(
      `[Debug] [Anilist] Starting AniList operation - Remaining queue ${queuedOperations}`
    )

    await waitForPause()

    try {
      const result = await runWithTimeout(operation)
      console.log(
        `[Debug] [Anilist] AniList operation completed - ${Date.now() - startedAt}ms`
      )
      return result
    } catch (error) {
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
