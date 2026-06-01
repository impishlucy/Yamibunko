import { z } from "zod"

import { requireAdminApiUser } from "@/server/auth/api"
import { createUser, listUsers } from "@/server/db/users"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9._-]+$/i),
  isAdmin: z.boolean().optional(),
})

function serializeUsers() {
  return listUsers().map((user) => ({
    username: user.username,
    isAdmin: user.isAdmin,
    hasPassword: Boolean(user.passwordHash),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }))
}

export async function GET() {
  const auth = await requireAdminApiUser()

  if (!auth.ok) {
    return auth.response
  }

  return Response.json({
    users: serializeUsers(),
  })
}

export async function POST(request: Request) {
  const auth = await requireAdminApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const body = await request.json().catch(() => null)
  const parsed = createUserSchema.safeParse(body)

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_USER_PAYLOAD" },
      { status: 400 }
    )
  }

  try {
    createUser({
      username: parsed.data.username,
      isAdmin: parsed.data.isAdmin ?? false,
      passwordHash: null,
    })
  } catch {
    return Response.json(
      { ok: false, error: "USER_ALREADY_EXISTS" },
      { status: 409 }
    )
  }

  return Response.json({
    ok: true,
    users: serializeUsers(),
  })
}
