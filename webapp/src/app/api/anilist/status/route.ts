import { requireApiUser } from "@/server/auth/api"
import { getAniListTrackingState } from "@/server/anilist/client"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const animeId = Number.parseInt(
    new URL(request.url).searchParams.get("animeId") ?? "",
    10
  )

  if (!Number.isInteger(animeId) || animeId < 1) {
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
    console.warn("[anilist] Tracking lookup failed.", error)
    return Response.json(
      { ok: false, error: "ANILIST_SYNC_FAILED" },
      { status: 502 }
    )
  }
}
