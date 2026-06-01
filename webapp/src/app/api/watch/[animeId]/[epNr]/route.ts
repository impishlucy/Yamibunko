import { requireApiUser } from "@/server/auth/api"
import {
  getAnimeInfo,
  getEpisode,
  getEpisodeNeighbors,
} from "@/server/media/libraryStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type WatchContext = {
  params: Promise<{
    animeId: string
    epNr: string
  }>
}

export async function GET(request: Request, context: WatchContext) {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const { animeId, epNr } = await context.params
  const url = new URL(request.url)
  const seasonNumber = Number.parseInt(
    url.searchParams.get("season") ?? "1",
    10
  )
  const episodeNumber = Number.parseInt(epNr, 10)

  if (
    !Number.isInteger(seasonNumber) ||
    !Number.isInteger(episodeNumber) ||
    seasonNumber < 1 ||
    episodeNumber < 1
  ) {
    return Response.json({ error: "Episode not found" }, { status: 404 })
  }

  const anime = getAnimeInfo(animeId)
  const episode = getEpisode(
    animeId,
    seasonNumber,
    episodeNumber,
    auth.user.username
  )

  if (!anime || !episode) {
    return Response.json({ error: "Episode not found" }, { status: 404 })
  }

  const neighbors = getEpisodeNeighbors({
    animeId: anime.id,
    seasonNr: seasonNumber,
    epNr: episodeNumber,
    username: auth.user.username,
  })
  const base = `/api/watch/${encodeURIComponent(animeId)}/${episodeNumber}/stream`
  const commonQuery = `season=${seasonNumber}`

  return Response.json({
    anime,
    episode,
    ...neighbors,
    playback: {
      directUrl: `${base}?${commonQuery}&mode=direct&profile=original`,
      originalTranscodeUrl: `${base}?${commonQuery}&mode=transcode&profile=original`,
      dataSaverUrl: `${base}?${commonQuery}&mode=transcode&profile=dataSaver`,
    },
  })
}
