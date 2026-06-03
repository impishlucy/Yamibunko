import { decryptSecret, encryptSecret } from "@/server/crypto/secrets"
import { getDb, nowIso } from "@/server/db/sqlite"

type AniListConnectionRow = {
  username: string
  anilist_user_id: number
  anilist_username: string
  access_token_ciphertext: string
  token_type: string
  score_format: string | null
  connected_at: string
  updated_at: string
  last_list_sync_at: string | null
}

type SafeAniListConnectionRow = Omit<
  AniListConnectionRow,
  "access_token_ciphertext"
>

type AniListMediaListEntryRow = {
  username: string
  anilist_user_id: number
  media_id: number
  list_entry_id: number
  status: string | null
  progress: number | null
  score: number | null
  created_at: string
  updated_at: string
  synced_at: string
}

export type AniListConnection = {
  username: string
  aniListUserId: number
  aniListUsername: string
  accessToken: string
  tokenType: string
  scoreFormat: string | null
  connectedAt: string
  updatedAt: string
  lastListSyncAt: string | null
}

export type SafeAniListConnection = Omit<AniListConnection, "accessToken">

export type CachedAniListMediaListEntry = {
  username: string
  aniListUserId: number
  mediaId: number
  listEntryId: number
  status: string | null
  progress: number | null
  score: number | null
  createdAt: string
  updatedAt: string
  syncedAt: string
}

function toConnection(row: AniListConnectionRow): AniListConnection {
  return {
    username: row.username,
    aniListUserId: row.anilist_user_id,
    aniListUsername: row.anilist_username,
    accessToken: decryptSecret(row.access_token_ciphertext),
    tokenType: row.token_type,
    scoreFormat: row.score_format,
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
    lastListSyncAt: row.last_list_sync_at,
  }
}

function toSafeConnection(
  row: SafeAniListConnectionRow
): SafeAniListConnection {
  return {
    username: row.username,
    aniListUserId: row.anilist_user_id,
    aniListUsername: row.anilist_username,
    tokenType: row.token_type,
    scoreFormat: row.score_format,
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
    lastListSyncAt: row.last_list_sync_at,
  }
}

function toMediaListEntry(
  row: AniListMediaListEntryRow
): CachedAniListMediaListEntry {
  return {
    username: row.username,
    aniListUserId: row.anilist_user_id,
    mediaId: row.media_id,
    listEntryId: row.list_entry_id,
    status: row.status,
    progress: row.progress,
    score: row.score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  }
}

export function getAniListConnection(username: string) {
  const row = getDb()
    .query<AniListConnectionRow>(
      `
      SELECT
        username,
        anilist_user_id,
        anilist_username,
        access_token_ciphertext,
        token_type,
        score_format,
        connected_at,
        updated_at,
        last_list_sync_at
      FROM anilist_connections
      WHERE username = ?
    `
    )
    .get(username)

  return row ? toConnection(row) : null
}

export function getSafeAniListConnection(username: string) {
  const row = getDb()
    .query<SafeAniListConnectionRow>(
      `
      SELECT
        username,
        anilist_user_id,
        anilist_username,
        token_type,
        score_format,
        connected_at,
        updated_at,
        last_list_sync_at
      FROM anilist_connections
      WHERE username = ?
    `
    )
    .get(username)

  return row ? toSafeConnection(row) : null
}

export function listAniListConnections() {
  return getDb()
    .query<AniListConnectionRow>(
      `
      SELECT
        username,
        anilist_user_id,
        anilist_username,
        access_token_ciphertext,
        token_type,
        score_format,
        connected_at,
        updated_at,
        last_list_sync_at
      FROM anilist_connections
      ORDER BY username ASC
    `
    )
    .all()
    .map(toConnection)
}

export function upsertAniListConnection(input: {
  username: string
  aniListUserId: number
  aniListUsername: string
  accessToken: string
  tokenType?: string
  scoreFormat?: string | null
}) {
  const now = nowIso()
  const encryptedToken = encryptSecret(input.accessToken)

  getDb()
    .query(
      `
      INSERT INTO anilist_connections (
        username,
        anilist_user_id,
        anilist_username,
        access_token_ciphertext,
        token_type,
        score_format,
        connected_at,
        updated_at,
        last_list_sync_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(username) DO UPDATE SET
        anilist_user_id = excluded.anilist_user_id,
        anilist_username = excluded.anilist_username,
        access_token_ciphertext = excluded.access_token_ciphertext,
        token_type = excluded.token_type,
        score_format = excluded.score_format,
        updated_at = excluded.updated_at
    `
    )
    .run(
      input.username,
      input.aniListUserId,
      input.aniListUsername,
      encryptedToken,
      input.tokenType ?? "Bearer",
      input.scoreFormat ?? null,
      now,
      now
    )
}

export function updateAniListConnectionScoreFormat(input: {
  username: string
  scoreFormat?: string | null
}) {
  getDb()
    .query(
      "UPDATE anilist_connections SET score_format = ?, updated_at = ? WHERE username = ?"
    )
    .run(input.scoreFormat ?? null, nowIso(), input.username)
}

export function deleteAniListConnection(username: string) {
  getDb()
    .query("DELETE FROM anilist_media_list_entries WHERE username = ?")
    .run(username)
  getDb()
    .query("DELETE FROM anilist_connections WHERE username = ?")
    .run(username)
}

export function markAniListConnectionSynced(username: string) {
  const now = nowIso()
  getDb()
    .query(
      "UPDATE anilist_connections SET last_list_sync_at = ?, updated_at = ? WHERE username = ?"
    )
    .run(now, now, username)
}

export function getCachedAniListMediaListEntry(input: {
  username: string
  mediaId: number
}) {
  const row = getDb()
    .query<AniListMediaListEntryRow>(
      `
      SELECT
        username,
        anilist_user_id,
        media_id,
        list_entry_id,
        status,
        progress,
        score,
        created_at,
        updated_at,
        synced_at
      FROM anilist_media_list_entries
      WHERE username = ? AND media_id = ?
    `
    )
    .get(input.username, input.mediaId)

  return row ? toMediaListEntry(row) : null
}

export function upsertAniListMediaListEntries(input: {
  username: string
  aniListUserId: number
  entries: Array<{
    id: number
    mediaId: number
    status?: string | null
    progress?: number | null
    score?: number | null
    createdAt?: string | null
    updatedAt?: string | null
  }>
  replace?: boolean
}) {
  const now = nowIso()

  if (input.replace) {
    getDb()
      .query("DELETE FROM anilist_media_list_entries WHERE username = ?")
      .run(input.username)
  }

  const statement = getDb().query(
    `
    INSERT INTO anilist_media_list_entries (
      username,
      anilist_user_id,
      media_id,
      list_entry_id,
      status,
      progress,
      score,
      created_at,
      updated_at,
      synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, media_id) DO UPDATE SET
      anilist_user_id = excluded.anilist_user_id,
      list_entry_id = excluded.list_entry_id,
      status = excluded.status,
      progress = excluded.progress,
      score = excluded.score,
      updated_at = excluded.updated_at,
      synced_at = excluded.synced_at
  `
  )

  for (const entry of input.entries) {
    statement.run(
      input.username,
      input.aniListUserId,
      entry.mediaId,
      entry.id,
      entry.status ?? null,
      entry.progress ?? null,
      entry.score ?? null,
      entry.createdAt ?? now,
      entry.updatedAt ?? now,
      now
    )
  }
}
