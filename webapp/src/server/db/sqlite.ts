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

const currentSchemaVersion = 13

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

function tableColumnExists(
  db: YamibunkoDatabase,
  tableName: string,
  columnName: string
) {
  return db
    .query<{ name: string }>(`PRAGMA table_info(${tableName})`)
    .all()
    .some((column) => column.name === columnName)
}

function ensureColumn(
  db: YamibunkoDatabase,
  tableName: string,
  columnName: string,
  definition: string
) {
  if (tableColumnExists(db, tableName, columnName)) {
    return
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`)
}

function getUserVersion(db: YamibunkoDatabase) {
  return db.query<{ user_version: number }>("PRAGMA user_version").get()
    ?.user_version ?? 0
}

function setUserVersion(db: YamibunkoDatabase, version: number) {
  db.exec(`PRAGMA user_version = ${version}`)
}

function initializeSchema(db: YamibunkoDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      password_hash TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_vip INTEGER NOT NULL DEFAULT 0,
      anilist_refresh_pressed_at TEXT,
      ignored_app_update_version TEXT,
      disable_update_badges INTEGER NOT NULL DEFAULT 0,
      blur_episode_thumbnails INTEGER NOT NULL DEFAULT 0,
      remove_unwatched_episode_titles INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE,
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
      anilist_raw_json TEXT,
      anilist_synced_at TEXT,
      streaming_episodes_synced_at TEXT,
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

    CREATE TABLE IF NOT EXISTS anime_streaming_episodes (
      anime_id INTEGER NOT NULL,
      episode_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      thumbnail TEXT,
      url TEXT,
      site TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (anime_id, episode_number),
      FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS episodes (
      anime_id INTEGER NOT NULL,
      season_nr INTEGER NOT NULL,
      ep_nr INTEGER NOT NULL,
      title TEXT,
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
      score_format TEXT,
      connected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_list_sync_at TEXT,
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS anilist_media_list_entries (
      username TEXT NOT NULL COLLATE NOCASE,
      anilist_user_id INTEGER NOT NULL,
      media_id INTEGER NOT NULL,
      list_entry_id INTEGER NOT NULL,
      status TEXT,
      progress INTEGER,
      score REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (username, media_id),
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS anime_library_slug_idx ON anime(library_slug);
    CREATE INDEX IF NOT EXISTS anime_relations_related_idx
      ON anime_relations(related_anime_id);
    CREATE INDEX IF NOT EXISTS anime_genres_genre_idx ON anime_genres(genre);
    CREATE INDEX IF NOT EXISTS anime_tags_tag_id_idx ON anime_tags(tag_id);
    CREATE INDEX IF NOT EXISTS anime_streaming_episodes_anime_id_idx
      ON anime_streaming_episodes(anime_id);
    CREATE INDEX IF NOT EXISTS episodes_anime_id_idx ON episodes(anime_id);
    CREATE INDEX IF NOT EXISTS episodes_file_path_idx ON episodes(file_path);
    CREATE INDEX IF NOT EXISTS episode_progress_username_idx
      ON episode_progress(username);
    CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
    CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at);
    CREATE INDEX IF NOT EXISTS anilist_connections_user_id_idx
      ON anilist_connections(anilist_user_id);
    CREATE INDEX IF NOT EXISTS anilist_media_list_entries_user_idx
      ON anilist_media_list_entries(username, anilist_user_id);
    CREATE INDEX IF NOT EXISTS sessions_username_idx ON sessions(username);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
  `)
}

type TableColumnInfo = {
  name: string
  pk: number
}

function hasSessionTokenPrimaryKey(db: YamibunkoDatabase) {
  return db
    .query<TableColumnInfo>("PRAGMA table_info(sessions)")
    .all()
    .some((column) => column.name === "token_hash" && column.pk > 0)
}

function migrateSessionsToMultiSessionSchema(db: YamibunkoDatabase) {
  db.exec("BEGIN IMMEDIATE")

  try {
    db.exec(`
      CREATE TABLE sessions_next (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
      );

      INSERT OR IGNORE INTO sessions_next (
        token_hash,
        username,
        user_agent,
        created_at,
        updated_at,
        expires_at
      )
      SELECT
        token_hash,
        username,
        user_agent,
        created_at,
        updated_at,
        expires_at
      FROM sessions
      WHERE token_hash IS NOT NULL;

      DROP TABLE sessions;
      ALTER TABLE sessions_next RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS sessions_username_idx ON sessions(username);
      CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
    `)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

function runSchemaMigrations(db: YamibunkoDatabase) {
  const version = getUserVersion(db)

  if (version < 2) {
    ensureColumn(db, "anime", "anilist_raw_json", "anilist_raw_json TEXT")
    ensureColumn(db, "anime", "anilist_synced_at", "anilist_synced_at TEXT")
    ensureColumn(
      db,
      "anime",
      "streaming_episodes_synced_at",
      "streaming_episodes_synced_at TEXT"
    )
    ensureColumn(db, "episodes", "title", "title TEXT")
    ensureColumn(db, "anilist_connections", "score_format", "score_format TEXT")

    db.exec(`
      CREATE TABLE IF NOT EXISTS anime_streaming_episodes (
        anime_id INTEGER NOT NULL,
        episode_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        thumbnail TEXT,
        url TEXT,
        site TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (anime_id, episode_number),
        FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS anilist_media_list_entries (
        username TEXT NOT NULL COLLATE NOCASE,
        anilist_user_id INTEGER NOT NULL,
        media_id INTEGER NOT NULL,
        list_entry_id INTEGER NOT NULL,
        status TEXT,
        progress INTEGER,
        score REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (username, media_id),
        FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS anime_streaming_episodes_anime_id_idx
        ON anime_streaming_episodes(anime_id);
      CREATE INDEX IF NOT EXISTS anilist_media_list_entries_user_idx
        ON anilist_media_list_entries(username, anilist_user_id);
    `)
  }

  if (version < 3) {
    const now = nowIso()
    const existingLibraryAnime = db
      .query<{ count: number }>(
        `
        SELECT COUNT(DISTINCT a.id) AS count
        FROM anime a
        WHERE a.library_slug IS NOT NULL
          AND (
            EXISTS (SELECT 1 FROM episodes e WHERE e.anime_id = a.id)
            OR EXISTS (
              SELECT 1
              FROM library_entries le
              WHERE le.primary_anime_id = a.id
            )
          )
      `
      )
      .get()?.count ?? 0

    db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)

    if (existingLibraryAnime > 0) {
      db.query(
        `
        UPDATE anime
        SET anilist_raw_json = NULL,
            anilist_synced_at = NULL,
            streaming_episodes_synced_at = NULL,
            updated_at = ?
        WHERE library_slug IS NOT NULL
          AND (
            EXISTS (SELECT 1 FROM episodes e WHERE e.anime_id = anime.id)
            OR EXISTS (
              SELECT 1
              FROM library_entries le
              WHERE le.primary_anime_id = anime.id
            )
          )
      `
      ).run(now)

      db.exec(`
        DELETE FROM anime_streaming_episodes
        WHERE anime_id IN (
          SELECT DISTINCT a.id
          FROM anime a
          WHERE a.library_slug IS NOT NULL
            AND (
              EXISTS (SELECT 1 FROM episodes e WHERE e.anime_id = a.id)
              OR EXISTS (
                SELECT 1
                FROM library_entries le
                WHERE le.primary_anime_id = a.id
              )
            )
        );
      `)

      db.query(
        `
        UPDATE episodes
        SET title = 'Episode ' || ep_nr,
            updated_at = ?
        WHERE anime_id IN (
          SELECT DISTINCT a.id
          FROM anime a
          WHERE a.library_slug IS NOT NULL
        )
      `
      ).run(now)
    }
  }

  if (version < 4) {
    const now = nowIso()

    db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)

    const existingLibraryAnime = db
      .query<{ count: number }>(
        `
        SELECT COUNT(DISTINCT a.id) AS count
        FROM anime a
        WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.anime_id = a.id)
          OR EXISTS (
            SELECT 1
            FROM library_entries le
            WHERE le.primary_anime_id = a.id
          )
      `
      )
      .get()?.count ?? 0

    if (existingLibraryAnime > 0) {
      db.query(
        `
        UPDATE episodes
        SET title = 'Episode ' || ep_nr,
            updated_at = ?
        WHERE anime_id IN (
          SELECT a.id
          FROM anime a
          LEFT JOIN anime_streaming_episodes se ON se.anime_id = a.id
          LEFT JOIN episodes e ON e.anime_id = a.id
          GROUP BY a.id
          HAVING COUNT(DISTINCT se.episode_number) = 0
            OR COUNT(DISTINCT se.episode_number) != COALESCE(NULLIF(a.episodes, 0), COUNT(DISTINCT e.ep_nr))
        )
      `
      ).run(now)
    }
  }

  if (version < 5) {
    const now = nowIso()

    const existingLibraryAnime = db
      .query<{ count: number }>(
        `
        SELECT COUNT(DISTINCT a.id) AS count
        FROM anime a
        WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.anime_id = a.id)
          OR EXISTS (
            SELECT 1
            FROM library_entries le
            WHERE le.primary_anime_id = a.id
          )
      `
      )
      .get()?.count ?? 0

    if (existingLibraryAnime > 0) {
      db.query(
        `
        UPDATE anime
        SET anilist_raw_json = NULL,
            anilist_synced_at = NULL,
            streaming_episodes_synced_at = NULL,
            updated_at = ?
        WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.anime_id = anime.id)
          OR EXISTS (
            SELECT 1
            FROM library_entries le
            WHERE le.primary_anime_id = anime.id
          )
      `
      ).run(now)

      db.exec(`
        DELETE FROM anime_streaming_episodes
        WHERE anime_id IN (
          SELECT DISTINCT a.id
          FROM anime a
          WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.anime_id = a.id)
            OR EXISTS (
              SELECT 1
              FROM library_entries le
              WHERE le.primary_anime_id = a.id
            )
        );
      `)

      db.query(
        `
        UPDATE episodes
        SET title = 'Episode ' || ep_nr,
            updated_at = ?
        WHERE anime_id IN (
          SELECT DISTINCT a.id
          FROM anime a
          WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.anime_id = a.id)
        )
      `
      ).run(now)
    }
  }

  if (version < 6) {
    ensureColumn(
      db,
      "users",
      "anilist_refresh_pressed_at",
      "anilist_refresh_pressed_at TEXT"
    )
  }


  if (version < 7) {
    const now = nowIso()

    const existingLibraryAnime = db
      .query<{ count: number }>(
        `
        SELECT COUNT(DISTINCT a.id) AS count
        FROM anime a
        WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.anime_id = a.id)
          OR EXISTS (
            SELECT 1
            FROM library_entries le
            WHERE le.primary_anime_id = a.id
          )
      `
      )
      .get()?.count ?? 0

    if (existingLibraryAnime > 0) {
      db.query(
        `
        UPDATE anime
        SET anilist_raw_json = NULL,
            anilist_synced_at = NULL,
            streaming_episodes_synced_at = NULL,
            updated_at = ?
        WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.anime_id = anime.id)
          OR EXISTS (
            SELECT 1
            FROM library_entries le
            WHERE le.primary_anime_id = anime.id
          )
      `
      ).run(now)

      db.exec(`
        DELETE FROM anime_streaming_episodes
        WHERE anime_id IN (
          SELECT DISTINCT a.id
          FROM anime a
          WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.anime_id = a.id)
            OR EXISTS (
              SELECT 1
              FROM library_entries le
              WHERE le.primary_anime_id = a.id
            )
        );
      `)

      db.query(
        `
        UPDATE episodes
        SET title = 'Episode ' || ep_nr,
            updated_at = ?
        WHERE anime_id IN (
          SELECT DISTINCT a.id
          FROM anime a
          WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.anime_id = a.id)
        )
      `
      ).run(now)
    }
  }

  if (version < 8) {
    ensureColumn(db, "users", "is_vip", "is_vip INTEGER NOT NULL DEFAULT 0")
    db.query(
      `
      UPDATE users
      SET is_vip = 1,
          updated_at = ?
      WHERE is_admin = 1
        AND is_vip = 0
    `
    ).run(nowIso())
  }

  if (version < 9) {
    if (!hasSessionTokenPrimaryKey(db)) {
      migrateSessionsToMultiSessionSchema(db)
    } else {
      db.exec(`
        CREATE INDEX IF NOT EXISTS sessions_username_idx ON sessions(username);
        CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
      `)
    }
  }

  if (version < 10) {
    ensureColumn(
      db,
      "users",
      "blur_episode_thumbnails",
      "blur_episode_thumbnails INTEGER NOT NULL DEFAULT 0"
    )
    ensureColumn(
      db,
      "users",
      "remove_unwatched_episode_titles",
      "remove_unwatched_episode_titles INTEGER NOT NULL DEFAULT 0"
    )
  }

  if (version === 10) {
    db.query(
      `
      UPDATE users
      SET blur_episode_thumbnails = 0,
          updated_at = ?
      WHERE blur_episode_thumbnails = 1
    `
    ).run(nowIso())
  }

  if (version < 12) {
    ensureColumn(
      db,
      "users",
      "ignored_app_update_version",
      "ignored_app_update_version TEXT"
    )
  }

  if (version < 13) {
    ensureColumn(
      db,
      "users",
      "disable_update_badges",
      "disable_update_badges INTEGER NOT NULL DEFAULT 0"
    )
  }

  setUserVersion(db, currentSchemaVersion)
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
  runSchemaMigrations(database)
  return database
}

export function nowIso() {
  return new Date().toISOString()
}
