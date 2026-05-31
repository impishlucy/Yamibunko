import { z } from "zod"

import type { SafeSettings } from "@/lib/types"

const serverConfigSchema = z.object({
  FFMPEG_PATH: z.string().min(1),
  FFPROBE_PATH: z.string().min(1),
  ANIME_INPUT_DIR: z.string().min(1),
  ANIME_MEDIA_DIR: z.string().min(1),
  ANIME_CACHE_DIR: z.string().min(1),
  TRANSCODE_ACCEL: z.enum(["nvenc", "qsv", "cpu"]),
  BACKGROUND_TRANSCODE_CONCURRENCY: z.coerce.number().int().positive(),
  LIVE_TRANSCODE_SLOTS: z.coerce.number().int().nonnegative(),
})

export type ServerConfig = {
  ffmpegPath: string
  ffprobePath: string
  inputDir: string
  mediaDir: string
  cacheDir: string
  transcodeAccel: "nvenc" | "qsv" | "cpu"
  backgroundTranscodeConcurrency: number
  liveTranscodeSlots: number
}

type ConfigResult =
  | { ok: true; config: ServerConfig }
  | { ok: false; issues: string[] }

let cachedConfig: ServerConfig | undefined
let cachedIssues: string[] | undefined

function mapConfig(env: z.infer<typeof serverConfigSchema>): ServerConfig {
  return {
    ffmpegPath: env.FFMPEG_PATH,
    ffprobePath: env.FFPROBE_PATH,
    inputDir: env.ANIME_INPUT_DIR,
    mediaDir: env.ANIME_MEDIA_DIR,
    cacheDir: env.ANIME_CACHE_DIR,
    transcodeAccel: env.TRANSCODE_ACCEL,
    backgroundTranscodeConcurrency: env.BACKGROUND_TRANSCODE_CONCURRENCY,
    liveTranscodeSlots: env.LIVE_TRANSCODE_SLOTS,
  }
}

export function getServerConfigResult(): ConfigResult {
  if (cachedConfig) {
    return { ok: true, config: cachedConfig }
  }

  if (cachedIssues) {
    return { ok: false, issues: cachedIssues }
  }

  const parsed = serverConfigSchema.safeParse(process.env)

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

export function getSafeServerSettings(): SafeSettings {
  const config = getServerConfig()

  return {
    account: {
      userName: "Local User",
    },
    paths: {
      inputDir: config.inputDir,
      mediaDir: config.mediaDir,
      cacheDir: config.cacheDir,
    },
    transcoding: {
      acceleration: config.transcodeAccel,
      backgroundConcurrency: config.backgroundTranscodeConcurrency,
      liveSlots: config.liveTranscodeSlots,
    },
    appearance: {
      theme: "dark",
    },
  }
}
