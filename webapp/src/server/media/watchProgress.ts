import { saveAniListProgress } from "@/server/anilist/client"
import { upsertEpisodeProgress } from "@/server/db/library"
import { getEpisodeNeighbors } from "@/server/media/libraryStore"
import { errorMessage } from "@/server/utils/format"
import {
  getStoredEpisodeWatchedSeconds,
  isEpisodeCompleteByProgress,
} from "@/lib/watch-progress"

const progressSaveIntervalMs = 15_000
const aniListCompletionSyncTtlMs = 10 * 60_000
const aniListCompletionSyncMarks = new Map<string, number>()

type EpisodeProgressTarget = {
  username: string
  animeId: number
  seasonNumber: number
  episodeNumber: number
}

type PlaybackProgressInput = EpisodeProgressTarget & {
  watchedSeconds: number
  durationSeconds?: number | null
  completed?: boolean
}

function cleanupCompletionSyncMarks(now: number) {
  for (const [key, markedAt] of aniListCompletionSyncMarks) {
    if (now - markedAt >= aniListCompletionSyncTtlMs) {
      aniListCompletionSyncMarks.delete(key)
    }
  }
}

async function syncAniListEpisodeCompletion(input: EpisodeProgressTarget) {
  const now = Date.now()
  const key = `${input.username}:${input.animeId}:${input.seasonNumber}:${input.episodeNumber}`

  cleanupCompletionSyncMarks(now)

  if (aniListCompletionSyncMarks.has(key)) {
    return
  }

  aniListCompletionSyncMarks.set(key, now)

  try {
    const neighbors = getEpisodeNeighbors({
      animeId: input.animeId,
      seasonNr: input.seasonNumber,
      epNr: input.episodeNumber,
      username: input.username,
    })

    await saveAniListProgress({
      username: input.username,
      animeId: input.animeId,
      progress: input.episodeNumber,
      completed: !neighbors.nextEpisode,
    })
  } catch (error) {
    aniListCompletionSyncMarks.delete(key)
    console.error(
      `[Error] [Anilist] Progress sync failed - watchProgress.ts - ${errorMessage(error)}`
    )
  }
}

export function saveEpisodePlaybackProgress(input: PlaybackProgressInput) {
  const completed = Boolean(
    input.completed ??
      isEpisodeCompleteByProgress({
        watchedSeconds: input.watchedSeconds,
        durationSeconds: input.durationSeconds,
      })
  )
  const watchedSeconds = getStoredEpisodeWatchedSeconds({
    watchedSeconds: input.watchedSeconds,
    completed,
  })

  upsertEpisodeProgress({
    username: input.username,
    animeId: input.animeId,
    seasonNr: input.seasonNumber,
    epNr: input.episodeNumber,
    watchedSeconds,
    durationSeconds: input.durationSeconds,
    completed,
  })

  if (completed) {
    void syncAniListEpisodeCompletion(input)
  }

  return completed
}

export function createElapsedPlaybackProgressTracker(input: EpisodeProgressTarget & {
  durationSeconds?: number | null
  enabled: boolean
  startSeconds: number
}) {
  if (!input.enabled || !input.durationSeconds || input.durationSeconds <= 0) {
    return {
      markNow: () => undefined,
      stop: () => undefined,
    }
  }

  const startedAt = Date.now()
  let lastSavedAt = 0
  let stopped = false
  let completed = false
  const timer = setInterval(() => markNow(), progressSaveIntervalMs)
  timer.unref?.()

  function currentWatchedSeconds() {
    const elapsedSeconds = (Date.now() - startedAt) / 1000
    return Math.min(
      Math.max(input.startSeconds + elapsedSeconds, 0),
      input.durationSeconds ?? input.startSeconds
    )
  }

  function markNow(force = false) {
    if (stopped || completed) {
      return
    }

    const now = Date.now()

    if (!force && now - lastSavedAt < progressSaveIntervalMs) {
      return
    }

    lastSavedAt = now
    const watchedSeconds = currentWatchedSeconds()
    completed = saveEpisodePlaybackProgress({
      username: input.username,
      animeId: input.animeId,
      seasonNumber: input.seasonNumber,
      episodeNumber: input.episodeNumber,
      watchedSeconds,
      durationSeconds: input.durationSeconds,
    })
  }

  function stop() {
    if (stopped) {
      return
    }

    stopped = true
    clearInterval(timer)

    if (!completed) {
      saveEpisodePlaybackProgress({
        username: input.username,
        animeId: input.animeId,
        seasonNumber: input.seasonNumber,
        episodeNumber: input.episodeNumber,
        watchedSeconds: currentWatchedSeconds(),
        durationSeconds: input.durationSeconds,
      })
    }
  }

  return {
    markNow,
    stop,
  }
}
