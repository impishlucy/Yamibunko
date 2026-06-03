import { rm } from "node:fs/promises"
import path from "node:path"

import {
  deleteEpisodeByPath,
  getEpisodeByPath,
  upsertAnime,
  upsertEpisode,
} from "@/server/db/library"
import { getServerConfig } from "@/server/config"
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
import { fileName, parsePositiveInt } from "@/server/utils/format"

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

  return parsePositiveInt(match[1])
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

  return parsePositiveInt(match[1])
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

  const folderName = parts[1] ?? ""
  const parsedFileName = parseAnimeFileName(filePath)
  const isMovieFolder = /^movies$/i.test(folderName)
  const isSpecialFolder = /^specials$/i.test(folderName)
  const seasonFolder = parseSeasonFolder(folderName)

  if (isSpecialFolder && parts.length !== 4) {
    return null
  }

  if (!isSpecialFolder && parts.length !== 3) {
    return null
  }

  if (!seasonFolder && !isMovieFolder && !isSpecialFolder) {
    return null
  }

  const season = seasonFolder ?? parsedFileName?.season ?? 1
  const animeTitle = sanitizePathPart(
    isSpecialFolder ? (parts[2] ?? "") : (parsedFileName?.title ?? "")
  )
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

  console.log(
    `[Info] [Media] Library file sync started - ${fileName(resolvedPath)}`
  )

  if (!isMediaFile(resolvedPath)) {
    console.log(
      `[Info] [Media] Skipped non-media library file - ${fileName(resolvedPath)}`
    )
    return null
  }

  if (!(await pathExists(resolvedPath))) {
    console.log(
      `[Info] [Media] Library file no longer exists, removing DB entry - ${resolvedPath}`
    )
    return removeLibraryFile(resolvedPath)
  }

  await waitForStableFile(resolvedPath)

  const existingEpisode = getEpisodeByPath(resolvedPath)

  if (existingEpisode) {
    console.log(
      `[Info] [Media] Library file already exists in database - Anime id ${existingEpisode.animeId}, Season ${existingEpisode.seasonNumber}, Episode ${existingEpisode.episodeNumber}`
    )
    return {
      animeId: existingEpisode.animeId,
      seasonNr: existingEpisode.seasonNumber,
      epNr: existingEpisode.episodeNumber,
      filePath: resolvedPath,
    }
  }

  const parsed = parseLibraryPath(resolvedPath)

  if (!parsed) {
    console.warn(
      `[Warn] [Media] Library file path could not be parsed - syncLibraryFile.ts - ${resolvedPath}`
    )
    return null
  }

  console.log(
    `[Info] [Media] Recognized library file - Title: ${parsed.animeTitle}, Season: ${parsed.season}, Episode: ${parsed.episode}`
  )

  const metadata = await findAnimeMetadata(parsed.animeTitle, parsed.season, parsed.episode)

  if (!metadata) {
    throw new Error(`AniList could not match "${parsed.animeTitle}"`)
  }

  upsertAnime(metadata)
  const animeId = metadata.id
  console.log(
    `[Info] [Media] Created anime from AniList metadata - ${parsed.animeTitle} - id ${animeId}`
  )

  const probe = (await ffprobe(resolvedPath)) as ProbeResult
  const durationSeconds = parseDurationSeconds(probe)

  console.log(
    `[Info] [Media] Generating thumbnail for library file - ${fileName(resolvedPath)}`
  )

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

  console.log(
    `[Info] [Media] Library episode added to database - Anime id ${animeId}, Season ${parsed.season}, Episode ${parsed.episode}`
  )

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
    console.log(
      `[Info] [Media] Removed deleted library file from database - Anime id ${episode.animeId}, Season ${episode.seasonNumber}, Episode ${episode.episodeNumber}`
    )
    await rm(thumbnailPathForEpisode(resolvedPath), { force: true }).catch(
      () => undefined
    )
  } else {
    console.log(
      `[Info] [Media] Deleted library file was not present in database - ${fileName(resolvedPath)}`
    )
  }

  return episode
}
