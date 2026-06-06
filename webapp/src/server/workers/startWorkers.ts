import chokidar, { type FSWatcher } from "chokidar"
import { readdir, rm } from "node:fs/promises"
import path from "node:path"

import { runFullAniListRefresh } from "@/server/anilist/sync"
import { beginStreamServerShutdown } from "@/server/bandwidth/streamBandwidth"
import { listEpisodeFilePaths } from "@/server/db/library"
import { getServerConfigResult } from "@/server/config"
import { isMediaFile, pathExists } from "@/server/media/mediaFiles"
import {
  isInputImportOutputActive,
  processInputFile,
  type DeferredInputWork,
  type QueueInputFileMove,
  type QueuedInputFileMove,
} from "@/server/media/processInputFile"
import {
  removeLibraryFile,
  syncLibraryFile,
} from "@/server/media/syncLibraryFile"
import { registerMediaImportProcessingItem } from "@/server/media/importProcessingStatus"
import { cancelPendingLiveTranscodes } from "@/server/transcode/transcodeCapacity"
import { errorMessage, fileName } from "@/server/utils/format"
import { debugLog } from "@/server/utils/debugLog"

type WorkerRuntime = {
  activeWork: Set<Promise<void>>
  watchers: FSWatcher[]
  stop: () => Promise<void>
}

type WorkKind = "input" | "library-sync" | "library-delete"

type QueuedWorkStart = {
  kind: WorkKind
  resolvedPath: string
  key: string
}

type QueuedLibraryFileMoveWork = {
  id: number
  move: QueuedInputFileMove
  startMove: () => Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}
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
const maxActiveWorkByKind: Record<WorkKind, number> = {
  input: 2,
  "library-sync": 1,
  "library-delete": 1,
}
const maxActiveLibraryFileMoveWork = 3

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
  debugLog(`[Debug] [Workers] ${message}`)
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

const failedImportsFolderName = "_failed_imports"
const failedImportsFolderNames = new Set([failedImportsFolderName])

function isInsideNamedDirectory(
  root: string,
  targetPath: string,
  directoryNames: Set<string>
) {
  const relative = path.relative(path.resolve(root), path.resolve(targetPath))

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false
  }

  return relative.split(path.sep).some((part) => directoryNames.has(part))
}

async function walkFiles(
  directory: string,
  options: { ignoredDirectoryNames?: Set<string> } = {}
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const [index, entry] of entries.entries()) {
    if (index > 0 && index % 50 === 0) {
      await yieldToEventLoop()
    }

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
    `Worker config loaded - Input ${config.inputDir}, Library ${config.mediaDir || "<disabled>"}, Temp ${config.tempDir}, Import enabled ${config.importEnabled}`
  )
  const queuedWork = new Set<string>()
  const pendingWorkStarts: QueuedWorkStart[] = []
  const pendingLibraryFileMoveWork: QueuedLibraryFileMoveWork[] = []
  const activeWork = new Set<Promise<void>>()
  const activeWorkByKind: Record<WorkKind, number> = {
    input: 0,
    "library-sync": 0,
    "library-delete": 0,
  }
  let shuttingDown = false
  let scanning = false
  let dailyAniListTimer: NodeJS.Timeout | undefined
  let dailyAniListSyncRunning = false
  let workStartScheduled = false
  let libraryFileMoveStartScheduled = false
  let activeLibraryFileMoveWork = 0
  let nextLibraryFileMoveId = 1
  const transcodeWaitShutdown = new AbortController()

  const inputWatcher = chokidar.watch(config.inputDir, {
    ignoreInitial: true,
    ignored: (watchPath) =>
      isInsideNamedDirectory(
        config.inputDir,
        watchPath.toString(),
        failedImportsFolderNames
      ),
    awaitWriteFinish: {
      stabilityThreshold: 3000,
      pollInterval: 1000,
    },
  })
  const libraryWatcher = config.importEnabled
    ? chokidar.watch(config.mediaDir, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 3000,
          pollInterval: 1000,
        },
      })
    : null

  console.log(
    config.importEnabled
      ? "[Info] [Workers] Started background file watchers."
      : "[Info] [Workers] Started input library watcher with import processing disabled."
  )

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

  function trackActiveWork(work: Promise<void>, key: string) {
    activeWork.add(work)
    void work.finally(() => {
      activeWork.delete(work)
      debugWorkers(`Work removed from active set - ${key}`)
    })
  }

  function startImmediateBackgroundInputWork(
    key: string,
    startWork: () => Promise<void>,
    deferredInfo: DeferredInputWork
  ) {
    const resolvedPath = path.resolve(deferredInfo.filePath)
    const processingHandle = deferredInfo.processing
      ? registerMediaImportProcessingItem(deferredInfo.processing)
      : null
    const work = new Promise<void>((resolve) => {
      setImmediate(resolve)
    }).then(async () => {
      try {
        await yieldToEventLoop()
        processingHandle?.start()
        console.log(
          `[Info] [Workers] Started background input work - ${deferredInfo.kind} - ${fileName(resolvedPath)}`
        )
        await startWork()
        console.log(
          `[Info] [Workers] Completed background input work - ${deferredInfo.kind} - ${fileName(resolvedPath)}`
        )
      } catch (error) {
        console.error(
          `[Error] [Workers] Background input work failed - startWorkers.ts - ${deferredInfo.kind} - ${resolvedPath} - ${errorMessage(error)}`
        )
      } finally {
        processingHandle?.finish()
        queuedWork.delete(key)
        scheduleQueuedWorkStart()
      }
    })

    debugWorkers(
      `Started background input work - ${key} - ${deferredInfo.kind} - Planned ${deferredInfo.planned}`
    )
    trackActiveWork(work, `${key}:background-${deferredInfo.kind}`)
  }

  function formatQueuedFileMoveKind(kind: QueuedInputFileMove["kind"]) {
    switch (kind) {
      case "direct-import":
        return "direct import move"
      case "transcode-output":
        return "transcoded output move"
      case "library-relocation":
        return "library relocation move"
    }
  }

  function startQueuedLibraryFileMove(item: QueuedLibraryFileMoveWork) {
    activeLibraryFileMoveWork += 1

    const moveLabel = formatQueuedFileMoveKind(item.move.kind)
    const work = new Promise<void>((resolve) => {
      setImmediate(resolve)
    }).then(async () => {
      try {
        await yieldToEventLoop()
        console.log(
          `[Info] [Workers] Started queued ${moveLabel} - ${fileName(item.move.sourcePath)} -> ${fileName(item.move.destinationPath)}`
        )
        await item.startMove()
        console.log(
          `[Info] [Workers] Completed queued ${moveLabel} - ${fileName(item.move.destinationPath)}`
        )
        item.resolve()
      } catch (error) {
        console.error(
          `[Error] [Workers] Queued ${moveLabel} failed - startWorkers.ts - ${item.move.sourcePath} -> ${item.move.destinationPath} - ${errorMessage(error)}`
        )
        item.reject(error)
      } finally {
        activeLibraryFileMoveWork = Math.max(activeLibraryFileMoveWork - 1, 0)
        scheduleLibraryFileMoveStart()
      }
    })

    debugWorkers(
      `Started queued ${moveLabel} #${item.id} - Active ${activeLibraryFileMoveWork}/${maxActiveLibraryFileMoveWork}`
    )
    trackActiveWork(work, `library-file-move:${item.id}`)
  }

  function scheduleLibraryFileMoveStart() {
    if (libraryFileMoveStartScheduled) {
      return
    }

    libraryFileMoveStartScheduled = true
    setImmediate(() => {
      libraryFileMoveStartScheduled = false

      while (
        activeLibraryFileMoveWork < maxActiveLibraryFileMoveWork &&
        pendingLibraryFileMoveWork.length > 0
      ) {
        const item = pendingLibraryFileMoveWork.shift()

        if (!item) {
          continue
        }

        startQueuedLibraryFileMove(item)
      }

      if (
        activeLibraryFileMoveWork < maxActiveLibraryFileMoveWork &&
        pendingLibraryFileMoveWork.length > 0
      ) {
        scheduleLibraryFileMoveStart()
      }
    })
  }

  const queueLibraryFileMove: QueueInputFileMove = (startMove, move) =>
    new Promise<void>((resolve, reject) => {
      const id = nextLibraryFileMoveId
      nextLibraryFileMoveId += 1

      pendingLibraryFileMoveWork.push({
        id,
        move,
        startMove,
        resolve,
        reject,
      })

      const moveLabel = formatQueuedFileMoveKind(move.kind)
      console.log(
        `[Info] [Workers] Queued ${moveLabel} - ${fileName(move.sourcePath)} -> ${fileName(move.destinationPath)} - ${pendingLibraryFileMoveWork.length} waiting, ${activeLibraryFileMoveWork}/${maxActiveLibraryFileMoveWork} active`
      )
      debugWorkers(
        `Queued ${moveLabel} #${id} - Source ${move.sourcePath}, Destination ${move.destinationPath}`
      )
      scheduleLibraryFileMoveStart()
    })

  function startBackgroundInputWork(
    key: string,
    startWork: () => Promise<void>,
    deferredInfo: DeferredInputWork
  ) {
    startImmediateBackgroundInputWork(key, startWork, deferredInfo)
  }

  function canStartWork(kind: WorkKind) {
    return activeWorkByKind[kind] < maxActiveWorkByKind[kind]
  }

  function takeNextStartableWork() {
    for (let index = 0; index < pendingWorkStarts.length; index += 1) {
      const item = pendingWorkStarts[index]

      if (!item) {
        continue
      }

      if (!queuedWork.has(item.key)) {
        pendingWorkStarts.splice(index, 1)
        index -= 1
        continue
      }

      if (canStartWork(item.kind)) {
        return pendingWorkStarts.splice(index, 1)[0]
      }
    }

    return undefined
  }

  function hasStartableWork() {
    return pendingWorkStarts.some(
      (item) => queuedWork.has(item.key) && canStartWork(item.kind)
    )
  }

  function startFileWork(kind: WorkKind, resolvedPath: string, key: string) {
    if (shuttingDown) {
      queuedWork.delete(key)
      debugWorkers(`Skipping queued work because shutdown started - ${key}`)
      return
    }

    if (kind === "library-sync" && isInputImportOutputActive(resolvedPath)) {
      queuedWork.delete(key)
      debugWorkers(`Skipping library sync for active input output - ${resolvedPath}`)
      return
    }

    activeWorkByKind[kind] += 1
    let deferredWorkRegistered = false
    const work = (async () => {
      try {
        console.log(
          `[Info] [Workers] Started file work - ${fileName(resolvedPath)}`
        )

        if (kind === "input") {
          const result = await processInputFile(resolvedPath, {
            transcodeWaitSignal: transcodeWaitShutdown.signal,
            deferVideoTranscodes: true,
            deferAudioTranscodes: true,
            queueFileMove: queueLibraryFileMove,
            onDeferredWork: (startDeferredWork, deferredInfo) => {
              deferredWorkRegistered = true
              startBackgroundInputWork(key, startDeferredWork, deferredInfo)
            },
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
        activeWorkByKind[kind] = Math.max(activeWorkByKind[kind] - 1, 0)

        if (!deferredWorkRegistered) {
          queuedWork.delete(key)
        }

        scheduleQueuedWorkStart()
      }
    })()

    trackActiveWork(work, key)
  }

  function scheduleQueuedWorkStart() {
    if (workStartScheduled) {
      return
    }

    workStartScheduled = true
    setImmediate(() => {
      workStartScheduled = false

      if (shuttingDown) {
        const cancelled = pendingWorkStarts.splice(0)

        for (const item of cancelled) {
          queuedWork.delete(item.key)
        }

        if (cancelled.length > 0) {
          debugWorkers(`Cancelled ${cancelled.length} queued work item(s) before start.`)
        }

        return
      }

      const item = takeNextStartableWork()

      if (item && queuedWork.has(item.key)) {
        startFileWork(item.kind, item.resolvedPath, item.key)
      }

      if (hasStartableWork()) {
        scheduleQueuedWorkStart()
      }
    })
  }

  function enqueue(kind: WorkKind, filePath: string) {
    if (shuttingDown) {
      debugWorkers(`Ignoring ${kind} work while shutting down - ${filePath}`)
      return
    }

    const resolvedPath = path.resolve(filePath)
    debugWorkers(`Enqueue requested - Kind ${kind}, Path ${resolvedPath}`)

    if (
      kind === "input" &&
      isInsideNamedDirectory(config.inputDir, resolvedPath, failedImportsFolderNames)
    ) {
      debugWorkers(`Ignoring failed-import quarantine path - ${resolvedPath}`)
      return
    }

    if (kind === "library-sync" && isInputImportOutputActive(resolvedPath)) {
      debugWorkers(`Ignoring library sync for active input output - ${resolvedPath}`)
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
    pendingWorkStarts.push({ kind, resolvedPath, key })
    console.log(`[Info] [Workers] Queued file work - ${fileName(resolvedPath)}`)
    scheduleQueuedWorkStart()
  }

  async function scanInputDirectory() {
    if (shuttingDown || scanning) {
      return
    }

    scanning = true
    console.log("[Info] [Workers] Scanning input folder.")

    try {
      const files = await walkFiles(config.inputDir, {
        ignoredDirectoryNames: failedImportsFolderNames,
      })
      const mediaFiles = files.filter(isMediaFile)

      debugWorkers(
        `Input folder scan found ${files.length} files, ${mediaFiles.length} media files.`
      )
      console.log("[Info] [Workers] Input folder scan completed.")

      for (const [index, filePath] of mediaFiles.entries()) {
        enqueue("input", filePath)

        if (index % 10 === 9) {
          await yieldToEventLoop()
        }
      }

      if (config.importEnabled) {
        await pruneNonMediaOnlyDirectories(config.inputDir, config.inputDir)
      }
    } catch (error) {
      console.error(
        `[Error] [Workers] Input folder scan failed - startWorkers.ts - ${config.inputDir} - ${errorMessage(error)}`
      )
    } finally {
      scanning = false
    }
  }

  async function scanKnownDeletedFiles() {
    for (const filePath of listEpisodeFilePaths()) {
      if (!(await pathExists(filePath))) {
        enqueue("library-delete", filePath)
      }
    }
  }

  async function scanLibraryDirectory() {
    if (!config.importEnabled) {
      await scanKnownDeletedFiles()
      return
    }

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

      for (const [index, filePath] of mediaFiles.entries()) {
        enqueue("library-sync", filePath)

        if (index % 10 === 9) {
          await yieldToEventLoop()
        }
      }

      await scanKnownDeletedFiles()

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

    if (config.importEnabled) {
      await scanLibraryDirectory()
    } else {
      await scanKnownDeletedFiles()
    }
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

  inputWatcher.on("unlink", (filePath) => {
    if (!config.importEnabled) {
      debugWorkers(`Input watcher unlink event with import disabled - ${filePath}`)
      enqueue("library-delete", filePath)
    }
  })

  libraryWatcher?.on("add", (filePath) => {
    debugWorkers(`Library watcher add event - ${filePath}`)
    enqueue("library-sync", filePath)
  })

  libraryWatcher?.on("unlink", (filePath) => {
    debugWorkers(`Library watcher unlink event - ${filePath}`)
    enqueue("library-delete", filePath)
  })

  libraryWatcher?.on("error", (error) => {
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

    const cancelled = pendingWorkStarts.splice(0)
    for (const item of cancelled) {
      queuedWork.delete(item.key)
    }
    if (cancelled.length > 0) {
      debugWorkers(`Cancelled ${cancelled.length} queued work item(s) before shutdown.`)
    }

    if (pendingLibraryFileMoveWork.length > 0) {
      debugWorkers(
        `Waiting for ${pendingLibraryFileMoveWork.length} queued library file move item(s) during shutdown.`
      )
      scheduleLibraryFileMoveStart()
    }

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
    await Promise.all([
      inputWatcher.close(),
      ...(libraryWatcher ? [libraryWatcher.close()] : []),
    ])

    while (activeWork.size > 0) {
      await Promise.allSettled([...activeWork])
    }

    console.log("[Info] [Workers] Background workers stopped.")
    workerGlobal.__yamibunkoWorkerRuntime = undefined
  }

  const runtime = {
    activeWork,
    watchers: [inputWatcher, ...(libraryWatcher ? [libraryWatcher] : [])],
    stop,
  }
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
