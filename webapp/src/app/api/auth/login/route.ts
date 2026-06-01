import { z } from "zod"

import { requireSameOriginRequest } from "@/server/auth/api"
import { createSession, setSessionCookie } from "@/server/auth/session"
import {
  hashPassword,
  isStrongPassword,
  verifyPassword,
} from "@/server/auth/password"
import { getUser, setUserPasswordHash } from "@/server/db/users"
import { isSecureRequest } from "@/server/http/request"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1024),
})

export async function POST(request: Request) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  if (!(await isSecureRequest(request))) {
    return Response.json(
      { ok: false, error: "SECURE_CONTEXT_REQUIRED" },
      { status: 400 }
    )
  }

  const body = await request.json().catch(() => null)
  const parsed = loginSchema.safeParse(body)

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_LOGIN_PAYLOAD" },
      { status: 400 }
    )
  }

  const user = getUser(parsed.data.username)

  if (!user) {
    return Response.json(
      { ok: false, error: "INVALID_CREDENTIALS" },
      { status: 401 }
    )
  }

  if (user.passwordHash) {
    const valid = await verifyPassword(parsed.data.password, user.passwordHash)

    if (!valid) {
      return Response.json(
        { ok: false, error: "INVALID_CREDENTIALS" },
        { status: 401 }
      )
    }
  } else {
    if (!isStrongPassword(parsed.data.password)) {
      return Response.json(
        { ok: false, error: "WEAK_PASSWORD" },
        { status: 400 }
      )
    }

    const passwordHash = await hashPassword(parsed.data.password)
    setUserPasswordHash(user.username, passwordHash)
  }

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
    },
  })
}
