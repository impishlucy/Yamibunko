import { createReadStream } from "node:fs"
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises"
import { Readable } from "node:stream"
import path from "node:path"

import { isLocalNonAnimeId } from "@/lib/local-media"
import { slugifyAnimeTitle } from "@/lib/slug"
import { getServerConfig } from "@/server/config"
import {
  repairLibraryIntegrity,
  resolveLibrarySeasonNumberForAnime,
  upsertAnime,
} from "@/server/db/library"
import { getDb, nowIso } from "@/server/db/sqlite"
import {
  formatEpisodeFileName,
  formatSeasonFolderName,
  formatStandaloneMediaFileName,
  sanitizeExportPathPart,
} from "@/server/media/filename"
import { emitLibraryChange } from "@/server/media/libraryEvents"
import { pathExists } from "@/server/media/mediaFiles"
import { subtitleSidecarPathForMediaFile } from "@/server/media/subtitles"
import { findAnimeMetadataById } from "@/server/metadata/anilist"
import { errorMessage } from "@/server/utils/format"

const maxCoverBytes = 5 * 1024 * 1024
const customCoverDirectoryName = "library-covers"
const supportedImageTypes = new Map([
  ["image/webp", "webp"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
])

const imageContentTypesByExtension = new Map([
  [".webp", "image/webp"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
])

type LibraryEditEntryRow = {
  slug: string
  title: string
  primary_anime_id: number
}

type AnimeEditRow = {
  id: number
  library_slug: string | null
  format: string | null
  title_user_preferred: string
}

type EditableEpisodeRow = {
  anime_id: number
  season_nr: number
  ep_nr: number
  title: string | null
  file_path: string
  thumbnail_path: string | null
  duration_seconds: number | null
}

type PlannedEpisodeMove = {
  row: EditableEpisodeRow
  targetSeason: number
  destinationPath: string
}

export class LibraryAdminError extends Error {
  status: number
  code: string

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = "LibraryAdminError"
    this.code = code
    this.status = status
  }
}

function getLibraryEntryRow(slug: string) {
  return getDb()
    .query<LibraryEditEntryRow>(
      "SELECT slug, title, primary_anime_id FROM library_entries WHERE slug = ?"
    )
    .get(slug) ?? null
}

function getAnimeRowForLibrary(input: { slug: string; animeId: number }) {
  return getDb()
    .query<AnimeEditRow>(
      `
      SELECT id, library_slug, format, title_user_preferred
      FROM anime
      WHERE id = ?
        AND library_slug = ?
    `
    )
    .get(input.animeId, input.slug) ?? null
}

function requireLibraryEntry(slug: string) {
  const entry = getLibraryEntryRow(slug)

  if (!entry) {
    throw new LibraryAdminError("LIBRARY_ENTRY_NOT_FOUND", "Library entry not found", 404)
  }

  return entry
}

function requireLibraryAnimeTarget(input: { slug: string; animeId?: number | null }) {
  const entry = requireLibraryEntry(input.slug)
  const targetAnimeId = input.animeId ?? entry.primary_anime_id
  const anime = getAnimeRowForLibrary({ slug: entry.slug, animeId: targetAnimeId })

  if (!anime) {
    throw new LibraryAdminError(
      "LIBRARY_MEDIA_NOT_FOUND",
      "Selected library entry was not found",
      404
    )
  }

  return { entry, anime }
}

function requireNonAnimeTarget(input: { slug: string; animeId?: number | null }) {
  const target = requireLibraryAnimeTarget(input)

  if (!isLocalNonAnimeId(target.anime.id)) {
    throw new LibraryAdminError(
      "NOT_NON_ANIME_ENTRY",
      "Only local non-anime entries can be edited this way",
      400
    )
  }

  return target
}

function metadataTitle(metadata: {
  id: number
  title: {
    userPreferred?: string | null
    english?: string | null
    romaji?: string | null
    native?: string | null
  }
}) {
  const title =
    metadata.title.english ??
    metadata.title.userPreferred ??
    metadata.title.romaji ??
    metadata.title.native

  if (!title) {
    throw new LibraryAdminError(
      "ANILIST_METADATA_INVALID",
      `AniList media ${metadata.id} did not include a usable title`,
      502
    )
  }

  return title
}

function safePathSegment(value: string, label: string) {
  const safeValue = sanitizeExportPathPart(value)

  if (!safeValue) {
    throw new LibraryAdminError(
      "INVALID_LIBRARY_PATH_SEGMENT",
      `${label} resolved to an empty path segment`,
      400
    )
  }

  return safeValue
}

function mediaFolderSegments(input: {
  format: string | null | undefined
  season: number
  mediaTitle: string
}) {
  if (input.format === "MOVIE") {
    return ["Movies"]
  }

  if (input.format === "SPECIAL" || input.format === "OVA") {
    return ["Specials", input.mediaTitle]
  }

  return [formatSeasonFolderName(input.season)]
}

function libraryCoverDirectory() {
  return path.join(process.cwd(), ".yamibunko", customCoverDirectoryName)
}

function coverBaseName(slug: string) {
  const safeSlug = slugifyAnimeTitle(slug)

  if (!safeSlug) {
    throw new LibraryAdminError("INVALID_LIBRARY_SLUG", "Invalid library slug", 400)
  }

  return safeSlug
}

function coverPathForSlug(slug: string, extension: string) {
  return path.join(libraryCoverDirectory(), `${coverBaseName(slug)}.${extension}`)
}

function detectImageType(buffer: Buffer) {
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp"
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png"
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg"
  }

  return null
}

async function removeOldCoverFiles(slug: string, keepPath: string) {
  const directory = libraryCoverDirectory()
  const baseName = coverBaseName(slug)
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${baseName}.`))
      .map((entry) => {
        const filePath = path.join(directory, entry.name)

        if (filePath === keepPath) {
          return Promise.resolve()
        }

        return rm(filePath, { force: true })
      })
  )
}

function assertPathInsideMediaDirectory(filePath: string) {
  const mediaDir = path.resolve(getServerConfig().mediaDir)
  const resolved = path.resolve(filePath)
  const relative = path.relative(mediaDir, resolved)

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new LibraryAdminError(
      "LIBRARY_FILE_OUTSIDE_MEDIA_DIR",
      `Refusing to move a library file outside the configured media directory: ${filePath}`,
      400
    )
  }
}

async function assertDestinationAvailable(sourcePath: string, destinationPath: string) {
  const resolvedSource = path.resolve(sourcePath)
  const resolvedDestination = path.resolve(destinationPath)

  if (resolvedSource === resolvedDestination) {
    return
  }

  if (await pathExists(resolvedDestination)) {
    throw new LibraryAdminError(
      "DESTINATION_ALREADY_EXISTS",
      `Refusing to overwrite an existing library file: ${resolvedDestination}`,
      409
    )
  }
}

async function moveFile(source: string, destination: string) {
  const resolvedSource = path.resolve(source)
  const resolvedDestination = path.resolve(destination)

  if (resolvedSource === resolvedDestination) {
    return
  }

  await mkdir(path.dirname(resolvedDestination), { recursive: true })

  try {
    await rename(resolvedSource, resolvedDestination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error
    }

    await copyFile(resolvedSource, resolvedDestination)
    await unlink(resolvedSource)
  }
}

async function moveSubtitleSidecar(sourceMediaPath: string, destinationMediaPath: string) {
  const sourceSubtitlePath = subtitleSidecarPathForMediaFile(sourceMediaPath)

  if (!(await pathExists(sourceSubtitlePath))) {
    return
  }

  const destinationSubtitlePath = subtitleSidecarPathForMediaFile(destinationMediaPath)
  await assertDestinationAvailable(sourceSubtitlePath, destinationSubtitlePath)
  await moveFile(sourceSubtitlePath, destinationSubtitlePath)
}

async function removeEmptyParentFolders(startFilePath: string) {
  const mediaDir = path.resolve(getServerConfig().mediaDir)
  let directory = path.dirname(path.resolve(startFilePath))

  while (directory.startsWith(mediaDir) && directory !== mediaDir) {
    const entries = await readdir(directory).catch(() => null)

    if (!entries || entries.length > 0) {
      return
    }

    await rm(directory, { recursive: false, force: true }).catch(() => undefined)
    directory = path.dirname(directory)
  }
}

function getAnimeEpisodes(animeId: number) {
  return getDb()
    .query<EditableEpisodeRow>(
      `
      SELECT
        e.anime_id,
        e.season_nr,
        e.ep_nr,
        e.title,
        e.file_path,
        e.thumbnail_path,
        e.duration_seconds
      FROM episodes e
      WHERE e.anime_id = ?
      ORDER BY e.season_nr ASC, e.ep_nr ASC, e.file_path ASC
    `
    )
    .all(animeId)
}

function episodeConflictExists(input: {
  animeId: number
  seasonNr: number
  epNr: number
  currentFilePath: string
}) {
  return Boolean(
    getDb()
      .query<{ file_path: string }>(
        `
        SELECT file_path
        FROM episodes
        WHERE anime_id = ?
          AND season_nr = ?
          AND ep_nr = ?
          AND file_path <> ?
        LIMIT 1
      `
      )
      .get(input.animeId, input.seasonNr, input.epNr, input.currentFilePath)
  )
}


function syncCorrectedEpisodeTitles(animeId: number) {
  getDb()
    .query(
      `
      UPDATE episodes
      SET title = COALESCE((
        SELECT title
        FROM anime_streaming_episodes
        WHERE anime_streaming_episodes.anime_id = episodes.anime_id
          AND anime_streaming_episodes.episode_number = episodes.ep_nr
      ), title, 'Episode ' || ep_nr),
          updated_at = ?
      WHERE anime_id = ?
    `
    )
    .run(nowIso(), animeId)
}

function updateEpisodeAfterMove(input: {
  oldFilePath: string
  newFilePath: string
  animeId: number
  seasonNr: number
  epNr: number
}) {
  getDb()
    .query(
      `
      UPDATE episodes
      SET anime_id = ?,
          season_nr = ?,
          ep_nr = ?,
          file_path = ?,
          updated_at = ?
      WHERE file_path = ?
    `
    )
    .run(
      input.animeId,
      input.seasonNr,
      input.epNr,
      input.newFilePath,
      nowIso(),
      input.oldFilePath
    )
}

function correctedEpisodePath(input: {
  libraryTitle: string
  mediaTitle: string
  format: string | null | undefined
  season: number
  episode: number
  sourcePath: string
}) {
  const safeLibraryTitle = safePathSegment(input.libraryTitle, "Library title")
  const safeMediaTitle = safePathSegment(input.mediaTitle, "Media title")
  const extension = path.extname(input.sourcePath) || ".mp4"
  const fileName =
    input.format === "MOVIE"
      ? formatStandaloneMediaFileName({ title: safeMediaTitle, extension })
      : formatEpisodeFileName({
          title: safeMediaTitle,
          season: input.season,
          episode: input.episode,
          extension,
        })

  return path.resolve(
    getServerConfig().mediaDir,
    safeLibraryTitle,
    ...mediaFolderSegments({
      format: input.format,
      season: input.season,
      mediaTitle: safeMediaTitle,
    }),
    fileName
  )
}

function emitAnimeUpdated(animeId: number, rootAnimeId: number, librarySlug: string) {
  emitLibraryChange({
    type: "anime-updated",
    animeId,
    rootAnimeId,
    librarySlug,
  })
}

export function updateNonAnimeLibraryDetails(input: {
  slug: string
  animeId?: number | null
  title: string
  description: string
}) {
  const { entry, anime } = requireNonAnimeTarget({
    slug: input.slug,
    animeId: input.animeId,
  })
  const title = sanitizeExportPathPart(input.title)
  const description = input.description.trim()

  if (!title) {
    throw new LibraryAdminError("INVALID_TITLE", "Title is required", 400)
  }

  if (description.length > 5000) {
    throw new LibraryAdminError(
      "DESCRIPTION_TOO_LONG",
      "Description is too long",
      400
    )
  }

  const now = nowIso()

  getDb().exec("BEGIN IMMEDIATE")

  try {
    getDb()
      .query(
        `
        UPDATE anime
        SET title_romaji = ?,
            title_english = ?,
            title_user_preferred = ?,
            description = ?,
            updated_at = ?
        WHERE library_slug = ?
          AND id = ?
      `
      )
      .run(title, title, title, description || null, now, entry.slug, anime.id)
    getDb().exec("COMMIT")
  } catch (error) {
    getDb().exec("ROLLBACK")
    throw error
  }

  emitAnimeUpdated(anime.id, entry.primary_anime_id, entry.slug)

  return { slug: entry.slug, animeId: anime.id, title, description }
}

export async function saveNonAnimeLibraryCover(input: {
  slug: string
  animeId?: number | null
  bytes: Buffer
}) {
  const { entry, anime } = requireNonAnimeTarget({
    slug: input.slug,
    animeId: input.animeId,
  })

  if (input.bytes.byteLength <= 0 || input.bytes.byteLength > maxCoverBytes) {
    throw new LibraryAdminError("INVALID_COVER_SIZE", "Invalid cover image size", 400)
  }

  const contentType = detectImageType(input.bytes)
  const extension = contentType ? supportedImageTypes.get(contentType) : null

  if (!contentType || !extension) {
    throw new LibraryAdminError(
      "INVALID_COVER_TYPE",
      "Cover image must be WebP, PNG, or JPEG",
      400
    )
  }

  const coverKey = `${entry.slug}-${anime.id}`
  const coverPath = coverPathForSlug(coverKey, extension)
  await mkdir(path.dirname(coverPath), { recursive: true })
  await writeFile(coverPath, input.bytes, { mode: 0o600 })
  await removeOldCoverFiles(coverKey, coverPath)

  const params = new URLSearchParams()
  params.set("media", String(anime.id))
  params.set("v", String(Date.now()))
  const coverImage = `/api/anime/library/${encodeURIComponent(entry.slug)}/cover?${params.toString()}`
  getDb()
    .query("UPDATE anime SET cover_image = ?, updated_at = ? WHERE id = ?")
    .run(coverImage, nowIso(), anime.id)

  emitAnimeUpdated(anime.id, entry.primary_anime_id, entry.slug)

  return { coverImage, animeId: anime.id }
}

export async function getLibraryCoverResponse(input: {
  slug: string
  animeId?: number | null
}) {
  const { entry, anime } = requireNonAnimeTarget(input)
  const directory = libraryCoverDirectory()
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const coverKeys = [`${entry.slug}-${anime.id}`, entry.slug]
  const entryFile = coverKeys
    .map((key) => {
      const baseName = coverBaseName(key)
      return entries.find((item) => item.isFile() && item.name.startsWith(`${baseName}.`))
    })
    .find(Boolean)

  if (!entryFile) {
    return null
  }

  const filePath = path.join(directory, entryFile.name)
  const fileStat = await stat(filePath).catch(() => null)

  if (!fileStat?.isFile()) {
    return null
  }

  const extension = path.extname(filePath).toLowerCase()
  const contentType = imageContentTypesByExtension.get(extension) ?? "application/octet-stream"
  const stream = createReadStream(filePath)

  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    headers: {
      "content-type": contentType,
      "content-length": String(fileStat.size),
      "cache-control": "private, max-age=3600",
    },
  })
}

export async function correctAnimeLibraryEntry(input: {
  slug: string
  animeId?: number | null
  anilistId: number
}) {
  const { entry, anime: currentAnime } = requireLibraryAnimeTarget({
    slug: input.slug,
    animeId: input.animeId,
  })

  if (isLocalNonAnimeId(currentAnime.id)) {
    throw new LibraryAdminError(
      "NON_ANIME_ANILIST_FORBIDDEN",
      "Local non-anime entries cannot be corrected with an AniList ID",
      400
    )
  }

  if (!Number.isInteger(input.anilistId) || input.anilistId <= 0) {
    throw new LibraryAdminError("INVALID_ANILIST_ID", "Invalid AniList ID", 400)
  }

  const metadata = await findAnimeMetadataById(input.anilistId).catch((error) => {
    throw new LibraryAdminError(
      "ANILIST_LOOKUP_FAILED",
      `AniList lookup failed: ${errorMessage(error)}`,
      502
    )
  })

  if (!metadata?.library) {
    throw new LibraryAdminError(
      "ANILIST_METADATA_NOT_FOUND",
      "AniList media not found",
      404
    )
  }

  const episodes = getAnimeEpisodes(currentAnime.id)

  if (episodes.length === 0) {
    throw new LibraryAdminError(
      "LIBRARY_ENTRY_HAS_NO_FILES",
      "Selected entry has no files to correct",
      400
    )
  }

  const libraryTitle = metadata.library.title
  const mediaTitle = metadataTitle(metadata)
  const moves: PlannedEpisodeMove[] = []
  const plannedDestinations = new Set<string>()

  for (const episode of episodes) {
    assertPathInsideMediaDirectory(episode.file_path)

    const targetSeason = resolveLibrarySeasonNumberForAnime({
      animeId: metadata.id,
      parsedSeason: episode.season_nr,
    })
    const destinationPath = correctedEpisodePath({
      libraryTitle,
      mediaTitle,
      format: metadata.format,
      season: targetSeason,
      episode: episode.ep_nr,
      sourcePath: episode.file_path,
    })

    assertPathInsideMediaDirectory(destinationPath)

    if (
      episodeConflictExists({
        animeId: metadata.id,
        seasonNr: targetSeason,
        epNr: episode.ep_nr,
        currentFilePath: episode.file_path,
      })
    ) {
      throw new LibraryAdminError(
        "EPISODE_CONFLICT",
        `The corrected entry already has Season ${targetSeason}, Episode ${episode.ep_nr}`,
        409
      )
    }

    const destinationKey = path.resolve(destinationPath).toLowerCase()

    if (plannedDestinations.has(destinationKey)) {
      throw new LibraryAdminError(
        "DUPLICATE_DESTINATION",
        `Multiple files would be moved to the same corrected path: ${destinationPath}`,
        409
      )
    }

    plannedDestinations.add(destinationKey)
    await assertDestinationAvailable(episode.file_path, destinationPath)
    moves.push({ row: episode, targetSeason, destinationPath })
  }

  upsertAnime(metadata)

  for (const move of moves) {
    const oldPath = move.row.file_path
    await moveSubtitleSidecar(oldPath, move.destinationPath)
    await moveFile(oldPath, move.destinationPath)
    updateEpisodeAfterMove({
      oldFilePath: oldPath,
      newFilePath: move.destinationPath,
      animeId: metadata.id,
      seasonNr: move.targetSeason,
      epNr: move.row.ep_nr,
    })
    await removeEmptyParentFolders(oldPath)
  }

  syncCorrectedEpisodeTitles(metadata.id)
  repairLibraryIntegrity("admin AniList correction")

  emitAnimeUpdated(metadata.id, metadata.library.primaryAnimeId, metadata.library.slug)
  emitAnimeUpdated(currentAnime.id, entry.primary_anime_id, entry.slug)

  console.log(
    `[Info] [Library] Admin corrected selected entry - ${entry.slug}:${currentAnime.id} -> AniList ${metadata.id} (${libraryTitle}); moved ${moves.length} file(s).`
  )

  return {
    slug: metadata.library.slug,
    title: libraryTitle,
    animeId: metadata.id,
    movedFiles: moves.length,
  }
}
