import { getDb, nowIso } from "@/server/db/sqlite"

type AniListMediaEntryRow = {
  username: string
  media_id: number
  list_entry_id: number | null
  status: string | null
  progress: number
  score: number | null
  score_format: string | null
  fetched_at: string
  updated_at: string
}

export type StoredAniListMediaEntry = {
  username: string
  mediaId: number
  listEntryId: number | null
  status: string | null
  progress: number
  score: number | null
  scoreFormat: string | null
  fetchedAt: string
  updatedAt: string
}

export type AniListMediaEntryInput = {
  mediaId: number
  listEntryId?: number | null
  status?: string | null
  progress?: number | null
  score?: number | null
}

function toEntry(row: AniListMediaEntryRow): StoredAniListMediaEntry {
  return {
    username: row.username,
    mediaId: row.media_id,
    listEntryId: row.list_entry_id,
    status: row.status,
    progress: row.progress,
    score: row.score,
    scoreFormat: row.score_format,
    fetchedAt: row.fetched_at,
    updatedAt: row.updated_at,
  }
}

export function getAniListMediaEntry(username: string, mediaId: number) {
  const row = getDb()
    .query<AniListMediaEntryRow>(
      `
      SELECT
        username,
        media_id,
        list_entry_id,
        status,
        progress,
        score,
        score_format,
        fetched_at,
        updated_at
      FROM anilist_media_entries
      WHERE username = ? AND media_id = ?
    `
    )
    .get(username, mediaId)

  return row ? toEntry(row) : null
}

export function replaceAniListMediaEntries(input: {
  username: string
  entries: AniListMediaEntryInput[]
  scoreFormat?: string | null
}) {
  const db = getDb()
  const now = nowIso()
  const statement = db.query(
    `
    INSERT INTO anilist_media_entries (
      username,
      media_id,
      list_entry_id,
      status,
      progress,
      score,
      score_format,
      fetched_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  )

  db.exec("BEGIN")

  try {
    db.query("DELETE FROM anilist_media_entries WHERE username = ?").run(
      input.username
    )

    for (const entry of input.entries) {
      statement.run(
        input.username,
        entry.mediaId,
        entry.listEntryId ?? null,
        entry.status ?? null,
        Math.max(entry.progress ?? 0, 0),
        entry.score ?? null,
        input.scoreFormat ?? null,
        now,
        now
      )
    }

    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

export function upsertAniListMediaEntry(input: {
  username: string
  entry: AniListMediaEntryInput
  scoreFormat?: string | null
}) {
  const now = nowIso()

  getDb()
    .query(
      `
      INSERT INTO anilist_media_entries (
        username,
        media_id,
        list_entry_id,
        status,
        progress,
        score,
        score_format,
        fetched_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username, media_id) DO UPDATE SET
        list_entry_id = excluded.list_entry_id,
        status = excluded.status,
        progress = excluded.progress,
        score = excluded.score,
        score_format = excluded.score_format,
        updated_at = excluded.updated_at
    `
    )
    .run(
      input.username,
      input.entry.mediaId,
      input.entry.listEntryId ?? null,
      input.entry.status ?? null,
      Math.max(input.entry.progress ?? 0, 0),
      input.entry.score ?? null,
      input.scoreFormat ?? null,
      now,
      now
    )
}
