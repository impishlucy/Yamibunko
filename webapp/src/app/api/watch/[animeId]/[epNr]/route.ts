import { getAnimeInfo, getEpisode } from "@/server/media/libraryStore"
import { requireApiUser } from "@/server/auth/api"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type WatchContext = {
  params: Promise<{
    animeId: string
    epNr: string
  }>
}

export async function GET(_request: Request, context: WatchContext) {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const { animeId, epNr } = await context.params
  const episodeNumber = Number.parseInt(epNr, 10)

  if (!Number.isInteger(episodeNumber) || episodeNumber < 1) {
    return Response.json({ error: "Episode not found" }, { status: 404 })
  }

  const anime = getAnimeInfo(animeId)
  const episode = getEpisode(animeId, episodeNumber)

  if (!anime || !episode) {
    return Response.json({ error: "Episode not found" }, { status: 404 })
  }

  const base = `/api/watch/${encodeURIComponent(animeId)}/${episodeNumber}/stream`

  return Response.json({
    anime,
    episode,
    playback: {
      directUrl: `${base}?mode=direct&profile=original`,
      originalTranscodeUrl: `${base}?mode=transcode&profile=original`,
      dataSaverUrl: `${base}?mode=transcode&profile=dataSaver`,
    },
  })
}
