import { z } from "zod"

import { createSession, setSessionCookie } from "@/server/auth/session"
import { hashPasswordProof, verifyPasswordProof } from "@/server/auth/password"
import { getUser, setUserPasswordHash } from "@/server/db/users"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  passwordHash: z.string().regex(/^[a-f0-9]{64}$/i),
})

export async function POST(request: Request) {
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
    const valid = await verifyPasswordProof(
      parsed.data.passwordHash,
      user.passwordHash
    )

    if (!valid) {
      return Response.json(
        { ok: false, error: "INVALID_CREDENTIALS" },
        { status: 401 }
      )
    }
  } else {
    const passwordHash = await hashPasswordProof(parsed.data.passwordHash)
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
