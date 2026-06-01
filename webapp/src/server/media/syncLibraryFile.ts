import { rm } from "node:fs/promises"
import path from "node:path"

import {
  deleteEpisodeByPath,
  findAnimeByTitle,
  upsertAnime,
  upsertEpisode,
} from "@/server/db/library"
import { getServerConfig } from "@/server/config"
import { serverLog } from "@/server/logger"
import { ffprobe } from "@/server/media/ffmpeg"
import { parseAnimeFileName, sanitizePathPart } from "@/server/media/filename"
import {
  generateEpisodeThumbnail,
  isMediaFile,
  parseDurationSeconds,
  pathExists,
  thumbnailPathForEpisode,
  type ProbeResult,
  waitForStableFile,
} from "@/server/media/mediaFiles"
import { findAnimeMetadata } from "@/server/metadata/anilist"

type ParsedLibraryPath = {
  animeTitle: string
  season: number
  episode: number
}

function parseSeasonFolder(value: string) {
  const match = /^season\s*(\d{1,2})$/i.exec(value.trim())

  if (!match) {
    return null
  }

  const season = Number.parseInt(match[1] ?? "", 10)
  return Number.isInteger(season) && season > 0 ? season : null
}

function parseEpisodeNumber(filePath: string) {
  const parsed = parseAnimeFileName(filePath)

  if (parsed) {
    return parsed.episode
  }

  const baseName = path.basename(filePath, path.extname(filePath))
  const match =
    /\bS\d{1,2}E(\d{1,4})\b/i.exec(baseName) ??
    /(?:^|\s-\s)(\d{1,4})(?:\b|$)/.exec(baseName)

  if (!match) {
    return null
  }

  const episode = Number.parseInt(match[1] ?? "", 10)
  return Number.isInteger(episode) && episode > 0 ? episode : null
}

function parseLibraryPath(filePath: string): ParsedLibraryPath | null {
  const root = path.resolve(getServerConfig().mediaDir)
  const resolved = path.resolve(filePath)
  const relative = path.relative(root, resolved)

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null
  }

  const parts = relative.split(path.sep).filter(Boolean)

  if (parts.length < 3) {
    return null
  }

  const animeTitle = sanitizePathPart(parts[0] ?? "")
  const season = parseSeasonFolder(parts[1] ?? "") ?? 1
  const episode = parseEpisodeNumber(filePath)

  if (!animeTitle || !episode) {
    return null
  }

  return {
    animeTitle,
    season,
    episode,
  }
}

export async function syncLibraryFile(filePath: string) {
  const resolvedPath = path.resolve(filePath)

  serverLog.info("Media", "Library file sync started.", {
    filePath: resolvedPath,
  })

  if (!isMediaFile(resolvedPath)) {
    serverLog.info("Media", "Skipped non-media library file.", {
      filePath: resolvedPath,
    })
    return null
  }

  if (!(await pathExists(resolvedPath))) {
    serverLog.info("Media", "Library file no longer exists, removing DB entry.", {
      filePath: resolvedPath,
    })
    return removeLibraryFile(resolvedPath)
  }

  await waitForStableFile(resolvedPath)

  const parsed = parseLibraryPath(resolvedPath)

  if (!parsed) {
    serverLog.warn("Media", "Library file path could not be parsed.", {
      filePath: resolvedPath,
    })
    return null
  }

  serverLog.info("Media", "Recognized library file.", {
    filePath: resolvedPath,
    title: parsed.animeTitle,
    season: parsed.season,
    episode: parsed.episode,
  })

  const existingAnime = findAnimeByTitle(parsed.animeTitle)
  let animeId = existingAnime?.id

  if (animeId) {
    serverLog.info("Media", "Matched library file to existing anime.", {
      filePath: resolvedPath,
      title: parsed.animeTitle,
      anilistId: animeId,
    })
  } else {
    const metadata = await findAnimeMetadata(parsed.animeTitle, parsed.season)

    if (!metadata) {
      throw new Error(`AniList could not match "${parsed.animeTitle}"`)
    }

    upsertAnime(metadata)
    animeId = metadata.id
    serverLog.info("Media", "Created anime from AniList metadata.", {
      filePath: resolvedPath,
      title: parsed.animeTitle,
      anilistId: animeId,
    })
  }

  const probe = (await ffprobe(resolvedPath)) as ProbeResult
  const durationSeconds = parseDurationSeconds(probe)

  serverLog.info("Media", "Generating thumbnail for library file.", {
    filePath: resolvedPath,
    animeId,
    season: parsed.season,
    episode: parsed.episode,
    durationSeconds,
  })

  const thumbnailPath = await generateEpisodeThumbnail(
    resolvedPath,
    durationSeconds
  )

  upsertEpisode({
    animeId,
    seasonNr: parsed.season,
    epNr: parsed.episode,
    filePath: resolvedPath,
    thumbnailPath,
    durationSeconds,
  })

  serverLog.info("Media", "Library episode added to database.", {
    animeId,
    season: parsed.season,
    episode: parsed.episode,
    filePath: resolvedPath,
    thumbnailPath,
  })

  return {
    animeId,
    seasonNr: parsed.season,
    epNr: parsed.episode,
    filePath: resolvedPath,
  }
}

export async function removeLibraryFile(filePath: string) {
  const resolvedPath = path.resolve(filePath)
  const episode = deleteEpisodeByPath(resolvedPath)

  if (episode) {
    serverLog.info("Media", "Removed deleted library file from database.", {
      filePath: resolvedPath,
      animeId: episode.animeId,
      season: episode.seasonNumber,
      episode: episode.episodeNumber,
    })
    await rm(thumbnailPathForEpisode(resolvedPath), { force: true }).catch(
      () => undefined
    )
  } else {
    serverLog.info("Media", "Deleted library file was not present in database.", {
      filePath: resolvedPath,
    })
  }

  return episode
}
