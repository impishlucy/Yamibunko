import chokidar, { type FSWatcher } from "chokidar"
import PQueue from "p-queue"
import { readdir } from "node:fs/promises"
import path from "node:path"

import { listEpisodeFilePaths } from "@/server/db/library"
import { getServerConfigResult } from "@/server/config"
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
    console.warn("[workers] Background watcher not started.", {
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
    queue
      .add(async () => {
        try {
          if (kind === "input") {
            await processInputFile(resolvedPath)
          } else if (kind === "library-sync") {
            await syncLibraryFile(resolvedPath)
          } else {
            await removeLibraryFile(resolvedPath)
          }
        } finally {
          queuedWork.delete(key)
        }
      })
      .catch((error: unknown) => {
        queuedWork.delete(key)
        console.error("[workers] Background file processing failed.", {
          kind,
          filePath: resolvedPath,
          error,
        })
      })
  }

  async function scanInputDirectory() {
    if (shuttingDown || scanning) {
      return
    }

    scanning = true

    try {
      for (const filePath of await walkFiles(config.inputDir)) {
        enqueue("input", filePath)
      }
    } catch (error) {
      console.error("[workers] Input folder scan failed.", error)
    } finally {
      scanning = false
    }
  }

  async function scanLibraryDirectory() {
    if (shuttingDown || scanning) {
      return
    }

    scanning = true

    try {
      for (const filePath of await walkFiles(config.mediaDir)) {
        enqueue("library-sync", filePath)
      }

      for (const filePath of listEpisodeFilePaths()) {
        if (!(await pathExists(filePath))) {
          enqueue("library-delete", filePath)
        }
      }
    } catch (error) {
      console.error("[workers] Library folder scan failed.", error)
    } finally {
      scanning = false
    }
  }

  async function scanAllDirectories() {
    await scanInputDirectory()
    await scanLibraryDirectory()
  }

  inputWatcher.on("add", (filePath) => {
    enqueue("input", filePath)
  })

  inputWatcher.on("error", (error) => {
    console.error("[workers] Input watcher failed.", error)
  })

  libraryWatcher.on("add", (filePath) => {
    enqueue("library-sync", filePath)
  })

  libraryWatcher.on("unlink", (filePath) => {
    enqueue("library-delete", filePath)
  })

  libraryWatcher.on("error", (error) => {
    console.error("[workers] Library watcher failed.", error)
  })

  const scanTimer = setInterval(() => {
    void scanAllDirectories()
  }, scanIntervalMs)
  scanTimer.unref?.()

  void scanAllDirectories()

  async function stop() {
    if (shuttingDown) {
      return
    }

    shuttingDown = true
    clearInterval(scanTimer)
    await Promise.all([inputWatcher.close(), libraryWatcher.close()])
    queue.pause()
    queue.clear()
    // Let active ffmpeg/ffprobe work and its DB writes finish before the process exits.
    await queue.onPendingZero()
    workerGlobal.__yamibunkoWorkerRuntime = undefined
  }

  const runtime = { queue, watchers: [inputWatcher, libraryWatcher], stop }
  workerGlobal.__yamibunkoWorkerRuntime = runtime

  if (!workerGlobal.__yamibunkoSignalHandlersRegistered) {
    workerGlobal.__yamibunkoSignalHandlersRegistered = true
    process.once("SIGINT", () => {
      void workerGlobal.__yamibunkoWorkerRuntime
        ?.stop()
        .finally(() => process.exit(130))
    })
    process.once("SIGTERM", () => {
      void workerGlobal.__yamibunkoWorkerRuntime
        ?.stop()
        .finally(() => process.exit(143))
    })
  }

  return runtime
}
