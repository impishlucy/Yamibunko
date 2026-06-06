import { z } from "zod"

import { requireApiUser, requireSameOriginRequest } from "@/server/auth/api"
import { controlServerCast } from "@/server/media/serverCast"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const controlSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("play"),
    sessionId: z.string().trim().min(1).max(120),
  }),
  z.object({
    action: z.literal("pause"),
    sessionId: z.string().trim().min(1).max(120),
  }),
  z.object({
    action: z.literal("stop"),
    sessionId: z.string().trim().min(1).max(120),
  }),
  z.object({
    action: z.literal("seek"),
    sessionId: z.string().trim().min(1).max(120),
    currentTime: z.number().finite().min(0),
  }),
])

export async function POST(request: Request) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const parsed = controlSchema.safeParse(await request.json().catch(() => null))

  if (!parsed.success) {
    return Response.json({ ok: false, error: "BAD_REQUEST" }, { status: 400 })
  }

  try {
    const state = await controlServerCast({
      ...parsed.data,
      username: auth.user.username,
    })

    return Response.json({ ok: true, state })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chromecast command failed."
    return Response.json({ ok: false, error: message }, { status: 502 })
  }
}
