import { constants as fsConstants } from "node:fs"
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { compareAppVersions, getCurrentAppVersion } from "@/server/app/updateCheck"
import { getAppStateValue, setAppStateValue } from "@/server/db/appState"
import { deleteEpisodeByPath } from "@/server/db/library"
import { getDb, nowIso } from "@/server/db/sqlite"
import { getServerConfig } from "@/server/config"
import {
  clearServerStartupEstimate,
  setServerStartupEstimate,
  setServerStartupPhase,
} from "@/server/startup/readiness"
import {
  registerActiveCacheJobDirectory,
  removeCacheJobDirectory,
} from "@/server/media/cacheMaintenance"
import {
  ffprobe,
  getFileHardwareInputArgs,
  getFileSubtitleInputArgs,
  getMp4FileArgs,
  getWebVttSidecarFileArgs,
  mp4FileExtension,
  runFfmpeg,
  type FfmpegProgress,
} from "@/server/media/ffmpeg"
import {
  pathExists,
  removeEpisodeThumbnails,
  parseDurationSeconds,
  type ProbeResult,
  type ProbeStream,
} from "@/server/media/mediaFiles"
import {
  isConvertibleTextSubtitleCodec,
  isWebVttSubtitleCodec,
  normalizeSubtitleCodecName,
  subtitleSidecarPathForMediaFile,
} from "@/server/media/subtitles"
import { errorMessage, fileName } from "@/server/utils/format"

const appVersionStateKey = "app.version"
const v6CompatibilityVersion = "6.0.0"
const targetHevcBytesPerMinute = 32 * 1024 * 1024
const targetAudioKbps = 320
const compatibilityTempPrefix = "v6-hevc-library-"
const compatibilityQueueFileName = "yamibunko-v6-compatibility-queue.json"
const compatibilityFailuresLogFileName = "v6-migration-failures.log"
export const v6CompatibilityFailedFolderName = "V6-Migration-Failed"
const progressBarWidth = 30

function shouldRunV6CompatibilityUpgrade(storedVersion: string | null) {
  if (!storedVersion) {
    return true
  }

  if (!/^\s*v?\d+(?:\.\d+)*(?:[+-][0-9a-z.-]+)?\s*$/i.test(storedVersion)) {
    return true
  }

  return compareAppVersions(storedVersion, v6CompatibilityVersion) < 0
}

type EpisodeFileRow = {
  file_path: string
}

type V6CompatibilityQueueItem = {
  filePath: string
  dbFilePath?: string
  probe: ProbeResult
}

type V6CompatibilityTranscodeResult =
  | { status: "converted" }
  | { status: "failed"; failurePath: string | null }

type VersionUpgradeGlobal = typeof globalThis & {
  __yamibunkoVersionUpgradeState?: VersionUpgradeState
}

type VersionUpgradeState = {
  shutdownRequested: boolean
  queuedV6CompatibilityFiles: V6CompatibilityQueueItem[]
  activeV6CompatibilityTask: Promise<V6CompatibilityTranscodeResult> | null
  activeV6CompatibilityLabel: string | null
  v6CompatibilityQueuePrepared: boolean
}

class StartupUpgradeShutdownError extends Error {
  constructor() {
    super("Version-dependent startup upgrade was interrupted by shutdown.")
    this.name = "StartupUpgradeShutdownError"
  }
}

function getVersionUpgradeState() {
  const versionUpgradeGlobal = globalThis as VersionUpgradeGlobal

  versionUpgradeGlobal.__yamibunkoVersionUpgradeState ??= {
    shutdownRequested: false,
    queuedV6CompatibilityFiles: [],
    activeV6CompatibilityTask: null,
    activeV6CompatibilityLabel: null,
    v6CompatibilityQueuePrepared: false,
  }

  return versionUpgradeGlobal.__yamibunkoVersionUpgradeState
}

function throwIfVersionUpgradeShutdownRequested() {
  if (getVersionUpgradeState().shutdownRequested) {
    throw new StartupUpgradeShutdownError()
  }
}

export function isStartupUpgradeShutdownError(error: unknown) {
  return error instanceof StartupUpgradeShutdownError
}

function compatibilityQueueFilePath() {
  return path.join(/* turbopackIgnore: true */ process.cwd(), compatibilityQueueFileName)
}

function compatibilityFailuresLogFilePath() {
  return path.join(/* turbopackIgnore: true */ process.cwd(), compatibilityFailuresLogFileName)
}

function clampProgress(value: number, total: number) {
  if (!Number.isFinite(value) || value <= 0 || total <= 0) {
    return 0
  }

  return Math.min(value, total)
}

function formatProgressBar(value: number, total: number, label?: string) {
  const safeTotal = Math.max(total, 1)
  const safeValue = clampProgress(value, safeTotal)
  const ratio = safeValue / safeTotal
  const filled = Math.min(
    progressBarWidth,
    Math.max(0, Math.round(ratio * progressBarWidth))
  )
  const percent = (ratio * 100).toFixed(1)
  const progressLabel = label ?? `${Math.floor(safeValue)}/${Math.floor(safeTotal)}`

  return `[${"#".repeat(filled)}${"-".repeat(progressBarWidth - filled)}] ${progressLabel} (${percent}%)`
}

function formatDuration(totalSeconds: number | null | undefined) {
  if (!Number.isFinite(totalSeconds ?? Number.NaN) || (totalSeconds ?? 0) < 0) {
    return "unknown"
  }

  const seconds = Math.ceil(totalSeconds ?? 0)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`
  }

  return `${remainingSeconds}s`
}

function formatSpeed(speed: number | null | undefined) {
  if (!Number.isFinite(speed ?? Number.NaN) || (speed ?? 0) <= 0) {
    return "unknown"
  }

  return `${(speed ?? 0).toFixed(2)}x`
}

function trimForProgressLog(value: string) {
  const normalized = value.replace(/\s+/g, " ")
  const maxLength = 140

  if (normalized.length <= maxLength) {
    return normalized
  }

  return `...${normalized.slice(-(maxLength - 3))}`
}

function createProgressLogger(intervalMs: number) {
  let lastLogAt = 0

  return (lines: string[], force = false) => {
    const now = Date.now()

    if (!force && now - lastLogAt < intervalMs) {
      return
    }

    lastLogAt = now

    for (const line of lines) {
      console.log(line)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizedFileKey(filePath: string) {
  return path.resolve(filePath)
}

function parsePersistedQueueItems(
  rawValue: unknown,
  rows: EpisodeFileRow[]
): V6CompatibilityQueueItem[] | null {
  if (!isRecord(rawValue) || rawValue.version !== 1 || !Array.isArray(rawValue.items)) {
    return null
  }

  const knownFilePaths = new Set(rows.map((row) => normalizedFileKey(row.file_path)))
  const parsedItems: V6CompatibilityQueueItem[] = []

  for (const rawItem of rawValue.items) {
    if (!isRecord(rawItem) || !isRecord(rawItem.probe)) {
      continue
    }

    const rawRow = rawItem.row
    const legacyRowPath =
      isRecord(rawRow) && typeof rawRow.file_path === "string"
        ? rawRow.file_path
        : null
    const filePath = typeof rawItem.filePath === "string" ? rawItem.filePath : legacyRowPath

    if (!filePath) {
      continue
    }

    const normalizedFilePath = normalizedFileKey(filePath)

    if (!knownFilePaths.has(normalizedFilePath)) {
      continue
    }

    parsedItems.push({
      filePath: normalizedFilePath,
      dbFilePath:
        typeof rawItem.dbFilePath === "string" ? rawItem.dbFilePath : filePath,
      probe: rawItem.probe as ProbeResult,
    })
  }

  return parsedItems
}


async function loadPersistedV6CompatibilityQueue(rows: EpisodeFileRow[]) {
  const queuePath = compatibilityQueueFilePath()

  if (!(await pathExists(queuePath))) {
    return null
  }

  try {
    const parsed = JSON.parse(await readFile(queuePath, "utf8")) as unknown
    const items = parsePersistedQueueItems(parsed, rows)

    if (!items) {
      console.warn(
        `[Warn] [Upgrade] Ignoring invalid V6 compatibility queue file - ${queuePath}`
      )
      await rm(queuePath, { force: true }).catch(() => undefined)
      return null
    }

    await rm(queuePath, { force: true }).catch(() => undefined)
    console.log(
      `[Info] [Upgrade] Loaded ${items.length} queued V6 compatibility transcode task(s) from ${queuePath}.`
    )

    return items
  } catch (error) {
    console.warn(
      `[Warn] [Upgrade] Could not read V6 compatibility queue file; running a fresh scan - ${queuePath} - ${errorMessage(error)}`
    )
    await rm(queuePath, { force: true }).catch(() => undefined)
    return null
  }
}

async function savePersistedV6CompatibilityQueue(items: V6CompatibilityQueueItem[]) {
  const queuePath = compatibilityQueueFilePath()
  const tempPath = `${queuePath}.tmp`
  const payload = {
    version: 1,
    targetVersion: v6CompatibilityVersion,
    savedAt: nowIso(),
    items,
  }

  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
  await rename(tempPath, queuePath)
  console.log(
    `[Info] [Shutdown] Saved ${items.length} queued V6 compatibility transcode task(s) to ${queuePath}.`
  )
}

function normalizeCodecName(value: string | undefined | null) {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_")
}

function primaryVideoCodec(probe: ProbeResult) {
  return (probe.streams ?? []).find((stream) => stream.codec_type === "video")?.codec_name
}

function isHevcVideo(probe: ProbeResult) {
  const codec = normalizeCodecName(primaryVideoCodec(probe))

  return codec === "hevc" || codec === "h265"
}

function migrationVideoBitrateKbps() {
  const totalKbps = Math.floor((targetHevcBytesPerMinute * 8) / 60 / 1000)
  return Math.max(totalKbps - targetAudioKbps, 500)
}

function firstConvertibleSubtitleStream(probe: ProbeResult) {
  return (probe.streams ?? []).find((stream) => {
    if (stream.codec_type !== "subtitle" || !Number.isInteger(stream.index)) {
      return false
    }

    return isConvertibleTextSubtitleCodec(stream.codec_name)
  })
}

async function moveFileReplacingDestination(source: string, destination: string) {
  await mkdir(path.dirname(destination), { recursive: true })
  await rm(destination, { force: true })

  try {
    await rename(source, destination)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    if (code !== "EXDEV") {
      throw error
    }

    try {
      await copyFile(source, destination)
      await rm(source, { force: true })
    } catch (copyError) {
      await rm(destination, { force: true }).catch(() => undefined)
      throw copyError
    }
  }
}


async function moveFileWithoutReplacingDestination(source: string, destination: string) {
  await mkdir(path.dirname(destination), { recursive: true })

  if (await pathExists(destination)) {
    throw new Error(`Destination already exists: ${destination}`)
  }

  try {
    await rename(source, destination)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    if (code !== "EXDEV") {
      throw error
    }

    try {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL)
      await rm(source, { force: true })
    } catch (copyError) {
      await rm(destination, { force: true }).catch(() => undefined)
      throw copyError
    }
  }
}

async function unusedDestinationPath(destination: string) {
  if (!(await pathExists(destination))) {
    return destination
  }

  const parsed = path.parse(destination)
  const timestamp = Date.now()

  for (let index = 1; index <= 999; index += 1) {
    const candidate = path.join(
      parsed.dir,
      `${parsed.name}.failed-${timestamp}-${index}${parsed.ext}`
    )

    if (!(await pathExists(candidate))) {
      return candidate
    }
  }

  throw new Error(`Could not allocate a unique V6 migration failure path for ${destination}`)
}

function safeMediaRelativePath(filePath: string, mediaDir: string) {
  const relativePath = path.relative(path.resolve(mediaDir), path.resolve(filePath))

  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return path.basename(filePath)
  }

  return relativePath
}

async function moveFileToV6FailureFolder(sourcePath: string, originalFilePath: string) {
  const config = getServerConfig()
  const mediaDir = config.mediaDir ? path.resolve(config.mediaDir) : path.dirname(originalFilePath)
  const relativePath = safeMediaRelativePath(originalFilePath, mediaDir)
  const baseDestination = path.join(mediaDir, v6CompatibilityFailedFolderName, relativePath)
  const destination = await unusedDestinationPath(baseDestination)

  await moveFileWithoutReplacingDestination(sourcePath, destination)
  return destination
}

function failureErrorOutput(error: unknown) {
  const message = errorMessage(error)
  const stderr =
    isRecord(error) && typeof error.stderr === "string" ? error.stderr.trim() : ""

  if (!stderr) {
    return message
  }

  return `${message}\n\nFFmpeg output:\n${stderr}`
}

async function recordV6CompatibilityFailure(input: {
  originalFilePath: string
  failurePath: string | null
  error: unknown
}) {
  const failureLogPath = compatibilityFailuresLogFilePath()
  const entry = [
    `[${nowIso()}] V6 library compatibility migration failure`,
    `Original file: ${input.originalFilePath}`,
    `Moved to: ${input.failurePath ?? "not moved"}`,
    "Reason:",
    failureErrorOutput(input.error),
    "",
    "----",
    "",
  ].join("\n")

  await appendFile(failureLogPath, entry, "utf8")
}

async function removeFailedV6CompatibilityEpisode(
  filePath: string,
  dbFilePath: string | undefined
) {
  const candidatePaths = Array.from(
    new Set([dbFilePath, filePath].filter((value): value is string => Boolean(value)))
  )
  let episode: ReturnType<typeof deleteEpisodeByPath> = null

  for (const candidatePath of candidatePaths) {
    episode = deleteEpisodeByPath(candidatePath)

    if (episode) {
      break
    }
  }

  if (episode) {
    console.warn(
      `[Warn] [Upgrade] Removed failed V6 migration file from the library database - ${filePath}`
    )
  } else {
    console.warn(
      `[Warn] [Upgrade] Failed V6 migration file was not present in the library database - ${filePath}`
    )
  }

  await removeEpisodeThumbnails(filePath).catch((error) => {
    console.warn(
      `[Warn] [Upgrade] Could not remove thumbnail cache for failed V6 migration file - ${filePath} - ${errorMessage(error)}`
    )
  })
}

function mp4CompatibilityArgs(input: {
  inputPath: string
  outputPath: string
  subtitleOutputPath?: string
  subtitleStream?: ProbeStream
  probe: ProbeResult
}) {
  const videoBitrateKbps = migrationVideoBitrateKbps()
  const subtitleStream =
    input.subtitleOutputPath && input.subtitleStream && Number.isInteger(input.subtitleStream.index)
      ? input.subtitleStream
      : null
  const subtitleCodec = normalizeSubtitleCodecName(subtitleStream?.codec_name)

  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:2",
    ...getFileHardwareInputArgs({
      inputVideoCodec: primaryVideoCodec(input.probe),
      keepFramesOnDevice: false,
    }),
    ...getFileSubtitleInputArgs(),
    ...(subtitleStream && !isWebVttSubtitleCodec(subtitleCodec) ? ["-fix_sub_duration"] : []),
    "-i",
    input.inputPath,
    ...getMp4FileArgs({
      videoBitrateKbps,
      maxVideoBitrateKbps: videoBitrateKbps,
      convertVideo: true,
      audioOutputIndexesToOpus: (input.probe.streams ?? [])
        .filter((stream) => stream.codec_type === "audio")
        .map((_stream, outputAudioIndex) => outputAudioIndex),
      fastStart: false,
    }),
    input.outputPath,
    ...(subtitleStream && input.subtitleOutputPath
      ? [
          ...getWebVttSidecarFileArgs({
            inputIndex: 0,
            streamIndex: subtitleStream.index as number,
            codec: isWebVttSubtitleCodec(subtitleCodec) ? "copy" : "webvtt",
          }),
          input.subtitleOutputPath,
        ]
      : []),
  ]
}

function listEpisodeFileRows() {
  return getDb()
    .query<EpisodeFileRow>(
      `
      SELECT file_path
      FROM episodes
      ORDER BY file_path ASC
    `
    )
    .all()
}


async function transcodeLibraryFileToHevc(
  inputPathValue: string,
  inputProbe: ProbeResult,
  dbFilePath?: string,
  onProgress?: (progress: FfmpegProgress) => void
): Promise<V6CompatibilityTranscodeResult> {
  const config = getServerConfig()
  const inputPath = path.resolve(inputPathValue)
  const parsed = path.parse(inputPath)
  const finalPath = inputPath
  const jobsTempRoot = path.join(config.tempDir, "jobs")

  await mkdir(jobsTempRoot, { recursive: true })

  const tempDirectory = await mkdtemp(path.join(jobsTempRoot, compatibilityTempPrefix))
  const transcodeDirectory = path.join(tempDirectory, "transcode")
  const tempOriginalPath = path.join(tempDirectory, parsed.base)
  const tempMp4Path = path.join(transcodeDirectory, `${parsed.name}${mp4FileExtension}`)
  const tempSubtitlePath = subtitleSidecarPathForMediaFile(tempMp4Path)
  const finalSubtitlePath = subtitleSidecarPathForMediaFile(finalPath)
  const releaseCacheJobDirectory = registerActiveCacheJobDirectory(tempDirectory)
  let originalMovedToTemp = false
  let outputMovedToFinalPath = false
  let failurePath: string | null = null
  let preserveTempDirectory = false

  try {
    const subtitleStream = firstConvertibleSubtitleStream(inputProbe)
    const hasSubtitleOutput = Boolean(subtitleStream && Number.isInteger(subtitleStream.index))

    console.log(
      `[Info] [Upgrade] Transcoding library file to HEVC for V6 compatibility using ${config.transcodeAccel} - ${fileName(inputPath)}`
    )

    await mkdir(transcodeDirectory, { recursive: true })
    await moveFileReplacingDestination(inputPath, tempOriginalPath)
    originalMovedToTemp = true

    await runFfmpeg(
      mp4CompatibilityArgs({
        inputPath: tempOriginalPath,
        outputPath: tempMp4Path,
        subtitleOutputPath: hasSubtitleOutput ? tempSubtitlePath : undefined,
        subtitleStream,
        probe: inputProbe,
      }),
      {
        priorityRole: "file-encoding",
        protectFromParentSignals: true,
        onProgress,
      }
    )

    if (!(await pathExists(tempMp4Path))) {
      throw new Error(`FFmpeg completed without creating V6 compatibility output: ${tempMp4Path}`)
    }

    const outputProbe = (await ffprobe(tempMp4Path)) as ProbeResult

    if (!isHevcVideo(outputProbe)) {
      throw new Error(`V6 compatibility output is not HEVC video: ${tempMp4Path}`)
    }

    await moveFileReplacingDestination(tempMp4Path, finalPath)
    outputMovedToFinalPath = true

    if (hasSubtitleOutput && (await pathExists(tempSubtitlePath))) {
      await moveFileReplacingDestination(tempSubtitlePath, finalSubtitlePath).catch((error) => {
        console.warn(
          `[Warn] [Upgrade] Could not move V6 compatibility subtitle sidecar - ${finalSubtitlePath} - ${errorMessage(error)}`
        )
      })
    }

    await removeEpisodeThumbnails(inputPath).catch((error) => {
      console.warn(
        `[Warn] [Upgrade] Could not remove stale thumbnail during V6 compatibility upgrade - ${inputPath} - ${errorMessage(error)}`
      )
    })

    return { status: "converted" }
  } catch (error) {
    const originalCandidatePath = originalMovedToTemp ? tempOriginalPath : finalPath

    if (!outputMovedToFinalPath && (await pathExists(originalCandidatePath))) {
      try {
        failurePath = await moveFileToV6FailureFolder(originalCandidatePath, finalPath)
      } catch (moveError) {
        preserveTempDirectory = originalMovedToTemp
        console.error(
          `[Error] [Upgrade] Could not move failed V6 migration file to the failure folder - ${finalPath} - ${errorMessage(moveError)}`
        )
      }
    }

    await recordV6CompatibilityFailure({
      originalFilePath: finalPath,
      failurePath,
      error,
    }).catch((logError) => {
      console.error(
        `[Error] [Upgrade] Could not write V6 migration failure log - ${compatibilityFailuresLogFilePath()} - ${errorMessage(logError)}`
      )
    })

    await removeFailedV6CompatibilityEpisode(finalPath, dbFilePath)

    console.warn(
      `[Warn] [Upgrade] V6 migration failed for ${finalPath}. The file was ${
        failurePath ? `moved to ${failurePath}` : "not moved to the failure folder"
      } and removed from the library database.`
    )

    return { status: "failed", failurePath }
  } finally {
    releaseCacheJobDirectory()

    if (preserveTempDirectory) {
      console.warn(
        `[Warn] [Upgrade] Preserved V6 compatibility temp directory for manual recovery - ${tempDirectory}`
      )
    } else {
      await removeCacheJobDirectory(tempDirectory, { allowActive: true }).catch(() =>
        rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined)
      )
    }
  }
}

async function assertLibraryIsHevc() {
  const rows = listEpisodeFileRows()
  const nonHevcFiles: string[] = []
  const logProgress = createProgressLogger(2000)

  console.log(
    `[Info] [Upgrade] Verifying V6 library compatibility for ${rows.length} episode file(s).`
  )

  for (const [index, row] of rows.entries()) {
    throwIfVersionUpgradeShutdownRequested()

    const filePath = path.resolve(row.file_path)
    const checked = index + 1

    logProgress(
      [
        `[Info] [Upgrade] Verify ${formatProgressBar(
          checked,
          rows.length,
          `${checked}/${rows.length}`
        )}`,
        `[Info] [Upgrade] Current file: ${trimForProgressLog(filePath)}`,
      ],
      checked === rows.length
    )

    if (!(await pathExists(filePath))) {
      continue
    }

    const probe = (await ffprobe(filePath)) as ProbeResult

    if (!isHevcVideo(probe)) {
      nonHevcFiles.push(filePath)
    }
  }

  if (nonHevcFiles.length > 0) {
    throw new Error(
      `V6 compatibility upgrade did not convert every library file to HEVC: ${nonHevcFiles.join(", ")}`
    )
  }
}

async function scanV6CompatibilityQueue(rows: EpisodeFileRow[]) {
  const queue: V6CompatibilityQueueItem[] = []
  const logProgress = createProgressLogger(2000)
  let alreadyCompatible = 0
  let missing = 0
  let failed = 0

  setServerStartupPhase("V6 library compatibility check")
  console.log(
    `[Info] [Upgrade] Running V6 library compatibility check for ${rows.length} episode file(s).`
  )

  for (const [index, row] of rows.entries()) {
    throwIfVersionUpgradeShutdownRequested()

    const filePath = path.resolve(row.file_path)
    const checked = index + 1

    logProgress(
      [
        `[Info] [Upgrade] Check ${formatProgressBar(
          checked,
          rows.length,
          `${checked}/${rows.length}`
        )}`,
        `[Info] [Upgrade] Current file: ${trimForProgressLog(filePath)}`,
      ],
      checked === rows.length
    )

    if (!(await pathExists(filePath))) {
      missing += 1
      console.warn(
        `[Warn] [Upgrade] Skipping missing library file during V6 compatibility upgrade - ${filePath}`
      )
      continue
    }

    let probe: ProbeResult

    try {
      probe = (await ffprobe(filePath)) as ProbeResult
    } catch (error) {
      let failurePath: string | null = null

      try {
        failurePath = await moveFileToV6FailureFolder(filePath, filePath)
      } catch (moveError) {
        console.error(
          `[Error] [Upgrade] Could not move failed V6 migration probe file to the failure folder - ${filePath} - ${errorMessage(moveError)}`
        )
      }

      await recordV6CompatibilityFailure({
        originalFilePath: filePath,
        failurePath,
        error,
      }).catch((logError) => {
        console.error(
          `[Error] [Upgrade] Could not write V6 migration failure log - ${compatibilityFailuresLogFilePath()} - ${errorMessage(logError)}`
        )
      })

      await removeFailedV6CompatibilityEpisode(filePath, row.file_path)
      failed += 1
      console.warn(
        `[Warn] [Upgrade] V6 migration probe failed for ${filePath}. The file was ${
          failurePath ? `moved to ${failurePath}` : "not moved to the failure folder"
        } and removed from the library database.`
      )
      continue
    }

    if (isHevcVideo(probe)) {
      alreadyCompatible += 1
      continue
    }

    queue.push({ filePath, dbFilePath: row.file_path, probe })
  }

  return { queue, alreadyCompatible, missing, failed }
}

function queueDurationSeconds(queue: V6CompatibilityQueueItem[]) {
  return queue.reduce((total, item) => total + parseDurationSeconds(item.probe), 0)
}

function estimateRemainingSeconds(input: {
  currentDurationSeconds: number
  currentDoneSeconds: number
  queuedRemainingDurationSeconds: number
  startedAt: number
  speed: number | null
}) {
  const currentRemainingSeconds = Math.max(
    input.currentDurationSeconds - input.currentDoneSeconds,
    0
  )
  const sourceSecondsRemaining = currentRemainingSeconds + input.queuedRemainingDurationSeconds

  if (input.speed && input.speed > 0) {
    return sourceSecondsRemaining / input.speed
  }

  const elapsedSeconds = Math.max((Date.now() - input.startedAt) / 1000, 1)
  const effectiveSpeed = input.currentDoneSeconds / elapsedSeconds

  if (!Number.isFinite(effectiveSpeed) || effectiveSpeed <= 0) {
    return null
  }

  return sourceSecondsRemaining / effectiveSpeed
}

async function runV6CompatibilityTranscodeQueue(input: {
  totalEpisodeFiles: number
}) {
  const upgradeState = getVersionUpgradeState()
  const totalTranscodeFiles = upgradeState.queuedV6CompatibilityFiles.length
  const totalDurationSeconds = Math.max(
    queueDurationSeconds(upgradeState.queuedV6CompatibilityFiles),
    1
  )
  const logProgress = createProgressLogger(1500)
  let processedFiles = 0
  let convertedFiles = 0
  let failedFiles = 0
  let completedDurationSeconds = 0

  setServerStartupPhase("V6 library HEVC transcode")
  console.log(
    `[Info] [Upgrade] ${totalTranscodeFiles} out of ${input.totalEpisodeFiles} files need to be transcoded to HEVC, that can take a couple of hours depending on your hardware.`
  )

  while (upgradeState.queuedV6CompatibilityFiles.length > 0) {
    throwIfVersionUpgradeShutdownRequested()

    const item = upgradeState.queuedV6CompatibilityFiles.shift()

    if (!item) {
      continue
    }

    const fileIndex = processedFiles + 1
    const fileDurationSeconds = Math.max(parseDurationSeconds(item.probe), 1)
    const queuedRemainingDurationSeconds = queueDurationSeconds(
      upgradeState.queuedV6CompatibilityFiles
    )
    const startedAt = Date.now()
    let latestProgressSeconds = 0
    let latestSpeed: number | null = null

    const reportProgress = (progress?: FfmpegProgress, force = false) => {
      if (progress) {
        latestProgressSeconds = Math.min(
          Math.max(progress.outTimeSeconds, latestProgressSeconds),
          fileDurationSeconds
        )
        latestSpeed = progress.speed ?? latestSpeed
      }

      const fileEtaSeconds = estimateRemainingSeconds({
        currentDurationSeconds: fileDurationSeconds,
        currentDoneSeconds: latestProgressSeconds,
        queuedRemainingDurationSeconds: 0,
        startedAt,
        speed: latestSpeed,
      })
      const totalEtaSeconds = estimateRemainingSeconds({
        currentDurationSeconds: fileDurationSeconds,
        currentDoneSeconds: latestProgressSeconds,
        queuedRemainingDurationSeconds,
        startedAt,
        speed: latestSpeed,
      })
      setServerStartupEstimate(totalEtaSeconds)
      const totalDoneSeconds = completedDurationSeconds + latestProgressSeconds

      logProgress(
        [
          `[Info] [Upgrade] HEVC transcode ${formatProgressBar(
            totalDoneSeconds,
            totalDurationSeconds,
            `${processedFiles}/${totalTranscodeFiles} file(s)`
          )} ETA ${formatDuration(totalEtaSeconds)}`,
          `[Info] [Upgrade] Current file (${fileIndex}/${totalTranscodeFiles}): ${trimForProgressLog(
            item.filePath
          )}`,
          `[Info] [Upgrade] File progress ${formatProgressBar(
            latestProgressSeconds,
            fileDurationSeconds,
            `${formatDuration(latestProgressSeconds)} / ${formatDuration(fileDurationSeconds)}`
          )} ETA ${formatDuration(fileEtaSeconds)} Speed ${formatSpeed(latestSpeed)}`,
        ],
        force
      )
    }

    reportProgress(undefined, true)

    const activeTask = transcodeLibraryFileToHevc(
      item.filePath,
      item.probe,
      item.dbFilePath,
      (progress) => {
        reportProgress(progress)
      }
    )
    upgradeState.activeV6CompatibilityTask = activeTask
    upgradeState.activeV6CompatibilityLabel = item.filePath

    try {
      const result = await activeTask

      processedFiles += 1
      completedDurationSeconds += fileDurationSeconds
      latestProgressSeconds = fileDurationSeconds

      if (result.status === "converted") {
        convertedFiles += 1
      } else {
        failedFiles += 1
      }

      reportProgress({ outTimeSeconds: fileDurationSeconds, speed: latestSpeed, status: "end" }, true)
    } finally {
      if (upgradeState.activeV6CompatibilityTask === activeTask) {
        upgradeState.activeV6CompatibilityTask = null
        upgradeState.activeV6CompatibilityLabel = null
      }
    }
  }

  clearServerStartupEstimate()

  return { converted: convertedFiles, failed: failedFiles }
}

async function runV6LibraryCompatibilityUpgrade() {
  const config = getServerConfig()
  const upgradeState = getVersionUpgradeState()

  if (!config.importEnabled || !config.mediaDir) {
    console.log(
      "[Info] [Upgrade] V6 compatibility upgrade skipped because catalog mode is active."
    )
    return
  }

  const mediaDirStat = await stat(config.mediaDir).catch(() => null)

  if (!mediaDirStat?.isDirectory()) {
    console.log(
      "[Info] [Upgrade] V6 compatibility upgrade skipped because the library directory is unavailable."
    )
    return
  }

  const rows = listEpisodeFileRows()
  let alreadyCompatible = 0
  let missing = 0
  let failed = 0

  upgradeState.queuedV6CompatibilityFiles.splice(0)
  upgradeState.v6CompatibilityQueuePrepared = false

  const persistedQueue = await loadPersistedV6CompatibilityQueue(rows)

  if (persistedQueue) {
    upgradeState.queuedV6CompatibilityFiles.push(...persistedQueue)
    upgradeState.v6CompatibilityQueuePrepared = true
    alreadyCompatible = Math.max(rows.length - persistedQueue.length, 0)
    setServerStartupPhase("V6 library HEVC transcode")
    console.log(
      "[Info] [Upgrade] Skipping V6 compatibility probe scan because a persisted queue was loaded."
    )
  } else {
    const scanResult = await scanV6CompatibilityQueue(rows)
    upgradeState.queuedV6CompatibilityFiles.push(...scanResult.queue)
    upgradeState.v6CompatibilityQueuePrepared = true
    alreadyCompatible = scanResult.alreadyCompatible
    missing = scanResult.missing
    failed = scanResult.failed
  }

  console.log(
    `[Info] [Upgrade] V6 library compatibility queue prepared with ${upgradeState.queuedV6CompatibilityFiles.length} file(s) requiring HEVC conversion.`
  )

  const transcodeResult = await runV6CompatibilityTranscodeQueue({
    totalEpisodeFiles: rows.length,
  })

  throwIfVersionUpgradeShutdownRequested()
  clearServerStartupEstimate()
  setServerStartupPhase("V6 library compatibility verification")
  await assertLibraryIsHevc()
  throwIfVersionUpgradeShutdownRequested()

  const failureLogPath = compatibilityFailuresLogFilePath()
  const failureLogExists = await pathExists(failureLogPath)

  if (failureLogExists) {
    console.warn(
      `[Warn] [Upgrade] V6 library compatibility migration completed with failed file(s). Failed files were moved to ${path.join(config.mediaDir, v6CompatibilityFailedFolderName)} and details were written to ${failureLogPath}. The database version will still be updated because failed entries were removed from the library database.`
    )
  }

  console.log(
    `[Info] [Upgrade] V6 library compatibility upgrade completed. HEVC-confirmed ${alreadyCompatible}, converted ${transcodeResult.converted}, failed ${failed + transcodeResult.failed}, missing ${missing}.`
  )
  clearServerStartupEstimate()
}

export async function beginVersionDependentStartupUpgradeShutdown() {
  const upgradeState = getVersionUpgradeState()

  upgradeState.shutdownRequested = true

  const queuedItems = [...upgradeState.queuedV6CompatibilityFiles]

  if (upgradeState.v6CompatibilityQueuePrepared && queuedItems.length > 0) {
    await savePersistedV6CompatibilityQueue(queuedItems).catch((error) => {
      console.warn(
        `[Warn] [Shutdown] Could not save queued V6 compatibility task file - ${errorMessage(error)}`
      )
    })
  }

  const cancelledQueueLength = upgradeState.queuedV6CompatibilityFiles.splice(0).length

  if (cancelledQueueLength > 0) {
    console.log(
      `[Info] [Shutdown] Cleared ${cancelledQueueLength} queued V6 compatibility upgrade file(s).`
    )
  }

  const activeTask = upgradeState.activeV6CompatibilityTask

  if (!activeTask) {
    return
  }

  console.log(
    `[Info] [Shutdown] Waiting for active V6 compatibility transcode to finish - ${upgradeState.activeV6CompatibilityLabel ?? "unknown file"}.`
  )

  await activeTask.catch((error) => {
    console.warn(
      `[Warn] [Shutdown] Active V6 compatibility transcode finished with an error during shutdown - ${errorMessage(error)}`
    )
  })
}

export async function runVersionDependentStartupUpgrades() {
  const upgradeState = getVersionUpgradeState()

  upgradeState.shutdownRequested = false
  upgradeState.queuedV6CompatibilityFiles.splice(0)
  upgradeState.activeV6CompatibilityTask = null
  upgradeState.activeV6CompatibilityLabel = null
  upgradeState.v6CompatibilityQueuePrepared = false

  const currentVersion = getCurrentAppVersion()
  const storedVersion = getAppStateValue(appVersionStateKey)
  const isV6OrNewer = compareAppVersions(currentVersion, v6CompatibilityVersion) >= 0
  const needsV6CompatibilityUpgrade =
    isV6OrNewer && shouldRunV6CompatibilityUpgrade(storedVersion)

  if (needsV6CompatibilityUpgrade) {
    console.log(
      `[Info] [Upgrade] Running version-dependent startup upgrades from ${storedVersion ?? "untracked"} to ${currentVersion}.`
    )
    await runV6LibraryCompatibilityUpgrade()
  }

  throwIfVersionUpgradeShutdownRequested()

  setAppStateValue(appVersionStateKey, currentVersion)
  console.log(`[Info] [Upgrade] Database app version set to ${currentVersion}.`)
}
