import { z } from "zod"

import { isStrongPassword, maxPasswordLength } from "@/lib/password-policy"
import { requireSameOriginRequest } from "@/server/auth/api"
import { hashPassword } from "@/server/auth/password"
import { createSession, setSessionCookie } from "@/server/auth/session"
import { createUser, hasAnyUsers } from "@/server/db/users"
import { isSecureRequest } from "@/server/http/request"
import {
  guardAuthRequest,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/server/security/abuseGuard"
import { usernameSchema } from "@/server/security/input"

import { getStartupBlockedResponse } from "@/server/startup/requestGuard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const registerSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(maxPasswordLength),
})

export async function POST(request: Request) {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const abuseError = await guardAuthRequest(request)

  if (abuseError) {
    return abuseError
  }

  if (!(await isSecureRequest(request))) {
    await recordAuthFailure({
      request,
      reason: "insecure-context",
    })

    return Response.json(
      { ok: false, error: "SECURE_CONTEXT_REQUIRED" },
      { status: 400 }
    )
  }

  if (hasAnyUsers()) {
    return Response.json(
      { ok: false, error: "REGISTRATION_CLOSED" },
      { status: 403 }
    )
  }

  const body = await request.json().catch(() => null)
  const parsed = registerSchema.safeParse(body)

  if (!parsed.success) {
    await recordAuthFailure({
      request,
      reason: "invalid-register-payload",
    })

    return Response.json(
      { ok: false, error: "INVALID_REGISTER_PAYLOAD" },
      { status: 400 }
    )
  }

  if (!isStrongPassword(parsed.data.password)) {
    await recordAuthFailure({
      request,
      username: parsed.data.username,
      reason: "weak-password-registration",
    })

    return Response.json({ ok: false, error: "WEAK_PASSWORD" }, { status: 400 })
  }

  const passwordHash = await hashPassword(parsed.data.password)
  const user = createUser({
    username: parsed.data.username,
    passwordHash,
    isAdmin: true,
  })
  const session = await createSession(
    user.username,
    request.headers.get("user-agent")
  )

  await recordAuthSuccess(request, user.username)
  await setSessionCookie(session.token, session.expires, request)

  return Response.json({
    ok: true,
    user: {
      username: user.username,
      isAdmin: user.isAdmin,
      isVip: user.isVip,
    },
  })
}
