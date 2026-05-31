import { getAnimeInfo, getEpisodes } from "@/server/media/libraryStore"

export const dynamic = "force-dynamic"

type EpisodesContext = {
  params: Promise<{
    animeId: string
  }>
}

export async function GET(_request: Request, context: EpisodesContext) {
  const { animeId } = await context.params
  const anime = getAnimeInfo(animeId)

  if (!anime) {
    return Response.json({ error: "Anime not found" }, { status: 404 })
  }

  return Response.json(getEpisodes(animeId))
}
