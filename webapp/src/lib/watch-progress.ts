export const episodeCompletionRatio = 0.7

export function isEpisodeCompleteByProgress(input: {
  watchedSeconds: number
  durationSeconds?: number | null
}) {
  const durationSeconds = input.durationSeconds

  return Boolean(
    durationSeconds &&
      durationSeconds > 0 &&
      Number.isFinite(durationSeconds) &&
      input.watchedSeconds / durationSeconds >= episodeCompletionRatio
  )
}

export function getStoredEpisodeWatchedSeconds(input: {
  watchedSeconds: number
  completed: boolean
}) {
  return input.completed ? 0 : Math.max(input.watchedSeconds, 0)
}
