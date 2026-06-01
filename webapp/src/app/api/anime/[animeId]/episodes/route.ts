import { getAnimeInfo, getEpisodes } from "@/server/media/libraryStore"
import { requireApiUser } from "@/server/auth/api"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type EpisodesContext = {
  params: Promise<{
    animeId: string
  }>
}

export async function GET(_request: Request, context: EpisodesContext) {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const { animeId } = await context.params
  const anime = getAnimeInfo(animeId)

  if (!anime) {
    return Response.json({ error: "Anime not found" }, { status: 404 })
  }

  return Response.json(getEpisodes(animeId))
}
