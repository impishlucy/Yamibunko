import { getDb, nowIso } from "@/server/db/sqlite"

type SessionRow = {
  username: string
  token_hash: string
  user_agent: string | null
  created_at: string
  updated_at: string
  expires_at: string
}

export type StoredSession = {
  username: string
  tokenHash: string
  userAgent: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string
}

function toSession(row: SessionRow): StoredSession {
  return {
    username: row.username,
    tokenHash: row.token_hash,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  }
}

export function getSessionByTokenHash(tokenHash: string) {
  const row = getDb()
    .query<SessionRow>(
      "SELECT username, token_hash, user_agent, created_at, updated_at, expires_at FROM sessions WHERE token_hash = ?"
    )
    .get(tokenHash)

  return row ? toSession(row) : null
}

export function replaceUserSession(input: {
  username: string
  tokenHash: string
  userAgent: string | null
  expiresAt: string
}) {
  const now = nowIso()

  getDb().exec("BEGIN IMMEDIATE")

  try {
    getDb().query("DELETE FROM sessions WHERE username = ?").run(input.username)
    getDb()
      .query(
        "INSERT INTO sessions (username, token_hash, user_agent, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.username,
        input.tokenHash,
        input.userAgent,
        now,
        now,
        input.expiresAt
      )
    getDb().exec("COMMIT")
  } catch (error) {
    getDb().exec("ROLLBACK")
    throw error
  }
}

export function touchSession(tokenHash: string) {
  getDb()
    .query("UPDATE sessions SET updated_at = ? WHERE token_hash = ?")
    .run(nowIso(), tokenHash)
}

export function deleteSessionByTokenHash(tokenHash: string) {
  getDb().query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash)
}


export function deleteSessionsByUsername(username: string) {
  getDb().query("DELETE FROM sessions WHERE username = ?").run(username)
}
