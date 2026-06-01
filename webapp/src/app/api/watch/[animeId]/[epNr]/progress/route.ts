import { z } from "zod"

import { requireApiUser, requireSameOriginRequest } from "@/server/auth/api"
import { saveAniListProgress } from "@/server/anilist/client"
import { upsertEpisodeProgress } from "@/server/db/library"
import { serverLog } from "@/server/logger"
import { getEpisode } from "@/server/media/libraryStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type ProgressContext = {
  params: Promise<{
    animeId: string
    epNr: string
  }>
}

const progressSchema = z.object({
  season: z.number().int().positive().optional(),
  watchedSeconds: z.number().finite().min(0),
  durationSeconds: z.number().finite().positive().optional(),
  completed: z.boolean().optional(),
})

export async function POST(request: Request, context: ProgressContext) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const { animeId, epNr } = await context.params
  const url = new URL(request.url)
  const body = await request.json().catch(() => null)
  const parsed = progressSchema.safeParse(body)

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_PROGRESS_PAYLOAD" },
      { status: 400 }
    )
  }

  const animeIdNumber = Number.parseInt(animeId, 10)
  const episodeNumber = Number.parseInt(epNr, 10)
  const seasonNumber =
    parsed.data.season ??
    Number.parseInt(url.searchParams.get("season") ?? "1", 10)

  if (
    !Number.isInteger(animeIdNumber) ||
    !Number.isInteger(seasonNumber) ||
    !Number.isInteger(episodeNumber) ||
    animeIdNumber < 1 ||
    seasonNumber < 1 ||
    episodeNumber < 1
  ) {
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

  const durationSeconds =
    parsed.data.durationSeconds ?? episode.durationSeconds ?? null
  const completed =
    parsed.data.completed ??
    (durationSeconds
      ? parsed.data.watchedSeconds / durationSeconds >= 0.8
      : false)

  upsertEpisodeProgress({
    username: auth.user.username,
    animeId: animeIdNumber,
    seasonNr: seasonNumber,
    epNr: episodeNumber,
    watchedSeconds: parsed.data.watchedSeconds,
    durationSeconds,
    completed,
  })

  if (completed) {
    await saveAniListProgress({
      username: auth.user.username,
      animeId: animeIdNumber,
      progress: episodeNumber,
    }).catch((error) => {
      serverLog.error("Anilist", "Progress sync failed.", { error })
    })
  }

  return Response.json({
    ok: true,
    episode: getEpisode(
      animeIdNumber,
      seasonNumber,
      episodeNumber,
      auth.user.username
    ),
  })
}
