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
  {
    version: 2,
    sql: `
      CREATE TABLE episodes_new (
        anime_id INTEGER NOT NULL,
        season_nr INTEGER NOT NULL DEFAULT 1,
        ep_nr INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        thumbnail_path TEXT,
        duration_seconds REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (anime_id, season_nr, ep_nr),
        FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE
      );

      INSERT INTO episodes_new (
        anime_id,
        season_nr,
        ep_nr,
        file_path,
        created_at,
        updated_at
      )
      SELECT
        anime_id,
        1,
        ep_nr,
        file_path,
        created_at,
        updated_at
      FROM episodes;

      DROP TABLE episodes;
      ALTER TABLE episodes_new RENAME TO episodes;

      CREATE INDEX episodes_anime_id_idx ON episodes(anime_id);
      CREATE INDEX episodes_file_path_idx ON episodes(file_path);

      CREATE TABLE episode_progress (
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

      CREATE INDEX episode_progress_username_idx ON episode_progress(username);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE anime_genres (
        anime_id INTEGER NOT NULL,
        genre TEXT NOT NULL,
        PRIMARY KEY (anime_id, genre),
        FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE
      );

      CREATE TABLE media_tags (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT,
        rank INTEGER,
        is_adult INTEGER
      );

      CREATE TABLE anime_tags (
        anime_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY (anime_id, tag_id),
        FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES media_tags(id) ON DELETE CASCADE
      );

      CREATE INDEX anime_genres_genre_idx ON anime_genres(genre);
      CREATE INDEX anime_tags_tag_id_idx ON anime_tags(tag_id);

      INSERT OR IGNORE INTO anime_genres (anime_id, genre)
      SELECT anime.id, genre.value
      FROM anime, json_each(
        CASE WHEN json_valid(anime.genres) THEN anime.genres ELSE '[]' END
      ) AS genre
      WHERE genre.value IS NOT NULL;

      INSERT OR REPLACE INTO media_tags (
        id,
        name,
        description,
        category,
        rank,
        is_adult
      )
      SELECT
        CAST(json_extract(tag.value, '$.id') AS INTEGER),
        COALESCE(json_extract(tag.value, '$.name'), 'Unknown'),
        json_extract(tag.value, '$.description'),
        json_extract(tag.value, '$.category'),
        json_extract(tag.value, '$.rank'),
        CASE json_extract(tag.value, '$.isAdult') WHEN 1 THEN 1 ELSE 0 END
      FROM anime, json_each(
        CASE WHEN json_valid(anime.tags) THEN anime.tags ELSE '[]' END
      ) AS tag
      WHERE json_extract(tag.value, '$.id') IS NOT NULL;

      INSERT OR IGNORE INTO anime_tags (anime_id, tag_id)
      SELECT
        anime.id,
        CAST(json_extract(tag.value, '$.id') AS INTEGER)
      FROM anime, json_each(
        CASE WHEN json_valid(anime.tags) THEN anime.tags ELSE '[]' END
      ) AS tag
      WHERE json_extract(tag.value, '$.id') IS NOT NULL;

      ALTER TABLE anime DROP COLUMN genres;
      ALTER TABLE anime DROP COLUMN tags;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE anilist_connections (
        username TEXT PRIMARY KEY COLLATE NOCASE,
        anilist_user_id INTEGER NOT NULL,
        anilist_username TEXT NOT NULL,
        access_token_ciphertext TEXT NOT NULL,
        token_type TEXT NOT NULL DEFAULT 'Bearer',
        connected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
      );

      CREATE INDEX anilist_connections_user_id_idx
        ON anilist_connections(anilist_user_id);
    `,
  },
] as const

function getDatabasePath() {
  return path.join(
    /*turbopackIgnore: true*/ process.cwd(),
    ".yamibunko",
    "yamibunko.sqlite"
  )
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
