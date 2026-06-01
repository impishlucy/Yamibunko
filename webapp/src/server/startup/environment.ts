import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const requiredEnvironmentKeys = [
  "FFMPEG_DIR",
  "ANIME_INPUT_DIR",
  "ANIME_MEDIA_DIR",
  "TRANSCODE_ACCEL",
] as const

const pathEnvironmentKeys = [
  "FFMPEG_DIR",
  "ANIME_INPUT_DIR",
  "ANIME_MEDIA_DIR",
] as const

const launcherAliases = new Map<string, string>([
  ["INPUT_FOLDER_PATH", "ANIME_INPUT_DIR"],
  ["INPUT_DIR", "ANIME_INPUT_DIR"],
  ["ANIME_INPUT_DIR", "ANIME_INPUT_DIR"],
  ["OUTPUT_FOLDER_PATH", "ANIME_MEDIA_DIR"],
  ["OUTPUT_DIR", "ANIME_MEDIA_DIR"],
  ["MEDIA_FOLDER_PATH", "ANIME_MEDIA_DIR"],
  ["MEDIA_DIR", "ANIME_MEDIA_DIR"],
  ["ANIME_MEDIA_DIR", "ANIME_MEDIA_DIR"],
  ["FFMPEG_DIR", "FFMPEG_DIR"],
  ["FFMPEG_BIN_DIR", "FFMPEG_DIR"],
  ["MEDIA_BIN_DIR", "FFMPEG_DIR"],
  ["TRANSCODE_ACCEL", "TRANSCODE_ACCEL"],
  ["TRANSCODE_ACCELERATION", "TRANSCODE_ACCEL"],
  ["PORT", "PORT"],
])

const requiredCanonicalKeys = new Set<string>(requiredEnvironmentKeys)

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

    const maybeKey = normalizeParameterName(arg)
    const canonical = launcherAliases.get(maybeKey)
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

function resolveRequiredPath(envVarName: string) {
  const rawPath = process.env[envVarName]

  if (!rawPath) {
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
    throw new Error(
      `CRITICAL STARTUP ERROR: ${label} path does not exist on disk: ${directoryPath}`
    )
  }
}

function assertExistingFile(label: string, filePath: string) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(
      `CRITICAL STARTUP ERROR: ${label} executable could not be found at: ${filePath}`
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

  if (
    !hadRuntimeEnvironment &&
    !appliedLauncherParameters &&
    !existsSync(dotEnvPath)
  ) {
    throw new Error("no parameters found, can't start")
  }

  loadDotEnv(dotEnvPath)
  applyEnvironmentAliases()

  for (const key of pathEnvironmentKeys) {
    if (process.env[key]) {
      process.env[key] = path.resolve(cleanValue(process.env[key]))
    }
  }

  for (const key of requiredEnvironmentKeys) {
    if (!process.env[key]) {
      throw new Error(
        `CRITICAL INITIALIZATION FAILURE: Environment variable '${key}' is missing. Ensure the launcher is passing parameters or the local .env file contains this variable.`
      )
    }
  }

  if (!["nvenc", "qsv", "cpu"].includes(process.env.TRANSCODE_ACCEL ?? "")) {
    throw new Error(
      "CRITICAL STARTUP ERROR: TRANSCODE_ACCEL must be one of nvenc, qsv, or cpu."
    )
  }

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

  bootstrapped = true
}
