import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

import { normalizeBaseUrl } from "@/server/http/baseUrl"
import { serverLog } from "@/server/logger"

const requiredEnvironmentKeys = [
  "FFMPEG_DIR",
  "ANIME_INPUT_DIR",
  "ANIME_MEDIA_DIR",
  "TRANSCODE_ACCEL",
  "BASE_URL",
] as const

const pathEnvironmentKeys = [
  "FFMPEG_DIR",
  "ANIME_INPUT_DIR",
  "ANIME_MEDIA_DIR",
] as const

const launcherAliases = new Map<string, string>([
  ["INPUT_FOLDER_PATH", "ANIME_INPUT_DIR"],
  ["ANIME_INPUT_DIR", "ANIME_INPUT_DIR"],
  ["OUTPUT_FOLDER_PATH", "ANIME_MEDIA_DIR"],
  ["ANIME_MEDIA_DIR", "ANIME_MEDIA_DIR"],
  ["FFMPEG_DIR", "FFMPEG_DIR"],
  ["FFMPEG_BIN_DIR", "FFMPEG_DIR"],
  ["TRANSCODE_ACCEL", "TRANSCODE_ACCEL"],
  ["ANILIST_CLIENT_ID", "ANILIST_CLIENT_ID"],
  ["ANILIST_CLIENT_SECRET", "ANILIST_CLIENT_SECRET"],
  ["BASE_URL", "BASE_URL"],
  ["APP_BASE_URL", "BASE_URL"],
])

const requiredCanonicalKeys = new Set<string>(requiredEnvironmentKeys)
const loggedEnvironmentKeys = [
  ...requiredEnvironmentKeys,
  "ANILIST_CLIENT_ID",
  "ANILIST_CLIENT_SECRET",
] as const

let bootstrapped = false

function cleanValue(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "")
}

function normalizeParameterName(value: string) {
  return value
    .replace(/^--?/, "")
    .replace(/^\//, "")
    .replace(/-/g, "_")
    .toUpperCase()
}

function setKnownEnvironmentValue(rawKey: string, rawValue: string) {
  const key = launcherAliases.get(normalizeParameterName(rawKey))

  if (!key) {
    return false
  }

  process.env[key] = cleanValue(rawValue)
  return requiredCanonicalKeys.has(key)
}

function applyLauncherParameters(argv = process.argv.slice(1)) {
  let applied = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (!arg) {
      continue
    }

    const equalsIndex = arg.indexOf("=")

    if (equalsIndex > 0) {
      const key = arg.slice(0, equalsIndex)
      const value = arg.slice(equalsIndex + 1)
      applied = setKnownEnvironmentValue(key, value) || applied
      continue
    }

    const canonical = launcherAliases.get(normalizeParameterName(arg))
    const nextValue = argv[index + 1]

    if (canonical && nextValue && !nextValue.startsWith("--")) {
      process.env[canonical] = cleanValue(nextValue)
      applied = requiredCanonicalKeys.has(canonical) || applied
      index += 1
    }
  }

  return applied
}

function loadDotEnv(dotEnvPath: string) {
  if (!existsSync(dotEnvPath)) {
    return false
  }

  const content = readFileSync(dotEnvPath, "utf8")

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }

    const equalsIndex = trimmed.indexOf("=")

    if (equalsIndex <= 0) {
      continue
    }

    const key = trimmed.slice(0, equalsIndex).trim()
    const value = cleanValue(trimmed.slice(equalsIndex + 1))
    const canonical = launcherAliases.get(normalizeParameterName(key)) ?? key

    if (!process.env[canonical]) {
      process.env[canonical] = value
    }
  }

  return true
}

function applyEnvironmentAliases() {
  for (const [alias, canonical] of launcherAliases) {
    const value = process.env[alias]

    if (value && !process.env[canonical]) {
      process.env[canonical] = cleanValue(value)
    }
  }
}

function hasAnyRequiredEnvironmentValue() {
  for (const [alias, canonical] of launcherAliases) {
    if (requiredCanonicalKeys.has(canonical) && process.env[alias]) {
      return true
    }
  }

  return false
}

function getKnownEnvironmentSnapshot() {
  return Object.fromEntries(
    loggedEnvironmentKeys.map((key) => [key, process.env[key] ?? null])
  )
}

function resolveRequiredPath(envVarName: string) {
  const rawPath = process.env[envVarName]

  if (!rawPath) {
    serverLog.error("Startup", "Required path variable is missing.", {
      envVarName,
    })
    throw new Error(
      `CRITICAL INITIALIZATION FAILURE: Environment variable '${envVarName}' is missing. Ensure the launcher is passing parameters or the local .env file contains this variable.`
    )
  }

  const resolved = path.resolve(cleanValue(rawPath))
  process.env[envVarName] = resolved
  return resolved
}

function assertExistingDirectory(label: string, directoryPath: string) {
  if (!existsSync(directoryPath) || !statSync(directoryPath).isDirectory()) {
    serverLog.error("Startup", "Directory validation failed.", {
      label,
      directoryPath,
    })
    throw new Error(
      `CRITICAL STARTUP ERROR: ${label} path does not exist on disk: ${directoryPath}`
    )
  }
}

function assertExistingFile(label: string, filePath: string) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    serverLog.error("Startup", "Executable validation failed.", {
      label,
      filePath,
    })
    throw new Error(
      `CRITICAL STARTUP ERROR: ${label} executable could not be found at: ${filePath}`
    )
  }
}

function assertValidBaseUrl(value: string | undefined) {
  if (!value) {
    serverLog.error("Startup", "BASE_URL is missing.")
    throw new Error(
      "CRITICAL INITIALIZATION FAILURE: Environment variable 'BASE_URL' is missing. Ensure the launcher is passing parameters or the local .env file contains this variable."
    )
  }

  try {
    process.env.BASE_URL = normalizeBaseUrl(cleanValue(value))
  } catch {
    serverLog.error("Startup", "BASE_URL validation failed.", {
      value,
    })
    throw new Error(
      `CRITICAL STARTUP ERROR: BASE_URL must be a valid http(s) URL, for example http://localhost:3000 or https://domain.ext/some/path. Received: ${value}`
    )
  }
}

function executableName(name: "ffmpeg" | "ffprobe") {
  return process.platform === "win32" ? `${name}.exe` : name
}

export function bootstrapEnvironment() {
  if (bootstrapped) {
    return
  }

  applyEnvironmentAliases()
  const hadRuntimeEnvironment = hasAnyRequiredEnvironmentValue()
  const appliedLauncherParameters = applyLauncherParameters()
  const dotEnvPath = path.resolve(process.cwd(), ".env")
  const hasDotEnv = existsSync(dotEnvPath)

  if (
    !hadRuntimeEnvironment &&
    !appliedLauncherParameters &&
    !hasDotEnv
  ) {
    serverLog.error("Startup", "no parameters found, can't start", {
      dotEnvPath,
    })
    throw new Error("no parameters found, can't start")
  }

  const loadedDotEnv = loadDotEnv(dotEnvPath)
  applyEnvironmentAliases()

  serverLog.info("Startup", "Loaded startup configuration.", {
    sources: [
      ...(hadRuntimeEnvironment ? ["process environment"] : []),
      ...(appliedLauncherParameters ? ["launcher parameters"] : []),
      ...(loadedDotEnv ? [".env"] : []),
    ],
    dotEnvPath: hasDotEnv ? dotEnvPath : null,
    values: getKnownEnvironmentSnapshot(),
  })

  for (const key of pathEnvironmentKeys) {
    if (process.env[key]) {
      process.env[key] = path.resolve(cleanValue(process.env[key]))
    }
  }

  for (const key of requiredEnvironmentKeys) {
    if (!process.env[key]) {
      serverLog.error("Startup", "Required environment variable is missing.", {
        key,
      })
      throw new Error(
        `CRITICAL INITIALIZATION FAILURE: Environment variable '${key}' is missing. Ensure the launcher is passing parameters or the local .env file contains this variable.`
      )
    }
  }

  if (!["nvenc", "qsv", "cpu"].includes(process.env.TRANSCODE_ACCEL ?? "")) {
    serverLog.error("Startup", "TRANSCODE_ACCEL validation failed.", {
      value: process.env.TRANSCODE_ACCEL,
    })
    throw new Error(
      "CRITICAL STARTUP ERROR: TRANSCODE_ACCEL must be one of nvenc, qsv, or cpu."
    )
  }

  assertValidBaseUrl(process.env.BASE_URL)

  assertExistingDirectory(
    "Input folder",
    resolveRequiredPath("ANIME_INPUT_DIR")
  )
  assertExistingDirectory(
    "Media folder",
    resolveRequiredPath("ANIME_MEDIA_DIR")
  )
  const ffmpegDir = resolveRequiredPath("FFMPEG_DIR")

  assertExistingDirectory("FFmpeg binary folder", ffmpegDir)
  assertExistingFile("FFmpeg", path.join(ffmpegDir, executableName("ffmpeg")))
  assertExistingFile("FFprobe", path.join(ffmpegDir, executableName("ffprobe")))

  serverLog.info("Startup", "Validated startup configuration.")

  bootstrapped = true
}
