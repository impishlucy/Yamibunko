import { headers } from "next/headers"

import { allowedDevOrigins } from "@/lib/allowed-dev-origins"
import { normalizeBaseUrl } from "@/server/http/baseUrl"

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim() ?? null
}

export function getConfiguredBaseUrl() {
  return normalizeBaseUrl(
    process.env.BASE_URL ?? process.env.APP_BASE_URL ?? ""
  )
}

function forwardedHeaderPart(headerValue: string | null, key: string) {
  const first = firstForwardedValue(headerValue)

  if (!first) {
    return null
  }

  for (const part of first.split(";")) {
    const [partKey, rawValue] = part.split("=")

    if (partKey?.trim().toLowerCase() === key) {
      return rawValue?.trim().replace(/^"|"$/g, "") ?? null
    }
  }

  return null
}

async function getHeaderDerivedOrigin(request?: Request) {
  const headerStore = await headers()
  const forwarded = headerStore.get("forwarded")
  const proto =
    forwardedHeaderPart(forwarded, "proto") ??
    firstForwardedValue(headerStore.get("x-forwarded-proto")) ??
    new URL(request?.url ?? "http://localhost").protocol.replace(":", "")
  const host =
    forwardedHeaderPart(forwarded, "host") ??
    firstForwardedValue(headerStore.get("x-forwarded-host")) ??
    headerStore.get("host") ??
    new URL(request?.url ?? "http://localhost").host

  return `${proto}://${host}`
}

export async function getRequestOrigin(request?: Request) {
  const configuredBaseUrl = process.env.BASE_URL ?? process.env.APP_BASE_URL

  if (configuredBaseUrl) {
    return new URL(getConfiguredBaseUrl()).origin
  }

  return getHeaderDerivedOrigin(request)
}

export async function getPublicBaseUrl() {
  return getConfiguredBaseUrl()
}

export async function isSecureRequest(request?: Request) {
  const origin = await getRequestOrigin(request)
  const url = new URL(origin)

  if (url.protocol === "https:") {
    return true
  }

  return ["localhost", "127.0.0.1", "::1"].includes(
    url.hostname
  )
}

function sameOrigin(left: string, right: string) {
  try {
    const leftUrl = new URL(left)
    const rightUrl = new URL(right)

    return (
      leftUrl.protocol === rightUrl.protocol &&
      leftUrl.host.toLowerCase() === rightUrl.host.toLowerCase()
    )
  } catch {
    return false
  }
}

function candidateRequestOrigin(request: Request) {
  const origin = firstForwardedValue(request.headers.get("origin"))

  if (origin) {
    return origin
  }

  const referer = firstForwardedValue(request.headers.get("referer"))

  if (!referer) {
    return null
  }

  try {
    return new URL(referer).origin
  } catch {
    return null
  }
}

function allowedDevOriginMatches(candidate: string) {
  if (process.env.NODE_ENV === "production" || allowedDevOrigins.length === 0) {
    return false
  }

  let candidateUrl: URL

  try {
    candidateUrl = new URL(candidate)
  } catch {
    return false
  }

  return allowedDevOrigins.some((allowedOrigin) => {
    const value = allowedOrigin.trim()

    if (!value) {
      return false
    }

    const hasProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    const normalizedAllowed = hasProtocol ? value : `http://${value}`

    try {
      const allowedUrl = new URL(normalizedAllowed)
      const hostnameMatches = allowedUrl.hostname.startsWith("*.")
        ? candidateUrl.hostname.endsWith(allowedUrl.hostname.slice(1))
        : candidateUrl.hostname === allowedUrl.hostname
      const portMatches = allowedUrl.port
        ? candidateUrl.port === allowedUrl.port
        : true
      const protocolMatches = hasProtocol
        ? candidateUrl.protocol === allowedUrl.protocol
        : true

      return hostnameMatches && portMatches && protocolMatches
    } catch {
      return false
    }
  })
}

function requestUrlOrigin(request: Request) {
  try {
    return new URL(request.url).origin
  } catch {
    return null
  }
}

export async function isSameOriginRequest(request: Request) {
  const candidate = candidateRequestOrigin(request)

  if (!candidate) {
    return true
  }

  const expectedOrigins = new Set<string>()
  const actualRequestOrigin = requestUrlOrigin(request)

  if (actualRequestOrigin) {
    expectedOrigins.add(actualRequestOrigin)
  }

  expectedOrigins.add(await getHeaderDerivedOrigin(request))

  const configuredBaseUrl = process.env.BASE_URL ?? process.env.APP_BASE_URL
  if (configuredBaseUrl) {
    expectedOrigins.add(new URL(getConfiguredBaseUrl()).origin)
  }

  return (
    Array.from(expectedOrigins).some((origin) => sameOrigin(candidate, origin)) ||
    allowedDevOriginMatches(candidate)
  )
}
