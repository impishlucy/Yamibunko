import { requireApiUser } from "@/server/auth/api"
import { getServerConfig } from "@/server/config"
import {
  getAnimeInfo,
  getEpisode,
  getEpisodeNeighbors,
} from "@/server/media/libraryStore"
import { joinBaseUrl } from "@/server/http/baseUrl"
import { getPublicBaseUrl } from "@/server/http/request"
import { createCastStreamToken } from "@/server/media/castTokens"
import { ffprobe } from "@/server/media/ffmpeg"
import type { ProbeResult } from "@/server/media/mediaFiles"
import { resolveEpisodeMedia } from "@/server/media/resolveMediaId"
import { getMediaStreamMetadata } from "@/server/media/streamMetadata"
import { errorMessage, parsePositiveInt } from "@/server/utils/format"

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

  const media = resolveEpisodeMedia(animeId, seasonNumber, episodeNumber)

  if (!media) {
    return Response.json({ error: "Episode not found" }, { status: 404 })
  }

  let streamMetadata

  try {
    streamMetadata = getMediaStreamMetadata(
      (await ffprobe(media.file)) as ProbeResult
    )
  } catch (error) {
    console.error(
      `[Error] [Watch] Unable to inspect media streams - route.ts - Anime ${animeId}, Season ${seasonNumber}, Episode ${episodeNumber} - ${errorMessage(error)}`
    )
    streamMetadata = {
      audioStreams: [],
      subtitleStreams: [],
      defaultAudioStreamId: null,
      defaultSubtitleStreamId: null,
      directAudioStreamId: null,
    }
  }

  const config = getServerConfig()
  const liveTranscodeEnabled = config.transcodeAccel !== "cpu"
  const neighbors = getEpisodeNeighbors({
    animeId: anime.id,
    seasonNr: seasonNumber,
    epNr: episodeNumber,
    username: auth.user.username,
  })
  const base = `/api/watch/${encodeURIComponent(animeId)}/${episodeNumber}/stream`
  const subtitleBase = `/api/watch/${encodeURIComponent(animeId)}/${episodeNumber}/subtitles`
  const commonQuery = `season=${seasonNumber}`
  const publicBaseUrl = await getPublicBaseUrl(request)
  const castBase = joinBaseUrl(publicBaseUrl, base)
  const castSubtitleBase = joinBaseUrl(publicBaseUrl, subtitleBase)
  const castToken = createCastStreamToken({
    username: auth.user.username,
    sessionTokenHash: auth.sessionTokenHash,
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
      castDataSaverUrl: `${castBase}?${commonQuery}&mode=transcode&profile=dataSaver&${castTokenQuery}`,
      liveTranscodeEnabled,
      importEnabled: config.importEnabled,
      subtitleUrl: `${subtitleBase}?${commonQuery}`,
      castSubtitleUrl: `${castSubtitleBase}?${commonQuery}&${castTokenQuery}`,
    },
    media: streamMetadata,
  })
}
