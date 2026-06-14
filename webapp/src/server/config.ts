import os from "node:os"
import path from "node:path"

import { z } from "zod"

import { defaultSpoilerSettings, type SafeSettings } from "@/lib/types"
import { normalizeBaseUrl } from "@/server/http/baseUrl"

export type TranscodeAcceleration =
  | "nvenc"
  | "intel_gpu"
  | "intel_cpu"
  | "amd_gpu"
  | "amd_cpu"
  | "cpu"
export type FileEncodeAcceleration = Exclude<TranscodeAcceleration, "cpu">
export type ImportEncoding = "av1" | "hevc" | "none"

const serverConfigSchema = z.object({
  FFMPEG_DIR: z.string().trim().min(1),
  ANIME_INPUT_DIR: z.string().trim().min(1),
  ANIME_MEDIA_DIR: z.string().trim().optional(),
  IMPORT_ENABLED: z.enum(["true", "false"]).default("true"),
  IMPORT_ENCODING: z.enum(["av1", "hevc", "none"]).default("none"),
  TRANSCODE_ACCEL: z.enum([
    "nvenc",
    "intel_gpu",
    "intel_cpu",
    "amd_gpu",
    "amd_cpu",
    "cpu",
  ]),
  ANILIST_CLIENT_ID: z.string().trim().optional(),
  ANILIST_CLIENT_SECRET: z.string().trim().optional(),
  BASE_URL: z.url(),
}).superRefine((env, context) => {
  if (env.IMPORT_ENABLED === "true" && !env.ANIME_MEDIA_DIR?.trim()) {
    context.addIssue({
      code: "custom",
      path: ["ANIME_MEDIA_DIR"],
      message: "Required when IMPORT_ENABLED is true",
    })
  }

  if (env.IMPORT_ENABLED === "true" && env.IMPORT_ENCODING === "none") {
    context.addIssue({
      code: "custom",
      path: ["IMPORT_ENCODING"],
      message: "Must be av1 or hevc when IMPORT_ENABLED is true",
    })
  }

  if (env.IMPORT_ENABLED === "false" && env.IMPORT_ENCODING !== "none") {
    context.addIssue({
      code: "custom",
      path: ["IMPORT_ENCODING"],
      message: "Must be none when IMPORT_ENABLED is false",
    })
  }
})

export type ServerConfig = {
  ffmpegPath: string
  ffprobePath: string
  inputDir: string
  mediaDir: string
  tempDir: string
  importEnabled: boolean
  importEncoding: ImportEncoding
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


export function getOutdatedTranscodeAccelerationReplacement(value: string) {
  switch (value.trim().toLowerCase()) {
    case "qsv":
    case "intel":
      return "intel_gpu"
    case "amd":
      return "amd_gpu"
    default:
      return null
  }
}

export function normalizeTranscodeAccelerationValue(value: string) {
  return (
    getOutdatedTranscodeAccelerationReplacement(value) ?? value.trim().toLowerCase()
  )
}

function cleanPath(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "")
}

function executableName(name: "ffmpeg" | "ffprobe") {
  return process.platform === "win32" ? `${name}.exe` : name
}

export function getDefaultTempDir() {
  switch (process.platform) {
    case "win32": {
      const base =
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local")
      return path.join(base, "yamibunko", "cache")
    }

    case "linux": {
      const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
      return path.join(base, "yamibunko")
    }

    default:
      return path.join(os.tmpdir(), "yamibunko")
  }
}

function readEnvironment() {
  return {
    ...process.env,
    FFMPEG_DIR: process.env.FFMPEG_DIR ?? process.env.FFMPEG_BIN_DIR,
    ANIME_INPUT_DIR:
      process.env.ANIME_INPUT_DIR ?? process.env.INPUT_FOLDER_PATH,
    ANIME_MEDIA_DIR:
      process.env.ANIME_MEDIA_DIR ?? process.env.OUTPUT_FOLDER_PATH,
    IMPORT_ENABLED: process.env.IMPORT_ENABLED
      ? process.env.IMPORT_ENABLED.trim().toLowerCase()
      : "true",
    IMPORT_ENCODING: process.env.IMPORT_ENCODING
      ? process.env.IMPORT_ENCODING.trim().toLowerCase()
      : process.env.IMPORT_ENABLED?.trim().toLowerCase() === "false"
        ? "none"
        : undefined,
    TRANSCODE_ACCEL: process.env.TRANSCODE_ACCEL
      ? normalizeTranscodeAccelerationValue(process.env.TRANSCODE_ACCEL)
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
    mediaDir: env.ANIME_MEDIA_DIR ? cleanPath(env.ANIME_MEDIA_DIR) : "",
    tempDir: getDefaultTempDir(),
    importEnabled: env.IMPORT_ENABLED === "true",
    importEncoding: env.IMPORT_ENCODING,
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

export function getSafeServerSettings(input: {
  account?: SafeSettings["account"]
  spoilers?: SafeSettings["spoilers"]
} = {}): SafeSettings {
  return {
    account: input.account ?? {
      userName: "Unknown",
      isAdmin: false,
      disableUpdateBadges: false,
    },
    spoilers: input.spoilers ?? defaultSpoilerSettings,
  }
}
