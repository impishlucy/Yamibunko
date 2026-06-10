import { randomUUID } from "node:crypto"

import { getDb, nowIso } from "@/server/db/sqlite"

export type JobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "skipped"
  | "failed"

export function createJob(inputPath: string) {
  const id = randomUUID()
  const now = nowIso()

  getDb()
    .query(
      "INSERT INTO jobs (id, kind, status, input_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, "media-processing", "queued", inputPath, now, now)

  return id
}

export function updateJob(
  id: string,
  patch: {
    status?: JobStatus
    outputPath?: string | null
    animeId?: number | null
    epNr?: number | null
    message?: string | null
    error?: string | null
    startedAt?: string | null
    finishedAt?: string | null
  }
) {
  const current = getDb()
    .query<{
      status: JobStatus
      output_path: string | null
      anime_id: number | null
      ep_nr: number | null
      message: string | null
      error: string | null
      started_at: string | null
      finished_at: string | null
    }>(
      "SELECT status, output_path, anime_id, ep_nr, message, error, started_at, finished_at FROM jobs WHERE id = ?"
    )
    .get(id)

  if (!current) {
    return
  }

  getDb()
    .query(
      `
      UPDATE jobs
      SET status = ?,
          output_path = ?,
          anime_id = ?,
          ep_nr = ?,
          message = ?,
          error = ?,
          started_at = ?,
          finished_at = ?,
          updated_at = ?
      WHERE id = ?
    `
    )
    .run(
      patch.status ?? current.status,
      patch.outputPath === undefined ? current.output_path : patch.outputPath,
      patch.animeId === undefined ? current.anime_id : patch.animeId,
      patch.epNr === undefined ? current.ep_nr : patch.epNr,
      patch.message === undefined ? current.message : patch.message,
      patch.error === undefined ? current.error : patch.error,
      patch.startedAt === undefined ? current.started_at : patch.startedAt,
      patch.finishedAt === undefined ? current.finished_at : patch.finishedAt,
      nowIso(),
      id
    )
}

export function listActiveJobIds() {
  return getDb()
    .query<{ id: string }>(
      "SELECT id FROM jobs WHERE status IN ('queued', 'processing')"
    )
    .all()
    .map((row) => row.id)
}
