import { z } from "zod"

import { createSession, setSessionCookie } from "@/server/auth/session"
import { hashPasswordProof } from "@/server/auth/password"
import { createUser, hasAnyUsers } from "@/server/db/users"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9._-]+$/i),
  passwordHash: z.string().regex(/^[a-f0-9]{64}$/i),
})

export async function POST(request: Request) {
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

  const passwordHash = await hashPasswordProof(parsed.data.passwordHash)
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
