import { z } from "zod"

import {
  requireApiUser,
  requireSameOriginRequest,
} from "@/server/auth/api"
import { createSession, setSessionCookie } from "@/server/auth/session"
import {
  approveTvAuthCode,
  consumeApprovedTvAuthCode,
  getTvAuthCodeStatus,
} from "@/server/db/tvAuthCodes"
import { isSecureRequest } from "@/server/http/request"
import { guardApiRequest } from "@/server/security/abuseGuard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const codeSchema = z.string().min(12).max(96).regex(/^[A-Za-z0-9_-]+$/)

type RouteContext = {
  params: Promise<{
    code: string
  }>
}

async function readCode(context: RouteContext) {
  const params = await context.params
  const parsed = codeSchema.safeParse(params.code)

  return parsed.success ? parsed.data : null
}

export async function GET(request: Request, context: RouteContext) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const abuseError = await guardApiRequest(request)

  if (abuseError) {
    return abuseError
  }

  if (!(await isSecureRequest(request))) {
    return Response.json(
      { ok: false, error: "SECURE_CONTEXT_REQUIRED" },
      { status: 400 }
    )
  }

  const code = await readCode(context)

  if (!code) {
    return Response.json({ ok: false, error: "INVALID_CODE" }, { status: 400 })
  }

  const approvedUsername = consumeApprovedTvAuthCode(code)

  if (approvedUsername) {
    const session = await createSession(
      approvedUsername,
      request.headers.get("user-agent")
    )
    await setSessionCookie(session.token, session.expires, request)

    return Response.json({ ok: true, status: "approved" })
  }

  const status = getTvAuthCodeStatus(code)

  if (status === "missing" || status === "expired") {
    return Response.json({ ok: true, status: "expired" })
  }

  return Response.json({ ok: true, status })
}

export async function POST(request: Request, context: RouteContext) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const auth = await requireApiUser(request)

  if (!auth.ok) {
    return auth.response
  }

  const code = await readCode(context)

  if (!code) {
    return Response.json({ ok: false, error: "INVALID_CODE" }, { status: 400 })
  }

  const approved = approveTvAuthCode(code, auth.user.username)

  if (!approved) {
    const status = getTvAuthCodeStatus(code)

    return Response.json(
      { ok: false, error: status === "expired" ? "CODE_EXPIRED" : "CODE_NOT_FOUND" },
      { status: status === "expired" ? 410 : 404 }
    )
  }

  return Response.json({ ok: true })
}
