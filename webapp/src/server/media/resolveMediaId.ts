import path from "node:path"

import { getServerConfig } from "@/server/config"
import { getEpisode } from "@/server/media/libraryStore"

function assertInsideRoot(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  )
}

function getAllowedMediaRoot() {
  const config = getServerConfig()
  const root = config.importEnabled ? config.mediaDir : config.inputDir

  return path.resolve(root)
}

function assertEpisodePathAllowed(candidate: string) {
  const root = getAllowedMediaRoot()

  if (!assertInsideRoot(root, candidate)) {
    throw new Error(
      "Resolved media path escaped the configured media directory"
    )
  }
}

export function resolveEpisodeFile(
  animeId: string,
  seasonNr: string | number,
  epNr: string | number
) {
  const episode = getEpisode(animeId, seasonNr, epNr)

  if (!episode) {
    return null
  }

  const resolved = path.resolve(episode.filePath)
  assertEpisodePathAllowed(resolved)

  return resolved
}

export function resolveEpisodeMedia(
  animeId: string,
  seasonNr: string | number,
  epNr: string | number
) {
  const episode = getEpisode(animeId, seasonNr, epNr)

  if (!episode) {
    return null
  }

  const resolved = path.resolve(episode.filePath)
  assertEpisodePathAllowed(resolved)

  return {
    file: resolved,
    episode,
  }
}
