import type { AnimeInfo, AnimeSummary, AnimeVariant, Episode } from "@/lib/types"
import { getDb, nowIso } from "@/server/db/sqlite"
import {
  fileName as baseFileName,
  parsePositiveInt,
} from "@/server/utils/format"
import { debugLog } from "@/server/utils/debugLog"

type AnimeRow = {
  id: number
  library_slug: string | null
  format: string | null
  relation_kind: string | null
  title_romaji: string | null
  title_english: string | null
  title_native: string | null
  title_user_preferred: string
  status: string | null
  description: string | null
  season_year: number | null
  episodes: number | null
  duration: number | null
  cover_image: string | null
  banner_image: string | null
  average_score: number | null
  anilist_raw_json: string | null
  anilist_synced_at: string | null
  streaming_episodes_synced_at: string | null
}

type AnimeListRow = AnimeRow & {
  slug: string
  library_title: string
  primary_anime_id: number
  local_episode_count: number
  media_count: number
}

type LibraryEntryRow = {
  slug: string
  title: string
  primary_anime_id: number
}

type AnimeVariantRow = AnimeRow & {
  local_episode_count: number
  first_season_nr: number | null
}

type EpisodeRow = {
  anime_id: number
  season_nr: number
  ep_nr: number
  title: string | null
  file_path: string
  thumbnail_path: string | null
  duration_seconds: number | null
  watched_seconds?: number | null
  watched_duration_seconds?: number | null
  completed?: number | null
}

type AnimeTagRow = {
  id: number
  name: string
  description: string | null
  category: string | null
  rank: number | null
  isAdult: number | null
}

type StreamingEpisodeRow = {
  anime_id: number
  episode_number: number
  title: string
  thumbnail: string | null
  url: string | null
  site: string | null
}

type CachedAnimeCandidateRow = AnimeRow & {
  library_title: string | null
  primary_anime_id: number | null
}

const seriesFormats = new Set(["TV", "TV_SHORT", "ONA"])
const libraryRelationTypes = new Set([
  "LIBRARY_ROOT",
  "PARENT",
  "PREQUEL",
  "SEQUEL",
  "SIDE_STORY",
  "SUMMARY",
  "SPIN_OFF",
  "COMPILATION",
  "CONTAINS",
])

function isLibraryRelationType(relationType: string | null | undefined) {
  return Boolean(relationType && libraryRelationTypes.has(relationType))
}

function animeTitle(metadata: Pick<AnimeMetadataInput, "id" | "title">) {
  const title =
    metadata.title.english ??
    metadata.title.userPreferred ??
    metadata.title.romaji ??
    metadata.title.native

  if (!title) {
    throw new Error(`AniList media ${metadata.id} did not include a usable title`)
  }

  return title
}

function requireLibrarySlug(row: AnimeRow) {
  if (!row.library_slug) {
    throw new Error(`Anime ${row.id} is not linked to a library entry`)
  }

  return row.library_slug
}

function requireLibrary(metadata: AnimeMetadataInput) {
  if (!metadata.library) {
    throw new Error(`AniList media ${metadata.id} did not resolve a library root`)
  }

  return metadata.library
}

function ensureLibraryEntry(input: {
  slug: string
  title: string
  primaryAnimeId: number
}) {
  if (!input.slug.trim()) {
    throw new Error(`Library root ${input.primaryAnimeId} did not include a usable slug`)
  }

  if (!input.title.trim()) {
    throw new Error(`Library root ${input.primaryAnimeId} did not include a usable title`)
  }

  const now = nowIso()
  const existing = getDb()
    .query<{ primary_anime_id: number }>(
      "SELECT primary_anime_id FROM library_entries WHERE slug = ?"
    )
    .get(input.slug)

  if (existing && existing.primary_anime_id !== input.primaryAnimeId) {
    throw new Error(
      `Library slug collision for "${input.slug}": existing root ${existing.primary_anime_id}, new root ${input.primaryAnimeId}`
    )
  }

  getDb()
    .query(
      `
      INSERT INTO library_entries (
        slug,
        title,
        primary_anime_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        title = excluded.title,
        primary_anime_id = excluded.primary_anime_id,
        updated_at = excluded.updated_at
    `
    )
    .run(input.slug, input.title, input.primaryAnimeId, now, now)

  return input.slug
}

export type AnimeStreamingEpisodeInput = {
  episodeNumber?: number | null
  title?: string | null
  thumbnail?: string | null
  url?: string | null
  site?: string | null
}

export type AnimeMetadataInput = {
  id: number
  format?: string | null
  library?: {
    slug: string
    title: string
    primaryAnimeId: number
    relationKind: string
  }
  relations?: Array<{
    relationType: string
    media: AnimeMetadataInput
  }>
  title: {
    romaji?: string | null
    english?: string | null
    native?: string | null
    userPreferred?: string | null
  }
  status?: string | null
  description?: string | null
  seasonYear?: number | null
  episodes?: number | null
  duration?: number | null
  coverImage?: string | null
  bannerImage?: string | null
  genres?: string[]
  averageScore?: number | null
  tags?: Array<{
    id: number
    name: string
    description?: string | null
    category?: string | null
    rank?: number | null
    isAdult?: boolean | null
  }>
  streamingEpisodes?: AnimeStreamingEpisodeInput[]
  rawMedia?: unknown
  anilistSyncedAt?: string | null
}

function listSeasonsForAnimeId(animeId: number) {
  return getDb()
    .query<{ season_nr: number }>(
      "SELECT DISTINCT season_nr FROM episodes WHERE anime_id = ? ORDER BY season_nr ASC"
    )
    .all(animeId)
    .map((row) => row.season_nr)
}

function listGenresForAnimeId(animeId: number) {
  return getDb()
    .query<{ genre: string }>(
      "SELECT genre FROM anime_genres WHERE anime_id = ? ORDER BY genre ASC"
    )
    .all(animeId)
    .map((row) => row.genre)
}

function listTagsForAnimeId(animeId: number) {
  return getDb()
    .query<AnimeTagRow>(
      `
      SELECT
        t.id,
        t.name,
        t.description,
        t.category,
        t.rank,
        t.is_adult AS isAdult
      FROM anime_tags at
      INNER JOIN media_tags t ON t.id = at.tag_id
      WHERE at.anime_id = ?
      ORDER BY COALESCE(t.rank, 0) DESC, t.name ASC
    `
    )
    .all(animeId)
    .map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      rank: row.rank,
      isAdult: row.isAdult === 1,
    }))
}

function listStreamingEpisodesForAnimeId(animeId: number) {
  return getDb()
    .query<StreamingEpisodeRow>(
      `
      SELECT anime_id, episode_number, title, thumbnail, url, site
      FROM anime_streaming_episodes
      WHERE anime_id = ?
      ORDER BY episode_number ASC
    `
    )
    .all(animeId)
    .map((row) => ({
      episodeNumber: row.episode_number,
      title: row.title,
      thumbnail: row.thumbnail,
      url: row.url,
      site: row.site,
    }))
}

function toAnimeInfo(
  row: AnimeRow,
  seasons = listSeasonsForAnimeId(row.id),
  genres = listGenresForAnimeId(row.id),
  tags = listTagsForAnimeId(row.id),
  variants?: AnimeVariant[]
): AnimeInfo {
  const librarySlug = requireLibrarySlug(row)

  return {
    id: row.id,
    slug: librarySlug,
    librarySlug,
    title: row.title_user_preferred,
    format: row.format ?? undefined,
    relationKind: row.relation_kind ?? undefined,
    titles: {
      romaji: row.title_romaji ?? undefined,
      english: row.title_english ?? undefined,
      native: row.title_native ?? undefined,
      userPreferred: row.title_user_preferred,
    },
    status: row.status ?? undefined,
    coverImage: row.cover_image ?? undefined,
    bannerImage: row.banner_image ?? undefined,
    episodeCount: row.episodes ?? 0,
    year: row.season_year ?? undefined,
    durationMinutes: row.duration ?? undefined,
    genres,
    averageScore: row.average_score ?? undefined,
    tags,
    description: row.description ?? undefined,
    seasons,
    variants,
  }
}

function replaceAnimeGenres(animeId: number, genres: string[]) {
  getDb().query("DELETE FROM anime_genres WHERE anime_id = ?").run(animeId)

  const statement = getDb().query(
    "INSERT OR IGNORE INTO anime_genres (anime_id, genre) VALUES (?, ?)"
  )

  for (const genre of genres) {
    const normalized = genre.trim()

    if (normalized) {
      statement.run(animeId, normalized)
    }
  }
}

function replaceAnimeTags(
  animeId: number,
  tags: NonNullable<AnimeMetadataInput["tags"]>
) {
  getDb().query("DELETE FROM anime_tags WHERE anime_id = ?").run(animeId)

  const tagStatement = getDb().query(
    `
    INSERT INTO media_tags (id, name, description, category, rank, is_adult)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      category = excluded.category,
      rank = excluded.rank,
      is_adult = excluded.is_adult
  `
  )
  const joinStatement = getDb().query(
    "INSERT OR IGNORE INTO anime_tags (anime_id, tag_id) VALUES (?, ?)"
  )

  for (const tag of tags) {
    tagStatement.run(
      tag.id,
      tag.name,
      tag.description ?? null,
      tag.category ?? null,
      tag.rank ?? null,
      tag.isAdult ? 1 : 0
    )
    joinStatement.run(animeId, tag.id)
  }
}

function inferStreamingEpisodeNumber(episode: AnimeStreamingEpisodeInput) {
  if (episode.episodeNumber && episode.episodeNumber > 0) {
    return episode.episodeNumber
  }

  const candidates = [episode.title, episode.url]
    .filter((value): value is string => Boolean(value))
    .join(" ")
  const patterns = [
    /(?:episode|ep)[\s._/-]*0*(\d{1,4})(?:\b|[^a-z0-9])/i,
    /(?:^|[^a-z0-9])e[\s._/-]*0*(\d{1,4})(?:\b|[^a-z0-9])/i,
    /(?:^|[\/._-])0*(\d{1,4})(?:[\/._-]|$)/i,
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(candidates)

    if (!match) {
      continue
    }

    const parsed = parsePositiveInt(match[1])

    if (parsed) {
      return parsed
    }
  }

  return null
}

function cleanStreamingEpisodeTitle(value: string | null | undefined) {
  if (!value) {
    return null
  }

  const cleaned = value
    .replace(/<[^>]*>/g, "")
    .replace(/^\s*(?:episode|ep)\s*\d{1,4}\s*[-–—:]\s*/i, "")
    .replace(/^\s*S\d{1,2}\s*E\d{1,4}\s*[-–—:]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()

  return cleaned || null
}

function fallbackEpisodeTitle(episodeNumber: number) {
  return `Episode ${episodeNumber}`
}

export function getCachedStreamingEpisodeTitle(animeId: number, episodeNumber: number) {
  return (
    getDb()
      .query<{ title: string }>(
        `
        SELECT title
        FROM anime_streaming_episodes
        WHERE anime_id = ?
          AND episode_number = ?
      `
      )
      .get(animeId, episodeNumber)?.title ?? null
  )
}

function setFallbackEpisodeTitles(animeId: number, now = nowIso()) {
  getDb()
    .query(
      `
      UPDATE episodes
      SET title = 'Episode ' || ep_nr,
          updated_at = ?
      WHERE anime_id = ?
    `
    )
    .run(now, animeId)
}

function replaceAnimeStreamingEpisodes(
  animeId: number,
  streamingEpisodes: AnimeStreamingEpisodeInput[]
) {
  const now = nowIso()
  const candidates = streamingEpisodes
    .map((episode, index) => ({
      index,
      episode,
      episodeNumber: inferStreamingEpisodeNumber(episode),
      title: cleanStreamingEpisodeTitle(episode.title),
    }))
    .filter((item) => item.title)
  const hasInferredEpisodeNumbers = candidates.some((item) => item.episodeNumber)
  const normalizedEpisodesByNumber = new Map<
    number,
    {
      episodeNumber: number
      title: string
      thumbnail: string | null
      url: string | null
      site: string | null
    }
  >()

  for (const candidate of candidates) {
    const episodeNumber =
      candidate.episodeNumber ??
      (hasInferredEpisodeNumbers ? null : candidate.index + 1)

    if (!episodeNumber || !candidate.title) {
      continue
    }

    if (normalizedEpisodesByNumber.has(episodeNumber)) {
      continue
    }

    normalizedEpisodesByNumber.set(episodeNumber, {
      episodeNumber,
      title: candidate.title,
      thumbnail: candidate.episode.thumbnail ?? null,
      url: candidate.episode.url ?? null,
      site: candidate.episode.site ?? null,
    })
  }

  const normalizedEpisodes = [...normalizedEpisodesByNumber.values()].sort(
    (left, right) => left.episodeNumber - right.episodeNumber
  )

  getDb()
    .query("DELETE FROM anime_streaming_episodes WHERE anime_id = ?")
    .run(animeId)

  if (normalizedEpisodes.length === 0) {
    setFallbackEpisodeTitles(animeId, now)
    getDb()
      .query(
        "UPDATE anime SET streaming_episodes_synced_at = ?, updated_at = ? WHERE id = ?"
      )
      .run(now, now, animeId)
    return
  }

  const insert = getDb().query(
    `
    INSERT INTO anime_streaming_episodes (
      anime_id,
      episode_number,
      title,
      thumbnail,
      url,
      site,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(anime_id, episode_number) DO UPDATE SET
      title = excluded.title,
      thumbnail = excluded.thumbnail,
      url = excluded.url,
      site = excluded.site,
      updated_at = excluded.updated_at
  `
  )

  for (const episode of normalizedEpisodes) {
    insert.run(
      animeId,
      episode.episodeNumber,
      episode.title,
      episode.thumbnail,
      episode.url,
      episode.site,
      now,
      now
    )
  }

  syncEpisodeTitlesFromCachedStreaming(animeId, now)

  getDb()
    .query(
      "UPDATE anime SET streaming_episodes_synced_at = ?, updated_at = ? WHERE id = ?"
    )
    .run(now, now, animeId)
}

function syncEpisodeTitlesFromCachedStreaming(animeId: number, now = nowIso()) {
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
    .run(now, animeId)
}

function safeJsonStringify(value: unknown) {
  if (value === undefined || value === null) {
    return null
  }

  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function safeJsonParse(value: string | null) {
  if (!value) {
    return undefined
  }

  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function toEpisode(row: EpisodeRow): Episode {
  const durationSeconds =
    row.duration_seconds ?? row.watched_duration_seconds ?? undefined
  const watchedSeconds = row.watched_seconds ?? 0
  const completed = row.completed === 1
  const ratio = durationSeconds
    ? Math.min(Math.max(watchedSeconds / durationSeconds, 0), 1)
    : completed
      ? 1
      : 0

  return {
    animeId: row.anime_id,
    seasonNumber: row.season_nr,
    episodeNumber: row.ep_nr,
    title: row.title ?? fallbackEpisodeTitle(row.ep_nr),
    fileName: baseFileName(row.file_path),
    filePath: row.file_path,
    thumbnail: `/api/anime/${row.anime_id}/episodes/${row.ep_nr}/thumbnail?season=${row.season_nr}`,
    durationSeconds,
    progress:
      watchedSeconds > 0 || completed
        ? {
            watchedSeconds,
            durationSeconds,
            completed,
            ratio,
          }
        : undefined,
  }
}

function upsertAnimeBase(metadata: AnimeMetadataInput) {
  const now = nowIso()
  const titleUserPreferred = animeTitle(metadata)
  const rawMedia = safeJsonStringify(metadata.rawMedia)
  const syncedAt = rawMedia ? (metadata.anilistSyncedAt ?? now) : null

  getDb()
    .query(
      `
      INSERT INTO anime (
        id,
        library_slug,
        format,
        relation_kind,
        title_romaji,
        title_english,
        title_native,
        title_user_preferred,
        status,
        description,
        season_year,
        episodes,
        duration,
        cover_image,
        banner_image,
        average_score,
        anilist_raw_json,
        anilist_synced_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        library_slug = COALESCE(excluded.library_slug, anime.library_slug),
        format = excluded.format,
        relation_kind = COALESCE(excluded.relation_kind, anime.relation_kind),
        title_romaji = excluded.title_romaji,
        title_english = excluded.title_english,
        title_native = excluded.title_native,
        title_user_preferred = excluded.title_user_preferred,
        status = excluded.status,
        description = excluded.description,
        season_year = excluded.season_year,
        episodes = excluded.episodes,
        duration = excluded.duration,
        cover_image = excluded.cover_image,
        banner_image = excluded.banner_image,
        average_score = excluded.average_score,
        anilist_raw_json = COALESCE(excluded.anilist_raw_json, anime.anilist_raw_json),
        anilist_synced_at = COALESCE(excluded.anilist_synced_at, anime.anilist_synced_at),
        updated_at = excluded.updated_at
    `
    )
    .run(
      metadata.id,
      metadata.library?.slug ?? null,
      metadata.format ?? null,
      metadata.library?.relationKind ?? null,
      metadata.title.romaji ?? null,
      metadata.title.english ?? null,
      metadata.title.native ?? null,
      titleUserPreferred,
      metadata.status ?? null,
      metadata.description ?? null,
      metadata.seasonYear ?? null,
      metadata.episodes ?? null,
      metadata.duration ?? null,
      metadata.coverImage ?? null,
      metadata.bannerImage ?? null,
      metadata.averageScore ?? null,
      rawMedia,
      syncedAt,
      now,
      now
    )
}

function replaceAnimeRelations(
  animeId: number,
  relations: NonNullable<AnimeMetadataInput["relations"]>
) {
  getDb().query("DELETE FROM anime_relations WHERE anime_id = ?").run(animeId)

  const statement = getDb().query(
    "INSERT OR IGNORE INTO anime_relations (anime_id, related_anime_id, relation_type) VALUES (?, ?, ?)"
  )

  for (const relation of relations) {
    statement.run(animeId, relation.media.id, relation.relationType)
  }
}

function normalizeRelatedMetadata(
  media: AnimeMetadataInput,
  library: NonNullable<AnimeMetadataInput["library"]>,
  relationKind: string
): AnimeMetadataInput {
  return {
    ...media,
    library: {
      ...library,
      relationKind: media.id === library.primaryAnimeId ? "self" : relationKind,
    },
  }
}

function stripLibraryInfo(media: AnimeMetadataInput): AnimeMetadataInput {
  return {
    ...media,
    library: undefined,
  }
}

function unlinkExternalRelationsFromLibrary(input: {
  librarySlug: string
  primaryAnimeId: number
  selectedAnimeId: number
  relations: NonNullable<AnimeMetadataInput["relations"]>
}) {
  const externalRelationIds = input.relations
    .filter((relation) => !isLibraryRelationType(relation.relationType))
    .map((relation) => relation.media.id)
    .filter(
      (animeId) =>
        animeId !== input.primaryAnimeId && animeId !== input.selectedAnimeId
    )

  if (externalRelationIds.length === 0) {
    return
  }

  const placeholders = externalRelationIds.map(() => "?").join(", ")
  const result = getDb()
    .query(
      `
      UPDATE anime
      SET library_slug = NULL,
          relation_kind = NULL,
          updated_at = ?
      WHERE library_slug = ?
        AND id IN (${placeholders})
    `
    )
    .run(nowIso(), input.librarySlug, ...externalRelationIds)

  if (result.changes > 0) {
    console.warn(
      `[Warn] [Library] Detached ${result.changes} external AniList relation(s) from library ${input.librarySlug}`
    )
  }
}

export function upsertAnime(metadata: AnimeMetadataInput) {
  const library = requireLibrary(metadata)
  const relations = metadata.relations ?? []
  const rootMetadata =
    library.primaryAnimeId === metadata.id
      ? metadata
      : relations.find((relation) => relation.media.id === library.primaryAnimeId)
          ?.media

  if (!rootMetadata) {
    throw new Error(
      `AniList media ${metadata.id} did not include its resolved library root ${library.primaryAnimeId}`
    )
  }

  debugLog(
    `[Debug] [Library] Upserting AniList metadata - Media id ${metadata.id}, Root id ${library.primaryAnimeId}, Library slug ${library.slug}`
  )

  upsertAnimeBase(normalizeRelatedMetadata(rootMetadata, library, "self"))
  debugLog(
    `[Debug] [Library] Root anime row upserted - Anime id ${rootMetadata.id}`
  )

  const librarySlug = ensureLibraryEntry(library)
  const normalizedLibrary = {
    ...library,
    slug: librarySlug,
  }

  debugLog(
    `[Debug] [Library] Library entry upserted - Slug ${librarySlug}, Primary anime id ${normalizedLibrary.primaryAnimeId}`
  )

  for (const relation of relations) {
    upsertAnimeBase(
      relation.media.id === normalizedLibrary.primaryAnimeId
        ? normalizeRelatedMetadata(relation.media, normalizedLibrary, "self")
        : stripLibraryInfo(relation.media)
    )
  }

  unlinkExternalRelationsFromLibrary({
    librarySlug,
    primaryAnimeId: normalizedLibrary.primaryAnimeId,
    selectedAnimeId: metadata.id,
    relations,
  })

  debugLog(
    `[Debug] [Library] Related anime rows upserted - Count ${relations.length}`
  )

  upsertAnimeBase(normalizeRelatedMetadata(metadata, normalizedLibrary, library.relationKind))
  debugLog(
    `[Debug] [Library] Selected anime row upserted - Anime id ${metadata.id}`
  )

  replaceAnimeGenres(metadata.id, metadata.genres ?? [])
  replaceAnimeTags(metadata.id, metadata.tags ?? [])
  replaceAnimeRelations(metadata.id, metadata.relations ?? [])
  replaceAnimeStreamingEpisodes(metadata.id, metadata.streamingEpisodes ?? [])

  debugLog(
    `[Debug] [Library] AniList metadata upsert completed - Anime id ${metadata.id}`
  )
}

export function getMaxCachedStreamingEpisodeNumber(animeId: number) {
  return (
    getDb()
      .query<{ max_episode: number | null }>(
        `
        SELECT MAX(episode_number) AS max_episode
        FROM anime_streaming_episodes
        WHERE anime_id = ?
      `
      )
      .get(animeId)?.max_episode ?? 0
  )
}


function extractSeasonMarkerFromTitle(value: string | null | undefined) {
  if (!value) {
    return null
  }

  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const seasonMatch = /\bseason\s*0*(\d{1,2})\b/i.exec(normalized)
  const shortSeasonMatch = /\bs\s*0*(\d{1,2})\b/i.exec(normalized)
  const season = parsePositiveInt(seasonMatch?.[1] ?? shortSeasonMatch?.[1])

  return season && season > 0 ? season : null
}

function titleSeasonMarker(
  row: Pick<
    AnimeRow,
    "title_user_preferred" | "title_english" | "title_romaji" | "title_native"
  >
) {
  for (const title of rowTitles(row)) {
    const season = extractSeasonMarkerFromTitle(title)

    if (season) {
      return season
    }
  }

  return null
}

export function resolveLibrarySeasonNumberForAnime(input: {
  animeId: number
  parsedSeason: number
  parsedPart?: number
}) {
  if (input.parsedPart && input.parsedPart > 1) {
    return input.parsedSeason
  }

  const row = getDb()
    .query<AnimeRow>("SELECT * FROM anime WHERE id = ?")
    .get(input.animeId)

  if (!row?.library_slug || !seriesFormats.has(row.format ?? "")) {
    return input.parsedSeason
  }

  const markerSeason = titleSeasonMarker(row)

  if (markerSeason) {
    return markerSeason
  }

  const library = getDb()
    .query<LibraryEntryRow>(
      "SELECT slug, title, primary_anime_id FROM library_entries WHERE slug = ?"
    )
    .get(row.library_slug)

  if (!library || row.id === library.primary_anime_id) {
    return input.parsedSeason
  }

  const seriesVariants = listCachedAnimeVariants(row.library_slug).filter(
    (variant) => seriesFormats.has(variant.format ?? "")
  )
  const variantIndex = seriesVariants.findIndex((variant) => variant.id === row.id)

  return variantIndex >= 0 ? variantIndex + 1 : input.parsedSeason
}

export function upsertEpisode(input: {
  animeId: number
  seasonNr: number
  epNr: number
  filePath: string
  title?: string | null
  thumbnailPath?: string | null
  durationSeconds?: number | null
}) {
  const now = nowIso()
  const title =
    input.title ??
    getCachedStreamingEpisodeTitle(input.animeId, input.epNr) ??
    fallbackEpisodeTitle(input.epNr)

  debugLog(
    `[Debug] [Library] Upserting episode row - Anime id ${input.animeId}, Season ${input.seasonNr}, Episode ${input.epNr}, Path ${input.filePath}`
  )

  getDb()
    .query(
      `
      INSERT INTO episodes (
        anime_id,
        season_nr,
        ep_nr,
        title,
        file_path,
        thumbnail_path,
        duration_seconds,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(anime_id, season_nr, ep_nr) DO UPDATE SET
        title = excluded.title,
        file_path = excluded.file_path,
        thumbnail_path = excluded.thumbnail_path,
        duration_seconds = excluded.duration_seconds,
        updated_at = excluded.updated_at
    `
    )
    .run(
      input.animeId,
      input.seasonNr,
      input.epNr,
      title,
      input.filePath,
      input.thumbnailPath ?? null,
      input.durationSeconds ?? null,
      now,
      now
    )

  syncEpisodeTitlesFromCachedStreaming(input.animeId, now)

  debugLog(
    `[Debug] [Library] Episode row upsert completed - Anime id ${input.animeId}, Season ${input.seasonNr}, Episode ${input.epNr}`
  )
}

export function listAnime(): AnimeSummary[] {
  return getDb()
    .query<AnimeListRow>(
      `
      SELECT
        le.slug,
        le.title AS library_title,
        le.primary_anime_id,
        root.id,
        root.library_slug,
        root.format,
        root.relation_kind,
        root.title_romaji,
        root.title_english,
        root.title_native,
        root.title_user_preferred,
        root.status,
        root.description,
        root.season_year,
        root.episodes,
        root.duration,
        root.cover_image,
        root.banner_image,
        root.average_score,
        root.anilist_raw_json,
        root.anilist_synced_at,
        root.streaming_episodes_synced_at,
        0 AS local_episode_count,
        0 AS media_count
      FROM library_entries le
      INNER JOIN anime root ON root.id = le.primary_anime_id
      ORDER BY le.title ASC
    `
    )
    .all()
    .flatMap((row): AnimeSummary[] => {
      const variants = listAnimeVariants(row.slug)
      const localEpisodeCount = variants.reduce(
        (total, variant) => total + variant.episodeCount,
        0
      )

      if (localEpisodeCount <= 0) {
        return []
      }

      return [
        {
          id: row.primary_anime_id,
          slug: row.slug,
          title: row.library_title,
          coverImage: row.cover_image ?? undefined,
          bannerImage: row.banner_image ?? undefined,
          episodeCount: localEpisodeCount,
          mediaCount: variants.length,
          year: row.season_year ?? undefined,
        },
      ]
    })
}

function toAnimeVariant(row: AnimeVariantRow): AnimeVariant {
  return {
    id: row.id,
    title: row.title_user_preferred,
    format: row.format ?? undefined,
    year: row.season_year ?? undefined,
    episodeCount: row.local_episode_count,
    seasonNumber: row.first_season_nr ?? undefined,
  }
}

function isLibraryMemberAnime(librarySlug: string, animeId: number) {
  const library = getDb()
    .query<LibraryEntryRow>(
      "SELECT slug, title, primary_anime_id FROM library_entries WHERE slug = ?"
    )
    .get(librarySlug)

  if (!library) {
    return false
  }

  if (animeId === library.primary_anime_id) {
    return true
  }

  const relationTypes = [...libraryRelationTypes]
  const placeholders = relationTypes.map(() => "?").join(", ")
  const relation = getDb()
    .query<{ count: number }>(
      `
      SELECT COUNT(*) AS count
      FROM anime_relations
      WHERE (
          (anime_id = ? AND related_anime_id = ?)
          OR (anime_id = ? AND related_anime_id = ?)
        )
        AND relation_type IN (${placeholders})
    `
    )
    .get(
      animeId,
      library.primary_anime_id,
      library.primary_anime_id,
      animeId,
      ...relationTypes
    )

  return (relation?.count ?? 0) > 0
}

function listAnimeVariants(librarySlug: string) {
  return getDb()
    .query<AnimeVariantRow>(
      `
      SELECT
        a.*,
        COUNT(e.ep_nr) AS local_episode_count,
        MIN(e.season_nr) AS first_season_nr
      FROM anime a
      INNER JOIN episodes e ON e.anime_id = a.id
      WHERE a.library_slug = ?
      GROUP BY a.id
      HAVING local_episode_count > 0
      ORDER BY
        CASE a.format
          WHEN 'TV' THEN 0
          WHEN 'TV_SHORT' THEN 1
          WHEN 'ONA' THEN 2
          WHEN 'MOVIE' THEN 3
          WHEN 'SPECIAL' THEN 4
          WHEN 'OVA' THEN 5
          ELSE 6
        END,
        COALESCE(a.season_year, 9999),
        a.title_user_preferred
    `
    )
    .all(librarySlug)
    .filter((row) => isLibraryMemberAnime(librarySlug, row.id))
    .map(toAnimeVariant)
}

function listCachedAnimeVariants(librarySlug: string) {
  return getDb()
    .query<AnimeRow>(
      `
      SELECT *
      FROM anime
      WHERE library_slug = ?
      ORDER BY
        CASE format
          WHEN 'TV' THEN 0
          WHEN 'TV_SHORT' THEN 1
          WHEN 'ONA' THEN 2
          WHEN 'MOVIE' THEN 3
          WHEN 'SPECIAL' THEN 4
          WHEN 'OVA' THEN 5
          ELSE 6
        END,
        COALESCE(season_year, 9999),
        title_user_preferred
    `
    )
    .all(librarySlug)
    .filter((row) => isLibraryMemberAnime(librarySlug, row.id))
}

export function getLibraryEntry(
  identifier: string,
  selectedAnimeId?: string | number
) {
  const entry = getDb()
    .query<LibraryEntryRow>(
      "SELECT slug, title, primary_anime_id FROM library_entries WHERE slug = ?"
    )
    .get(identifier)

  if (!entry) {
    return null
  }

  const variants = listAnimeVariants(entry.slug)

  if (variants.length === 0) {
    return null
  }

  const selectedId = parsePositiveInt(selectedAnimeId)
  const selectedVariant =
    variants.find((variant) => variant.id === selectedId) ??
    variants.find((variant) => variant.id === entry.primary_anime_id) ??
    variants[0]

  if (!selectedVariant) {
    return null
  }

  const anime = getAnime(selectedVariant.id)

  if (!anime) {
    return null
  }

  return {
    slug: entry.slug,
    title: entry.title,
    variants,
    selected: {
      ...anime,
      slug: entry.slug,
      librarySlug: entry.slug,
      variants,
    },
  }
}

export function getAnime(animeId: string | number) {
  const id = parsePositiveInt(animeId)

  if (!id) {
    return null
  }

  const row = getDb()
    .query<AnimeRow>("SELECT * FROM anime WHERE id = ?")
    .get(id)

  return row ? toAnimeInfo(row) : null
}

export function listEpisodes(animeId: string | number, username?: string) {
  const id = parsePositiveInt(animeId)

  if (!id) {
    return []
  }

  if (username) {
    return getDb()
      .query<EpisodeRow>(
        `
        SELECT
          e.anime_id,
          e.season_nr,
          e.ep_nr,
          e.title,
          e.file_path,
          e.thumbnail_path,
          e.duration_seconds,
          p.watched_seconds,
          p.duration_seconds AS watched_duration_seconds,
          p.completed
        FROM episodes e
        LEFT JOIN episode_progress p
          ON p.username = ?
          AND p.anime_id = e.anime_id
          AND p.season_nr = e.season_nr
          AND p.ep_nr = e.ep_nr
        WHERE e.anime_id = ?
        ORDER BY e.season_nr ASC, e.ep_nr ASC
      `
      )
      .all(username, id)
      .map(toEpisode)
  }

  return getDb()
    .query<EpisodeRow>(
      `
      SELECT anime_id, season_nr, ep_nr, title, file_path, thumbnail_path, duration_seconds
      FROM episodes
      WHERE anime_id = ?
      ORDER BY season_nr ASC, ep_nr ASC
    `
    )
    .all(id)
    .map(toEpisode)
}

export function getStoredEpisode(
  animeId: string | number,
  seasonOrEpNr: string | number,
  epNr?: string | number,
  username?: string
) {
  const id = parsePositiveInt(animeId)
  const seasonNumber = epNr === undefined ? 1 : parsePositiveInt(seasonOrEpNr)
  const episodeNumber =
    epNr === undefined ? parsePositiveInt(seasonOrEpNr) : parsePositiveInt(epNr)

  if (!id || !seasonNumber || !episodeNumber) {
    return null
  }

  const rows = username
    ? getDb()
        .query<EpisodeRow>(
          `
          SELECT
            e.anime_id,
            e.season_nr,
            e.ep_nr,
            e.title,
            e.file_path,
            e.thumbnail_path,
            e.duration_seconds,
            p.watched_seconds,
            p.duration_seconds AS watched_duration_seconds,
            p.completed
          FROM episodes e
          LEFT JOIN episode_progress p
            ON p.username = ?
            AND p.anime_id = e.anime_id
            AND p.season_nr = e.season_nr
            AND p.ep_nr = e.ep_nr
          WHERE e.anime_id = ? AND e.season_nr = ? AND e.ep_nr = ?
        `
        )
        .get(username, id, seasonNumber, episodeNumber)
    : getDb()
        .query<EpisodeRow>(
          `
          SELECT anime_id, season_nr, ep_nr, title, file_path, thumbnail_path, duration_seconds
          FROM episodes
          WHERE anime_id = ? AND season_nr = ? AND ep_nr = ?
        `
        )
        .get(id, seasonNumber, episodeNumber)

  return rows ? toEpisode(rows) : null
}

export function getEpisodeByPath(filePath: string) {
  const row = getDb()
    .query<EpisodeRow>(
      `
      SELECT anime_id, season_nr, ep_nr, title, file_path, thumbnail_path, duration_seconds
      FROM episodes
      WHERE file_path = ?
    `
    )
    .get(filePath)

  return row ? toEpisode(row) : null
}

export function getLibraryEventTargetForAnime(animeId: string | number) {
  const id = parsePositiveInt(animeId)

  if (!id) {
    return null
  }

  const row = getDb()
    .query<{
      anime_id: number
      library_slug: string | null
      primary_anime_id: number | null
    }>(
      `
      SELECT
        a.id AS anime_id,
        a.library_slug,
        le.primary_anime_id
      FROM anime a
      LEFT JOIN library_entries le ON le.slug = a.library_slug
      WHERE a.id = ?
    `
    )
    .get(id)

  if (!row?.library_slug) {
    return null
  }

  return {
    animeId: row.anime_id,
    rootAnimeId: row.primary_anime_id ?? row.anime_id,
    librarySlug: row.library_slug,
  }
}

export function getEpisodeThumbnailPath(
  animeId: string | number,
  seasonNr: string | number,
  epNr: string | number
) {
  const id = parsePositiveInt(animeId)
  const seasonNumber = parsePositiveInt(seasonNr)
  const episodeNumber = parsePositiveInt(epNr)

  if (!id || !seasonNumber || !episodeNumber) {
    return null
  }

  return (
    getDb()
      .query<{ thumbnail_path: string | null }>(
        `
        SELECT thumbnail_path
        FROM episodes
        WHERE anime_id = ? AND season_nr = ? AND ep_nr = ?
      `
      )
      .get(id, seasonNumber, episodeNumber)?.thumbnail_path ?? null
  )
}

export function listEpisodeFilePaths() {
  return getDb()
    .query<{ file_path: string }>("SELECT file_path FROM episodes")
    .all()
    .map((row) => row.file_path)
}

export function deleteEpisodeByPath(filePath: string) {
  const episode = getEpisodeByPath(filePath)

  if (!episode) {
    return null
  }

  getDb()
    .query(
      "DELETE FROM episodes WHERE anime_id = ? AND season_nr = ? AND ep_nr = ?"
    )
    .run(episode.animeId, episode.seasonNumber, episode.episodeNumber)

  pruneAnimeIfEmpty(episode.animeId)
  return episode
}

export function deleteEpisodeRecord(input: {
  animeId: number
  seasonNr: number
  epNr: number
}) {
  getDb()
    .query(
      "DELETE FROM episode_progress WHERE anime_id = ? AND season_nr = ? AND ep_nr = ?"
    )
    .run(input.animeId, input.seasonNr, input.epNr)
  getDb()
    .query(
      "DELETE FROM episodes WHERE anime_id = ? AND season_nr = ? AND ep_nr = ?"
    )
    .run(input.animeId, input.seasonNr, input.epNr)
}

export function pruneAnimeIfEmpty(animeId: number) {
  const remaining =
    getDb()
      .query<{
        count: number
      }>("SELECT COUNT(*) AS count FROM episodes WHERE anime_id = ?")
      .get(animeId)?.count ?? 0

  if (remaining > 0) {
    return
  }

  const libraryStillHasFiles =
    getDb()
      .query<{ count: number }>(
        `
        SELECT COUNT(e.ep_nr) AS count
        FROM library_entries le
        INNER JOIN anime a ON a.library_slug = le.slug
        INNER JOIN episodes e ON e.anime_id = a.id
        WHERE le.primary_anime_id = ?
      `
      )
      .get(animeId)?.count ?? 0

  if (libraryStillHasFiles > 0) {
    return
  }

  getDb().query("DELETE FROM anime WHERE id = ?").run(animeId)
}

export function getAdjacentEpisodes(input: {
  animeId: number
  seasonNr: number
  epNr: number
  username?: string
}) {
  const episodes = listEpisodes(input.animeId, input.username)
  const index = episodes.findIndex(
    (episode) =>
      episode.seasonNumber === input.seasonNr &&
      episode.episodeNumber === input.epNr
  )

  return {
    previousEpisode: index > 0 ? episodes[index - 1] : undefined,
    nextEpisode:
      index >= 0 && index < episodes.length - 1
        ? episodes[index + 1]
        : undefined,
  }
}

export function upsertEpisodeProgress(input: {
  username: string
  animeId: number
  seasonNr: number
  epNr: number
  watchedSeconds: number
  durationSeconds?: number | null
  completed: boolean
}) {
  const now = nowIso()

  getDb()
    .query(
      `
      INSERT INTO episode_progress (
        username,
        anime_id,
        season_nr,
        ep_nr,
        watched_seconds,
        duration_seconds,
        completed,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username, anime_id, season_nr, ep_nr) DO UPDATE SET
        watched_seconds = MAX(episode_progress.watched_seconds, excluded.watched_seconds),
        duration_seconds = COALESCE(excluded.duration_seconds, episode_progress.duration_seconds),
        completed = CASE
          WHEN episode_progress.completed = 1 OR excluded.completed = 1 THEN 1
          ELSE 0
        END,
        updated_at = excluded.updated_at
    `
    )
    .run(
      input.username,
      input.animeId,
      input.seasonNr,
      input.epNr,
      Math.max(input.watchedSeconds, 0),
      input.durationSeconds ?? null,
      input.completed ? 1 : 0,
      now,
      now
    )
}

export function markEpisodesCompleteThrough(input: {
  username: string
  animeId: number
  progress: number
}) {
  const episodes = listEpisodes(input.animeId)
  const completedEpisodes = episodes.slice(0, Math.max(input.progress, 0))
  const now = nowIso()

  for (const episode of completedEpisodes) {
    upsertEpisodeProgress({
      username: input.username,
      animeId: input.animeId,
      seasonNr: episode.seasonNumber,
      epNr: episode.episodeNumber,
      watchedSeconds: episode.durationSeconds ?? 0,
      durationSeconds: episode.durationSeconds ?? null,
      completed: true,
    })
  }

  getDb()
    .query(
      `
      UPDATE episode_progress
      SET watched_seconds = 0,
          completed = 0,
          updated_at = ?
      WHERE username = ?
        AND anime_id = ?
        AND ep_nr > ?
    `
    )
    .run(now, input.username, input.animeId, Math.max(input.progress, 0))

  return completedEpisodes.length
}

function normalizeComparableTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(season|part|cour)\s+\d+\b/g, " ")
    .replace(/\bs\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function titleTokens(value: string) {
  return normalizeComparableTitle(value)
    .split(" ")
    .filter((token) => token.length > 2)
}

function tokenOverlap(search: string, title: string) {
  const searchTokens = titleTokens(search)

  if (searchTokens.length === 0) {
    return 0
  }

  const candidateTokens = new Set(titleTokens(title))
  const matches = searchTokens.filter((token) => candidateTokens.has(token))

  return matches.length / searchTokens.length
}

function hasUnrequestedTitleSuffix(normalizedTitle: string, normalizedSearch: string) {
  const searchTokens = normalizedSearch.split(" ").filter(Boolean)

  if (searchTokens.length < 4 || normalizedTitle === normalizedSearch) {
    return false
  }

  return normalizedTitle.startsWith(`${normalizedSearch} `)
}

function scoreTitleCandidate(search: string, titles: Array<string | null | undefined>) {
  const normalizedSearch = normalizeComparableTitle(search)
  const normalizedTitles = titles
    .filter((title): title is string => Boolean(title))
    .map(normalizeComparableTitle)
    .filter(Boolean)

  if (normalizedTitles.length === 0 || !normalizedSearch) {
    return 4
  }

  if (normalizedTitles.some((title) => title === normalizedSearch)) {
    return 0
  }

  if (normalizedTitles.some((title) => title.includes(normalizedSearch))) {
    const bestContainingTitle = normalizedTitles
      .filter((title) => title.includes(normalizedSearch))
      .sort((left, right) => left.length - right.length)[0]

    return hasUnrequestedTitleSuffix(bestContainingTitle, normalizedSearch) ? 4 : 1
  }

  const bestOverlap = Math.max(
    ...normalizedTitles.map((title) => tokenOverlap(normalizedSearch, title)),
    0
  )

  return bestOverlap >= 0.7 ? 2 : 4
}

function rowTitles(row: Pick<AnimeRow, "title_user_preferred" | "title_english" | "title_romaji" | "title_native">) {
  return [
    row.title_user_preferred,
    row.title_english,
    row.title_romaji,
    row.title_native,
  ]
}

function getOrdinalPartLabel(part: number) {
  const ordinals: Record<number, string> = {
    1: "1st",
    2: "2nd",
    3: "3rd",
  }

  return ordinals[part] ?? `${part}th`
}

function getWordPartLabel(part: number) {
  const labels: Record<number, string> = {
    1: "first",
    2: "second",
    3: "third",
    4: "fourth",
    5: "fifth",
    6: "sixth",
    7: "seventh",
    8: "eighth",
    9: "ninth",
    10: "tenth",
  }

  return labels[part] ?? null
}

function getRomanPartLabel(part: number) {
  const labels: Record<number, string> = {
    1: "i",
    2: "ii",
    3: "iii",
    4: "iv",
    5: "v",
    6: "vi",
    7: "vii",
    8: "viii",
    9: "ix",
    10: "x",
  }

  return labels[part] ?? null
}

function hasPartMarker(value: string, part: number) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const ordinalPart = getOrdinalPartLabel(part).toLowerCase()
  const wordPart = getWordPartLabel(part)
  const romanPart = getRomanPartLabel(part)
  const markers = [
    `part ${part}`,
    `pt ${part}`,
    `cour ${part}`,
    `p ${part}`,
    `c ${part}`,
    `${ordinalPart} cour`,
  ]

  if (wordPart) {
    markers.push(`${wordPart} cour`, `${wordPart} half`)
  }

  if (romanPart) {
    markers.push(`part ${romanPart}`, `pt ${romanPart}`, `p ${romanPart}`)
  }

  return markers.some((marker) => normalized.includes(marker))
}

function rowHasPartMarker(
  row: Pick<AnimeRow, "title_user_preferred" | "title_english" | "title_romaji" | "title_native">,
  part?: number
) {
  if (!part || part <= 1) {
    return true
  }

  return rowTitles(row)
    .filter((title): title is string => Boolean(title))
    .some((title) => hasPartMarker(title, part))
}

function rowHasSeasonMarker(
  row: Pick<AnimeRow, "title_user_preferred" | "title_english" | "title_romaji" | "title_native">,
  season?: number
) {
  if (!season || season <= 1) {
    return true
  }

  const markers = [`season ${season}`, `s${season}`]

  return rowTitles(row)
    .filter((title): title is string => Boolean(title))
    .some((title) => {
      const normalized = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()

      return markers.some((marker) => normalized.includes(marker))
    })
}

function toMetadataFromRow(
  row: AnimeRow,
  visited = new Set<number>()
): AnimeMetadataInput {
  const library = row.library_slug
    ? getDb()
        .query<LibraryEntryRow>(
          "SELECT slug, title, primary_anime_id FROM library_entries WHERE slug = ?"
        )
        .get(row.library_slug)
    : null

  const nextVisited = new Set(visited)
  nextVisited.add(row.id)
  const relations = visited.has(row.id)
    ? []
    : getDb()
        .query<{ relation_type: string; related_anime_id: number }>(
          `
          SELECT relation_type, related_anime_id
          FROM anime_relations
          WHERE anime_id = ?
        `
        )
        .all(row.id)
        .map((relation) => {
          if (nextVisited.has(relation.related_anime_id)) {
            return null
          }

          const relatedRow = getDb()
            .query<AnimeRow>("SELECT * FROM anime WHERE id = ?")
            .get(relation.related_anime_id)
          const related = relatedRow
            ? toMetadataFromRow(relatedRow, nextVisited)
            : null

          return related
            ? {
                relationType: relation.relation_type,
                media: related,
              }
            : null
        })
        .filter(
          (relation): relation is { relationType: string; media: AnimeMetadataInput } =>
            Boolean(relation)
        )

  return {
    id: row.id,
    format: row.format,
    library: library
      ? {
          slug: library.slug,
          title: library.title,
          primaryAnimeId: library.primary_anime_id,
          relationKind: row.relation_kind ?? "related",
        }
      : undefined,
    relations,
    title: {
      romaji: row.title_romaji,
      english: row.title_english,
      native: row.title_native,
      userPreferred: row.title_user_preferred,
    },
    status: row.status,
    description: row.description,
    seasonYear: row.season_year,
    episodes: row.episodes,
    duration: row.duration,
    coverImage: row.cover_image,
    bannerImage: row.banner_image,
    genres: listGenresForAnimeId(row.id),
    averageScore: row.average_score,
    tags: listTagsForAnimeId(row.id),
    streamingEpisodes: listStreamingEpisodesForAnimeId(row.id),
    rawMedia: safeJsonParse(row.anilist_raw_json),
    anilistSyncedAt: row.anilist_synced_at,
  }
}

export function getAnimeMetadataById(animeId: number) {
  const row = getDb()
    .query<AnimeRow>("SELECT * FROM anime WHERE id = ?")
    .get(animeId)

  return row ? toMetadataFromRow(row) : null
}

function listCachedAnimeCandidates() {
  return getDb()
    .query<CachedAnimeCandidateRow>(
      `
      SELECT
        a.*,
        le.title AS library_title,
        le.primary_anime_id
      FROM anime a
      LEFT JOIN library_entries le ON le.slug = a.library_slug
      WHERE a.library_slug IS NOT NULL
    `
    )
    .all()
}

function findLibraryRootMatch(title: string) {
  const candidates = listCachedAnimeCandidates()
    .filter((row) => row.primary_anime_id === row.id)
    .map((row) => ({
      row,
      score: scoreTitleCandidate(title, [...rowTitles(row), row.library_title]),
    }))
    .sort((left, right) => left.score - right.score)

  return candidates.find((candidate) => candidate.score <= 2)?.row ?? null
}

function findSeasonVariant(librarySlug: string, season?: number, part?: number) {
  if (!season || season <= 1) {
    return null
  }

  const seriesVariants = listCachedAnimeVariants(librarySlug).filter((row) =>
    seriesFormats.has(row.format ?? "")
  )

  if (part && part > 1) {
    return (
      seriesVariants.find(
        (row) => rowHasPartMarker(row, part) && rowHasSeasonMarker(row, season)
      ) ?? null
    )
  }

  return seriesVariants[season - 1] ?? null
}

export function findCachedAnimeMetadataForFile(
  title: string,
  season?: number,
  part?: number
) {
  const root = findLibraryRootMatch(title)

  if (root?.library_slug) {
    const seasonVariant = findSeasonVariant(root.library_slug, season, part)

    if (seasonVariant) {
      return toMetadataFromRow(seasonVariant)
    }

    if ((season && season > 1) || (part && part > 1)) {
      return null
    }

    return toMetadataFromRow(root)
  }

  const directMatch = listCachedAnimeCandidates()
    .filter(
      (row) =>
        row.library_slug &&
        isLibraryMemberAnime(row.library_slug, row.id) &&
        rowHasPartMarker(row, part)
    )
    .map((row) => ({
      row,
      score: scoreTitleCandidate(title, rowTitles(row)),
    }))
    .sort((left, right) => left.score - right.score)
    .find((candidate) => candidate.score <= 1)?.row

  return directMatch ? toMetadataFromRow(directMatch) : null
}

export function listAnimeIdsForAniListRefresh() {
  return getDb()
    .query<{ id: number }>(
      `
      SELECT DISTINCT a.id
      FROM anime a
      WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.anime_id = a.id)
        OR EXISTS (
          SELECT 1
          FROM library_entries le
          WHERE le.primary_anime_id = a.id
        )
      ORDER BY a.id ASC
    `
    )
    .all()
    .map((row) => row.id)
}
