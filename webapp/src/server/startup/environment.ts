import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

import {
  av1HardwareUnsupportedMessage,
  detectHardwareAcceleration,
  type HardwareAcceleration,
} from "@/server/startup/hardwareAcceleration"
import {
  getOutdatedTranscodeAccelerationReplacement,
  normalizeTranscodeAccelerationValue,
  type TranscodeAcceleration,
} from "@/server/config"
import { normalizeBaseUrl } from "@/server/http/baseUrl"

const baseRequiredEnvironmentKeys = [
  "FFMPEG_DIR",
  "ANIME_INPUT_DIR",
  "TRANSCODE_ACCEL",
  "BASE_URL",
] as const

const importRequiredEnvironmentKeys = ["ANIME_MEDIA_DIR"] as const

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
  ["IMPORT_ENABLED", "IMPORT_ENABLED"],
  ["ANILIST_CLIENT_ID", "ANILIST_CLIENT_ID"],
  ["ANILIST_CLIENT_SECRET", "ANILIST_CLIENT_SECRET"],
  ["BASE_URL", "BASE_URL"],
  ["APP_BASE_URL", "BASE_URL"],
])

const requiredCanonicalKeys = new Set<string>([
  ...baseRequiredEnvironmentKeys,
  ...importRequiredEnvironmentKeys,
])
const loggedEnvironmentKeys = [
  ...baseRequiredEnvironmentKeys,
  ...importRequiredEnvironmentKeys,
  "IMPORT_ENABLED",
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

function logOutdatedDotEnvTranscodeAcceleration() {
  const value = process.env.TRANSCODE_ACCEL

  if (!value) {
    return
  }

  const cleanedValue = cleanValue(value)
  const replacement = getOutdatedTranscodeAccelerationReplacement(cleanedValue)

  if (!replacement) {
    return
  }

  console.log(
    `[Warning] [Startup] Selected TRANSCODE_ACCEL value '${cleanedValue}' is outdated. Use TRANSCODE_ACCEL=${replacement} in .env.`
  )
}

function normalizeTranscodeAcceleration() {
  const value = process.env.TRANSCODE_ACCEL

  if (value) {
    process.env.TRANSCODE_ACCEL = normalizeTranscodeAccelerationValue(cleanValue(value))
  }
}

function normalizeImportEnabled() {
  const value = process.env.IMPORT_ENABLED

  if (!value) {
    process.env.IMPORT_ENABLED = "true"
    return
  }

  process.env.IMPORT_ENABLED = cleanValue(value).toLowerCase()
}

function isImportEnabled() {
  return process.env.IMPORT_ENABLED !== "false"
}

function getSelectedAv1HardwareAcceleration(): HardwareAcceleration | null {
  const value = process.env.TRANSCODE_ACCEL

  if (
    value === "nvenc" ||
    value === "intel_gpu" ||
    value === "intel_cpu" ||
    value === "amd_gpu" ||
    value === "amd_cpu"
  ) {
    return value as Exclude<TranscodeAcceleration, "cpu">
  }

  return null
}

function getRequiredEnvironmentKeys() {
  return isImportEnabled()
    ? [...baseRequiredEnvironmentKeys, ...importRequiredEnvironmentKeys]
    : [...baseRequiredEnvironmentKeys]
}

function hasAnyRequiredEnvironmentValue() {
  for (const [alias, canonical] of launcherAliases) {
    if (requiredCanonicalKeys.has(canonical) && process.env[alias]) {
      return true
    }
  }

  return false
}

function formatKnownEnvironmentSnapshot() {
  return loggedEnvironmentKeys
    .map((key) => {
      const value = process.env[key]

      if (!value) {
        return `${key}=<missing>`
      }

      return key.includes("SECRET") ? `${key}=<redacted>` : `${key}=${value}`
    })
    .join(", ")
}

function resolveRequiredPath(envVarName: string) {
  const rawPath = process.env[envVarName]

  if (!rawPath) {
    console.error(
      `[Error] [Startup] Required path variable is missing - environment.ts - ${envVarName}`
    )
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
    console.error(
      `[Error] [Startup] Directory validation failed - environment.ts - ${label}: ${directoryPath}`
    )
    throw new Error(
      `CRITICAL STARTUP ERROR: ${label} path does not exist on disk: ${directoryPath}`
    )
  }
}

function assertExistingFile(label: string, filePath: string) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    console.error(
      `[Error] [Startup] Executable validation failed - environment.ts - ${label}: ${filePath}`
    )
    throw new Error(
      `CRITICAL STARTUP ERROR: ${label} executable could not be found at: ${filePath}`
    )
  }
}

function assertValidBaseUrl(value: string | undefined) {
  if (!value) {
    console.error("[Error] [Startup] BASE_URL is missing - environment.ts")
    throw new Error(
      "CRITICAL INITIALIZATION FAILURE: Environment variable 'BASE_URL' is missing. Ensure the launcher is passing parameters or the local .env file contains this variable."
    )
  }

  try {
    process.env.BASE_URL = normalizeBaseUrl(cleanValue(value))
  } catch {
    console.error(
      `[Error] [Startup] BASE_URL validation failed - environment.ts - ${value}`
    )
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

  if (!hadRuntimeEnvironment && !appliedLauncherParameters && !hasDotEnv) {
    console.error(
      `[Error] [Startup] no parameters found, can't start - environment.ts - Checked .env: ${dotEnvPath}`
    )
    throw new Error("no parameters found, can't start")
  }

  const loadedDotEnv = loadDotEnv(dotEnvPath)
  applyEnvironmentAliases()

  if (loadedDotEnv && !hadRuntimeEnvironment && !appliedLauncherParameters) {
    logOutdatedDotEnvTranscodeAcceleration()
  }

  normalizeTranscodeAcceleration()
  normalizeImportEnabled()

  const sources = [
    ...(hadRuntimeEnvironment ? ["process environment"] : []),
    ...(appliedLauncherParameters ? ["launcher parameters"] : []),
    ...(loadedDotEnv ? [".env"] : []),
  ].join(", ")

  console.log(
    `[Info] [Startup] Loaded startup configuration - Sources: ${sources || "none"} - ${formatKnownEnvironmentSnapshot()}${
      hasDotEnv ? ` - .env: ${dotEnvPath}` : ""
    }`
  )

  for (const key of pathEnvironmentKeys) {
    if (process.env[key]) {
      process.env[key] = path.resolve(cleanValue(process.env[key]))
    }
  }

  for (const key of getRequiredEnvironmentKeys()) {
    if (!process.env[key]) {
      console.error(
        `[Error] [Startup] Required environment variable is missing - environment.ts - ${key}`
      )
      throw new Error(
        `CRITICAL INITIALIZATION FAILURE: Environment variable '${key}' is missing. Ensure the launcher is passing parameters or the local .env file contains this variable.`
      )
    }
  }

  if (!["true", "false"].includes(process.env.IMPORT_ENABLED ?? "")) {
    console.error(
      `[Error] [Startup] IMPORT_ENABLED validation failed - environment.ts - ${process.env.IMPORT_ENABLED}`
    )
    throw new Error(
      "CRITICAL STARTUP ERROR: IMPORT_ENABLED must be true or false."
    )
  }

  if (
    ![
      "nvenc",
      "intel_gpu",
      "intel_cpu",
      "amd_gpu",
      "amd_cpu",
      "cpu",
    ].includes(process.env.TRANSCODE_ACCEL ?? "")
  ) {
    console.error(
      `[Error] [Startup] TRANSCODE_ACCEL validation failed - environment.ts - ${process.env.TRANSCODE_ACCEL}`
    )
    throw new Error(
      "CRITICAL STARTUP ERROR: TRANSCODE_ACCEL must be one of nvenc, intel_gpu, intel_cpu, amd_gpu, amd_cpu, or cpu."
    )
  }

  if (
    (process.env.TRANSCODE_ACCEL === "amd_gpu" ||
      process.env.TRANSCODE_ACCEL === "amd_cpu") &&
    process.platform !== "win32" &&
    process.platform !== "linux"
  ) {
    console.error(
      `[Error] [Startup] AMD transcoding is unsupported on this OS - environment.ts - ${process.platform}`
    )
    throw new Error(
      "CRITICAL STARTUP ERROR: AMD transcoding is only supported on Windows through AMF or Linux through VA-API."
    )
  }

  assertValidBaseUrl(process.env.BASE_URL)

  assertExistingDirectory(
    "Input folder",
    resolveRequiredPath("ANIME_INPUT_DIR")
  )

  if (isImportEnabled()) {
    assertExistingDirectory(
      "Media folder",
      resolveRequiredPath("ANIME_MEDIA_DIR")
    )
  }

  const ffmpegDir = resolveRequiredPath("FFMPEG_DIR")

  assertExistingDirectory("FFmpeg binary folder", ffmpegDir)
  assertExistingFile("FFmpeg", path.join(ffmpegDir, executableName("ffmpeg")))
  assertExistingFile("FFprobe", path.join(ffmpegDir, executableName("ffprobe")))

  if (loadedDotEnv && !hadRuntimeEnvironment && !appliedLauncherParameters) {
    const acceleration = detectHardwareAcceleration({
      ffmpegDir,
      probeEncoders: true,
      av1AccelerationFilter: isImportEnabled()
        ? getSelectedAv1HardwareAcceleration()
        : undefined,
    })

    if (isImportEnabled()) {
      if (!acceleration.av1ImportAcceleration) {
        console.error(`[Error] [Startup] ${av1HardwareUnsupportedMessage}`)
        throw new Error(av1HardwareUnsupportedMessage)
      }

      process.env.TRANSCODE_ACCEL = acceleration.av1ImportAcceleration
    } else {
      process.env.TRANSCODE_ACCEL = acceleration.liveTranscodeAcceleration
    }

    console.log(
      `[Info] [Startup] Hardware acceleration selected - Requested: ${
        process.env.TRANSCODE_ACCEL ?? "unknown"
      }, Import AV1: ${acceleration.av1ImportAcceleration ?? "unsupported"}${
        acceleration.av1ImportDevice ? ` (${acceleration.av1ImportDevice})` : ""
      }, Live transcode: ${acceleration.liveTranscodeAcceleration}${
        acceleration.liveTranscodeDevice ? ` (${acceleration.liveTranscodeDevice})` : ""
      }`
    )
  }

  if (isImportEnabled() && process.env.TRANSCODE_ACCEL === "cpu") {
    console.error(
      "[Error] [Startup] CPU AV1 encoding is unsupported while import mode is enabled - environment.ts"
    )
    throw new Error(
      "CRITICAL STARTUP ERROR: CPU AV1 encoding is not supported. Use hardware AV1 encoding or disable import mode."
    )
  }

  console.log("[Info] [Startup] Validated startup configuration.")

  bootstrapped = true
}
