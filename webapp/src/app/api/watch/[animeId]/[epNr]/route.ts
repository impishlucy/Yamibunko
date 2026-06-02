import { requireApiUser } from "@/server/auth/api"
import {
  getAnimeInfo,
  getEpisode,
  getEpisodeNeighbors,
} from "@/server/media/libraryStore"
import { joinBaseUrl } from "@/server/http/baseUrl"
import { getPublicBaseUrl } from "@/server/http/request"
import { createCastStreamToken } from "@/server/media/castTokens"
import { parsePositiveInt } from "@/server/utils/format"

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
  const seasonNumber = parsePositiveInt(url.searchParams.get("season") ?? "1")
  const episodeNumber = parsePositiveInt(epNr)

  if (!seasonNumber || !episodeNumber) {
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
  const castBase = joinBaseUrl(await getPublicBaseUrl(), base)
  const castToken = createCastStreamToken({
    username: auth.user.username,
    animeId,
    seasonNumber,
    episodeNumber,
  })
  const castTokenQuery = `castToken=${encodeURIComponent(castToken)}`

  return Response.json({
    anime,
    episode,
    ...neighbors,
    playback: {
      directUrl: `${base}?${commonQuery}&mode=direct&profile=original`,
      originalTranscodeUrl: `${base}?${commonQuery}&mode=transcode&profile=original`,
      dataSaverUrl: `${base}?${commonQuery}&mode=transcode&profile=dataSaver`,
      castDirectUrl: `${castBase}?${commonQuery}&mode=direct&profile=original&${castTokenQuery}`,
      castTranscodeUrl: `${castBase}?${commonQuery}&mode=transcode&profile=original&${castTokenQuery}`,
    },
  })
}
