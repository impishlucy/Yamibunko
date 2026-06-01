import { z } from "zod"

import { requireApiUser, requireSameOriginRequest } from "@/server/auth/api"
import { hashPassword, isStrongPassword } from "@/server/auth/password"
import { setUserPasswordHash } from "@/server/db/users"
import { isSecureRequest } from "@/server/http/request"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const passwordSchema = z.object({
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

  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const body = await request.json().catch(() => null)
  const parsed = passwordSchema.safeParse(body)

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_PASSWORD_PAYLOAD" },
      { status: 400 }
    )
  }

  if (!isStrongPassword(parsed.data.password)) {
    return Response.json({ ok: false, error: "WEAK_PASSWORD" }, { status: 400 })
  }

  const passwordHash = await hashPassword(parsed.data.password)
  setUserPasswordHash(auth.user.username, passwordHash)

  return Response.json({ ok: true })
}
