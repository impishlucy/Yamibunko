import path from "node:path"

import {
  deleteEpisodeByPath,
  getEpisodeByPath,
  upsertAnime,
  upsertEpisode,
} from "@/server/db/library"
import { getServerConfig } from "@/server/config"
import { ffprobe } from "@/server/media/ffmpeg"
import { parseAnimeFileName, sanitizeExportPathPart } from "@/server/media/filename"
import {
  generateEpisodeThumbnail,
  isMediaFile,
  parseDurationSeconds,
  pathExists,
  removeEpisodeThumbnails,
  type ProbeResult,
  waitForStableFile,
} from "@/server/media/mediaFiles"
import { isInputImportOutputActive } from "@/server/media/processInputFile"
import { findAnimeMetadata } from "@/server/metadata/anilist"
import { errorMessage, fileName, parsePositiveInt } from "@/server/utils/format"
import { debugLog } from "@/server/utils/debugLog"

type ParsedLibraryPath = {
  animeTitle: string
  season: number
  episode: number
  part?: number
}

function debugLibrarySync(message: string) {
  debugLog(`[Debug] [LibrarySync] ${message}`)
}


function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isTemporaryFileAccessError(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code
  const message = errorMessage(error).toLowerCase()

  return (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EBUSY" ||
    code === "ETXTBSY" ||
    message.includes("permission denied") ||
    message.includes("resource busy") ||
    message.includes("file is locked") ||
    message.includes("used by another process") ||
    message.includes("process cannot access the file") ||
    message.includes("access is denied")
  )
}

function shouldSkipActiveInputOutput(filePath: string) {
  if (!isInputImportOutputActive(filePath)) {
    return false
  }

  console.log(
    `[Info] [Media] Skipped library sync for active input output - ${fileName(filePath)}`
  )
  debugLibrarySync(`Skipped active input output - ${filePath}`)
  return true
}

async function runWithTemporaryFileAccessRetry<T>(
  label: string,
  filePath: string,
  work: () => Promise<T>
) {
  let lastError: unknown

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (shouldSkipActiveInputOutput(filePath)) {
      return null
    }

    try {
      return await work()
    } catch (error) {
      lastError = error

      if (!isTemporaryFileAccessError(error)) {
        throw error
      }

      if (attempt < 4) {
        console.warn(
          `[Warn] [Media] Library file is temporarily locked; retrying ${label} ${attempt}/4 - ${fileName(filePath)} - ${errorMessage(error)}`
        )
        debugLibrarySync(
          `Temporary file access failure during ${label} attempt ${attempt}/4 - ${filePath} - ${errorMessage(error)}`
        )
        await sleep(1000 * attempt)
        continue
      }
    }
  }

  console.warn(
    `[Warn] [Media] Skipped temporarily locked library file after retries - ${fileName(filePath)} - ${errorMessage(lastError)}`
  )
  debugLibrarySync(
    `Skipped temporarily locked library file after retries - ${filePath} - ${errorMessage(lastError)}`
  )

  return null
}

function parseSeasonFolder(value: string) {
  const match = /^(?:season\s*|season_)(\d{1,2})$/i.exec(value.trim())

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
  const animeTitle = sanitizeExportPathPart(
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
    part: parsedFileName?.part,
  }
}

export async function syncLibraryFile(filePath: string) {
  const resolvedPath = path.resolve(filePath)
  debugLibrarySync(`Sync requested - ${resolvedPath}`)

  console.log(
    `[Info] [Media] Library file sync started - ${fileName(resolvedPath)}`
  )

  debugLibrarySync(`Checking media file extension - ${resolvedPath}`)
  if (!isMediaFile(resolvedPath)) {
    console.log(
      `[Info] [Media] Skipped non-media library file - ${fileName(resolvedPath)}`
    )
    return null
  }

  debugLibrarySync(`Checking library path exists - ${resolvedPath}`)
  if (!(await pathExists(resolvedPath))) {
    console.log(
      `[Info] [Media] Library file no longer exists, removing DB entry - ${resolvedPath}`
    )
    return removeLibraryFile(resolvedPath)
  }

  if (shouldSkipActiveInputOutput(resolvedPath)) {
    return null
  }

  debugLibrarySync("Waiting for library file to become stable.")
  const stableFileResult = await runWithTemporaryFileAccessRetry(
    "stability check",
    resolvedPath,
    () => waitForStableFile(resolvedPath)
  )

  if (stableFileResult === null) {
    return null
  }

  debugLibrarySync("Library file is stable.")

  debugLibrarySync("Checking for existing database episode by file path.")
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

  debugLibrarySync("Parsing library path.")
  const parsed = parseLibraryPath(resolvedPath)

  if (!parsed) {
    console.warn(
      `[Warn] [Media] Library file path could not be parsed - syncLibraryFile.ts - ${resolvedPath}`
    )
    return null
  }

  console.log(
    `[Info] [Media] Recognized library file - Title: ${parsed.animeTitle}, Season: ${parsed.season}${parsed.part ? `, Part: ${parsed.part}` : ""}, Episode: ${parsed.episode}`
  )

  debugLibrarySync("Starting AniList metadata lookup for library file.")
  const metadata = await findAnimeMetadata(
    parsed.animeTitle,
    parsed.season,
    parsed.episode,
    parsed.part
  )

  if (!metadata) {
    throw new Error(`AniList could not match "${parsed.animeTitle}"`)
  }

  debugLibrarySync(`AniList metadata lookup completed - Anime id ${metadata.id}.`)
  debugLibrarySync("Saving AniList metadata for library file.")
  upsertAnime(metadata)
  debugLibrarySync("AniList metadata saved for library file.")
  const animeId = metadata.id
  console.log(
    `[Info] [Media] Created anime from AniList metadata - ${parsed.animeTitle} - id ${animeId}`
  )

  if (shouldSkipActiveInputOutput(resolvedPath)) {
    return null
  }

  debugLibrarySync(`Running ffprobe for library file - ${resolvedPath}`)
  const probe = await runWithTemporaryFileAccessRetry(
    "ffprobe",
    resolvedPath,
    async () => (await ffprobe(resolvedPath)) as ProbeResult
  )

  if (probe === null) {
    return null
  }

  debugLibrarySync(`ffprobe completed for library file - Streams ${(probe.streams ?? []).length}.`)
  const durationSeconds = parseDurationSeconds(probe)
  debugLibrarySync(`Parsed library file duration - ${durationSeconds}s.`)

  if (shouldSkipActiveInputOutput(resolvedPath)) {
    return null
  }

  console.log(
    `[Info] [Media] Generating thumbnail for library file - ${fileName(resolvedPath)}`
  )

  const thumbnailPath = await runWithTemporaryFileAccessRetry(
    "thumbnail generation",
    resolvedPath,
    () => generateEpisodeThumbnail(resolvedPath, durationSeconds)
  )

  if (thumbnailPath === null) {
    return null
  }

  debugLibrarySync(`Thumbnail generated for library file - ${thumbnailPath}`)

  debugLibrarySync("Saving library episode row.")
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
  debugLibrarySync("Library file sync completed.")

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
    await removeEpisodeThumbnails(resolvedPath).catch(() => undefined)
  } else {
    console.log(
      `[Info] [Media] Deleted library file was not present in database - ${fileName(resolvedPath)}`
    )
  }

  return episode
}
