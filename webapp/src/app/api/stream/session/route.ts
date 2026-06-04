import { z } from "zod"

import { requireApiUser, requireSameOriginRequest } from "@/server/auth/api"
import {
  closeActiveStreamsForUser,
  getActiveStreamConflict,
} from "@/server/bandwidth/streamBandwidth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const streamSessionQuerySchema = z.object({
  clientId: z.string().trim().min(8).max(128).optional(),
})

const streamSessionReplaceSchema = z.object({
  action: z.literal("replace"),
})

export async function GET(request: Request) {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const url = new URL(request.url)
  const parsed = streamSessionQuerySchema.safeParse({
    clientId: url.searchParams.get("clientId") ?? undefined,
  })

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_STREAM_SESSION_QUERY" },
      { status: 400 }
    )
  }

  const conflict = getActiveStreamConflict({
    username: auth.user.username,
    clientId: parsed.data.clientId ?? null,
  })

  return Response.json({
    ok: true,
    hasActiveStream: Boolean(conflict),
    activeStream: conflict,
  })
}

export async function POST(request: Request) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const parsed = streamSessionReplaceSchema.safeParse(
    await request.json().catch(() => null)
  )

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_STREAM_SESSION_BODY" },
      { status: 400 }
    )
  }

  closeActiveStreamsForUser(auth.user.username)

  return Response.json({ ok: true })
}
