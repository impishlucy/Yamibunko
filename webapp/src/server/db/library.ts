import type { AnimeInfo, AnimeSummary, AnimeVariant, Episode } from "@/lib/types"
import { getDb, nowIso } from "@/server/db/sqlite"
import {
  fileName as baseFileName,
  parsePositiveInt,
} from "@/server/utils/format"

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
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  upsertAnimeBase({
    ...rootMetadata,
    library: {
      ...library,
      relationKind:
        rootMetadata.id === metadata.id ? library.relationKind : "self",
    },
  })

  const librarySlug = ensureLibraryEntry(library)
  const normalizedLibrary = {
    ...library,
    slug: librarySlug,
  }

  for (const relation of relations) {
    upsertAnimeBase(
      relation.media.id === normalizedLibrary.primaryAnimeId
        ? {
            ...relation.media,
            library: {
              ...normalizedLibrary,
              relationKind: "self",
            },
          }
        : relation.media
    )
  }

  upsertAnimeBase({
    ...metadata,
    library: normalizedLibrary,
  })

  replaceAnimeGenres(metadata.id, metadata.genres ?? [])
  replaceAnimeTags(metadata.id, metadata.tags ?? [])
  replaceAnimeRelations(metadata.id, metadata.relations ?? [])
}

export function upsertEpisode(input: {
  animeId: number
  seasonNr: number
  epNr: number
  filePath: string
  thumbnailPath?: string | null
  durationSeconds?: number | null
}) {
  const now = nowIso()

  getDb()
    .query(
      `
      INSERT INTO episodes (
        anime_id,
        season_nr,
        ep_nr,
        file_path,
        thumbnail_path,
        duration_seconds,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(anime_id, season_nr, ep_nr) DO UPDATE SET
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
      input.filePath,
      input.thumbnailPath ?? null,
      input.durationSeconds ?? null,
      now,
      now
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
        COUNT(e.ep_nr) AS local_episode_count,
        COUNT(DISTINCT a.id) AS media_count
      FROM library_entries le
      INNER JOIN anime a ON a.library_slug = le.slug
      INNER JOIN episodes e ON e.anime_id = a.id
      INNER JOIN anime root ON root.id = le.primary_anime_id
      GROUP BY le.slug
      HAVING local_episode_count > 0
      ORDER BY le.title ASC
    `
    )
    .all()
    .map((row) => {
      return {
        id: row.primary_anime_id,
        slug: row.slug,
        title: row.library_title,
        coverImage: row.cover_image ?? undefined,
        bannerImage: row.banner_image ?? undefined,
        episodeCount: row.local_episode_count,
        mediaCount: row.media_count,
        year: row.season_year ?? undefined,
      }
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
    .map(toAnimeVariant)
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
      SELECT anime_id, season_nr, ep_nr, file_path, thumbnail_path, duration_seconds
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
          SELECT anime_id, season_nr, ep_nr, file_path, thumbnail_path, duration_seconds
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
      SELECT anime_id, season_nr, ep_nr, file_path, thumbnail_path, duration_seconds
      FROM episodes
      WHERE file_path = ?
    `
    )
    .get(filePath)

  return row ? toEpisode(row) : null
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

export function listAnimeIdsForAniListRefresh() {
  return getDb()
    .query<{ id: number }>(
      `
      SELECT DISTINCT a.id
      FROM anime a
      INNER JOIN episodes e ON e.anime_id = a.id
      WHERE COALESCE(a.status, '') <> 'FINISHED'
      ORDER BY a.id ASC
    `
    )
    .all()
    .map((row) => row.id)
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
