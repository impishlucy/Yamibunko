import chokidar, { type FSWatcher } from "chokidar"
import { readdir } from "node:fs/promises"
import path from "node:path"

import { runFullAniListRefresh } from "@/server/anilist/sync"
import { listEpisodeFilePaths } from "@/server/db/library"
import { getServerConfigResult } from "@/server/config"
import { isMediaFile, pathExists } from "@/server/media/mediaFiles"
import { processInputFile } from "@/server/media/processInputFile"
import {
  removeLibraryFile,
  syncLibraryFile,
} from "@/server/media/syncLibraryFile"
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

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)))
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
  const queuedWork = new Set<string>()
  const activeWork = new Set<Promise<void>>()
  let shuttingDown = false
  let scanning = false
  let dailyAniListTimer: NodeJS.Timeout | undefined
  let dailyAniListSyncRunning = false

  const inputWatcher = chokidar.watch(config.inputDir, {
    ignoreInitial: true,
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

  function enqueue(kind: WorkKind, filePath: string) {
    if (shuttingDown) {
      return
    }

    const resolvedPath = path.resolve(filePath)

    if (!isMediaFile(resolvedPath)) {
      return
    }

    const key = `${kind}:${resolvedPath}`

    if (queuedWork.has(key)) {
      return
    }

    queuedWork.add(key)
    console.log(`[Info] [Workers] Queued file work - ${fileName(resolvedPath)}`)

    const work = (async () => {
      try {
        console.log(
          `[Info] [Workers] Started file work - ${fileName(resolvedPath)}`
        )

        if (kind === "input") {
          await processInputFile(resolvedPath)
        } else if (kind === "library-sync") {
          await syncLibraryFile(resolvedPath)
        } else {
          await removeLibraryFile(resolvedPath)
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
    })
  }

  async function scanInputDirectory() {
    if (shuttingDown || scanning) {
      return
    }

    scanning = true
    console.log("[Info] [Workers] Scanning input folder.")

    try {
      const files = await walkFiles(config.inputDir)
      const mediaFiles = files.filter(isMediaFile)

      console.log("[Info] [Workers] Input folder scan completed.")

      for (const filePath of mediaFiles) {
        enqueue("input", filePath)
      }
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
    enqueue("input", filePath)
  })

  inputWatcher.on("error", (error) => {
    console.error(
      `[Error] [Workers] Input watcher failed - startWorkers.ts - ${errorMessage(error)}`
    )
  })

  libraryWatcher.on("add", (filePath) => {
    enqueue("library-sync", filePath)
  })

  libraryWatcher.on("unlink", (filePath) => {
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

  void scanAllDirectories()
  scheduleDailyAniListSync()

  async function stop() {
    if (shuttingDown) {
      return
    }

    shuttingDown = true
    console.log("[Info] [Workers] Stopping background workers.")
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
    process.once("SIGINT", () => {
      console.log("[Info] [Workers] Received SIGINT.")
      void workerGlobal.__yamibunkoWorkerRuntime
        ?.stop()
        .finally(() => process.exit(130))
    })
    process.once("SIGTERM", () => {
      console.log("[Info] [Workers] Received SIGTERM.")
      void workerGlobal.__yamibunkoWorkerRuntime
        ?.stop()
        .finally(() => process.exit(143))
    })
  }

  return runtime
}
