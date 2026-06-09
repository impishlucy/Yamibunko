import { z } from "zod"

import { requireApiUser, requireSameOriginRequest } from "@/server/auth/api"
import {
  normalizeServerCastCandidates,
  startServerCast,
} from "@/server/media/serverCast"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const textTrackSchema = z.object({
  id: z.number().int().positive(),
  language: z.string().optional(),
  label: z.string().trim().min(1).max(200),
  url: z.string().trim().min(1).max(4000),
})

const trackingSchema = z.object({
  animeId: z.number().int().positive(),
  seasonNumber: z.number().int().positive(),
  episodeNumber: z.number().int().positive(),
})

const candidateSchema = z.object({
  id: z.string().trim().min(1).max(64),
  url: z.string().trim().min(1).max(4000),
  contentType: z.string().trim().min(1).max(120),
  currentTime: z.number().finite().min(0),
  durationSeconds: z.number().finite().positive().optional(),
  sourceStartOffset: z.number().finite().min(0),
  textTrack: textTrackSchema.optional(),
  title: z.string().trim().min(1).max(240).optional(),
  tracking: trackingSchema.optional(),
})

const startSchema = z.object({
  autoplay: z.boolean(),
  candidates: z.array(candidateSchema).min(1).max(3),
  deviceId: z.string().trim().min(1).max(120),
  receiverBaseUrl: z.string().trim().min(1).max(300).optional().nullable(),
})

export async function POST(request: Request) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const parsed = startSchema.safeParse(await request.json().catch(() => null))

  if (!parsed.success) {
    return Response.json({ ok: false, error: "BAD_REQUEST" }, { status: 400 })
  }

  try {
    const result = await startServerCast({
      autoplay: parsed.data.autoplay,
      candidates: normalizeServerCastCandidates(
        request,
        parsed.data.candidates,
        parsed.data.receiverBaseUrl ?? undefined
      ),
      deviceId: parsed.data.deviceId,
      username: auth.user.username,
    })

    return Response.json({ ok: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chromecast failed to start."
    console.error(`[Error] [Cast] Server-side Chromecast start failed - User ${auth.user.username} - ${message}`)
    return Response.json({ ok: false, error: message }, { status: 502 })
  }
}
