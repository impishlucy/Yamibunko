import { z } from "zod"

import { saveAniListProgress } from "@/server/anilist/client"
import { requireApiUser, requireSameOriginRequest } from "@/server/auth/api"
import { setEpisodeWatchState } from "@/server/db/library"
import { getEpisode } from "@/server/media/libraryStore"
import { errorMessage, parsePositiveInt } from "@/server/utils/format"

import { getStartupBlockedResponse } from "@/server/startup/requestGuard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type WatchStateContext = {
  params: Promise<{
    animeId: string
    epNr: string
  }>
}

const watchStateSchema = z.object({
  season: z.number().int().positive(),
  watched: z.boolean(),
})

export async function POST(request: Request, context: WatchStateContext) {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const { animeId, epNr } = await context.params
  const body = await request.json().catch(() => null)
  const parsed = watchStateSchema.safeParse(body)

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_WATCH_STATE_PAYLOAD" },
      { status: 400 }
    )
  }

  const animeIdNumber = parsePositiveInt(animeId)
  const episodeNumber = parsePositiveInt(epNr)
  const seasonNumber = parsed.data.season

  if (!animeIdNumber || !episodeNumber) {
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 })
  }

  const episode = getEpisode(
    animeIdNumber,
    seasonNumber,
    episodeNumber,
    auth.user.username
  )

  if (!episode) {
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 })
  }

  const result = setEpisodeWatchState({
    username: auth.user.username,
    animeId: animeIdNumber,
    seasonNr: seasonNumber,
    epNr: episodeNumber,
    watched: parsed.data.watched,
  })

  const anilistEntry = await saveAniListProgress({
    username: auth.user.username,
    animeId: animeIdNumber,
    progress: result.anilistProgress,
    completed: parsed.data.watched && result.completedSeason,
    allowProgressDecrease: !parsed.data.watched,
    updateLocalProgress: false,
  }).catch((error) => {
    console.error(
      `[Error] [Anilist] Manual watch state sync failed - watch-state/route.ts - ${errorMessage(error)}`
    )
    return null
  })

  return Response.json({
    ok: true,
    affectedEpisodes: result.affectedEpisodes,
    anilistConnected: Boolean(anilistEntry),
  })
}
