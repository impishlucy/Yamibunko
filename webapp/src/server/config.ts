import os from "node:os"
import path from "node:path"

import { z } from "zod"

import type { SafeSettings } from "@/lib/types"
import { normalizeBaseUrl } from "@/server/http/baseUrl"

export type TranscodeAcceleration = "nvenc" | "qsv" | "amd" | "cpu"

const serverConfigSchema = z.object({
  FFMPEG_DIR: z.string().trim().min(1),
  ANIME_INPUT_DIR: z.string().trim().min(1),
  ANIME_MEDIA_DIR: z.string().trim().min(1),
  TRANSCODE_ACCEL: z.enum(["nvenc", "qsv", "amd", "cpu"]),
  ANILIST_CLIENT_ID: z.string().trim().optional(),
  ANILIST_CLIENT_SECRET: z.string().trim().optional(),
  BASE_URL: z.url(),
})

export type ServerConfig = {
  ffmpegPath: string
  ffprobePath: string
  inputDir: string
  mediaDir: string
  tempDir: string
  transcodeAccel: TranscodeAcceleration
  anilistClientId?: string
  anilistClientSecret?: string
  baseUrl: string
}

type ConfigResult =
  | { ok: true; config: ServerConfig }
  | { ok: false; issues: string[] }

let cachedConfig: ServerConfig | undefined
let cachedIssues: string[] | undefined

function cleanPath(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "")
}

function executableName(name: "ffmpeg" | "ffprobe") {
  return process.platform === "win32" ? `${name}.exe` : name
}

function getDefaultTempDir() {
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local")
    return path.join(base, "Yamibunko", "Cache")
  }

  if (process.platform === "linux") {
    const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
    return path.join(base, "yamibunko")
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "Yamibunko")
  }

  return path.join(os.tmpdir(), "yamibunko")
}

function readEnvironment() {
  return {
    ...process.env,
    FFMPEG_DIR: process.env.FFMPEG_DIR ?? process.env.FFMPEG_BIN_DIR,
    ANIME_INPUT_DIR:
      process.env.ANIME_INPUT_DIR ?? process.env.INPUT_FOLDER_PATH,
    ANIME_MEDIA_DIR:
      process.env.ANIME_MEDIA_DIR ?? process.env.OUTPUT_FOLDER_PATH,
    TRANSCODE_ACCEL: process.env.TRANSCODE_ACCEL
      ? process.env.TRANSCODE_ACCEL.trim().toLowerCase()
      : undefined,
    ANILIST_CLIENT_ID: process.env.ANILIST_CLIENT_ID,
    ANILIST_CLIENT_SECRET: process.env.ANILIST_CLIENT_SECRET,
    BASE_URL: process.env.BASE_URL ?? process.env.APP_BASE_URL,
  }
}

function mapConfig(env: z.infer<typeof serverConfigSchema>): ServerConfig {
  const ffmpegDir = path.resolve(cleanPath(env.FFMPEG_DIR))

  return {
    ffmpegPath: path.join(ffmpegDir, executableName("ffmpeg")),
    ffprobePath: path.join(ffmpegDir, executableName("ffprobe")),
    inputDir: cleanPath(env.ANIME_INPUT_DIR),
    mediaDir: cleanPath(env.ANIME_MEDIA_DIR),
    tempDir: getDefaultTempDir(),
    transcodeAccel: env.TRANSCODE_ACCEL,
    anilistClientId: env.ANILIST_CLIENT_ID
      ? cleanPath(env.ANILIST_CLIENT_ID)
      : undefined,
    anilistClientSecret: env.ANILIST_CLIENT_SECRET
      ? cleanPath(env.ANILIST_CLIENT_SECRET)
      : undefined,
    baseUrl: normalizeBaseUrl(env.BASE_URL),
  }
}

export function getServerConfigResult(): ConfigResult {
  if (cachedConfig) {
    return { ok: true, config: cachedConfig }
  }

  if (cachedIssues) {
    return { ok: false, issues: cachedIssues }
  }

  const parsed = serverConfigSchema.safeParse(readEnvironment())

  if (!parsed.success) {
    cachedIssues = parsed.error.issues.map((issue) => {
      const key = issue.path.join(".") || "environment"
      return `${key}: ${issue.message}`
    })

    return { ok: false, issues: cachedIssues }
  }

  cachedConfig = mapConfig(parsed.data)
  return { ok: true, config: cachedConfig }
}

export function getServerConfig(): ServerConfig {
  const result = getServerConfigResult()

  if (!result.ok) {
    throw new Error(
      `Server configuration is invalid: ${result.issues.join(", ")}`
    )
  }

  return result.config
}

export function getSafeServerSettings(
  account: SafeSettings["account"] = {
    userName: "Unknown",
    isAdmin: false,
  }
): SafeSettings {
  return {
    account,
  }
}
