import { Anilist } from "@api-wrappers/anilist-wrapper"
import { isRateLimitError } from "@api-wrappers/api-core"

import { errorMessage } from "@/server/utils/format"

const clients = new Map<string, Anilist>()

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

  const run = queue.then(async () => {
    queuedOperations = Math.max(queuedOperations - 1, 0)
    activeOperation = true
    await waitForPause()

    try {
      return await operation()
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
