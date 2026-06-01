import { decryptSecret, encryptSecret } from "@/server/crypto/secrets"
import { getDb, nowIso } from "@/server/db/sqlite"

type AniListConnectionRow = {
  username: string
  anilist_user_id: number
  anilist_username: string
  access_token_ciphertext: string
  token_type: string
  connected_at: string
  updated_at: string
  last_list_sync_at: string | null
}

export type AniListConnection = {
  username: string
  aniListUserId: number
  aniListUsername: string
  accessToken: string
  tokenType: string
  connectedAt: string
  updatedAt: string
  lastListSyncAt: string | null
}

export type SafeAniListConnection = Omit<AniListConnection, "accessToken">

function toConnection(row: AniListConnectionRow): AniListConnection {
  return {
    username: row.username,
    aniListUserId: row.anilist_user_id,
    aniListUsername: row.anilist_username,
    accessToken: decryptSecret(row.access_token_ciphertext),
    tokenType: row.token_type,
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
    lastListSyncAt: row.last_list_sync_at,
  }
}

function toSafeConnection(row: AniListConnectionRow): SafeAniListConnection {
  return {
    username: row.username,
    aniListUserId: row.anilist_user_id,
    aniListUsername: row.anilist_username,
    tokenType: row.token_type,
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
    lastListSyncAt: row.last_list_sync_at,
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
    .query<AniListConnectionRow>(
      `
      SELECT
        username,
        anilist_user_id,
        anilist_username,
        access_token_ciphertext,
        token_type,
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

export function upsertAniListConnection(input: {
  username: string
  aniListUserId: number
  aniListUsername: string
  accessToken: string
  tokenType?: string
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
        connected_at,
        updated_at,
        last_list_sync_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(username) DO UPDATE SET
        anilist_user_id = excluded.anilist_user_id,
        anilist_username = excluded.anilist_username,
        access_token_ciphertext = excluded.access_token_ciphertext,
        token_type = excluded.token_type,
        updated_at = excluded.updated_at
    `
    )
    .run(
      input.username,
      input.aniListUserId,
      input.aniListUsername,
      encryptedToken,
      input.tokenType ?? "Bearer",
      now,
      now
    )
}

export function deleteAniListConnection(username: string) {
  getDb()
    .query("DELETE FROM anilist_connections WHERE username = ?")
    .run(username)
}

export function markAniListConnectionSynced(username: string) {
  getDb()
    .query(
      "UPDATE anilist_connections SET last_list_sync_at = ?, updated_at = ? WHERE username = ?"
    )
    .run(nowIso(), nowIso(), username)
}
