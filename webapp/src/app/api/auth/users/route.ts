import { z } from "zod"

import {
  requireAdminApiUser,
  requireSameOriginRequest,
} from "@/server/auth/api"
import { createUser, deleteUser, getUser, listUsers } from "@/server/db/users"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9._-]+$/i),
})

const deleteUserSchema = z.object({
  username: z.string().trim().min(1).max(64),
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
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

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
      isAdmin: false,
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

export async function DELETE(request: Request) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const auth = await requireAdminApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const body = await request.json().catch(() => null)
  const parsed = deleteUserSchema.safeParse(body)

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_USER_PAYLOAD" },
      { status: 400 }
    )
  }

  const target = getUser(parsed.data.username)

  if (!target) {
    return Response.json(
      { ok: false, error: "USER_NOT_FOUND" },
      { status: 404 }
    )
  }

  if (target.isAdmin || target.username === auth.user.username) {
    return Response.json(
      { ok: false, error: "USER_DELETE_FORBIDDEN" },
      { status: 403 }
    )
  }

  deleteUser(target.username)

  return Response.json({
    ok: true,
    users: serializeUsers(),
  })
}
