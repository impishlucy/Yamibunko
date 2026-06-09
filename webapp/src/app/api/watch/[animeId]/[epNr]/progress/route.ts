import { z } from "zod"

import { requireApiUser, requireSameOriginRequest } from "@/server/auth/api"
import { getEpisode } from "@/server/media/libraryStore"
import { parsePositiveInt } from "@/server/utils/format"
import { isEpisodeCompleteByProgress } from "@/lib/watch-progress"
import { saveEpisodePlaybackProgress } from "@/server/media/watchProgress"

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

  const animeIdNumber = parsePositiveInt(animeId)
  const episodeNumber = parsePositiveInt(epNr)
  const seasonNumber =
    parsed.data.season ??
    parsePositiveInt(url.searchParams.get("season") ?? "1")

  if (!animeIdNumber || !seasonNumber || !episodeNumber) {
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
    isEpisodeCompleteByProgress({
      watchedSeconds: parsed.data.watchedSeconds,
      durationSeconds,
    })

  saveEpisodePlaybackProgress({
    username: auth.user.username,
    animeId: animeIdNumber,
    seasonNumber,
    episodeNumber,
    watchedSeconds: parsed.data.watchedSeconds,
    durationSeconds,
    completed,
  })

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
