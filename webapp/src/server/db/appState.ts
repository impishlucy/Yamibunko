import { getDb, nowIso } from "@/server/db/sqlite"

export function getAppStateValue(key: string) {
  const row = getDb()
    .query<{ value: string }>("SELECT value FROM app_state WHERE key = ?")
    .get(key)

  return row?.value ?? null
}

export function setAppStateValue(key: string, value: string) {
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
    .run(key, value, now)
}

export function getAppStateBoolean(key: string, defaultValue: boolean) {
  const value = getAppStateValue(key)

  if (value === null) {
    return defaultValue
  }

  return value === "true"
}

export function setAppStateBoolean(key: string, value: boolean) {
  setAppStateValue(key, value ? "true" : "false")
}
