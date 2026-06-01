import chokidar, { type FSWatcher } from "chokidar"
import PQueue from "p-queue"
import { readdir } from "node:fs/promises"
import path from "node:path"

import { listEpisodeFilePaths } from "@/server/db/library"
import { getServerConfigResult } from "@/server/config"
import { serverLog } from "@/server/logger"
import { isMediaFile, pathExists } from "@/server/media/mediaFiles"
import { processInputFile } from "@/server/media/processInputFile"
import {
  removeLibraryFile,
  syncLibraryFile,
} from "@/server/media/syncLibraryFile"

type WorkerRuntime = {
  queue: PQueue
  watchers: FSWatcher[]
  stop: () => Promise<void>
}

type WorkKind = "input" | "library-sync" | "library-delete"
type WorkTrigger = "startup-scan" | "scheduled-scan" | "watcher-add" | "watcher-unlink"
type WorkerGlobalState = typeof globalThis & {
  __yamibunkoWorkerRuntime?: WorkerRuntime
  __yamibunkoSignalHandlersRegistered?: boolean
}

const scanIntervalMs = 5 * 60 * 1000

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
    serverLog.warn("Workers", "Background watcher not started.", {
      issues: configResult.issues,
    })
    return undefined
  }

  const config = configResult.config
  const queue = new PQueue({
    concurrency: 1,
  })
  const queuedWork = new Set<string>()
  let shuttingDown = false
  let scanning = false

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

  serverLog.info("Workers", "Started background file watchers.", {
    inputDir: config.inputDir,
    mediaDir: config.mediaDir,
    scanIntervalMs,
  })

  function enqueue(kind: WorkKind, filePath: string, trigger: WorkTrigger) {
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
    serverLog.info("Workers", "Queued file work.", {
      kind,
      trigger,
      filePath: resolvedPath,
      queueSize: queue.size,
      pending: queue.pending,
    })

    queue
      .add(async () => {
        try {
          serverLog.info("Workers", "Started file work.", {
            kind,
            trigger,
            filePath: resolvedPath,
          })

          let result: unknown

          if (kind === "input") {
            result = await processInputFile(resolvedPath)
          } else if (kind === "library-sync") {
            result = await syncLibraryFile(resolvedPath)
          } else {
            result = await removeLibraryFile(resolvedPath)
          }

          serverLog.info("Workers", "Completed file work.", {
            kind,
            trigger,
            filePath: resolvedPath,
            result,
          })
        } finally {
          queuedWork.delete(key)
        }
      })
      .catch((error: unknown) => {
        queuedWork.delete(key)
        serverLog.error("Workers", "Background file processing failed.", {
          kind,
          filePath: resolvedPath,
          error,
        })
      })
  }

  async function scanInputDirectory(trigger: WorkTrigger) {
    if (shuttingDown || scanning) {
      return
    }

    scanning = true
    serverLog.info("Workers", "Scanning input folder.", {
      trigger,
      directory: config.inputDir,
    })

    try {
      const files = await walkFiles(config.inputDir)
      const mediaFiles = files.filter(isMediaFile)

      serverLog.info("Workers", "Input folder scan completed.", {
        trigger,
        files: files.length,
        mediaFiles: mediaFiles.length,
      })

      for (const filePath of mediaFiles) {
        enqueue("input", filePath, trigger)
      }
    } catch (error) {
      serverLog.error("Workers", "Input folder scan failed.", { error })
    } finally {
      scanning = false
    }
  }

  async function scanLibraryDirectory(trigger: WorkTrigger) {
    if (shuttingDown || scanning) {
      return
    }

    scanning = true
    serverLog.info("Workers", "Scanning library folder.", {
      trigger,
      directory: config.mediaDir,
    })

    try {
      const files = await walkFiles(config.mediaDir)
      const mediaFiles = files.filter(isMediaFile)
      let missingDbFiles = 0

      serverLog.info("Workers", "Library folder scan found media files.", {
        trigger,
        files: files.length,
        mediaFiles: mediaFiles.length,
      })

      for (const filePath of mediaFiles) {
        enqueue("library-sync", filePath, trigger)
      }

      for (const filePath of listEpisodeFilePaths()) {
        if (!(await pathExists(filePath))) {
          missingDbFiles += 1
          enqueue("library-delete", filePath, trigger)
        }
      }

      serverLog.info("Workers", "Library folder scan completed.", {
        trigger,
        mediaFiles: mediaFiles.length,
        missingDbFiles,
      })
    } catch (error) {
      serverLog.error("Workers", "Library folder scan failed.", { error })
    } finally {
      scanning = false
    }
  }

  async function scanAllDirectories(trigger: WorkTrigger) {
    await scanInputDirectory(trigger)
    await scanLibraryDirectory(trigger)
  }

  inputWatcher.on("add", (filePath) => {
    enqueue("input", filePath, "watcher-add")
  })

  inputWatcher.on("error", (error) => {
    serverLog.error("Workers", "Input watcher failed.", { error })
  })

  libraryWatcher.on("add", (filePath) => {
    enqueue("library-sync", filePath, "watcher-add")
  })

  libraryWatcher.on("unlink", (filePath) => {
    enqueue("library-delete", filePath, "watcher-unlink")
  })

  libraryWatcher.on("error", (error) => {
    serverLog.error("Workers", "Library watcher failed.", { error })
  })

  const scanTimer = setInterval(() => {
    void scanAllDirectories("scheduled-scan")
  }, scanIntervalMs)
  scanTimer.unref?.()

  void scanAllDirectories("startup-scan")

  async function stop() {
    if (shuttingDown) {
      return
    }

    shuttingDown = true
    serverLog.info("Workers", "Stopping background workers.")
    clearInterval(scanTimer)
    await Promise.all([inputWatcher.close(), libraryWatcher.close()])
    queue.pause()
    queue.clear()
    // Let active ffmpeg/ffprobe work and its DB writes finish before the process exits.
    await queue.onPendingZero()
    serverLog.info("Workers", "Background workers stopped.")
    workerGlobal.__yamibunkoWorkerRuntime = undefined
  }

  const runtime = { queue, watchers: [inputWatcher, libraryWatcher], stop }
  workerGlobal.__yamibunkoWorkerRuntime = runtime

  if (!workerGlobal.__yamibunkoSignalHandlersRegistered) {
    workerGlobal.__yamibunkoSignalHandlersRegistered = true
    process.once("SIGINT", () => {
      serverLog.info("Workers", "Received SIGINT.")
      void workerGlobal.__yamibunkoWorkerRuntime
        ?.stop()
        .finally(() => process.exit(130))
    })
    process.once("SIGTERM", () => {
      serverLog.info("Workers", "Received SIGTERM.")
      void workerGlobal.__yamibunkoWorkerRuntime
        ?.stop()
        .finally(() => process.exit(143))
    })
  }

  return runtime
}
