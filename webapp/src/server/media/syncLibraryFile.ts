import path from "node:path"

import {
  deleteEpisodeByPath,
  getEpisodeByPath,
  getLibraryEventTargetForAnime,
  resolveLibrarySeasonNumberForAnime,
  upsertAnime,
  upsertEpisode,
} from "@/server/db/library"
import { getServerConfig } from "@/server/config"
import { ffprobe } from "@/server/media/ffmpeg"
import {
  getAnimeMetadataLookupSeason,
  formatSeasonFolderName,
  getFolderTitleFallbackCandidates,
  parseAnimeFilePath,
  parseSeasonPartMarker,
  sanitizeExportPathPart,
} from "@/server/media/filename"
import {
  generateEpisodeThumbnail,
  isMediaFile,
  parseDurationSeconds,
  pathExists,
  removeEpisodeThumbnails,
  type ProbeResult,
  waitForStableFile,
} from "@/server/media/mediaFiles"
import { emitLibraryChange } from "@/server/media/libraryEvents"
import { isInputImportOutputActive } from "@/server/media/processInputFile"
import { findAnimeMetadata } from "@/server/metadata/anilist"
import { errorMessage, fileName } from "@/server/utils/format"
import { debugLog } from "@/server/utils/debugLog"

type ParsedLibraryPath = {
  animeTitle: string
  season: number
  episode: number
  part?: number
  metadataLookupSeason?: number
}

function debugLibrarySync(message: string) {
  debugLog(`[Debug] [LibrarySync] ${message}`)
}


function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

async function runCooperativeSyncStep<T>(work: () => T) {
  await yieldToEventLoop()
  const result = work()
  await yieldToEventLoop()

  return result
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
  const marker = parseSeasonPartMarker(value)

  if (!marker?.season) {
    return null
  }

  return marker
}


function formatLibraryEpisodeLabel(input: {
  season: number
  episode: number
  part?: number
}) {
  return `${formatSeasonFolderName(input.season, input.part)}, Episode ${input.episode}`
}

function formatDeletedEpisodeLabel(input: {
  filePath: string
  seasonNumber: number
  episodeNumber: number
}) {
  const parsed = parseLibraryPath(input.filePath)

  if (parsed) {
    return formatLibraryEpisodeLabel({
      season: parsed.season,
      part: parsed.part,
      episode: parsed.episode,
    })
  }

  return `Season ${input.seasonNumber}, Episode ${input.episodeNumber}`
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

  const parsedFileName = parseAnimeFilePath(filePath, { rootDir: root })

  if (!parsedFileName) {
    return null
  }

  const season = parsedFileName.hasExplicitSeason
    ? parsedFileName.season
    : seasonFolder?.season ?? parsedFileName.season
  const part = parsedFileName.part ?? seasonFolder?.part
  const animeTitle = sanitizeExportPathPart(parsedFileName.title)

  if (!animeTitle || !parsedFileName.episode) {
    return null
  }

  return {
    animeTitle,
    season,
    episode: parsedFileName.episode,
    part,
    metadataLookupSeason: getAnimeMetadataLookupSeason({
      ...parsedFileName,
      season,
      part,
      hasExplicitSeason: parsedFileName.hasExplicitSeason || Boolean(seasonFolder?.season),
    }),
  }
}

export async function syncLibraryFile(filePath: string) {
  const resolvedPath = path.resolve(filePath)
  debugLibrarySync(`Sync requested - ${resolvedPath}`)

  debugLibrarySync(`Checking media file extension - ${resolvedPath}`)
  if (!isMediaFile(resolvedPath)) {
    return null
  }

  debugLibrarySync(`Checking library path exists - ${resolvedPath}`)
  if (!(await pathExists(resolvedPath))) {
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
  const existingEpisode = await runCooperativeSyncStep(() =>
    getEpisodeByPath(resolvedPath)
  )

  if (existingEpisode) {
    return {
      animeId: existingEpisode.animeId,
      seasonNr: existingEpisode.seasonNumber,
      epNr: existingEpisode.episodeNumber,
      filePath: resolvedPath,
    }
  }

  debugLibrarySync("Parsing library path.")
  let parsed = parseLibraryPath(resolvedPath)

  if (!parsed) {
    console.warn(
      `[Warn] [Media] Library file path could not be parsed - syncLibraryFile.ts - ${resolvedPath}`
    )
    return null
  }

  console.log(
    `[Info] [Media] Detected library episode - Anime: ${parsed.animeTitle}, ${formatLibraryEpisodeLabel({ season: parsed.season, part: parsed.part, episode: parsed.episode })} - ${fileName(resolvedPath)}`
  )

  debugLibrarySync("Starting AniList metadata lookup for library file.")
  let metadata = await findAnimeMetadata(
    parsed.animeTitle,
    parsed.metadataLookupSeason,
    parsed.episode,
    parsed.part
  )

  if (!metadata) {
    const fallbackTitles = getFolderTitleFallbackCandidates(
      getServerConfig().mediaDir,
      resolvedPath,
      parsed.animeTitle
    )

    for (const fallbackTitle of fallbackTitles) {
      debugLibrarySync(
        `Trying library folder title fallback - Filename title ${parsed.animeTitle}, Folder title ${fallbackTitle}`
      )

      const fallbackMetadata = await findAnimeMetadata(
        fallbackTitle,
        parsed.metadataLookupSeason,
        parsed.episode,
        parsed.part
      )

      if (!fallbackMetadata) {
        continue
      }

      metadata = fallbackMetadata
      parsed = { ...parsed, animeTitle: fallbackTitle }
      break
    }
  }

  if (!metadata) {
    throw new Error(`AniList could not match "${parsed.animeTitle}"`)
  }

  debugLibrarySync(`AniList metadata lookup completed - Anime id ${metadata.id}.`)
  debugLibrarySync("Saving AniList metadata for library file.")
  await runCooperativeSyncStep(() => upsertAnime(metadata))
  debugLibrarySync("AniList metadata saved for library file.")
  const animeId = metadata.id
  const librarySeason = await runCooperativeSyncStep(() =>
    resolveLibrarySeasonNumberForAnime({
      animeId,
      parsedSeason: parsed.season,
      parsedPart: parsed.part,
    })
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
  await runCooperativeSyncStep(() =>
    upsertEpisode({
      animeId,
      seasonNr: librarySeason,
      epNr: parsed.episode,
      filePath: resolvedPath,
      thumbnailPath,
      durationSeconds,
    })
  )

  if (metadata.library) {
    emitLibraryChange({
      type: "episode-added",
      animeId,
      rootAnimeId: metadata.library.primaryAnimeId,
      librarySlug: metadata.library.slug,
      seasonNumber: librarySeason,
      episodeNumber: parsed.episode,
    })
  }

  console.log(
    `[Info] [Media] Library database import completed - Anime: ${parsed.animeTitle}, ${formatLibraryEpisodeLabel({ season: parsed.season, part: parsed.part, episode: parsed.episode })} - ${fileName(resolvedPath)}`
  )
  debugLibrarySync("Library file sync completed.")

  return {
    animeId,
    seasonNr: librarySeason,
    epNr: parsed.episode,
    filePath: resolvedPath,
  }
}

export async function removeLibraryFile(filePath: string) {
  const resolvedPath = path.resolve(filePath)
  const existingEpisode = await runCooperativeSyncStep(() =>
    getEpisodeByPath(resolvedPath)
  )
  const eventTarget = existingEpisode
    ? await runCooperativeSyncStep(() =>
        getLibraryEventTargetForAnime(existingEpisode.animeId)
      )
    : null
  const episode = await runCooperativeSyncStep(() =>
    deleteEpisodeByPath(resolvedPath)
  )

  if (episode) {
    console.log(
      `[Info] [Media] Removed deleted library file from database - Anime id ${episode.animeId}, ${formatDeletedEpisodeLabel({ filePath: resolvedPath, seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber })}`
    )

    if (eventTarget) {
      emitLibraryChange({
        type: "episode-removed",
        animeId: eventTarget.animeId,
        rootAnimeId: eventTarget.rootAnimeId,
        librarySlug: eventTarget.librarySlug,
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
      })
    }

    await removeEpisodeThumbnails(resolvedPath).catch(() => undefined)
  } else {
    console.log(
      `[Info] [Media] Deleted library file was not present in database - ${fileName(resolvedPath)}`
    )
  }

  return episode
}
