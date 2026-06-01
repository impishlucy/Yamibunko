import type { AnimeInfo, AnimeSummary, Episode } from "@/lib/types"
import { getDb, nowIso } from "@/server/db/sqlite"

type AnimeRow = {
  id: number
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
  genres: string
  average_score: number | null
  tags: string
}

type EpisodeRow = {
  anime_id: number
  ep_nr: number
  file_path: string
}

export type AnimeMetadataInput = {
  id: number
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

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function toAnimeInfo(row: AnimeRow): AnimeInfo {
  const genres = parseJsonArray<string>(row.genres)
  const tags = parseJsonArray<AnimeInfo["tags"][number]>(row.tags)

  return {
    id: row.id,
    title: row.title_user_preferred,
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
  }
}

function toEpisode(row: EpisodeRow): Episode {
  const fileName = row.file_path.split(/[\\/]/).at(-1) ?? row.file_path

  return {
    animeId: row.anime_id,
    episodeNumber: row.ep_nr,
    fileName,
    filePath: row.file_path,
    thumbnail: `/api/anime/${row.anime_id}/episodes/${row.ep_nr}/thumbnail`,
  }
}

export function upsertAnime(metadata: AnimeMetadataInput) {
  const now = nowIso()
  const titleUserPreferred =
    metadata.title.userPreferred ??
    metadata.title.english ??
    metadata.title.romaji ??
    metadata.title.native ??
    `AniList ${metadata.id}`

  getDb()
    .query(
      `
      INSERT INTO anime (
        id,
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
        genres,
        average_score,
        tags,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
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
        genres = excluded.genres,
        average_score = excluded.average_score,
        tags = excluded.tags,
        updated_at = excluded.updated_at
    `
    )
    .run(
      metadata.id,
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
      JSON.stringify(metadata.genres ?? []),
      metadata.averageScore ?? null,
      JSON.stringify(metadata.tags ?? []),
      now,
      now
    )
}

export function upsertEpisode(input: {
  animeId: number
  epNr: number
  filePath: string
}) {
  const now = nowIso()

  getDb()
    .query(
      `
      INSERT INTO episodes (anime_id, ep_nr, file_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(anime_id, ep_nr) DO UPDATE SET
        file_path = excluded.file_path,
        updated_at = excluded.updated_at
    `
    )
    .run(input.animeId, input.epNr, input.filePath, now, now)
}

export function listAnime(): AnimeSummary[] {
  return getDb()
    .query<AnimeRow>(
      `
      SELECT a.*, COUNT(e.ep_nr) AS local_episode_count
      FROM anime a
      LEFT JOIN episodes e ON e.anime_id = a.id
      GROUP BY a.id
      ORDER BY a.title_user_preferred ASC
    `
    )
    .all()
    .map((row) => {
      const anime = toAnimeInfo(row)

      return {
        id: anime.id,
        title: anime.title,
        coverImage: anime.coverImage,
        bannerImage: anime.bannerImage,
        episodeCount: anime.episodeCount,
        year: anime.year,
      }
    })
}

export function getAnime(animeId: string | number) {
  const id =
    typeof animeId === "number" ? animeId : Number.parseInt(animeId, 10)

  if (!Number.isInteger(id)) {
    return null
  }

  const row = getDb()
    .query<AnimeRow>("SELECT * FROM anime WHERE id = ?")
    .get(id)

  return row ? toAnimeInfo(row) : null
}

export function listEpisodes(animeId: string | number) {
  const id =
    typeof animeId === "number" ? animeId : Number.parseInt(animeId, 10)

  if (!Number.isInteger(id)) {
    return []
  }

  return getDb()
    .query<EpisodeRow>(
      "SELECT anime_id, ep_nr, file_path FROM episodes WHERE anime_id = ? ORDER BY ep_nr ASC"
    )
    .all(id)
    .map(toEpisode)
}

export function getStoredEpisode(
  animeId: string | number,
  epNr: string | number
) {
  const id =
    typeof animeId === "number" ? animeId : Number.parseInt(animeId, 10)
  const episodeNumber =
    typeof epNr === "number" ? epNr : Number.parseInt(epNr, 10)

  if (!Number.isInteger(id) || !Number.isInteger(episodeNumber)) {
    return null
  }

  const row = getDb()
    .query<EpisodeRow>(
      "SELECT anime_id, ep_nr, file_path FROM episodes WHERE anime_id = ? AND ep_nr = ?"
    )
    .get(id, episodeNumber)

  return row ? toEpisode(row) : null
}
