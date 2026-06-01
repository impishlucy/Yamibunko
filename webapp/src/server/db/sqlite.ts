import { mkdirSync } from "node:fs"
import path from "node:path"

import { DatabaseSync, type StatementSync } from "node:sqlite"

type TypedStatement<TResult> = Omit<StatementSync, "all" | "get" | "run"> & {
  all(...params: unknown[]): TResult[]
  get(...params: unknown[]): TResult | undefined
  run(...params: unknown[]): {
    changes: number
    lastInsertRowid: number | bigint
  }
}

type YamibunkoDatabase = DatabaseSync & {
  query<TResult = unknown>(sql: string): TypedStatement<TResult>
}

let database: YamibunkoDatabase | undefined

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        username TEXT PRIMARY KEY COLLATE NOCASE,
        password_hash TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        username TEXT PRIMARY KEY COLLATE NOCASE,
        token_hash TEXT NOT NULL UNIQUE,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
      );

      CREATE TABLE anime (
        id INTEGER PRIMARY KEY,
        title_romaji TEXT,
        title_english TEXT,
        title_native TEXT,
        title_user_preferred TEXT NOT NULL,
        status TEXT,
        description TEXT,
        season_year INTEGER,
        episodes INTEGER,
        duration INTEGER,
        cover_image TEXT,
        banner_image TEXT,
        genres TEXT NOT NULL DEFAULT '[]',
        average_score INTEGER,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE episodes (
        anime_id INTEGER NOT NULL,
        ep_nr INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (anime_id, ep_nr),
        FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        input_path TEXT NOT NULL,
        output_path TEXT,
        anime_id INTEGER,
        ep_nr INTEGER,
        message TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE SET NULL
      );

      CREATE INDEX jobs_status_idx ON jobs(status);
      CREATE INDEX jobs_created_at_idx ON jobs(created_at);
      CREATE INDEX episodes_anime_id_idx ON episodes(anime_id);
    `,
  },
] as const

function getDatabasePath() {
  return path.resolve(process.cwd(), ".yamibunko", "yamibunko.sqlite")
}

function migrate(db: YamibunkoDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)

  const current =
    db
      .query<{
        version: number
      }>("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get()?.version ?? 0

  for (const migration of migrations) {
    if (migration.version <= current) {
      continue
    }

    db.exec("BEGIN IMMEDIATE")

    try {
      db.exec(migration.sql)
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
      ).run(migration.version, new Date().toISOString())
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }
}

export function getDb() {
  if (database) {
    return database
  }

  const dbPath = getDatabasePath()
  mkdirSync(path.dirname(dbPath), { recursive: true })

  const rawDatabase = new DatabaseSync(dbPath)
  database = rawDatabase as YamibunkoDatabase
  database.query = <TResult>(sql: string) =>
    rawDatabase.prepare(sql) as TypedStatement<TResult>
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `)

  migrate(database)
  return database
}

export function nowIso() {
  return new Date().toISOString()
}
