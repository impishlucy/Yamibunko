import { z } from "zod"

import { isStrongPassword, maxPasswordLength } from "@/lib/password-policy"
import { requireSameOriginRequest } from "@/server/auth/api"
import { hashPassword, verifyPassword } from "@/server/auth/password"
import { createSession, setSessionCookie } from "@/server/auth/session"
import { getUser, setUserPasswordHash } from "@/server/db/users"
import { isSecureRequest } from "@/server/http/request"
import {
  guardAuthRequest,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/server/security/abuseGuard"
import { usernameSchema } from "@/server/security/input"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(maxPasswordLength),
})

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
    await recordAuthFailure({
      request,
      reason: "insecure-context",
    })

    return Response.json(
      { ok: false, error: "SECURE_CONTEXT_REQUIRED" },
      { status: 400 }
    )
  }

  const body = await request.json().catch(() => null)
  const parsed = loginSchema.safeParse(body)

  if (!parsed.success) {
    await recordAuthFailure({
      request,
      reason: "invalid-login-payload",
    })

    return Response.json(
      { ok: false, error: "INVALID_LOGIN_PAYLOAD" },
      { status: 400 }
    )
  }

  const user = getUser(parsed.data.username)

  if (!user) {
    await recordAuthFailure({
      request,
      username: parsed.data.username,
      reason: "invalid-credentials",
    })

    return Response.json(
      { ok: false, error: "INVALID_CREDENTIALS" },
      { status: 401 }
    )
  }

  if (user.passwordHash) {
    const valid = await verifyPassword(parsed.data.password, user.passwordHash)

    if (!valid) {
      await recordAuthFailure({
        request,
        username: user.username,
        reason: "invalid-credentials",
      })

      return Response.json(
        { ok: false, error: "INVALID_CREDENTIALS" },
        { status: 401 }
      )
    }
  } else {
    if (!isStrongPassword(parsed.data.password)) {
      await recordAuthFailure({
        request,
        username: user.username,
        reason: "weak-password-setup",
      })

      return Response.json(
        { ok: false, error: "WEAK_PASSWORD" },
        { status: 400 }
      )
    }

    const passwordHash = await hashPassword(parsed.data.password)
    setUserPasswordHash(user.username, passwordHash)
  }

  await recordAuthSuccess(request, user.username)

  const session = await createSession(
    user.username,
    request.headers.get("user-agent")
  )
  await setSessionCookie(session.token, session.expires)

  return Response.json({
    ok: true,
    user: {
      username: user.username,
      isAdmin: user.isAdmin,
      isVip: user.isVip,
    },
  })
}
