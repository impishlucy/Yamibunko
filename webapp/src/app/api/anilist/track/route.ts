import { z } from "zod"

import { isLocalNonAnimeId } from "@/lib/local-media"
import { requireApiUser, requireSameOriginRequest } from "@/server/auth/api"
import {
  saveAniListProgress,
  saveAniListRating,
} from "@/server/anilist/client"
import { errorMessage } from "@/server/utils/format"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const trackSchema = z.object({
  animeId: z.number().int().positive(),
  progress: z.number().int().min(0).default(0),
  rating: z.number().int().positive().optional(),
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

  const body = await request.json().catch(() => null)
  const parsed = trackSchema.safeParse(body)

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_TRACK_PAYLOAD" },
      { status: 400 }
    )
  }

  if (isLocalNonAnimeId(parsed.data.animeId)) {
    return Response.json(
      { ok: false, error: "LOCAL_MEDIA_NOT_ANILIST" },
      { status: 400 }
    )
  }

  const entry = await (parsed.data.rating
    ? saveAniListRating({
        username: auth.user.username,
        animeId: parsed.data.animeId,
        rating: parsed.data.rating,
      })
    : saveAniListProgress({
        username: auth.user.username,
        animeId: parsed.data.animeId,
        progress: parsed.data.progress,
      })
  ).catch((error) => {
    console.error(
      `[Error] [Anilist] Sync failed - track/route.ts - ${errorMessage(error)}`
    )
    return "sync-failed" as const
  })

  if (entry === "sync-failed") {
    return Response.json(
      { ok: false, error: "ANILIST_SYNC_FAILED" },
      { status: 502 }
    )
  }

  if (!entry) {
    return Response.json(
      { ok: false, error: "ANILIST_NOT_CONNECTED" },
      { status: 400 }
    )
  }

  return Response.json({ ok: true, entry })
}
