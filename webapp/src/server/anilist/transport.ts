import { serverLog } from "@/server/logger"

type AniListGraphQLResponse<TData> = {
  data?: TData
  errors?: Array<{
    message?: string
  }>
}

const anilistGraphQlUrl = "https://graphql.anilist.co"
const requestTimeoutMs = 20_000

let queue = Promise.resolve()
let pausedUntil = 0
let rateLimit = {
  limit: null as number | null,
  remaining: null as number | null,
  resetAt: null as number | null,
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseIntegerHeader(headers: Headers, name: string) {
  const value = headers.get(name)

  if (!value) {
    return null
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) ? parsed : null
}

function readRetryAfterMs(headers: Headers) {
  const value = headers.get("retry-after")

  if (!value) {
    return null
  }

  const seconds = Number.parseInt(value, 10)

  if (Number.isInteger(seconds)) {
    return Math.max(seconds * 1000, 0)
  }

  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(date - Date.now(), 0)
}

function updateRateLimit(headers: Headers) {
  const limit = parseIntegerHeader(headers, "x-ratelimit-limit")
  const remaining = parseIntegerHeader(headers, "x-ratelimit-remaining")
  const reset = parseIntegerHeader(headers, "x-ratelimit-reset")

  rateLimit = {
    limit,
    remaining,
    resetAt: reset ? reset * 1000 : null,
  }

  if (remaining === 0 && rateLimit.resetAt) {
    pausedUntil = Math.max(pausedUntil, rateLimit.resetAt)
  }
}

function timeoutSignal() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  }
}

async function waitForPause() {
  const waitMs = pausedUntil - Date.now()

  if (waitMs > 0) {
    await sleep(waitMs)
  }
}

async function executeAniListRequest<TData, TVariables extends object>(input: {
  query: string
  variables?: TVariables
  accessToken?: string
}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitForPause()

    const timeout = timeoutSignal()

    try {
      const response = await fetch(anilistGraphQlUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(input.accessToken
            ? { authorization: `Bearer ${input.accessToken}` }
            : {}),
        },
        body: JSON.stringify({
          query: input.query,
          variables: input.variables,
        }),
        signal: timeout.signal,
      })

      updateRateLimit(response.headers)

      if (response.status === 429) {
        const waitMs =
          readRetryAfterMs(response.headers) ??
          (rateLimit.resetAt ? rateLimit.resetAt - Date.now() : 60_000)
        pausedUntil = Math.max(pausedUntil, Date.now() + Math.max(waitMs, 0))
        serverLog.warn("Anilist", "Rate limit reached, pausing requests.", {
          waitMs,
          rateLimit,
        })
        continue
      }

      const payload = (await response
        .json()
        .catch(() => null)) as AniListGraphQLResponse<TData> | null

      if (!response.ok) {
        throw new Error(
          `AniList request failed with HTTP ${response.status}: ${
            payload?.errors?.[0]?.message ?? response.statusText
          }`
        )
      }

      if (!payload || payload.errors?.length) {
        const message =
          payload?.errors?.[0]?.message ?? "AniList GraphQL request failed"

        if (/rate|limit|timeout/i.test(message) && attempt === 0) {
          pausedUntil = Math.max(pausedUntil, Date.now() + 60_000)
          serverLog.warn("Anilist", "AniList asked us to pause and retry.", {
            message,
            pausedUntil,
          })
          continue
        }

        throw new Error(message)
      }

      if (!payload.data) {
        throw new Error("AniList response did not include data")
      }

      return payload.data
    } catch (error) {
      if (timeout.signal.aborted && attempt === 0) {
        pausedUntil = Math.max(pausedUntil, Date.now() + 5_000)
        serverLog.warn("Anilist", "AniList request timed out, retrying.", {
          pausedUntil,
        })
        continue
      }

      serverLog.error("Anilist", "AniList request failed.", {
        error,
        rateLimit,
      })
      throw error
    } finally {
      timeout.clear()
    }
  }

  const error = new Error("AniList request was rate limited")
  serverLog.error("Anilist", "AniList request failed.", {
    error,
    rateLimit,
  })
  throw error
}

export function getAniListRateLimitState() {
  return {
    ...rateLimit,
    pausedUntil: pausedUntil > Date.now() ? pausedUntil : null,
  }
}

export function queueAniListOperation<T>(operation: () => Promise<T>) {
  const run = queue.then(async () => {
    await waitForPause()
    return operation()
  })
  queue = run.then(
    () => undefined,
    () => undefined
  )

  return run
}

export function requestAniListGraphQL<
  TData,
  TVariables extends object = Record<string, never>,
>(input: { query: string; variables?: TVariables; accessToken?: string }) {
  return queueAniListOperation(() =>
    executeAniListRequest<TData, TVariables>(input)
  )
}
