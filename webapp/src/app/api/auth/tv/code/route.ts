import { randomBytes } from "node:crypto"

import { requireSameOriginRequest } from "@/server/auth/api"
import { createTvAuthCode } from "@/server/db/tvAuthCodes"
import { getPublicBaseUrl, isSecureRequest } from "@/server/http/request"
import { guardAuthRequest } from "@/server/security/abuseGuard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function createLoginCode() {
  return randomBytes(16).toString("base64url")
}

export async function POST(request: Request) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const abuseError = await guardAuthRequest(request)

  if (abuseError) {
    return abuseError
  }

  if (!(await isSecureRequest(request))) {
    return Response.json(
      { ok: false, error: "SECURE_CONTEXT_REQUIRED" },
      { status: 400 }
    )
  }

  const code = createLoginCode()
  const { expiresAt } = createTvAuthCode({
    code,
    deviceUserAgent: request.headers.get("user-agent"),
  })
  const baseUrl = await getPublicBaseUrl(request)

  return Response.json({
    ok: true,
    code,
    url: `${baseUrl}/auth/code/${code}`,
    expiresAt,
    pollAfterMs: 2_000,
  })
}
