import { getAnimeInfo } from "@/server/media/libraryStore"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
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
