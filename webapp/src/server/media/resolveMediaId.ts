import path from "node:path"

import { getServerConfig } from "@/server/config"
import { getEpisode } from "@/server/media/libraryStore"

const SAFE_MEDIA_ID = /^[a-z0-9][a-z0-9._ -]*$/i

function assertInsideRoot(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  )
}

export function resolveEpisodeFile(animeId: string, epNr: string | number) {
  const episode = getEpisode(animeId, epNr)

  if (!episode) {
    return null
  }

  if (
    episode.mediaId.includes("/") ||
    episode.mediaId.includes("\\") ||
    episode.mediaId.includes("..") ||
    !SAFE_MEDIA_ID.test(episode.mediaId)
  ) {
    throw new Error("Unsafe media identifier")
  }

  const config = getServerConfig()
  const root = path.resolve(config.mediaDir)
  const resolved = path.resolve(root, episode.mediaId)

  if (!assertInsideRoot(root, resolved)) {
    throw new Error(
      "Resolved media path escaped the configured media directory"
    )
  }

  return resolved
}
