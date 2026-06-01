import { z } from "zod"

import { requireSameOriginRequest } from "@/server/auth/api"
import { createSession, setSessionCookie } from "@/server/auth/session"
import { hashPassword, isStrongPassword } from "@/server/auth/password"
import { createUser, hasAnyUsers } from "@/server/db/users"
import { isSecureRequest } from "@/server/http/request"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9._-]+$/i),
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

  if (hasAnyUsers()) {
    return Response.json(
      { ok: false, error: "REGISTRATION_CLOSED" },
      { status: 403 }
    )
  }

  const body = await request.json().catch(() => null)
  const parsed = registerSchema.safeParse(body)

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_REGISTER_PAYLOAD" },
      { status: 400 }
    )
  }

  if (!isStrongPassword(parsed.data.password)) {
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

  await setSessionCookie(session.token, session.expires)

  return Response.json({
    ok: true,
    user: {
      username: user.username,
      isAdmin: user.isAdmin,
    },
  })
}
