import chokidar, { type FSWatcher } from "chokidar"
import { readdir, rm } from "node:fs/promises"
import path from "node:path"

import { runFullAniListRefresh } from "@/server/anilist/sync"
import { beginStreamServerShutdown } from "@/server/bandwidth/streamBandwidth"
import { listEpisodeFilePaths } from "@/server/db/library"
import { getServerConfigResult } from "@/server/config"
import { isMediaFile, pathExists } from "@/server/media/mediaFiles"
import { processInputFile } from "@/server/media/processInputFile"
import {
  removeLibraryFile,
  syncLibraryFile,
} from "@/server/media/syncLibraryFile"
import { cancelPendingLiveTranscodes } from "@/server/transcode/transcodeCapacity"
import { errorMessage, fileName } from "@/server/utils/format"

type WorkerRuntime = {
  activeWork: Set<Promise<void>>
  watchers: FSWatcher[]
  stop: () => Promise<void>
}

type WorkKind = "input" | "library-sync" | "library-delete"
type WorkerGlobalState = typeof globalThis & {
  __yamibunkoWorkerRuntime?: WorkerRuntime
  __yamibunkoSignalHandlersRegistered?: boolean
}


type WorkResultEpisode =
  | { animeId: number; seasonNr: number; epNr: number }
  | { animeId: number; seasonNumber: number; episodeNumber: number }

function formatWorkResultEpisode(result: WorkResultEpisode | null) {
  if (!result) {
    return "no-op"
  }

  if ("seasonNr" in result) {
    return `episode ${result.animeId}/${result.seasonNr}/${result.epNr}`
  }

  return `episode ${result.animeId}/${result.seasonNumber}/${result.episodeNumber}`
}

const scanIntervalMs = 5 * 60 * 1000

function msUntilNextDailyAniListSync() {
  const now = new Date()
  const next = new Date(now)
  next.setHours(5, 0, 0, 0)

  if (next <= now) {
    next.setDate(next.getDate() + 1)
  }

  return next.getTime() - now.getTime()
}

const workerGlobal = globalThis as WorkerGlobalState

function debugWorkers(message: string) {
  console.log(`[Debug] [Workers] ${message}`)
}

const failedImportsFolderName = "_Failed Imports"

function isInsideNamedDirectory(root: string, targetPath: string, directoryName: string) {
  const relative = path.relative(path.resolve(root), path.resolve(targetPath))

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false
  }

  return relative.split(path.sep).includes(directoryName)
}

async function walkFiles(
  directory: string,
  options: { ignoredDirectoryNames?: Set<string> } = {}
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      if (options.ignoredDirectoryNames?.has(entry.name)) {
        continue
      }

      files.push(...(await walkFiles(entryPath, options)))
      continue
    }

    if (entry.isFile()) {
      files.push(entryPath)
    }
  }

  return files
}

export function startWorkers() {
  if (workerGlobal.__yamibunkoWorkerRuntime) {
    return workerGlobal.__yamibunkoWorkerRuntime
  }

  const configResult = getServerConfigResult()

  if (!configResult.ok) {
    console.warn(
      `[Warn] [Workers] Background watcher not started - startWorkers.ts - ${configResult.issues.join("; ")}`
    )
    return undefined
  }

  const config = configResult.config
  debugWorkers(
    `Worker config loaded - Input ${config.inputDir}, Library ${config.mediaDir}, Temp ${config.tempDir}`
  )
  const queuedWork = new Set<string>()
  const activeWork = new Set<Promise<void>>()
  let shuttingDown = false
  let scanning = false
  let dailyAniListTimer: NodeJS.Timeout | undefined
  let dailyAniListSyncRunning = false
  const transcodeWaitShutdown = new AbortController()

  const inputWatcher = chokidar.watch(config.inputDir, {
    ignoreInitial: true,
    ignored: (watchPath) =>
      isInsideNamedDirectory(config.inputDir, watchPath.toString(), failedImportsFolderName),
    awaitWriteFinish: {
      stabilityThreshold: 3000,
      pollInterval: 1000,
    },
  })
  const libraryWatcher = chokidar.watch(config.mediaDir, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 3000,
      pollInterval: 1000,
    },
  })

  console.log("[Info] [Workers] Started background file watchers.")

  async function pruneNonMediaOnlyDirectories(
    directory: string,
    root: string
  ): Promise<boolean> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => null)

    if (!entries) {
      return false
    }

    let containsMedia = false

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)

      if (entry.isDirectory()) {
        containsMedia = (await pruneNonMediaOnlyDirectories(entryPath, root)) || containsMedia
        continue
      }

      if (entry.isFile() && isMediaFile(entryPath)) {
        containsMedia = true
      }
    }

    if (path.resolve(directory) !== path.resolve(root) && !containsMedia) {
      debugWorkers(`Removing input folder with only non-media leftovers - ${directory}`)
      await rm(directory, { force: true, recursive: true })
    }

    return containsMedia
  }

  function startFileWork(kind: WorkKind, resolvedPath: string, key: string) {
    const work = (async () => {
      try {
        console.log(
          `[Info] [Workers] Started file work - ${fileName(resolvedPath)}`
        )

        if (kind === "input") {
          const result = await processInputFile(resolvedPath, {
            transcodeWaitSignal: transcodeWaitShutdown.signal,
          })

          if (!result.ok) {
            throw new Error(result.message)
          }

          debugWorkers(
            `Input processing returned ok - Planned ${result.planned}, Output ${result.filePath}`
          )
        } else if (kind === "library-sync") {
          const result = await syncLibraryFile(resolvedPath)
          debugWorkers(
            `Library sync returned ${formatWorkResultEpisode(result)} - ${resolvedPath}`
          )
        } else {
          const result = await removeLibraryFile(resolvedPath)
          debugWorkers(
            `Library delete returned ${formatWorkResultEpisode(result)} - ${resolvedPath}`
          )
        }

        console.log(
          `[Info] [Workers] Completed file work - ${fileName(resolvedPath)}`
        )
      } catch (error) {
        console.error(
          `[Error] [Workers] Background file processing failed - startWorkers.ts - ${kind} - ${resolvedPath} - ${errorMessage(error)}`
        )
      } finally {
        queuedWork.delete(key)
      }
    })()

    activeWork.add(work)
    void work.finally(() => {
      activeWork.delete(work)
      debugWorkers(`Work removed from active set - ${key}`)
    })
  }

  function enqueue(kind: WorkKind, filePath: string) {
    if (shuttingDown) {
      debugWorkers(`Ignoring ${kind} work while shutting down - ${filePath}`)
      return
    }

    const resolvedPath = path.resolve(filePath)
    debugWorkers(`Enqueue requested - Kind ${kind}, Path ${resolvedPath}`)

    if (kind === "input" && isInsideNamedDirectory(config.inputDir, resolvedPath, failedImportsFolderName)) {
      debugWorkers(`Ignoring failed-import quarantine path - ${resolvedPath}`)
      return
    }

    if (!isMediaFile(resolvedPath)) {
      debugWorkers(`Ignoring non-media file - Kind ${kind}, Path ${resolvedPath}`)
      return
    }

    const key = `${kind}:${resolvedPath}`

    if (queuedWork.has(key)) {
      debugWorkers(`Ignoring duplicate queued work - ${key}`)
      return
    }

    queuedWork.add(key)
    console.log(`[Info] [Workers] Queued file work - ${fileName(resolvedPath)}`)
    startFileWork(kind, resolvedPath, key)
  }

  async function scanInputDirectory() {
    if (shuttingDown || scanning) {
      return
    }

    scanning = true
    console.log("[Info] [Workers] Scanning input folder.")

    try {
      const files = await walkFiles(config.inputDir, {
        ignoredDirectoryNames: new Set([failedImportsFolderName]),
      })
      const mediaFiles = files.filter(isMediaFile)

      debugWorkers(
        `Input folder scan found ${files.length} files, ${mediaFiles.length} media files.`
      )
      console.log("[Info] [Workers] Input folder scan completed.")

      for (const filePath of mediaFiles) {
        enqueue("input", filePath)
      }

      await pruneNonMediaOnlyDirectories(config.inputDir, config.inputDir)
    } catch (error) {
      console.error(
        `[Error] [Workers] Input folder scan failed - startWorkers.ts - ${config.inputDir} - ${errorMessage(error)}`
      )
    } finally {
      scanning = false
    }
  }

  async function scanLibraryDirectory() {
    if (shuttingDown || scanning) {
      return
    }

    scanning = true
    console.log("[Info] [Workers] Scanning library folder.")

    try {
      const files = await walkFiles(config.mediaDir)
      const mediaFiles = files.filter(isMediaFile)

      debugWorkers(
        `Library folder scan found ${files.length} files, ${mediaFiles.length} media files.`
      )
      console.log("[Info] [Workers] Library folder scan found media files.")

      for (const filePath of mediaFiles) {
        enqueue("library-sync", filePath)
      }

      for (const filePath of listEpisodeFilePaths()) {
        if (!(await pathExists(filePath))) {
          enqueue("library-delete", filePath)
        }
      }

      console.log("[Info] [Workers] Library folder scan completed.")
    } catch (error) {
      console.error(
        `[Error] [Workers] Library folder scan failed - startWorkers.ts - ${config.mediaDir} - ${errorMessage(error)}`
      )
    } finally {
      scanning = false
    }
  }

  async function scanAllDirectories() {
    await scanInputDirectory()
    await scanLibraryDirectory()
  }

  async function runDailyAniListSync() {
    if (shuttingDown || dailyAniListSyncRunning) {
      return
    }

    dailyAniListSyncRunning = true
    console.log("[Info] [Workers] Starting daily AniList sync.")

    try {
      await runFullAniListRefresh()
      console.log("[Info] [Workers] Daily AniList sync completed.")
    } catch (error) {
      console.error(
        `[Error] [Workers] Daily AniList sync failed - startWorkers.ts - ${errorMessage(error)}`
      )
    } finally {
      dailyAniListSyncRunning = false
    }
  }

  function scheduleDailyAniListSync() {
    if (shuttingDown) {
      return
    }

    dailyAniListTimer = setTimeout(() => {
      void runDailyAniListSync().finally(scheduleDailyAniListSync)
    }, msUntilNextDailyAniListSync())
    dailyAniListTimer.unref?.()
  }

  inputWatcher.on("add", (filePath) => {
    debugWorkers(`Input watcher add event - ${filePath}`)
    enqueue("input", filePath)
  })

  inputWatcher.on("error", (error) => {
    console.error(
      `[Error] [Workers] Input watcher failed - startWorkers.ts - ${errorMessage(error)}`
    )
  })

  libraryWatcher.on("add", (filePath) => {
    debugWorkers(`Library watcher add event - ${filePath}`)
    enqueue("library-sync", filePath)
  })

  libraryWatcher.on("unlink", (filePath) => {
    debugWorkers(`Library watcher unlink event - ${filePath}`)
    enqueue("library-delete", filePath)
  })

  libraryWatcher.on("error", (error) => {
    console.error(
      `[Error] [Workers] Library watcher failed - startWorkers.ts - ${errorMessage(error)}`
    )
  })

  const scanTimer = setInterval(() => {
    void scanAllDirectories()
  }, scanIntervalMs)
  scanTimer.unref?.()

  const startupAniListSync = runDailyAniListSync()
  activeWork.add(startupAniListSync)
  void startupAniListSync.finally(() => {
    activeWork.delete(startupAniListSync)
  })

  debugWorkers("Starting initial input/library scans.")
  void scanAllDirectories()
  scheduleDailyAniListSync()

  async function stop() {
    if (shuttingDown) {
      return
    }

    shuttingDown = true
    console.log("[Info] [Workers] Stopping background workers.")
    await beginStreamServerShutdown()
    cancelPendingLiveTranscodes(
      "Server is shutting down. Live transcode request was cancelled"
    )
    transcodeWaitShutdown.abort()
    debugWorkers("Cancelled pending background transcode waits.")
    clearInterval(scanTimer)
    if (dailyAniListTimer) {
      clearTimeout(dailyAniListTimer)
    }
    await Promise.all([inputWatcher.close(), libraryWatcher.close()])

    while (activeWork.size > 0) {
      await Promise.allSettled([...activeWork])
    }

    console.log("[Info] [Workers] Background workers stopped.")
    workerGlobal.__yamibunkoWorkerRuntime = undefined
  }

  const runtime = { activeWork, watchers: [inputWatcher, libraryWatcher], stop }
  workerGlobal.__yamibunkoWorkerRuntime = runtime

  if (!workerGlobal.__yamibunkoSignalHandlersRegistered) {
    workerGlobal.__yamibunkoSignalHandlersRegistered = true
    let processShutdownStarted = false

    function handleProcessShutdown(
      signal: "SIGINT" | "SIGTERM",
      exitCode: number
    ) {
      console.log(`[Info] [Workers] Received ${signal}.`)

      if (processShutdownStarted) {
        console.warn(
          `[Warn] [Workers] Shutdown already in progress. Press again only after the current worker cleanup has finished.`
        )
        return
      }

      processShutdownStarted = true
      const runtime = workerGlobal.__yamibunkoWorkerRuntime

      if (!runtime) {
        process.exit(exitCode)
        return
      }

      void runtime
        .stop()
        .then(() => process.exit(exitCode))
        .catch((error) => {
          console.error(
            `[Error] [Workers] Graceful shutdown failed - startWorkers.ts - ${errorMessage(error)}`
          )
          process.exit(exitCode)
        })
    }

    process.on("SIGINT", () => handleProcessShutdown("SIGINT", 130))
    process.on("SIGTERM", () => handleProcessShutdown("SIGTERM", 143))
  }

  return runtime
}
