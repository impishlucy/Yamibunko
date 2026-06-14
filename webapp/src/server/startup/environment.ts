import { existsSync, rmSync, statSync } from "node:fs"
import path from "node:path"

import {
  normalizeTranscodeAccelerationValue,
  type ImportEncoding,
} from "@/server/config"
import { normalizeBaseUrl } from "@/server/http/baseUrl"

const baseRequiredEnvironmentKeys = [
  "FFMPEG_DIR",
  "ANIME_INPUT_DIR",
  "TRANSCODE_ACCEL",
  "BASE_URL",
  "IMPORT_ENABLED",
  "IMPORT_ENCODING",
] as const

const importRequiredEnvironmentKeys = ["ANIME_MEDIA_DIR"] as const

const pathEnvironmentKeys = [
  "FFMPEG_DIR",
  "ANIME_INPUT_DIR",
  "ANIME_MEDIA_DIR",
] as const

const staleEnvironmentFileNames = [".env", ".env.local"] as const
const launcherAliases = new Map<string, string>([
  ["INPUT_FOLDER_PATH", "ANIME_INPUT_DIR"],
  ["ANIME_INPUT_DIR", "ANIME_INPUT_DIR"],
  ["OUTPUT_FOLDER_PATH", "ANIME_MEDIA_DIR"],
  ["ANIME_MEDIA_DIR", "ANIME_MEDIA_DIR"],
  ["FFMPEG_DIR", "FFMPEG_DIR"],
  ["FFMPEG_BIN_DIR", "FFMPEG_DIR"],
  ["TRANSCODE_ACCEL", "TRANSCODE_ACCEL"],
  ["IMPORT_ENABLED", "IMPORT_ENABLED"],
  ["IMPORT_ENCODING", "IMPORT_ENCODING"],
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

function setKnownEnvironmentValue(
  rawKey: string,
  rawValue: string,
  options: { overwrite: boolean }
) {
  const key = launcherAliases.get(normalizeParameterName(rawKey))

  if (!key) {
    return false
  }

  if (!options.overwrite && process.env[key]) {
    return requiredCanonicalKeys.has(key)
  }

  process.env[key] = cleanValue(rawValue)
  return requiredCanonicalKeys.has(key)
}

function applyRuntimeEnvironmentValues() {
  let applied = false

  for (const [rawKey, canonicalKey] of launcherAliases) {
    const value = process.env[rawKey]

    if (!value) {
      continue
    }

    if (!process.env[canonicalKey]) {
      process.env[canonicalKey] = cleanValue(value)
    } else if (rawKey === canonicalKey) {
      process.env[canonicalKey] = cleanValue(process.env[canonicalKey])
    }

    applied = requiredCanonicalKeys.has(canonicalKey) || applied
  }

  return applied
}

function applyManualStartupParameters(argv = process.argv.slice(1)) {
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
      applied =
        setKnownEnvironmentValue(key, value, { overwrite: false }) || applied
      continue
    }

    const canonical = launcherAliases.get(normalizeParameterName(arg))
    const nextValue = argv[index + 1]

    if (canonical && nextValue && !nextValue.startsWith("--")) {
      if (!process.env[canonical]) {
        process.env[canonical] = cleanValue(nextValue)
      }

      applied = requiredCanonicalKeys.has(canonical) || applied
      index += 1
    }
  }

  return applied
}

function deleteStaleEnvironmentFiles() {
  let deleted = false

  for (const fileName of staleEnvironmentFileNames) {
    const filePath = path.resolve(/* turbopackIgnore: true */ process.cwd(), fileName)

    if (!existsSync(filePath)) {
      continue
    }

    rmSync(filePath, { force: true })
    deleted = true
    console.warn(
      `[Warn] [Startup] Removed unsupported startup config file - ${filePath}`
    )
  }

  return deleted
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
    return
  }

  process.env.IMPORT_ENABLED = cleanValue(value).toLowerCase()
}

function normalizeImportEncoding() {
  const value = process.env.IMPORT_ENCODING

  if (!value) {
    return
  }

  process.env.IMPORT_ENCODING = cleanValue(value).toLowerCase()
}

function hasRuntimeEnvironment() {
  return [...requiredCanonicalKeys].some((key) => Boolean(process.env[key]))
}

function isImportEnabled() {
  return process.env.IMPORT_ENABLED !== "false"
}

function getRequiredEnvironmentKeys() {
  return isImportEnabled()
    ? [...baseRequiredEnvironmentKeys, ...importRequiredEnvironmentKeys]
    : [...baseRequiredEnvironmentKeys]
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
      `[Error] [Startup] Required startup argument is missing - environment.ts - ${envVarName}`
    )
    throw new Error(
      `CRITICAL INITIALIZATION FAILURE: Startup argument '${envVarName}' is missing. Start Yamibunko through the launcher or pass the required arguments manually.`
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
      "CRITICAL INITIALIZATION FAILURE: Startup argument 'BASE_URL' is missing. Start Yamibunko through the launcher or pass the required arguments manually."
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

function assertValidImportEncoding(value: string | undefined): asserts value is ImportEncoding {
  if (value === "av1" || value === "hevc" || value === "none") {
    return
  }

  console.error(
    `[Error] [Startup] IMPORT_ENCODING validation failed - environment.ts - ${value}`
  )
  throw new Error(
    "CRITICAL STARTUP ERROR: IMPORT_ENCODING must be one of av1, hevc, or none."
  )
}

export function bootstrapEnvironment() {
  if (bootstrapped) {
    return
  }

  deleteStaleEnvironmentFiles()
  const appliedRuntimeEnvironment = applyRuntimeEnvironmentValues()
  const appliedManualParameters = applyManualStartupParameters()
  const hasExistingRuntimeEnvironment = hasRuntimeEnvironment()

  if (
    !appliedRuntimeEnvironment &&
    !appliedManualParameters &&
    !hasExistingRuntimeEnvironment
  ) {
    console.error(
      "[Error] [Startup] no startup arguments found, can't start - environment.ts"
    )
    throw new Error("no startup arguments found, can't start")
  }

  normalizeTranscodeAcceleration()
  normalizeImportEnabled()
  normalizeImportEncoding()

  console.log(
    `[Info] [Startup] Loaded startup configuration - ${formatKnownEnvironmentSnapshot()}`
  )

  for (const key of pathEnvironmentKeys) {
    if (process.env[key]) {
      process.env[key] = path.resolve(cleanValue(process.env[key]))
    }
  }

  for (const key of getRequiredEnvironmentKeys()) {
    if (!process.env[key]) {
      console.error(
        `[Error] [Startup] Required startup argument is missing - environment.ts - ${key}`
      )
      throw new Error(
        `CRITICAL INITIALIZATION FAILURE: Startup argument '${key}' is missing. Start Yamibunko through the launcher or pass the required arguments manually.`
      )
    }
  }

  if (!isImportEnabled()) {
    process.env.IMPORT_ENCODING = "none"
  }

  if (!["true", "false"].includes(process.env.IMPORT_ENABLED ?? "")) {
    console.error(
      `[Error] [Startup] IMPORT_ENABLED validation failed - environment.ts - ${process.env.IMPORT_ENABLED}`
    )
    throw new Error(
      "CRITICAL STARTUP ERROR: IMPORT_ENABLED must be true or false."
    )
  }

  assertValidImportEncoding(process.env.IMPORT_ENCODING)

  if (isImportEnabled() && process.env.IMPORT_ENCODING === "none") {
    console.error(
      "[Error] [Startup] IMPORT_ENCODING=none is invalid while import mode is enabled - environment.ts"
    )
    throw new Error(
      "CRITICAL STARTUP ERROR: IMPORT_ENCODING must be av1 or hevc when IMPORT_ENABLED is true."
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

  if (isImportEnabled() && process.env.TRANSCODE_ACCEL === "cpu") {
    console.error(
      "[Error] [Startup] CPU file encoding is unsupported while import mode is enabled - environment.ts"
    )
    throw new Error(
      "CRITICAL STARTUP ERROR: CPU file encoding is not supported. Use hardware AV1/HEVC encoding or disable import mode."
    )
  }

  console.log("[Info] [Startup] Validated startup configuration.")

  bootstrapped = true
}
