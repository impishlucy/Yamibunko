import { headers } from "next/headers"

import { getServerConfigResult } from "@/server/config"

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim() ?? null
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

export async function getRequestOrigin(request?: Request) {
  const configured = getServerConfigResult()

  if (configured.ok && configured.config.baseUrl) {
    return new URL(configured.config.baseUrl).origin
  }

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

export async function isSecureRequest(request?: Request) {
  const origin = await getRequestOrigin(request)
  const url = new URL(origin)

  if (url.protocol === "https:") {
    return true
  }

  return ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
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

export async function isSameOriginRequest(request: Request) {
  const expectedOrigin = await getRequestOrigin(request)
  const origin = firstForwardedValue(request.headers.get("origin"))

  if (origin) {
    return sameOrigin(origin, expectedOrigin)
  }

  const referer = firstForwardedValue(request.headers.get("referer"))

  if (referer) {
    return sameOrigin(referer, expectedOrigin)
  }

  return true
}
