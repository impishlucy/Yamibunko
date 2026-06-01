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

export function resolveEpisodeFile(
  animeId: string,
  seasonNr: string | number,
  epNr: string | number
) {
  const episode = getEpisode(animeId, seasonNr, epNr)

  if (!episode) {
    return null
  }

  const config = getServerConfig()
  const root = path.resolve(config.mediaDir)
  const resolved = path.resolve(episode.filePath)

  if (!assertInsideRoot(root, resolved)) {
    throw new Error(
      "Resolved media path escaped the configured media directory"
    )
  }

  return resolved
}
