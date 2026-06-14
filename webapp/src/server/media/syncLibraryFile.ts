import { mkdir, readdir, rename, rmdir } from "node:fs/promises"
import path from "node:path"

import {
  deleteEpisodeByPath,
  deleteEpisodeRecord,
  getEpisodeByPath,
  getLibraryEventTargetForAnime,
  getStoredEpisode,
  resolveLibrarySeasonNumberForAnime,
  upsertAnime,
  upsertEpisode,
  type AnimeMetadataInput,
} from "@/server/db/library"
import { getServerConfig } from "@/server/config"
import { ffprobe } from "@/server/media/ffmpeg"
import {
  formatEpisodeFileName,
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
import {
  createNonAnimeMetadata,
  nonAnimeFolderName,
  parseNonAnimeFilePath,
} from "@/server/media/nonAnime"
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
  isNonAnime?: boolean
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

function metadataTitle(metadata: AnimeMetadataInput) {
  const title =
    metadata.title.english ??
    metadata.title.userPreferred ??
    metadata.title.romaji ??
    metadata.title.native

  if (!title) {
    throw new Error(`Media ${metadata.id} did not include a usable title`)
  }

  return title
}

function safePathSegment(value: string, label: string) {
  const safeValue = sanitizeExportPathPart(value)

  if (!safeValue) {
    throw new Error(`${label} resolved to an empty path segment`)
  }

  return safeValue
}

function mediaFolderSegments(input: {
  format: string | null | undefined
  season: number
  mediaTitle: string
  part?: number
}) {
  if (input.format === "MOVIE") {
    return ["Movies"]
  }

  if (input.format === "SPECIAL" || input.format === "OVA") {
    return ["Specials", input.mediaTitle]
  }

  return [formatSeasonFolderName(input.season, input.part)]
}

function canonicalLibraryPath(input: {
  metadata: AnimeMetadataInput
  parsed: ParsedLibraryPath
  sourcePath: string
}) {
  const library = input.metadata.library

  if (!library?.title) {
    throw new Error(`Media ${input.metadata.id} did not resolve a library root`)
  }

  const safeLibraryTitle = safePathSegment(library.title, "Library title")
  const safeMediaTitle = safePathSegment(metadataTitle(input.metadata), "Media title")
  const extension = path.extname(input.sourcePath) || ".mp4"
  const fileName = formatEpisodeFileName({
    title: safeMediaTitle,
    season: input.parsed.season,
    part: input.parsed.part,
    episode: input.parsed.episode,
    extension,
  })

  return path.resolve(
    getServerConfig().mediaDir,
    ...(input.parsed.isNonAnime ? [nonAnimeFolderName, safeLibraryTitle] : [safeLibraryTitle]),
    ...mediaFolderSegments({
      format: input.metadata.format,
      season: input.parsed.season,
      part: input.parsed.part,
      mediaTitle: safeMediaTitle,
    }),
    fileName
  )
}

function samePath(left: string, right: string) {
  const leftPath = path.resolve(left)
  const rightPath = path.resolve(right)

  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath
}

function isInsideDirectory(root: string, targetPath: string) {
  const relative = path.relative(path.resolve(root), path.resolve(targetPath))

  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

async function removeEmptyLibraryParents(startDirectory: string) {
  const mediaRoot = path.resolve(getServerConfig().mediaDir)
  let current = path.resolve(startDirectory)

  while (isInsideDirectory(mediaRoot, current)) {
    const entries = await readdir(current).catch(() => null)

    if (!entries || entries.length > 0) {
      return
    }

    await rmdir(current).catch(() => undefined)
    current = path.dirname(current)
  }
}

async function moveLibraryFileIfNeeded(sourcePath: string, destinationPath: string) {
  const source = path.resolve(sourcePath)
  const destination = path.resolve(destinationPath)

  if (samePath(source, destination)) {
    return source
  }

  if (await pathExists(destination)) {
    throw new Error(`Cannot repair library path because destination already exists: ${destination}`)
  }

  await mkdir(path.dirname(destination), { recursive: true })
  await rename(source, destination)
  await removeEmptyLibraryParents(path.dirname(source))

  return destination
}

function parseLibraryPath(filePath: string): ParsedLibraryPath | null {
  const root = path.resolve(getServerConfig().mediaDir)
  const resolved = path.resolve(filePath)
  const relative = path.relative(root, resolved)

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null
  }

  const parts = relative.split(path.sep).filter(Boolean)
  const nonAnimeParsed = parseNonAnimeFilePath(resolved, root)

  if (nonAnimeParsed) {
    const parsedFileName = nonAnimeParsed.parsed
    const season = parsedFileName.season
    const part = parsedFileName.part

    return {
      animeTitle: nonAnimeParsed.title,
      season,
      episode: parsedFileName.episode,
      part,
      metadataLookupSeason: getAnimeMetadataLookupSeason({
        ...parsedFileName,
        season,
        part,
      }),
      isNonAnime: true,
    }
  }

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

async function resolveParsedLibraryMetadata(parsed: ParsedLibraryPath, filePath: string) {
  if (parsed.isNonAnime) {
    return createNonAnimeMetadata({
      title: parsed.animeTitle,
      episodeNumber: parsed.episode,
    })
  }

  let metadata = await findAnimeMetadata(
    parsed.animeTitle,
    parsed.metadataLookupSeason,
    parsed.episode,
    parsed.part
  )

  if (!metadata) {
    const fallbackTitles = getFolderTitleFallbackCandidates(
      getServerConfig().mediaDir,
      filePath,
      parsed.animeTitle
    )

    for (const fallbackTitle of fallbackTitles) {
      metadata = await findAnimeMetadata(
        fallbackTitle,
        parsed.metadataLookupSeason,
        parsed.episode,
        parsed.part
      )

      if (metadata) {
        break
      }
    }
  }

  return metadata
}

async function repairExistingLibraryEpisodeIfNeeded(
  resolvedPath: string,
  existingEpisode: NonNullable<ReturnType<typeof getEpisodeByPath>>
) {
  const parsed = parseLibraryPath(resolvedPath)

  if (!parsed) {
    return {
      animeId: existingEpisode.animeId,
      seasonNr: existingEpisode.seasonNumber,
      epNr: existingEpisode.episodeNumber,
      filePath: resolvedPath,
    }
  }

  const metadata = await resolveParsedLibraryMetadata(parsed, resolvedPath)

  if (!metadata) {
    console.warn(
      `[Warn] [Media] Existing library episode could not be revalidated against AniList - ${resolvedPath}`
    )
    return {
      animeId: existingEpisode.animeId,
      seasonNr: existingEpisode.seasonNumber,
      epNr: existingEpisode.episodeNumber,
      filePath: resolvedPath,
    }
  }

  await runCooperativeSyncStep(() => upsertAnime(metadata))
  const librarySeason = await runCooperativeSyncStep(() =>
    resolveLibrarySeasonNumberForAnime({
      animeId: metadata.id,
      parsedSeason: parsed.season,
      parsedPart: parsed.part,
    })
  )
  const targetPath = canonicalLibraryPath({
    metadata,
    parsed,
    sourcePath: resolvedPath,
  })
  const needsDbRepair =
    existingEpisode.animeId !== metadata.id ||
    existingEpisode.seasonNumber !== librarySeason ||
    existingEpisode.episodeNumber !== parsed.episode
  const needsPathRepair = !samePath(resolvedPath, targetPath)

  if (!needsDbRepair && !needsPathRepair) {
    return {
      animeId: existingEpisode.animeId,
      seasonNr: existingEpisode.seasonNumber,
      epNr: existingEpisode.episodeNumber,
      filePath: resolvedPath,
    }
  }

  console.warn(
    `[Warn] [Media] Repairing library episode mismatch - ${resolvedPath} -> ${targetPath}`
  )

  const oldEventTarget = await runCooperativeSyncStep(() =>
    getLibraryEventTargetForAnime(existingEpisode.animeId)
  )
  const repairedPath = await moveLibraryFileIfNeeded(resolvedPath, targetPath)
  const targetEpisode = await runCooperativeSyncStep(() =>
    getStoredEpisode(metadata.id, librarySeason, parsed.episode)
  )

  if (targetEpisode && !samePath(targetEpisode.filePath, resolvedPath)) {
    await runCooperativeSyncStep(() =>
      deleteEpisodeRecord({
        animeId: metadata.id,
        seasonNr: librarySeason,
        epNr: parsed.episode,
      })
    )
  }

  await runCooperativeSyncStep(() => deleteEpisodeByPath(resolvedPath))

  if (oldEventTarget) {
    emitLibraryChange({
      type: "episode-removed",
      animeId: oldEventTarget.animeId,
      rootAnimeId: oldEventTarget.rootAnimeId,
      librarySlug: oldEventTarget.librarySlug,
      seasonNumber: existingEpisode.seasonNumber,
      episodeNumber: existingEpisode.episodeNumber,
    })
  }

  await removeEpisodeThumbnails(resolvedPath).catch(() => undefined)

  const probe = await runWithTemporaryFileAccessRetry(
    "ffprobe",
    repairedPath,
    async () => (await ffprobe(repairedPath)) as ProbeResult
  )

  if (probe === null) {
    return null
  }

  const durationSeconds = parseDurationSeconds(probe)
  const thumbnailPath = await runWithTemporaryFileAccessRetry(
    "thumbnail generation",
    repairedPath,
    () => generateEpisodeThumbnail(repairedPath, durationSeconds)
  )

  if (thumbnailPath === null) {
    return null
  }

  await runCooperativeSyncStep(() =>
    upsertEpisode({
      animeId: metadata.id,
      seasonNr: librarySeason,
      epNr: parsed.episode,
      filePath: repairedPath,
      thumbnailPath,
      durationSeconds,
    })
  )

  if (metadata.library) {
    emitLibraryChange({
      type: "episode-added",
      animeId: metadata.id,
      rootAnimeId: metadata.library.primaryAnimeId,
      librarySlug: metadata.library.slug,
      seasonNumber: librarySeason,
      episodeNumber: parsed.episode,
    })
  }

  console.log(
    `[Info] [Media] Library episode mismatch repaired - Anime: ${metadataTitle(metadata)}, ${formatLibraryEpisodeLabel({ season: parsed.season, part: parsed.part, episode: parsed.episode })} - ${fileName(repairedPath)}`
  )

  return {
    animeId: metadata.id,
    seasonNr: librarySeason,
    epNr: parsed.episode,
    filePath: repairedPath,
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
    return repairExistingLibraryEpisodeIfNeeded(resolvedPath, existingEpisode)
  }

  debugLibrarySync("Parsing library path.")
  const parsed = parseLibraryPath(resolvedPath)

  if (!parsed) {
    console.warn(
      `[Warn] [Media] Library file path could not be parsed - syncLibraryFile.ts - ${resolvedPath}`
    )
    return null
  }

  let resolvedParsed = parsed

  console.log(
    `[Info] [Media] Detected library episode - Anime: ${resolvedParsed.animeTitle}, ${formatLibraryEpisodeLabel({ season: resolvedParsed.season, part: resolvedParsed.part, episode: resolvedParsed.episode })} - ${fileName(resolvedPath)}`
  )

  const metadata = resolvedParsed.isNonAnime
    ? createNonAnimeMetadata({
        title: resolvedParsed.animeTitle,
        episodeNumber: resolvedParsed.episode,
      })
    : await (async () => {
        debugLibrarySync("Starting AniList metadata lookup for library file.")
        let animeMetadata = await findAnimeMetadata(
          resolvedParsed.animeTitle,
          resolvedParsed.metadataLookupSeason,
          resolvedParsed.episode,
          resolvedParsed.part
        )

        if (!animeMetadata) {
          const fallbackTitles = getFolderTitleFallbackCandidates(
            getServerConfig().mediaDir,
            resolvedPath,
            resolvedParsed.animeTitle
          )

          for (const fallbackTitle of fallbackTitles) {
            debugLibrarySync(
              `Trying library folder title fallback - Filename title ${resolvedParsed.animeTitle}, Folder title ${fallbackTitle}`
            )

            const fallbackMetadata = await findAnimeMetadata(
              fallbackTitle,
              resolvedParsed.metadataLookupSeason,
              resolvedParsed.episode,
              resolvedParsed.part
            )

            if (!fallbackMetadata) {
              continue
            }

            animeMetadata = fallbackMetadata
            resolvedParsed = { ...resolvedParsed, animeTitle: fallbackTitle }
            break
          }
        }

        return animeMetadata
      })()

  if (!metadata) {
    throw new Error(`AniList could not match "${resolvedParsed.animeTitle}"`)
  }

  debugLibrarySync(`${resolvedParsed.isNonAnime ? "Local metadata prepared" : "AniList metadata lookup completed"} - Anime id ${metadata.id}.`)
  debugLibrarySync("Saving media metadata for library file.")
  await runCooperativeSyncStep(() => upsertAnime(metadata))
  debugLibrarySync("Media metadata saved for library file.")
  const animeId = metadata.id
  const librarySeason = await runCooperativeSyncStep(() =>
    resolveLibrarySeasonNumberForAnime({
      animeId,
      parsedSeason: resolvedParsed.season,
      parsedPart: resolvedParsed.part,
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
      epNr: resolvedParsed.episode,
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
      episodeNumber: resolvedParsed.episode,
    })
  }

  console.log(
    `[Info] [Media] Library database import completed - Anime: ${resolvedParsed.animeTitle}, ${formatLibraryEpisodeLabel({ season: resolvedParsed.season, part: resolvedParsed.part, episode: resolvedParsed.episode })} - ${fileName(resolvedPath)}`
  )
  debugLibrarySync("Library file sync completed.")

  return {
    animeId,
    seasonNr: librarySeason,
    epNr: resolvedParsed.episode,
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
