import { requireApiUser } from "@/server/auth/api"
import { getAniListTrackingState } from "@/server/anilist/client"
import { errorMessage, parsePositiveInt } from "@/server/utils/format"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const animeId = parsePositiveInt(
    new URL(request.url).searchParams.get("animeId")
  )

  if (!animeId) {
    return Response.json(
      { ok: false, error: "INVALID_ANIME_ID" },
      { status: 400 }
    )
  }

  try {
    return Response.json(
      await getAniListTrackingState(auth.user.username, animeId)
    )
  } catch (error) {
    console.error(
      `[Error] [Anilist] Tracking lookup failed - status/route.ts - ${errorMessage(error)}`
    )
    return Response.json(
      { ok: false, error: "ANILIST_SYNC_FAILED" },
      { status: 502 }
    )
  }
}
