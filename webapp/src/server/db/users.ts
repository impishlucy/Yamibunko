import { getDb, nowIso } from "@/server/db/sqlite"

type UserRow = {
  username: string
  password_hash: string | null
  is_admin: number
  created_at: string
  updated_at: string
}

export type StoredUser = {
  username: string
  passwordHash: string | null
  isAdmin: boolean
  createdAt: string
  updatedAt: string
}

function toUser(row: UserRow): StoredUser {
  return {
    username: row.username,
    passwordHash: row.password_hash,
    isAdmin: row.is_admin === 1,
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
      "SELECT username, password_hash, is_admin, created_at, updated_at FROM users WHERE username = ?"
    )
    .get(username.trim())

  return row ? toUser(row) : null
}

export function listUsers() {
  return getDb()
    .query<UserRow>(
      "SELECT username, password_hash, is_admin, created_at, updated_at FROM users ORDER BY is_admin DESC, username ASC"
    )
    .all()
    .map(toUser)
}

export function createUser(input: {
  username: string
  passwordHash?: string | null
  isAdmin: boolean
}) {
  const now = nowIso()

  getDb()
    .query(
      "INSERT INTO users (username, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      input.username.trim(),
      input.passwordHash ?? null,
      input.isAdmin ? 1 : 0,
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
