import { getAnimeInfo } from "@/server/media/libraryStore"
import { requireApiUser } from "@/server/auth/api"

import { getStartupBlockedResponse } from "@/server/startup/requestGuard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const animeId = new URL(request.url).searchParams.get("animeId")

  if (!animeId) {
    return Response.json({ error: "animeId is required" }, { status: 400 })
  }

  const anime = getAnimeInfo(animeId)

  if (!anime) {
    return Response.json({ error: "Anime not found" }, { status: 404 })
  }

  return Response.json(anime)
}
