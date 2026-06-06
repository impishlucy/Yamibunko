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

export async function getHeaderDerivedOrigin(request?: Request) {
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


function parseIpv4(hostname: string) {
  const parts = hostname.split(".")

  if (parts.length !== 4) {
    return null
  }

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return null
    }

    const value = Number(part)

    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null
  })

  if (octets.some((octet) => octet === null)) {
    return null
  }

  return octets as [number, number, number, number]
}

export function isDeviceLocalHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase()

  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true
  }

  const octets = parseIpv4(normalized)

  return octets?.[0] === 127 || octets?.[0] === 0
}

export function isPrivateLanIpv4Host(hostname: string) {
  const octets = parseIpv4(hostname.trim())

  if (!octets) {
    return false
  }

  const [first, second] = octets

  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}


export function isHttpLocalNetworkOrigin(origin: string) {
  try {
    const url = new URL(origin)

    if (url.protocol !== "http:") {
      return false
    }

    return isDeviceLocalHost(url.hostname) || isPrivateLanIpv4Host(url.hostname)
  } catch {
    return false
  }
}

export async function isLocalStreamBandwidthBypassRequest(request: Request) {
  return isHttpLocalNetworkOrigin(await getHeaderDerivedOrigin(request))
}

function isCastReachableOrigin(origin: string) {
  try {
    const url = new URL(origin)

    if (isDeviceLocalHost(url.hostname)) {
      return false
    }

    if (url.protocol === "https:") {
      return true
    }

    return url.protocol === "http:" && isPrivateLanIpv4Host(url.hostname)
  } catch {
    return false
  }
}

export async function getRequestOrigin(request?: Request) {
  if (request) {
    return getHeaderDerivedOrigin(request)
  }

  const configuredBaseUrl = process.env.BASE_URL ?? process.env.APP_BASE_URL

  if (configuredBaseUrl) {
    return new URL(getConfiguredBaseUrl()).origin
  }

  return getHeaderDerivedOrigin()
}

export async function getPublicBaseUrl(request?: Request) {
  const configuredBaseUrl = getConfiguredBaseUrl()

  if (!request) {
    return configuredBaseUrl
  }

  const requestOrigin = await getHeaderDerivedOrigin(request)

  if (isCastReachableOrigin(requestOrigin)) {
    const configuredUrl = new URL(configuredBaseUrl)

    if (isDeviceLocalHost(configuredUrl.hostname)) {
      return requestOrigin
    }
  }

  return configuredBaseUrl
}

function isSecureLocalOrigin(origin: string) {
  try {
    const url = new URL(origin)

    if (url.protocol === "https:") {
      return true
    }

    if (url.protocol !== "http:") {
      return false
    }

    return isDeviceLocalHost(url.hostname) || isPrivateLanIpv4Host(url.hostname)
  } catch {
    return false
  }
}

export async function isSecureRequest(request?: Request) {
  if (request) {
    const browserOrigin = getBrowserRequestOrigin(request)

    if (browserOrigin && isSecureLocalOrigin(browserOrigin)) {
      return true
    }
  }

  return isSecureLocalOrigin(await getHeaderDerivedOrigin(request))
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

export function getBrowserRequestOrigin(request: Request) {
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
  const candidate = getBrowserRequestOrigin(request)

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
