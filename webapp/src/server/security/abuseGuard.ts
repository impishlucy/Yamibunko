import { headers } from "next/headers"

import { sanitizeLogText } from "@/server/security/input"

type GuardKind = "api" | "auth"

type RateBucket = {
  count: number
  resetAt: number
}

type BanEntry = {
  reason: string
  expiresAt: number
  createdAt: number
}

type GuardOptions = {
  kind: GuardKind
  count?: boolean
}

const banDurationMs = 2 * 60 * 60 * 1000
const apiWindowMs = 60 * 1000
const authWindowMs = 60 * 1000
const authFailureWindowMs = 15 * 60 * 1000
const apiMaxRequestsPerWindow = 600
const authMaxRequestsPerWindow = 40
const authIpFailureLimit = 10
const authIdentityFailureLimit = 6

const requestBuckets = new Map<string, RateBucket>()
const authFailures = new Map<string, RateBucket>()
const bannedClients = new Map<string, BanEntry>()

function firstHeaderValue(value: string | null) {
  return value?.split(",")[0]?.trim() ?? null
}

function normalizeIp(value: string | null) {
  const trimmed = value?.trim()

  if (!trimmed) {
    return null
  }

  return trimmed.replace(/^\[|]$/g, "")
}

async function getRequestHeaders(request?: Request) {
  if (request) {
    return request.headers
  }

  return await headers()
}

export async function getClientAddress(request?: Request) {
  const headerStore = await getRequestHeaders(request)

  return (
    normalizeIp(firstHeaderValue(headerStore.get("cf-connecting-ip"))) ??
    normalizeIp(firstHeaderValue(headerStore.get("x-real-ip"))) ??
    normalizeIp(firstHeaderValue(headerStore.get("x-forwarded-for"))) ??
    "unknown"
  )
}

function getUserAgent(request: Request) {
  return sanitizeLogText(request.headers.get("user-agent") ?? "unknown", 500)
}

function cleanup(now = Date.now()) {
  for (const [key, entry] of bannedClients) {
    if (entry.expiresAt <= now) {
      bannedClients.delete(key)
    }
  }

  for (const [key, bucket] of requestBuckets) {
    if (bucket.resetAt <= now) {
      requestBuckets.delete(key)
    }
  }

  for (const [key, bucket] of authFailures) {
    if (bucket.resetAt <= now) {
      authFailures.delete(key)
    }
  }
}

function retryAfterSeconds(expiresAt: number) {
  return Math.max(Math.ceil((expiresAt - Date.now()) / 1000), 1)
}

function blockedResponse(entry: BanEntry) {
  return Response.json(
    { ok: false, error: "CLIENT_BLOCKED" },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds(entry.expiresAt)),
      },
    }
  )
}

async function banClient(input: {
  ip: string
  reason: string
  request?: Request
}) {
  const now = Date.now()
  const existing = bannedClients.get(input.ip)
  const expiresAt = now + banDurationMs

  if (existing && existing.expiresAt > now) {
    return existing
  }

  const entry: BanEntry = {
    reason: input.reason,
    expiresAt,
    createdAt: now,
  }

  bannedClients.set(input.ip, entry)

  console.warn(
    `[Warn] [Security] Temporarily blocked client - abuseGuard.ts - IP ${
      input.ip
    } - Reason ${sanitizeLogText(input.reason, 250)} - User-Agent ${
      input.request ? getUserAgent(input.request) : "unknown"
    }`
  )


  return entry
}

function incrementBucket(key: string, windowMs: number, now = Date.now()) {
  const bucket = requestBuckets.get(key)

  if (!bucket || bucket.resetAt <= now) {
    const next = {
      count: 1,
      resetAt: now + windowMs,
    }

    requestBuckets.set(key, next)
    return next
  }

  bucket.count += 1
  return bucket
}

function incrementFailure(key: string, now = Date.now()) {
  const bucket = authFailures.get(key)

  if (!bucket || bucket.resetAt <= now) {
    const next = {
      count: 1,
      resetAt: now + authFailureWindowMs,
    }

    authFailures.set(key, next)
    return next
  }

  bucket.count += 1
  return bucket
}

export async function guardRequest(
  request: Request | undefined,
  options: GuardOptions
) {
  const now = Date.now()

  cleanup(now)

  const ip = await getClientAddress(request)
  const ban = bannedClients.get(ip)

  if (ban && ban.expiresAt > now) {
    return blockedResponse(ban)
  }

  if (options.count === false) {
    return null
  }

  const windowMs = options.kind === "auth" ? authWindowMs : apiWindowMs
  const maxRequests =
    options.kind === "auth" ? authMaxRequestsPerWindow : apiMaxRequestsPerWindow
  const bucket = incrementBucket(`${options.kind}:${ip}`, windowMs, now)

  if (bucket.count > maxRequests) {
    return blockedResponse(
      await banClient({
        ip,
        reason: `${options.kind}-rate-limit`,
        request,
      })
    )
  }

  return null
}

export async function guardApiRequest(request?: Request) {
  return guardRequest(request, { kind: "api" })
}

export async function guardAuthRequest(request: Request) {
  return guardRequest(request, { kind: "auth" })
}

export async function recordBadOrigin(request: Request) {
  const ip = await getClientAddress(request)
  const bucket = incrementFailure(`origin:${ip}`)

  if (bucket.count >= 5) {
    await banClient({
      ip,
      reason: "bad-origin",
      request,
    })
  }
}

export async function recordAuthFailure(input: {
  request: Request
  username?: string | null
  reason: string
}) {
  const ip = await getClientAddress(input.request)
  const safeUsername = input.username
    ? sanitizeLogText(input.username, 80).toLowerCase()
    : "unknown"
  const ipBucket = incrementFailure(`auth-ip:${ip}`)
  const identityBucket = incrementFailure(`auth-id:${ip}:${safeUsername}`)

  if (
    ipBucket.count >= authIpFailureLimit ||
    identityBucket.count >= authIdentityFailureLimit
  ) {
    await banClient({
      ip,
      reason: `auth-failures:${sanitizeLogText(input.reason, 80)}`,
      request: input.request,
    })
  }
}

export async function recordAuthSuccess(request: Request, username: string) {
  const ip = await getClientAddress(request)
  const safeUsername = sanitizeLogText(username, 80).toLowerCase()

  authFailures.delete(`auth-id:${ip}:${safeUsername}`)
}
