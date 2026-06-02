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

function getDatabasePath() {
  return path.join(
    /*turbopackIgnore: true*/ process.cwd(),
    ".yamibunko",
    "yamibunko.sqlite"
  )
}

function assertNoLegacyMigrationTable(db: YamibunkoDatabase) {
  const legacyTable = db
    .query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    )
    .get()

  if (legacyTable) {
    throw new Error(
      "Yamibunko V1 requires a fresh database. Delete .yamibunko/yamibunko.sqlite and import the library again."
    )
  }
}

function initializeSchema(db: YamibunkoDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      password_hash TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      token_hash TEXT NOT NULL UNIQUE,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS anime (
      id INTEGER PRIMARY KEY,
      library_slug TEXT,
      format TEXT,
      relation_kind TEXT,
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
      average_score INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS library_entries (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      primary_anime_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (primary_anime_id) REFERENCES anime(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS anime_relations (
      anime_id INTEGER NOT NULL,
      related_anime_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      PRIMARY KEY (anime_id, related_anime_id, relation_type),
      FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE,
      FOREIGN KEY (related_anime_id) REFERENCES anime(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS anime_genres (
      anime_id INTEGER NOT NULL,
      genre TEXT NOT NULL,
      PRIMARY KEY (anime_id, genre),
      FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS media_tags (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      rank INTEGER,
      is_adult INTEGER
    );

    CREATE TABLE IF NOT EXISTS anime_tags (
      anime_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (anime_id, tag_id),
      FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES media_tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS episodes (
      anime_id INTEGER NOT NULL,
      season_nr INTEGER NOT NULL,
      ep_nr INTEGER NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      thumbnail_path TEXT,
      duration_seconds REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (anime_id, season_nr, ep_nr),
      FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS episode_progress (
      username TEXT NOT NULL COLLATE NOCASE,
      anime_id INTEGER NOT NULL,
      season_nr INTEGER NOT NULL,
      ep_nr INTEGER NOT NULL,
      watched_seconds REAL NOT NULL DEFAULT 0,
      duration_seconds REAL,
      completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (username, anime_id, season_nr, ep_nr),
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE,
      FOREIGN KEY (anime_id, season_nr, ep_nr)
        REFERENCES episodes(anime_id, season_nr, ep_nr)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS jobs (
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

    CREATE TABLE IF NOT EXISTS anilist_connections (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      anilist_user_id INTEGER NOT NULL,
      anilist_username TEXT NOT NULL,
      access_token_ciphertext TEXT NOT NULL,
      token_type TEXT NOT NULL DEFAULT 'Bearer',
      connected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_list_sync_at TEXT,
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS anime_library_slug_idx ON anime(library_slug);
    CREATE INDEX IF NOT EXISTS anime_relations_related_idx
      ON anime_relations(related_anime_id);
    CREATE INDEX IF NOT EXISTS anime_genres_genre_idx ON anime_genres(genre);
    CREATE INDEX IF NOT EXISTS anime_tags_tag_id_idx ON anime_tags(tag_id);
    CREATE INDEX IF NOT EXISTS episodes_anime_id_idx ON episodes(anime_id);
    CREATE INDEX IF NOT EXISTS episodes_file_path_idx ON episodes(file_path);
    CREATE INDEX IF NOT EXISTS episode_progress_username_idx
      ON episode_progress(username);
    CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
    CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at);
    CREATE INDEX IF NOT EXISTS anilist_connections_user_id_idx
      ON anilist_connections(anilist_user_id);
  `)
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

  assertNoLegacyMigrationTable(database)
  initializeSchema(database)
  return database
}

export function nowIso() {
  return new Date().toISOString()
}
