import { createHash } from "node:crypto"

import { getDb, nowIso } from "@/server/db/sqlite"

const tvAuthCodeLifetimeMs = 10 * 60 * 1000

export type TvAuthCodeStatus = "missing" | "pending" | "approved" | "expired"

type TvAuthCodeRow = {
  code_hash: string
  approved_username: string | null
  device_user_agent: string | null
  created_at: string
  expires_at: string
  approved_at: string | null
}

function hashTvAuthCode(code: string) {
  return createHash("sha256").update(code).digest("base64url")
}

function isExpired(expiresAt: string) {
  return Date.parse(expiresAt) <= Date.now()
}

function cleanupExpiredTvAuthCodes() {
  getDb().query("DELETE FROM tv_auth_codes WHERE expires_at <= ?").run(nowIso())
}

export function createTvAuthCode(input: {
  code: string
  deviceUserAgent: string | null
}) {
  cleanupExpiredTvAuthCodes()

  const now = nowIso()
  const expiresAt = new Date(Date.now() + tvAuthCodeLifetimeMs).toISOString()

  getDb()
    .query(
      `
      INSERT INTO tv_auth_codes (
        code_hash,
        approved_username,
        device_user_agent,
        created_at,
        expires_at,
        approved_at
      ) VALUES (?, NULL, ?, ?, ?, NULL)
    `
    )
    .run(hashTvAuthCode(input.code), input.deviceUserAgent, now, expiresAt)

  return { expiresAt }
}

export function getTvAuthCodeStatus(code: string): TvAuthCodeStatus {
  cleanupExpiredTvAuthCodes()

  const row = getDb()
    .query<TvAuthCodeRow>(
      `
      SELECT code_hash, approved_username, device_user_agent, created_at, expires_at, approved_at
      FROM tv_auth_codes
      WHERE code_hash = ?
    `
    )
    .get(hashTvAuthCode(code))

  if (!row) {
    return "missing"
  }

  if (isExpired(row.expires_at)) {
    return "expired"
  }

  return row.approved_username ? "approved" : "pending"
}

export function approveTvAuthCode(code: string, username: string) {
  cleanupExpiredTvAuthCodes()

  const now = nowIso()
  const result = getDb()
    .query(
      `
      UPDATE tv_auth_codes
      SET approved_username = ?, approved_at = ?
      WHERE code_hash = ?
        AND expires_at > ?
        AND approved_username IS NULL
    `
    )
    .run(username, now, hashTvAuthCode(code), now)

  return result.changes > 0
}

export function consumeApprovedTvAuthCode(code: string) {
  const db = getDb()
  const codeHash = hashTvAuthCode(code)
  const now = nowIso()

  db.exec("BEGIN IMMEDIATE")

  try {
    db.query("DELETE FROM tv_auth_codes WHERE expires_at <= ?").run(now)

    const row = db
      .query<TvAuthCodeRow>(
        `
        SELECT code_hash, approved_username, device_user_agent, created_at, expires_at, approved_at
        FROM tv_auth_codes
        WHERE code_hash = ?
      `
      )
      .get(codeHash)

    if (!row?.approved_username || isExpired(row.expires_at)) {
      db.exec("COMMIT")
      return null
    }

    db.query("DELETE FROM tv_auth_codes WHERE code_hash = ?").run(codeHash)
    db.exec("COMMIT")

    return row.approved_username
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
