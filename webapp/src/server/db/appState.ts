import { getDb, nowIso } from "@/server/db/sqlite"

export function getAppStateBoolean(key: string, defaultValue: boolean) {
  const row = getDb()
    .query<{ value: string }>("SELECT value FROM app_state WHERE key = ?")
    .get(key)

  if (!row) {
    return defaultValue
  }

  return row.value === "true"
}

export function setAppStateBoolean(key: string, value: boolean) {
  const now = nowIso()

  getDb()
    .query(
      `
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `
    )
    .run(key, value ? "true" : "false", now)
}
