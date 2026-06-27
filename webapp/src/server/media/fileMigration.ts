import { constants } from "node:fs"
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { getAppStateBoolean, setAppStateBoolean } from "@/server/db/appState"
import { getDb, nowIso } from "@/server/db/sqlite"
import { getServerConfig } from "@/server/config"
import {
  registerActiveCacheJobDirectory,
  removeCacheJobDirectory,
} from "@/server/media/cacheMaintenance"
import {
  ffprobe,
  getFileHardwareInputArgs,
  getFileSubtitleInputArgs,
  getMp4FileArgs,
  runFfmpeg,
  webmFileExtension,
} from "@/server/media/ffmpeg"
import { type ProbeResult, type ProbeStream } from "@/server/media/mediaFiles"
import {
  isConvertibleTextSubtitleCodec,
  isWebVttSubtitleCodec,
  normalizeSubtitleCodecName,
  subtitleSidecarPathForMediaFile,
  subtitlesDirectoryName,
} from "@/server/media/subtitles"
import { errorMessage, fileName } from "@/server/utils/format"

const migrationStateKey = "migration.webm_to_mp4_sidecar_vtt.pending"
const targetHevcBytesPerMinute = 32 * 1024 * 1024
const targetAudioKbps = 320
const migrationTempPrefix = "migration-webm-to-mp4-"
const migrationManifestFileName = "migration.json"

type MigrationShutdownState = {
  requested: boolean
  signal: NodeJS.Signals | null
  exitCode: number
}

type MigrationWorkManifest = {
  originalWebmPath: string
  finalMp4Path: string
  finalSubtitlePath: string
  tempInputPath: string
  tempMp4Path: string
  tempSubtitlePath: string
}

type EpisodeWebmPathRow = {
  file_path: string
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

async function createMigrationTempDirectory() {
  const config = getServerConfig()
  const jobsTempRoot = path.join(config.tempDir, "jobs")

  await mkdir(jobsTempRoot, { recursive: true })
  return mkdtemp(path.join(jobsTempRoot, migrationTempPrefix))
}

async function listMigrationTempDirectories() {
  const config = getServerConfig()
  const jobsTempRoot = path.join(config.tempDir, "jobs")
  const entries = await readdir(jobsTempRoot, { withFileTypes: true }).catch(() => null)

  if (!entries) {
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(migrationTempPrefix))
    .map((entry) => path.join(jobsTempRoot, entry.name))
}

function migrationManifestPath(directoryPath: string) {
  return path.join(directoryPath, migrationManifestFileName)
}

async function writeMigrationManifest(directoryPath: string, manifest: MigrationWorkManifest) {
  await writeFile(migrationManifestPath(directoryPath), JSON.stringify(manifest, null, 2), "utf8")
}

async function readMigrationManifest(directoryPath: string) {
  const text = await readFile(migrationManifestPath(directoryPath), "utf8")
  return JSON.parse(text) as MigrationWorkManifest
}

async function pathExists(filePath: string) {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function isMigrationOutputTempFileName(name: string) {
  return /^\..+\.migration-\d+\.tmp$/u.test(name)
}

async function removeStaleMigrationOutputTempFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => null)

  if (!entries) {
    return 0
  }

  let removedCount = 0

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      removedCount += await removeStaleMigrationOutputTempFiles(entryPath)
      continue
    }

    if (!entry.isFile() || !isMigrationOutputTempFileName(entry.name)) {
      continue
    }

    await rm(entryPath, { force: true })
    removedCount += 1
  }

  return removedCount
}

async function restoreMovedMigrationInput(manifest: MigrationWorkManifest) {
  if (!(await pathExists(manifest.tempInputPath))) {
    return false
  }

  await mkdir(path.dirname(manifest.originalWebmPath), { recursive: true })

  if (await pathExists(manifest.originalWebmPath)) {
    await rm(manifest.tempInputPath, { force: true })
    return true
  }

  await moveFileReplacingDestination(manifest.tempInputPath, manifest.originalWebmPath)
  return true
}

async function* walkWebmFiles(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      if (entry.name === subtitlesDirectoryName) {
        continue
      }

      yield* walkWebmFiles(entryPath)
      continue
    }

    if (entry.isFile() && path.extname(entry.name).toLowerCase() === webmFileExtension) {
      yield entryPath
    }
  }
}

async function hasWebmFiles(directory: string) {
  for await (const _webmPath of walkWebmFiles(directory)) {
    return true
  }

  return false
}

function firstConvertibleSubtitleStream(probe: ProbeResult) {
  return (probe.streams ?? []).find((stream) => {
    if (stream.codec_type !== "subtitle" || !Number.isInteger(stream.index)) {
      return false
    }

    return isConvertibleTextSubtitleCodec(stream.codec_name)
  })
}

function primaryVideoCodec(probe: ProbeResult) {
  return (probe.streams ?? []).find((stream) => stream.codec_type === "video")?.codec_name
}

function canCopyVideoToTargetMp4(probe: ProbeResult) {
  const codec = normalizeCodecName(primaryVideoCodec(probe))

  return codec === "hevc" || codec === "h265"
}

function migrationVideoBitrateKbps() {
  const totalKbps = Math.floor((targetHevcBytesPerMinute * 8) / 60 / 1000)
  return Math.max(totalKbps - targetAudioKbps, 500)
}

function normalizeCodecName(value: string | undefined | null) {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_")
}

function audioOutputIndexesToOpus(probe: ProbeResult) {
  return (probe.streams ?? [])
    .filter((stream) => stream.codec_type === "audio")
    .map((stream, outputAudioIndex) => {
      const codec = normalizeCodecName(stream.codec_name)
      return codec === "opus" ? null : outputAudioIndex
    })
    .filter((index): index is number => index !== null)
}

function migrationConvertsVideo(probe: ProbeResult) {
  return !canCopyVideoToTargetMp4(probe)
}

function migrationSubtitleOutputArgs(input: {
  outputPath: string
  streamIndex: number
  codec?: string | null
}) {
  const codec = normalizeSubtitleCodecName(input.codec)

  return [
    "-map",
    `0:${input.streamIndex}`,
    "-c:s",
    isWebVttSubtitleCodec(codec) ? "copy" : "webvtt",
    "-f",
    "webvtt",
    input.outputPath,
  ]
}

function mp4MigrationArgs(input: {
  inputPath: string
  outputPath: string
  subtitleOutputPath?: string
  subtitleStream?: ProbeStream
  probe: ProbeResult
}) {
  const videoBitrateKbps = migrationVideoBitrateKbps()
  const convertVideo = migrationConvertsVideo(input.probe)
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
    ...(convertVideo
      ? getFileHardwareInputArgs({
          inputVideoCodec: primaryVideoCodec(input.probe),
          keepFramesOnDevice: false,
        })
      : []),
    ...getFileSubtitleInputArgs(),
    ...(subtitleStream && !isWebVttSubtitleCodec(subtitleCodec) ? ["-fix_sub_duration"] : []),
    "-i",
    input.inputPath,
    ...getMp4FileArgs({
      videoBitrateKbps,
      maxVideoBitrateKbps: videoBitrateKbps,
      convertVideo,
      audioOutputIndexesToOpus: audioOutputIndexesToOpus(input.probe),
      fastStart: false,
    }),
    input.outputPath,
    ...(subtitleStream && input.subtitleOutputPath
      ? migrationSubtitleOutputArgs({
          outputPath: input.subtitleOutputPath,
          streamIndex: subtitleStream.index as number,
          codec: subtitleStream.codec_name,
        })
      : []),
  ]
}

function migrationModeLabel(probe: ProbeResult) {
  const copyVideo = canCopyVideoToTargetMp4(probe)
  const audioTranscodeCount = audioOutputIndexesToOpus(probe).length

  switch (true) {
    case copyVideo && audioTranscodeCount === 0:
      return "fast-remuxing"

    case copyVideo:
      return "copying video and converting audio"

    default:
      return "re-encoding to HEVC"
  }
}

async function updateEpisodePath(oldPath: string, newPath: string) {
  getDb()
    .query(
      `
      UPDATE episodes
      SET file_path = ?, updated_at = ?
      WHERE file_path = ?
    `
    )
    .run(newPath, nowIso(), oldPath)
}

async function assertFileExists(filePath: string, label: string) {
  try {
    await access(filePath, constants.F_OK)
  } catch {
    throw new Error(`${label} was not created: ${filePath}`)
  }
}

function installMigrationShutdownHandlers() {
  const state: MigrationShutdownState = {
    requested: false,
    signal: null,
    exitCode: 0,
  }

  const handlers = new Map<NodeJS.Signals, () => void>()

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (state.requested) {
        return
      }

      state.requested = true
      state.signal = signal
      state.exitCode = signal === "SIGINT" ? 130 : 143

      console.warn(
        `[Warn] [Migration] Shutdown requested during file migration. Finishing the active file, then stopping before the next file.`
      )
    }

    handlers.set(signal, handler)
    process.once(signal, handler)
  }

  return {
    state,
    uninstall() {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler)
      }
    },
  }
}

function stopAfterActiveMigrationFile(state: MigrationShutdownState) {
  if (!state.requested) {
    return false
  }

  console.warn(
    `[Warn] [Migration] File migration stopped after the active file. Remaining WebM files will continue on next startup.`
  )
  process.exit(state.exitCode)
}

async function recoverStaleMigrationWorkDirectories() {
  for (const migrationTempDirectory of await listMigrationTempDirectories()) {
    const releaseCacheJobDirectory = registerActiveCacheJobDirectory(migrationTempDirectory)

    try {
      const manifest = await readMigrationManifest(migrationTempDirectory).catch(() => null)

      if (!manifest) {
        await removeCacheJobDirectory(migrationTempDirectory, { allowActive: true })
        continue
      }

      if (await pathExists(manifest.finalMp4Path)) {
        if (await pathExists(manifest.tempSubtitlePath)) {
          await moveFileReplacingDestination(manifest.tempSubtitlePath, manifest.finalSubtitlePath)
        }

        await updateEpisodePath(manifest.originalWebmPath, manifest.finalMp4Path)
      } else {
        await restoreMovedMigrationInput(manifest)
      }

      await removeCacheJobDirectory(migrationTempDirectory, { allowActive: true })
    } catch (error) {
      console.warn(
        `[Warn] [Migration] Could not recover stale migration work directory - ${migrationTempDirectory} - ${errorMessage(error)}`
      )
    } finally {
      releaseCacheJobDirectory()
    }
  }
}

function episodeWebmRows() {
  return getDb()
    .query<EpisodeWebmPathRow>(
      "SELECT file_path FROM episodes WHERE lower(file_path) LIKE '%.webm' ORDER BY file_path ASC"
    )
    .all()
}

function mp4PathForWebmPath(webmPath: string) {
  const parsed = path.parse(webmPath)
  return path.join(parsed.dir, `${parsed.name}.mp4`)
}

async function reconcileDatabaseWebmEpisodePaths(shutdownState: MigrationShutdownState) {
  const rows = episodeWebmRows()

  if (rows.length === 0) {
    return
  }

  console.log(
    `[Info] [Migration] Checking ${rows.length} database episode path(s) that still reference old WebM files`
  )

  for (const row of rows) {
    stopAfterActiveMigrationFile(shutdownState)

    const webmPath = row.file_path
    const mp4Path = mp4PathForWebmPath(webmPath)

    switch (true) {
      case await pathExists(webmPath):
        await migrateWebmFile(webmPath)
        break

      case await pathExists(mp4Path):
        await updateEpisodePath(webmPath, mp4Path)
        console.log(
          `[Info] [Migration] Repaired database episode path for already migrated MP4 - ${fileName(mp4Path)}`
        )
        break

      default:
        console.warn(
          `[Warn] [Migration] Database still references an old WebM file, but neither the WebM nor matching MP4 exists - ${webmPath}`
        )
    }

    stopAfterActiveMigrationFile(shutdownState)
  }
}

async function migrateWebmFile(webmPath: string) {
  const config = getServerConfig()

  const parsed = path.parse(webmPath)
  const mp4Path = path.join(parsed.dir, `${parsed.name}.mp4`)
  const finalSubtitlePath = subtitleSidecarPathForMediaFile(mp4Path)
  const migrationTempDirectory = await createMigrationTempDirectory()
  const tempInputPath = path.join(migrationTempDirectory, parsed.base)
  const tempMp4Path = path.join(migrationTempDirectory, `${parsed.name}.mp4`)
  const tempSubtitlePath = subtitleSidecarPathForMediaFile(tempMp4Path)
  const manifest: MigrationWorkManifest = {
    originalWebmPath: webmPath,
    finalMp4Path: mp4Path,
    finalSubtitlePath,
    tempInputPath,
    tempMp4Path,
    tempSubtitlePath,
  }

  const releaseCacheJobDirectory = registerActiveCacheJobDirectory(migrationTempDirectory)
  let migrationCompleted = false
  let keepWorkDirectoryForRecovery = false

  try {
    await rm(tempInputPath, { force: true })
    await rm(tempMp4Path, { force: true })
    await rm(tempSubtitlePath, { force: true })
    await writeMigrationManifest(migrationTempDirectory, manifest)

    await moveFileReplacingDestination(webmPath, tempInputPath)

    const probe = (await ffprobe(tempInputPath)) as ProbeResult
    const subtitleStream = firstConvertibleSubtitleStream(probe)
    const hasSubtitleOutput = Boolean(subtitleStream && Number.isInteger(subtitleStream.index))
    const convertsVideo = migrationConvertsVideo(probe)
    const acceleratorLabel = convertsVideo ? ` using ${config.transcodeAccel}` : ""

    console.log(
      `[Info] [Migration] ${migrationModeLabel(probe)} old WebM library file to MP4${acceleratorLabel} - ${fileName(webmPath)}`
    )

    if (hasSubtitleOutput) {
      await mkdir(path.dirname(tempSubtitlePath), { recursive: true })
    }

    await runFfmpeg(
      mp4MigrationArgs({
        inputPath: tempInputPath,
        outputPath: tempMp4Path,
        subtitleOutputPath: hasSubtitleOutput ? tempSubtitlePath : undefined,
        subtitleStream,
        probe,
      }),
      {
        priorityRole: convertsVideo ? "file-encoding" : undefined,
        protectFromParentSignals: true,
      }
    )
    await assertFileExists(tempMp4Path, "MP4 migration output")

    if (hasSubtitleOutput) {
      await assertFileExists(tempSubtitlePath, "WebVTT subtitle sidecar")
    }

    await moveFileReplacingDestination(tempMp4Path, mp4Path)

    if (hasSubtitleOutput) {
      await moveFileReplacingDestination(tempSubtitlePath, finalSubtitlePath)
    } else {
      await rm(finalSubtitlePath, { force: true })
    }

    await updateEpisodePath(webmPath, mp4Path)
    migrationCompleted = true
    console.log(`[Info] [Migration] Migrated WebM library file to MP4 - ${fileName(mp4Path)}`)
  } catch (error) {
    if (!migrationCompleted) {
      await restoreMovedMigrationInput(manifest).catch((restoreError) => {
        keepWorkDirectoryForRecovery = true
        console.error(
          `[Error] [Migration] Could not restore WebM source after failed migration - ${webmPath} - ${errorMessage(restoreError)}`
        )
      })
    }

    throw error
  } finally {
    releaseCacheJobDirectory()

    if (!keepWorkDirectoryForRecovery) {
      await removeCacheJobDirectory(migrationTempDirectory, { allowActive: true }).catch(() =>
        rm(migrationTempDirectory, { recursive: true, force: true }).catch(() => undefined)
      )
    }
  }
}

export async function runStartupFileMigrations() {
  const config = getServerConfig()

  if (!getAppStateBoolean(migrationStateKey, true)) {
    return
  }

  if (!config.importEnabled || !config.mediaDir) {
    setAppStateBoolean(migrationStateKey, false)
    return
  }

  console.log(
    "[Info] [Migration] Running File Migration, the app is not useable while this is running."
  )
  console.log(
    "[Info] [Migration] The migration can take a couple of minutes, depending on how many files you have and how strong your Hardware is."
  )
  console.log(
    "[Info] [Migration] This is mandatory to comply with V5 and can't be skipped."
  )

  const outputStat = await stat(config.mediaDir).catch(() => null)

  if (!outputStat?.isDirectory()) {
    setAppStateBoolean(migrationStateKey, false)
    return
  }

  await recoverStaleMigrationWorkDirectories()

  const staleOutputTempFiles = await removeStaleMigrationOutputTempFiles(config.mediaDir)

  if (staleOutputTempFiles > 0) {
    console.log(
      `[Info] [Migration] Removed ${staleOutputTempFiles} stale migration temp file(s) from the output directory.`
    )
  }

  const shutdown = installMigrationShutdownHandlers()

  try {
    for await (const webmPath of walkWebmFiles(config.mediaDir)) {
      stopAfterActiveMigrationFile(shutdown.state)

      try {
        await migrateWebmFile(webmPath)
      } catch (error) {
        console.error(
          `[Error] [Migration] WebM to MP4 migration failed - ${webmPath} - ${errorMessage(error)}`
        )
        throw error
      }

      stopAfterActiveMigrationFile(shutdown.state)
    }

    await reconcileDatabaseWebmEpisodePaths(shutdown.state)
  } finally {
    shutdown.uninstall()
  }

  if (!(await hasWebmFiles(config.mediaDir)) && episodeWebmRows().length === 0) {
    setAppStateBoolean(migrationStateKey, false)
    console.log("[Info] [Migration] File migration completed. No old WebM files remain in the output directory.")
  }
}
