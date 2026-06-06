import { defaultSpoilerSettings, type SpoilerSettings } from "@/lib/types"
import { getDb, nowIso } from "@/server/db/sqlite"

type UserRow = {
  username: string
  password_hash: string | null
  is_admin: number
  is_vip: number
  anilist_refresh_pressed_at: string | null
  blur_episode_thumbnails: number
  remove_unwatched_episode_titles: number
  created_at: string
  updated_at: string
}

export type StoredUser = {
  username: string
  passwordHash: string | null
  isAdmin: boolean
  isVip: boolean
  aniListRefreshPressedAt: string | null
  spoilerSettings: SpoilerSettings
  createdAt: string
  updatedAt: string
}

export const aniListRefreshCooldownMs = 5 * 60 * 1000

const userSelectColumns = `
  username,
  password_hash,
  is_admin,
  is_vip,
  anilist_refresh_pressed_at,
  blur_episode_thumbnails,
  remove_unwatched_episode_titles,
  created_at,
  updated_at
`

function toUser(row: UserRow): StoredUser {
  return {
    username: row.username,
    passwordHash: row.password_hash,
    isAdmin: row.is_admin === 1,
    isVip: row.is_vip === 1,
    aniListRefreshPressedAt: row.anilist_refresh_pressed_at,
    spoilerSettings: {
      blurEpisodeThumbnails: row.blur_episode_thumbnails === 1,
      removeUnwatchedEpisodeTitles:
        row.remove_unwatched_episode_titles === 1,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function hasAnyUsers() {
  const row = getDb()
    .query<{ count: number }>("SELECT COUNT(*) AS count FROM users")
    .get()

  return (row?.count ?? 0) > 0
}

export function getUser(username: string) {
  const row = getDb()
    .query<UserRow>(
      `SELECT ${userSelectColumns} FROM users WHERE username = ?`
    )
    .get(username.trim())

  return row ? toUser(row) : null
}

export function listUsers() {
  return getDb()
    .query<UserRow>(
      `SELECT ${userSelectColumns} FROM users ORDER BY is_admin DESC, is_vip DESC, username ASC`
    )
    .all()
    .map(toUser)
}

export function createUser(input: {
  username: string
  passwordHash?: string | null
  isAdmin: boolean
  isVip?: boolean
}) {
  const now = nowIso()
  const isVip = input.isVip ?? input.isAdmin

  getDb()
    .query(
      `
      INSERT INTO users (
        username,
        password_hash,
        is_admin,
        is_vip,
        blur_episode_thumbnails,
        remove_unwatched_episode_titles,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      input.username.trim(),
      input.passwordHash ?? null,
      input.isAdmin ? 1 : 0,
      isVip ? 1 : 0,
      defaultSpoilerSettings.blurEpisodeThumbnails ? 1 : 0,
      defaultSpoilerSettings.removeUnwatchedEpisodeTitles ? 1 : 0,
      now,
      now
    )

  const user = getUser(input.username)

  if (!user) {
    throw new Error("Created user could not be loaded")
  }

  return user
}

export function setUserPasswordHash(username: string, passwordHash: string) {
  getDb()
    .query(
      "UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ?"
    )
    .run(passwordHash, nowIso(), username.trim())
}

export function deleteUser(username: string) {
  getDb().query("DELETE FROM users WHERE username = ?").run(username.trim())
}

export function setUserVip(username: string, isVip: boolean) {
  getDb()
    .query("UPDATE users SET is_vip = ?, updated_at = ? WHERE username = ?")
    .run(isVip ? 1 : 0, nowIso(), username.trim())
}

export function getUserSpoilerSettings(username: string) {
  const row = getDb()
    .query<{
      blur_episode_thumbnails: number
      remove_unwatched_episode_titles: number
    }>(
      `
      SELECT blur_episode_thumbnails, remove_unwatched_episode_titles
      FROM users
      WHERE username = ?
    `
    )
    .get(username.trim())

  if (!row) {
    return null
  }

  return {
    blurEpisodeThumbnails: row.blur_episode_thumbnails === 1,
    removeUnwatchedEpisodeTitles: row.remove_unwatched_episode_titles === 1,
  }
}

export function setUserSpoilerSettings(
  username: string,
  settings: SpoilerSettings
) {
  getDb()
    .query(
      `
      UPDATE users
      SET blur_episode_thumbnails = ?,
          remove_unwatched_episode_titles = ?,
          updated_at = ?
      WHERE username = ?
    `
    )
    .run(
      settings.blurEpisodeThumbnails ? 1 : 0,
      settings.removeUnwatchedEpisodeTitles ? 1 : 0,
      nowIso(),
      username.trim()
    )

  return getUserSpoilerSettings(username) ?? defaultSpoilerSettings
}

export function getUserAniListRefreshState(username: string) {
  const row = getDb()
    .query<{ anilist_refresh_pressed_at: string | null }>(
      "SELECT anilist_refresh_pressed_at FROM users WHERE username = ?"
    )
    .get(username.trim())

  if (!row) {
    return null
  }

  const lastPressedAt = row.anilist_refresh_pressed_at
  const lastPressedMs = lastPressedAt ? Date.parse(lastPressedAt) : Number.NaN
  const remainingMs = Number.isFinite(lastPressedMs)
    ? Math.max(lastPressedMs + aniListRefreshCooldownMs - Date.now(), 0)
    : 0

  return {
    lastPressedAt,
    canPress: remainingMs <= 0,
    cooldownSeconds: Math.ceil(remainingMs / 1000),
  }
}

export function markUserAniListRefreshPressed(username: string) {
  const now = nowIso()
  const allowedBefore = new Date(Date.now() - aniListRefreshCooldownMs).toISOString()
  const result = getDb()
    .query(
      `
      UPDATE users
      SET anilist_refresh_pressed_at = ?, updated_at = ?
      WHERE username = ?
        AND (
          anilist_refresh_pressed_at IS NULL
          OR anilist_refresh_pressed_at <= ?
        )
    `
    )
    .run(now, now, username.trim(), allowedBefore)

  return result.changes > 0
}
