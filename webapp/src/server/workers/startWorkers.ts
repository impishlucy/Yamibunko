import chokidar, { type FSWatcher } from "chokidar"
import { AsyncLocalStorage } from "node:async_hooks"
import { writeSync } from "node:fs"
import { readdir, rm } from "node:fs/promises"
import path from "node:path"

import {
  hasActiveAniListRefreshes,
  runFullAniListRefresh,
  waitForActiveAniListRefreshes,
} from "@/server/anilist/sync"
import { beginAniListOperationShutdown } from "@/server/anilist/transport"
import {
  checkForYamibunkoUpdate,
  getCurrentAppVersion,
} from "@/server/app/updateCheck"
import { beginStreamServerShutdown } from "@/server/bandwidth/streamBandwidth"
import { updateJob } from "@/server/db/jobs"
import { listEpisodeFilePaths } from "@/server/db/library"
import { resetAdminIgnoredAppUpdateVersions } from "@/server/db/users"
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
import {
  cancelPendingLiveTranscodes,
  registerImportTranscodeCapacity,
  type ImportTranscodeCapacityKind,
  type LiveTranscodeLease,
} from "@/server/transcode/transcodeCapacity"
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

type ImportFileActionKind =
  | DeferredInputWork["kind"]
  | QueuedInputFileMove["kind"]

type QueuedImportFileActionWork = {
  id: number
  kind: ImportFileActionKind
  label: string
  priority: number
  sequence: number
  run: () => Promise<void>
  cancel: (reason: string) => void
}
type WorkerGlobalState = typeof globalThis & {
  __yamibunkoWorkerRuntime?: WorkerRuntime
  __yamibunkoSignalHandlersRegistered?: boolean
  __yamibunkoOriginalProcessExit?: typeof process.exit
  __yamibunkoProcessExitGuardInstalled?: boolean
  __yamibunkoProcessExitAllowed?: boolean
}

type ShutdownSignal = "SIGINT" | "SIGTERM"

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

function formatShutdownActiveWorkLabel(label: string) {
  for (const kind of ["input", "library-sync", "library-delete"] as const) {
    const prefix = `${kind}:`

    if (!label.startsWith(prefix)) {
      continue
    }

    const value = label.slice(prefix.length)
    const backgroundSuffixIndex = value.indexOf(":background-")
    const filePath =
      backgroundSuffixIndex >= 0 ? value.slice(0, backgroundSuffixIndex) : value
    const suffix =
      backgroundSuffixIndex >= 0 ? value.slice(backgroundSuffixIndex + 1) : ""

    return suffix
      ? `${kind}:${fileName(filePath)}:${suffix}`
      : `${kind}:${fileName(filePath)}`
  }

  return label
}

const scanIntervalMs = 5 * 60 * 1000
const maxActiveWorkByKind: Record<WorkKind, number> = {
  input: 2,
  "library-sync": 1,
  "library-delete": 1,
}
const maxActiveImportFileActionWork = 1
const importFileActionContext = new AsyncLocalStorage<{ id: number }>()

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

function writeImmediateShutdownLine(message: string) {
  try {
    writeSync(1, `${message}\n`)
  } catch {
    console.log(message)
  }
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

  resetAdminIgnoredAppUpdateVersions(getCurrentAppVersion())

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
  const pendingImportFileActionWork: QueuedImportFileActionWork[] = []
  const activeWork = new Set<Promise<void>>()
  const activeWorkLabels = new Map<Promise<void>, string>()
  const shutdownAbortController = new AbortController()
  const activeWorkByKind: Record<WorkKind, number> = {
    input: 0,
    "library-sync": 0,
    "library-delete": 0,
  }
  let shuttingDown = false
  let stopPromise: Promise<void> | null = null
  let scanning = false
  let dailyAniListTimer: NodeJS.Timeout | undefined
  let dailyAniListSyncRunning = false
  let workStartScheduled = false
  let importFileActionStartScheduled = false
  let activeImportFileActionWork = 0
  let nextImportFileActionId = 1
  let nextImportFileActionSequence = 1

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
    activeWorkLabels.set(work, key)
    void work.then(
      () => {
        activeWork.delete(work)
        activeWorkLabels.delete(work)
        debugWorkers(`Work removed from active set - ${key}`)
      },
      () => {
        activeWork.delete(work)
        activeWorkLabels.delete(work)
        debugWorkers(`Work removed from active set - ${key}`)
      }
    )
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
      let started = false

      try {
        await yieldToEventLoop()

        if (shuttingDown) {
          debugWorkers(
            `Cancelled deferred background input work before start during shutdown - ${key} - ${deferredInfo.kind}`
          )
          return
        }

        started = true
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
        if (started) {
          processingHandle?.finish()
        }

        queuedWork.delete(key)
        scheduleQueuedWorkStart()
      }
    })

    debugWorkers(
      `Scheduled background input work - ${key} - ${deferredInfo.kind} - Planned ${deferredInfo.planned}`
    )
    trackActiveWork(work, `${key}:background-${deferredInfo.kind}`)
  }

  function getDeferredInputWorkPriority(kind: DeferredInputWork["kind"]) {
    switch (kind) {
      case "direct-move":
      case "existing-output":
        return 0
      case "audio-transcode":
        return 1
      case "container-remux":
        return 2
      case "video-transcode":
        return 3
      case "catalog-only":
        return 4
    }
  }

  function getMoveWorkPriority(kind: QueuedInputFileMove["kind"]) {
    switch (kind) {
      case "direct-import":
      case "transcode-output":
      case "library-relocation":
        return 0
    }
  }

  function formatQueuedFileMoveKind(kind: QueuedInputFileMove["kind"]) {
    switch (kind) {
      case "direct-import":
        return "direct import move"
      case "transcode-output":
        return "processed output move"
      case "library-relocation":
        return "library relocation move"
    }
  }

  function getImportFileActionCapacityKind(
    kind: ImportFileActionKind
  ): ImportTranscodeCapacityKind | null {
    switch (kind) {
      case "video-transcode":
        return "video"
      case "container-remux":
        return "remux"
      default:
        return null
    }
  }

  function sortPendingImportFileActions() {
    pendingImportFileActionWork.sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority
      }

      return left.sequence - right.sequence
    })
  }

  function startQueuedImportFileAction(item: QueuedImportFileActionWork) {
    activeImportFileActionWork += 1

    const work = new Promise<void>((resolve) => {
      setImmediate(resolve)
    }).then(async () => {
      let liveCapacityLease: LiveTranscodeLease | null = null

      try {
        await yieldToEventLoop()

        const capacityKind = getImportFileActionCapacityKind(item.kind)

        if (capacityKind) {
          liveCapacityLease = registerImportTranscodeCapacity(
            item.label,
            capacityKind
          )
        }

        console.log(
          `[Info] [Workers] Started queued import file action - ${item.label}`
        )
        await importFileActionContext.run({ id: item.id }, item.run)
        console.log(
          `[Info] [Workers] Finished queued import file action - ${item.label}`
        )
      } catch (error) {
        console.error(
          `[Error] [Workers] Queued import file action failed - startWorkers.ts - ${item.label} - ${errorMessage(error)}`
        )
      } finally {
        liveCapacityLease?.release()
        activeImportFileActionWork = Math.max(activeImportFileActionWork - 1, 0)
        scheduleImportFileActionStart()
      }
    })

    debugWorkers(
      `Started queued import file action #${item.id} - ${item.label} - Active ${activeImportFileActionWork}/${maxActiveImportFileActionWork}`
    )
    trackActiveWork(work, `import-file-action:${item.id}`)
  }

  function scheduleImportFileActionStart() {
    if (importFileActionStartScheduled) {
      return
    }

    importFileActionStartScheduled = true
    setImmediate(() => {
      importFileActionStartScheduled = false

      if (shuttingDown) {
        return
      }

      while (
        activeImportFileActionWork < maxActiveImportFileActionWork &&
        pendingImportFileActionWork.length > 0
      ) {
        sortPendingImportFileActions()
        const item = pendingImportFileActionWork.shift()

        if (!item) {
          continue
        }

        startQueuedImportFileAction(item)
      }
    })
  }

  function queueImportFileAction(input: {
    kind: ImportFileActionKind
    label: string
    priority: number
    run: () => Promise<void>
    cancel: (reason: string) => void
  }) {
    if (shuttingDown) {
      input.cancel("Skipped queued import file action because shutdown started.")
      debugWorkers(
        `Rejected import file action because shutdown is already active - ${input.label}`
      )
      return null
    }

    const id = nextImportFileActionId
    nextImportFileActionId += 1

    pendingImportFileActionWork.push({
      id,
      kind: input.kind,
      label: input.label,
      priority: input.priority,
      sequence: nextImportFileActionSequence,
      run: input.run,
      cancel: input.cancel,
    })
    nextImportFileActionSequence += 1

    console.log(
      `[Info] [Workers] Queued import file action - ${input.label} - ${pendingImportFileActionWork.length} waiting, ${activeImportFileActionWork}/${maxActiveImportFileActionWork} active`
    )
    debugWorkers(
      `Queued import file action #${id} - Kind ${input.kind}, Priority ${input.priority}, Label ${input.label}`
    )
    scheduleImportFileActionStart()

    return id
  }

  function startQueuedBackgroundInputWork(
    key: string,
    startWork: () => Promise<void>,
    deferredInfo: DeferredInputWork
  ) {
    const resolvedPath = path.resolve(deferredInfo.filePath)
    const processingHandle = deferredInfo.processing
      ? registerMediaImportProcessingItem(deferredInfo.processing)
      : null
    const label = `${deferredInfo.kind} - ${fileName(resolvedPath)}`

    queueImportFileAction({
      kind: deferredInfo.kind,
      label,
      priority: getDeferredInputWorkPriority(deferredInfo.kind),
      run: async () => {
        let started = false

        try {
          if (shuttingDown) {
            debugWorkers(
              `Cancelled queued background input work before start during shutdown - ${key} - ${deferredInfo.kind}`
            )
            return
          }

          started = true
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
          if (started) {
            processingHandle?.finish()
          }

          queuedWork.delete(key)
          scheduleQueuedWorkStart()
        }
      },
      cancel: (reason) => {
        processingHandle?.finish()
        queuedWork.delete(key)
        scheduleQueuedWorkStart()

        if (deferredInfo.processing?.id) {
          updateJob(deferredInfo.processing.id, {
            status: "skipped",
            message: reason,
            finishedAt: new Date().toISOString(),
          })
        }

        debugWorkers(
          `Cancelled queued background input work - ${key} - ${deferredInfo.kind} - ${reason}`
        )
      },
    })
  }

  const queueLibraryFileMove: QueueInputFileMove = async (startMove, move) => {
    const moveLabel = formatQueuedFileMoveKind(move.kind)

    if (importFileActionContext.getStore()) {
      console.log(
        `[Info] [Workers] Running ${moveLabel} inside active import file action - ${fileName(move.sourcePath)} -> ${fileName(move.destinationPath)}`
      )
      await startMove()
      return
    }

    if (shuttingDown) {
      throw new Error("Queued file move was cancelled because shutdown started")
    }

    return new Promise<void>((resolve, reject) => {
      queueImportFileAction({
        kind: move.kind,
        label: `${moveLabel} - ${fileName(move.sourcePath)} -> ${fileName(move.destinationPath)}`,
        priority: getMoveWorkPriority(move.kind),
        run: async () => {
          try {
            console.log(
              `[Info] [Workers] Started queued ${moveLabel} - ${fileName(move.sourcePath)} -> ${fileName(move.destinationPath)}`
            )
            await startMove()
            console.log(
              `[Info] [Workers] Completed queued ${moveLabel} - ${fileName(move.destinationPath)}`
            )
            resolve()
          } catch (error) {
            console.error(
              `[Error] [Workers] Queued ${moveLabel} failed - startWorkers.ts - ${move.sourcePath} -> ${move.destinationPath} - ${errorMessage(error)}`
            )
            reject(error)
            throw error
          }
        },
        cancel: (reason) => {
          reject(new Error(reason))
        },
      })
    })
  }

  function cancelDeferredInputWorkAfterShutdown(
    key: string,
    deferredInfo: DeferredInputWork
  ) {
    const reason = "Skipped queued import file action because shutdown started."

    queuedWork.delete(key)

    if (deferredInfo.processing?.id) {
      updateJob(deferredInfo.processing.id, {
        status: "skipped",
        message: reason,
        finishedAt: new Date().toISOString(),
      })
    }

    console.log(
      `[Info] [Workers] Cancelled queued background input work during shutdown - ${deferredInfo.kind} - ${fileName(deferredInfo.filePath)}`
    )
    debugWorkers(
      `Cancelled deferred input work registered after shutdown started - ${key} - ${deferredInfo.kind}`
    )
  }

  function startBackgroundInputWork(
    key: string,
    startWork: () => Promise<void>,
    deferredInfo: DeferredInputWork
  ) {
    if (shuttingDown) {
      cancelDeferredInputWorkAfterShutdown(key, deferredInfo)
      return
    }

    if (deferredInfo.kind === "catalog-only") {
      startImmediateBackgroundInputWork(key, startWork, deferredInfo)
      return
    }

    startQueuedBackgroundInputWork(key, startWork, deferredInfo)
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
            shutdownSignal: shutdownAbortController.signal,
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

  function enqueue(
    kind: WorkKind,
    filePath: string,
    options: { log?: boolean } = {}
  ) {
    if (shuttingDown) {
      debugWorkers(`Ignoring ${kind} work while shutting down - ${filePath}`)
      return false
    }

    const resolvedPath = path.resolve(filePath)
    debugWorkers(`Enqueue requested - Kind ${kind}, Path ${resolvedPath}`)

    if (
      kind === "input" &&
      isInsideNamedDirectory(config.inputDir, resolvedPath, failedImportsFolderNames)
    ) {
      debugWorkers(`Ignoring failed-import quarantine path - ${resolvedPath}`)
      return false
    }

    if (kind === "library-sync" && isInputImportOutputActive(resolvedPath)) {
      debugWorkers(`Ignoring library sync for active input output - ${resolvedPath}`)
      return false
    }

    if (!isMediaFile(resolvedPath)) {
      debugWorkers(`Ignoring non-media file - Kind ${kind}, Path ${resolvedPath}`)
      return false
    }

    const key = `${kind}:${resolvedPath}`

    if (queuedWork.has(key)) {
      debugWorkers(`Ignoring duplicate queued work - ${key}`)
      return false
    }

    queuedWork.add(key)
    pendingWorkStarts.push({ kind, resolvedPath, key })

    if (options.log !== false) {
      console.log(`[Info] [Workers] Queued file work - ${fileName(resolvedPath)}`)
    }

    scheduleQueuedWorkStart()
    return true
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

      let queuedInputFiles = 0

      for (const [index, filePath] of mediaFiles.entries()) {
        if (enqueue("input", filePath, { log: false })) {
          queuedInputFiles += 1
        }

        if (index % 10 === 9) {
          await yieldToEventLoop()
        }
      }

      if (queuedInputFiles > 0) {
        console.log(
          `[Info] [Workers] Queued ${queuedInputFiles} input media file(s) from scan.`
        )
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

      let queuedLibraryFiles = 0

      for (const [index, filePath] of mediaFiles.entries()) {
        if (enqueue("library-sync", filePath, { log: false })) {
          queuedLibraryFiles += 1
        }

        if (index % 10 === 9) {
          await yieldToEventLoop()
        }
      }

      if (queuedLibraryFiles > 0) {
        console.log(
          `[Info] [Workers] Queued ${queuedLibraryFiles} library media file(s) from scan.`
        )
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

  function startTrackedDirectoryScan(reason: string) {
    const work = scanAllDirectories()
    trackActiveWork(work, `directory-scan:${reason}`)
  }

  async function runDailyAniListSync(
    reason = "daily maintenance",
    includeUpdateCheck = true
  ) {
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
    }

    try {
      if (includeUpdateCheck) {
        await checkForYamibunkoUpdate(reason)
      }
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
    startTrackedDirectoryScan("interval")
  }, scanIntervalMs)
  scanTimer.unref?.()

  const startupAniListSync = runDailyAniListSync("startup", false)
  trackActiveWork(startupAniListSync, "startup-anilist-sync")

  const startupUpdateCheck = checkForYamibunkoUpdate("startup").then(
    () => undefined
  )
  trackActiveWork(startupUpdateCheck, "startup-update-check")

  debugWorkers("Starting initial input/library scans.")
  startTrackedDirectoryScan("startup")
  scheduleDailyAniListSync()

  function cancelQueuedFileWorkForShutdown() {
    const cancelled = pendingWorkStarts.splice(0)

    for (const item of cancelled) {
      queuedWork.delete(item.key)
    }

    if (cancelled.length > 0) {
      console.log(
        `[Info] [Workers] Cancelled ${cancelled.length} queued file work item(s) before shutdown.`
      )
      debugWorkers(`Cancelled ${cancelled.length} queued work item(s) before shutdown.`)
    }
  }

  function cancelQueuedImportFileActionsForShutdown() {
    const cancelled = pendingImportFileActionWork.splice(0)
    const reason = "Skipped queued import file action because shutdown started."

    for (const item of cancelled) {
      item.cancel(reason)
    }

    if (cancelled.length > 0) {
      console.log(
        `[Info] [Workers] Cancelled ${cancelled.length} queued import file action(s) before shutdown.`
      )
      debugWorkers(
        `Cancelled ${cancelled.length} queued import file action(s) before shutdown.`
      )
    }
  }

  async function waitForActiveShutdownWork() {
    for (;;) {
      const workerWork = [...activeWork]
      const hasAniListWork = hasActiveAniListRefreshes()

      if (workerWork.length === 0 && !hasAniListWork) {
        return
      }

      const formattedLabels = workerWork.map((work) =>
        formatShutdownActiveWorkLabel(activeWorkLabels.get(work) ?? "unknown")
      )
      const visibleLabels = formattedLabels.slice(0, 5)
      const hiddenLabelCount = formattedLabels.length - visibleLabels.length
      const labelSuffix = visibleLabels.length
        ? ` Active: ${visibleLabels.join("; ")}${hiddenLabelCount > 0 ? `; +${hiddenLabelCount} more` : ""}.`
        : ""

      console.log(
        `[Info] [Workers] Shutdown still waiting - ${workerWork.length} worker task(s), AniList ${hasAniListWork ? "active" : "idle"}.${labelSuffix}`
      )
      debugWorkers(
        `Waiting for active shutdown work - Workers ${workerWork.length}, AniList ${hasAniListWork ? "active" : "idle"}, Active ${formattedLabels.join("; ") || "none"}.`
      )

      await Promise.race([
        Promise.allSettled([
          ...workerWork,
          ...(hasAniListWork ? [waitForActiveAniListRefreshes()] : []),
        ]),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 15_000)
        }),
      ])
    }
  }

  async function stopInternal() {
    shuttingDown = true
    shutdownAbortController.abort()
    console.log("[Info] [Workers] Stopping background workers.")

    clearInterval(scanTimer)

    if (dailyAniListTimer) {
      clearTimeout(dailyAniListTimer)
      dailyAniListTimer = undefined
    }

    debugWorkers("Shutdown started; new work is blocked and queued work will be cancelled.")
    cancelQueuedFileWorkForShutdown()
    cancelQueuedImportFileActionsForShutdown()

    cancelPendingLiveTranscodes(
      "Server is shutting down. Live transcode request was cancelled"
    )
    beginAniListOperationShutdown(
      "AniList operation was cancelled because server shutdown started"
    )

    await beginStreamServerShutdown()
    await Promise.all([
      inputWatcher.close(),
      ...(libraryWatcher ? [libraryWatcher.close()] : []),
    ])

    await waitForActiveShutdownWork()

    console.log("[Info] [Workers] Background workers stopped.")
    workerGlobal.__yamibunkoWorkerRuntime = undefined
  }

  function stop() {
    stopPromise ??= stopInternal().catch((error) => {
      stopPromise = null
      throw error
    })

    return stopPromise
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
    let shutdownKeepAliveTimer: NodeJS.Timeout | null = null

    function keepProcessAliveForShutdown() {
      if (shutdownKeepAliveTimer) {
        return
      }

      shutdownKeepAliveTimer = setInterval(() => undefined, 1000)
    }

    function releaseShutdownKeepAlive() {
      if (!shutdownKeepAliveTimer) {
        return
      }

      clearInterval(shutdownKeepAliveTimer)
      shutdownKeepAliveTimer = null
    }

    function parseExitCode(code: string | number | null | undefined) {
      if (typeof code === "number" && Number.isFinite(code)) {
        return code
      }

      if (typeof code === "string" && code.trim()) {
        const parsed = Number.parseInt(code, 10)

        if (Number.isFinite(parsed)) {
          return parsed
        }
      }

      return undefined
    }

    function installProcessExitGuard() {
      if (workerGlobal.__yamibunkoProcessExitGuardInstalled) {
        workerGlobal.__yamibunkoProcessExitAllowed = false
        return
      }

      const originalProcessExit = process.exit.bind(process) as typeof process.exit
      workerGlobal.__yamibunkoOriginalProcessExit = originalProcessExit
      workerGlobal.__yamibunkoProcessExitAllowed = false
      workerGlobal.__yamibunkoProcessExitGuardInstalled = true

      process.exit = ((code?: string | number | null | undefined) => {
        if (!workerGlobal.__yamibunkoProcessExitAllowed) {
          const parsedExitCode = parseExitCode(code)

          if (parsedExitCode !== undefined) {
            process.exitCode = parsedExitCode
          }

          console.warn(
            `[Warn] [Workers] Delayed process.exit${code === undefined ? "" : `(${code})`} while graceful shutdown is waiting for active work.`
          )
          return undefined as never
        }

        return originalProcessExit(code)
      }) as typeof process.exit
    }

    function exitAfterShutdown(exitCode: number) {
      restoreConsoleInputMode()
      workerGlobal.__yamibunkoProcessExitAllowed = true
      process.exitCode = exitCode

      const originalProcessExit =
        workerGlobal.__yamibunkoOriginalProcessExit ?? process.exit
      const forceExit = (process as NodeJS.Process & {
        reallyExit?: (code?: number) => never
      }).reallyExit

      setImmediate(() => {
        if (typeof forceExit === "function") {
          forceExit.call(process, exitCode)
          return
        }

        originalProcessExit(exitCode)
      })
    }

    function handleProcessShutdown(signal: ShutdownSignal, signalExitCode: number) {
      if (processShutdownStarted) {
        writeImmediateShutdownLine(
          `[Warn] [Workers] Shutdown signal received (${signal}); graceful shutdown is already running. Please wait for active work to finish.`
        )
        console.warn(
          "[Warn] [Workers] Graceful shutdown is already running. Waiting for active work to finish."
        )
        return
      }

      processShutdownStarted = true
      writeImmediateShutdownLine(
        `\n[Info] [Workers] Shutdown signal received (${signal}); starting graceful shutdown now. Queued work will be cancelled and active work will finish before exit.`
      )
      process.exitCode = signalExitCode
      installProcessExitGuard()
      keepProcessAliveForShutdown()
      console.log(`[Info] [Workers] Received ${signal}.`)
      console.log(
        `[Info] [Workers] Graceful shutdown started from ${signal}; cancelling queued work and waiting for active work.`
      )

      const runtime = workerGlobal.__yamibunkoWorkerRuntime

      if (!runtime) {
        releaseShutdownKeepAlive()
        exitAfterShutdown(0)
        return
      }

      void runtime
        .stop()
        .then(() => {
          releaseShutdownKeepAlive()
          console.log("[Info] [Workers] Graceful shutdown completed. Exiting process.")
          exitAfterShutdown(0)
        })
        .catch((error) => {
          releaseShutdownKeepAlive()
          console.error(
            `[Error] [Workers] Graceful shutdown failed - startWorkers.ts - ${errorMessage(error)}`
          )
          exitAfterShutdown(signalExitCode)
        })
    }

    let consoleInputDataHandler:
      | ((chunk: Buffer | string) => void)
      | null = null
    let consoleRawModeEnabled = false
    let consoleInputResumed = false

    function restoreConsoleInputMode() {
      if (consoleInputDataHandler) {
        process.stdin.off("data", consoleInputDataHandler)
        consoleInputDataHandler = null
      }

      if (consoleRawModeEnabled) {
        consoleRawModeEnabled = false

        try {
          process.stdin.setRawMode(false)
        } catch {
        }
      }

      if (consoleInputResumed) {
        consoleInputResumed = false

        try {
          process.stdin.pause()
        } catch {
        }
      }
    }

    function canInstallInteractiveShutdownInputHandler() {
      return Boolean(
        process.stdin.isTTY &&
          typeof process.stdin.setRawMode === "function" &&
          typeof process.stdin.resume === "function" &&
          typeof process.stdin.on === "function"
      )
    }

    function installInteractiveShutdownInputHandler() {
      if (consoleInputDataHandler || !canInstallInteractiveShutdownInputHandler()) {
        return
      }

      consoleInputDataHandler = (chunk) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

        if (!data.includes(3)) {
          return
        }

        handleProcessShutdown("SIGINT", 130)
      }

      try {
        process.stdin.setRawMode(true)
        consoleRawModeEnabled = true
        process.stdin.resume()
        consoleInputResumed = true
        process.stdin.on("data", consoleInputDataHandler)
        process.once("exit", restoreConsoleInputMode)
        debugWorkers("Registered interactive Ctrl+C shutdown input handler.")
      } catch (error) {
        consoleInputDataHandler = null
        consoleRawModeEnabled = false
        debugWorkers(
          `Interactive Ctrl+C shutdown input handler unavailable - ${errorMessage(error)}`
        )
      }
    }

    function registerGracefulSignalHandler(
      signal: ShutdownSignal,
      exitCode: number
    ) {
      process.prependListener(signal, () => handleProcessShutdown(signal, exitCode))
      debugWorkers(`Registered graceful ${signal} shutdown handler.`)
    }

    registerGracefulSignalHandler("SIGINT", 130)
    registerGracefulSignalHandler("SIGTERM", 143)
    installInteractiveShutdownInputHandler()
  }

  return runtime
}
