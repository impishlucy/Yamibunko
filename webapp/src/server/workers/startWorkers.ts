import chokidar, { type FSWatcher } from "chokidar"
import { AsyncLocalStorage } from "node:async_hooks"
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
import {
  beginStreamServerShutdown,
  runUploadCapacityRecheckWithStreamHold,
} from "@/server/bandwidth/streamBandwidth"
import { startUploadCapacityMeasurement } from "@/server/bandwidth/uploadCapacity"
import { updateJob } from "@/server/db/jobs"
import { listEpisodeFilePaths } from "@/server/db/library"
import { resetAdminIgnoredAppUpdateVersions } from "@/server/db/users"
import { getServerConfigResult } from "@/server/config"
import { tryRunCacheMaintenance } from "@/server/media/cacheMaintenance"
import { repairLibraryPathMismatches } from "@/server/media/libraryPathRepair"
import { isMediaFile, pathExists } from "@/server/media/mediaFiles"
import {
  isInputImportOutputActive,
  processInputFile,
  type DeferredInputProcessingInfo,
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
  acquireImportTranscodeCapacity,
  type ImportTranscodeCapacityKind,
  type LiveTranscodeLease,
} from "@/server/transcode/transcodeCapacity"
import { errorMessage, fileName } from "@/server/utils/format"
import { debugLog } from "@/server/utils/debugLog"

type WorkerRuntime = {
  activeWork: Set<Promise<void>>
  watchers: FSWatcher[]
  startupChecksReady: Promise<void>
  startImportProcessing: () => void
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
  const importActionPrefix = "import-file-action:"

  if (label.startsWith(importActionPrefix)) {
    return label.slice(importActionPrefix.length)
  }

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

function formatImportFileActionKind(kind: ImportFileActionKind) {
  switch (kind) {
    case "video-transcode":
      return "video transcode"
    case "audio-transcode":
      return "audio transcode"
    case "container-remux":
      return "MP4 remux"
    case "direct-move":
    case "direct-import":
      return "direct import move"
    case "existing-output":
      return "existing output finalization"
    case "catalog-only":
      return "database cataloging"
    case "transcode-output":
      return "processed output move"
    case "library-relocation":
      return "library relocation"
  }
}

function formatQueuedImportFileActionLabel(item: QueuedImportFileActionWork) {
  return `${formatImportFileActionKind(item.kind)} - ${item.label}`
}

function formatProcessingInfoLabel(processing: DeferredInputProcessingInfo) {
  const season = processing.displaySeasonLabel ?? `Season ${processing.seasonNumber}`
  const episode = processing.displayEpisodeLabel ?? `Episode ${processing.episodeNumber}`

  return `${processing.animeTitle} - ${season}, ${episode} - ${processing.fileName}`
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

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

function normalizeFilePathKey(filePath: string) {
  const resolvedPath = path.resolve(filePath)

  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath
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
  let scanTimer: NodeJS.Timeout | undefined
  let dailyAniListSyncRunning = false
  let workStartScheduled = false
  let importFileActionStartScheduled = false
  let activeImportFileActionWork = 0
  let nextImportFileActionId = 1
  let nextImportFileActionSequence = 1
  let importProcessingStarted = false
  let importWorkBlockReason: string | null = "startup checks"
  let startupChecksResolve: () => void = () => undefined
  const startupChecksReady = new Promise<void>((resolve) => {
    startupChecksResolve = resolve
  })

  const runtimeWatchers: FSWatcher[] = []
  let inputWatcher: FSWatcher | null = null
  let libraryWatcher: FSWatcher | null = null
  let watchersStarted = false

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

  function blockImportWork(reason: string) {
    importWorkBlockReason = reason
    debugWorkers(`Import work blocked - ${reason}`)
  }

  function unblockImportWork(reason: string) {
    if (!importWorkBlockReason) {
      return
    }

    debugWorkers(`Import work unblocked - ${reason}; previous block was ${importWorkBlockReason}`)
    importWorkBlockReason = null
    scheduleQueuedWorkStart()
    scheduleImportFileActionStart()
  }

  function importWorkIsBlocked() {
    return Boolean(importWorkBlockReason)
  }

  function hasActiveImportWork() {
    return activeWorkByKind.input > 0 || activeImportFileActionWork > 0
  }

  async function waitForActiveImportWorkToFinish(reason: string) {
    let logged = false

    while (hasActiveImportWork()) {
      if (!logged) {
        logged = true
        console.log(
          `[Info] [Workers] Waiting for active import work to finish before ${reason}.`
        )
      }

      await sleep(250)
      await yieldToEventLoop()
    }
  }

  function hasQueuedOrActiveWorkForKinds(kinds: Set<WorkKind>) {
    if ([...kinds].some((kind) => activeWorkByKind[kind] > 0)) {
      return true
    }

    return pendingWorkStarts.some(
      (item) => kinds.has(item.kind) && queuedWork.has(item.key)
    )
  }

  async function waitForQueuedWorkKindsToFinish(
    kinds: WorkKind[],
    reason: string
  ) {
    const kindSet = new Set(kinds)
    let logged = false

    while (hasQueuedOrActiveWorkForKinds(kindSet)) {
      if (!logged) {
        logged = true
        console.log(
          `[Info] [Workers] Waiting for ${kinds.join("/")} work to finish before ${reason}.`
        )
      }

      scheduleQueuedWorkStart()
      await sleep(250)
      await yieldToEventLoop()
    }
  }

  async function waitForDirectoryScanToFinish(reason: string) {
    let logged = false

    while (scanning) {
      if (!logged) {
        logged = true
        console.log(
          `[Info] [Workers] Waiting for active directory scan to finish before ${reason}.`
        )
      }

      await sleep(250)
      await yieldToEventLoop()
    }
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
          `[Info] [File Import] Running ${formatImportFileActionKind(deferredInfo.kind)} - ${fileName(resolvedPath)}`
        )
        await startWork()
        console.log(
          `[Info] [File Import] Finished ${formatImportFileActionKind(deferredInfo.kind)} - ${fileName(resolvedPath)}`
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
          liveCapacityLease = await acquireImportTranscodeCapacity(
            item.label,
            capacityKind,
            shutdownAbortController.signal
          )
        }

        console.log(
          `[Info] [File Import] Running ${formatQueuedImportFileActionLabel(item)}`
        )
        await importFileActionContext.run({ id: item.id }, item.run)
        console.log(
          `[Info] [File Import] Finished ${formatQueuedImportFileActionLabel(item)}`
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
    trackActiveWork(work, `import-file-action:${formatQueuedImportFileActionLabel(item)}`)
  }

  function scheduleImportFileActionStart() {
    if (importFileActionStartScheduled) {
      return
    }

    importFileActionStartScheduled = true
    setImmediate(() => {
      importFileActionStartScheduled = false

      if (shuttingDown || importWorkIsBlocked()) {
        return
      }

      while (
        !importWorkIsBlocked() &&
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
    const label = deferredInfo.processing
      ? formatProcessingInfoLabel(deferredInfo.processing)
      : fileName(resolvedPath)

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
          await startWork()
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
      debugWorkers(
        `Running ${moveLabel} inside active import file action - ${move.sourcePath} -> ${move.destinationPath}`
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
        label: `${fileName(move.sourcePath)} -> ${fileName(move.destinationPath)}`,
        priority: getMoveWorkPriority(move.kind),
        run: async () => {
          try {
            await startMove()
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

    if (deferredInfo.kind === "catalog-only" && !importWorkIsBlocked()) {
      startImmediateBackgroundInputWork(key, startWork, deferredInfo)
      return
    }

    startQueuedBackgroundInputWork(key, startWork, deferredInfo)
  }

  function canStartWork(kind: WorkKind) {
    if (kind === "input" && importWorkIsBlocked()) {
      return false
    }

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
      debugWorkers(`Queued new file work - ${kind} - ${resolvedPath}`)
    }

    scheduleQueuedWorkStart()
    return true
  }

  async function scanInputDirectory() {
    if (shuttingDown || scanning) {
      return
    }

    scanning = true

    try {
      const files = await walkFiles(config.inputDir, {
        ignoredDirectoryNames: failedImportsFolderNames,
      })
      const mediaFiles = files.filter(isMediaFile)

      debugWorkers(
        `Input folder scan found ${files.length} files, ${mediaFiles.length} media files.`
      )

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
          `[Info] [File Import] Found ${queuedInputFiles} input media file(s) to inspect from scan.`
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

    try {
      const files = await walkFiles(config.mediaDir)
      const mediaFiles = files.filter(isMediaFile)
      const knownLibraryPaths = new Set(
        listEpisodeFilePaths().map((filePath) => normalizeFilePathKey(filePath))
      )

      debugWorkers(
        `Library folder scan found ${files.length} files, ${mediaFiles.length} media files.`
      )

      let queuedLibraryFiles = 0
      let knownLibraryFiles = 0

      for (const [index, filePath] of mediaFiles.entries()) {
        if (knownLibraryPaths.has(normalizeFilePathKey(filePath))) {
          knownLibraryFiles += 1
        } else if (enqueue("library-sync", filePath, { log: false })) {
          queuedLibraryFiles += 1
        }

        if (index % 10 === 9) {
          await yieldToEventLoop()
        }
      }

      debugWorkers(
        `Library folder scan skipped ${knownLibraryFiles} already indexed media file(s).`
      )

      if (queuedLibraryFiles > 0) {
        console.log(
          `[Info] [File Import] Found ${queuedLibraryFiles} unknown library media file(s) to sync from scan.`
        )
      }

      await scanKnownDeletedFiles()

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
    if (reason === "interval" && dailyAniListSyncRunning) {
      debugWorkers("Skipping interval directory scan while daily maintenance is running.")
      return
    }

    const work = scanAllDirectories()
    trackActiveWork(work, `directory-scan:${reason}`)
  }

  async function runLibraryPathRepairForMaintenance(label: string) {
    if (!config.importEnabled) {
      return null
    }

    console.log(`[Info] [Workers] Starting ${label} library path repair.`)

    try {
      const result = await repairLibraryPathMismatches()
      console.log(
        `[Info] [Workers] ${label} library path repair completed - Scanned: ${result.scanned}, Repaired: ${result.repaired}, Missing: ${result.missing}, Skipped: ${result.skipped}.`
      )
      return result
    } catch (error) {
      console.error(
        `[Error] [Workers] ${label} library path repair failed - startWorkers.ts - ${errorMessage(error)}`
      )
      return null
    }
  }

  function queueRepairedLibrarySyncPaths(paths: string[], label: string) {
    const uniquePaths = [...new Set(paths.map((filePath) => path.resolve(filePath)))]
    let queued = 0

    for (const filePath of uniquePaths) {
      if (enqueue("library-sync", filePath, { log: false })) {
        queued += 1
      }
    }

    if (queued > 0) {
      console.log(
        `[Info] [Workers] Queued ${queued} repaired library media file(s) for ${label} resync.`
      )
    }
  }

  async function runAniListRefreshForMaintenance(label: string) {
    console.log(`[Info] [Workers] Starting ${label} AniList sync.`)

    try {
      await runFullAniListRefresh()
      console.log(`[Info] [Workers] ${label} AniList sync completed.`)
    } catch (error) {
      console.error(
        `[Error] [Workers] ${label} AniList sync failed - startWorkers.ts - ${errorMessage(error)}`
      )
    }
  }

  async function runStartupChecks() {
    blockImportWork("startup checks")
    console.log(
      "[Info] [Workers] Starting startup checks for database, library files, and AniList."
    )

    try {
      const repairResult = await runLibraryPathRepairForMaintenance("startup")
      await runAniListRefreshForMaintenance("startup")
      queueRepairedLibrarySyncPaths(repairResult?.repairedPaths ?? [], "startup repair")
      await scanKnownDeletedFiles()
      await waitForQueuedWorkKindsToFinish(
        ["library-delete"],
        "startup checks"
      )
      await checkForYamibunkoUpdate("startup")
    } finally {
      await tryRunCacheMaintenance()
      console.log("[Info] [Workers] Startup checks completed.")
      startupChecksResolve()
    }
  }

  async function runDailyMaintenanceChecks() {
    await waitForActiveImportWorkToFinish("daily checks")
    const repairResult = await runLibraryPathRepairForMaintenance("daily")
    await runAniListRefreshForMaintenance("daily")
    queueRepairedLibrarySyncPaths(repairResult?.repairedPaths ?? [], "daily repair")
    await waitForDirectoryScanToFinish("daily checks")
    await scanKnownDeletedFiles()
    await waitForQueuedWorkKindsToFinish(
      ["library-delete"],
      "daily checks"
    )
    await checkForYamibunkoUpdate("daily maintenance")
    await tryRunCacheMaintenance()
  }

  async function runDailyAniListSync() {
    if (shuttingDown || dailyAniListSyncRunning) {
      return
    }

    dailyAniListSyncRunning = true
    blockImportWork("daily maintenance")
    console.log(
      "[Info] [Workers] Starting daily maintenance; new import jobs are paused."
    )

    try {
      await runUploadCapacityRecheckWithStreamHold(
        () => startUploadCapacityMeasurement("scheduled"),
        {
          initialCloseModes: ["transcode"],
          beforeMeasurement: runDailyMaintenanceChecks,
        }
      )
    } catch (error) {
      console.error(
        `[Error] [Workers] Daily maintenance failed - startWorkers.ts - ${errorMessage(error)}`
      )
    } finally {
      dailyAniListSyncRunning = false
      unblockImportWork("daily maintenance completed")
      console.log(
        "[Info] [Workers] Daily maintenance completed; import jobs may resume."
      )
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

  function startFileWatchers() {
    if (watchersStarted || shuttingDown) {
      return
    }

    watchersStarted = true
    inputWatcher = chokidar.watch(config.inputDir, {
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
    runtimeWatchers.push(inputWatcher)

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

    if (config.importEnabled) {
      libraryWatcher = chokidar.watch(config.mediaDir, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 3000,
          pollInterval: 1000,
        },
      })
      runtimeWatchers.push(libraryWatcher)

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
    }

    console.log(
      config.importEnabled
        ? "[Info] [File Import] Watching input and library folders."
        : "[Info] [File Import] Watching input folder with import processing disabled."
    )
  }

  function startImportProcessing() {
    if (importProcessingStarted || shuttingDown) {
      return
    }

    importProcessingStarted = true
    startFileWatchers()
    unblockImportWork("startup checks and startup bandwidth test completed")

    scanTimer = setInterval(() => {
      startTrackedDirectoryScan("interval")
    }, scanIntervalMs)
    scanTimer.unref?.()

    debugWorkers("Starting non-blocking initial directory scan after startup checks.")
    const startupScan = (async () => {
      await scanInputDirectory()

      if (config.importEnabled) {
        await scanLibraryDirectory()
      }
    })()
    trackActiveWork(startupScan, "directory-scan:startup")

    scheduleDailyAniListSync()
  }

  const startupChecks = runStartupChecks().catch((error) => {
    console.error(
      `[Error] [Workers] Startup checks failed - startWorkers.ts - ${errorMessage(error)}`
    )
  })
  trackActiveWork(startupChecks, "startup-checks")

  function cancelQueuedFileWorkForShutdown() {
    const cancelled = pendingWorkStarts.splice(0)

    for (const item of cancelled) {
      queuedWork.delete(item.key)
    }

    if (cancelled.length > 0) {
      debugWorkers(`Cancelled ${cancelled.length} queued work item(s) before shutdown.`)
    }

    return cancelled.length
  }

  function cancelQueuedImportFileActionsForShutdown() {
    const cancelled = pendingImportFileActionWork.splice(0)
    const reason = "Skipped queued import file action because shutdown started."

    for (const item of cancelled) {
      item.cancel(reason)
    }

    if (cancelled.length > 0) {
      debugWorkers(
        `Cancelled ${cancelled.length} queued import file action(s) before shutdown.`
      )
    }

    return cancelled.length
  }

  function getActiveShutdownWorkSummary() {
    const workerWork = [...activeWork]
    const hasAniListWork = hasActiveAniListRefreshes()
    const formattedLabels = workerWork.map((work) =>
      formatShutdownActiveWorkLabel(activeWorkLabels.get(work) ?? "unknown")
    )
    const visibleLabels = formattedLabels.slice(0, 5)
    const hiddenLabelCount = formattedLabels.length - visibleLabels.length

    return {
      workerWork,
      hasAniListWork,
      formattedLabels,
      activeLabel: visibleLabels.length
        ? `${visibleLabels.join("; ")}${hiddenLabelCount > 0 ? `; +${hiddenLabelCount} more` : ""}`
        : "none",
    }
  }

  async function waitForActiveShutdownWork() {
    let loggedWaitSummary = false

    for (;;) {
      const { workerWork, hasAniListWork, formattedLabels, activeLabel } =
        getActiveShutdownWorkSummary()

      if (workerWork.length === 0 && !hasAniListWork) {
        return
      }

      if (!loggedWaitSummary) {
        console.log(
          `[Info] [Shutdown] Waiting for active work to finish - ${workerWork.length} worker task(s), AniList ${hasAniListWork ? "active" : "idle"}. Active: ${activeLabel}.`
        )
        debugWorkers(
          `Waiting for active shutdown work - Workers ${workerWork.length}, AniList ${hasAniListWork ? "active" : "idle"}, Active ${formattedLabels.join("; ") || "none"}.`
        )
        loggedWaitSummary = true
      }

      await Promise.allSettled([
        ...workerWork,
        ...(hasAniListWork ? [waitForActiveAniListRefreshes()] : []),
      ])
    }
  }

  async function stopInternal() {
    shuttingDown = true
    shutdownAbortController.abort()
    console.log("[Info] [Shutdown] Stopping background workers.")

    if (scanTimer) {
      clearInterval(scanTimer)
      scanTimer = undefined
    }

    if (dailyAniListTimer) {
      clearTimeout(dailyAniListTimer)
      dailyAniListTimer = undefined
    }

    debugWorkers("Shutdown started; new work is blocked and queued work will be cancelled.")
    const cancelledFileWork = cancelQueuedFileWorkForShutdown()
    const cancelledImportActions = cancelQueuedImportFileActionsForShutdown()

    console.log(
      `[Info] [Shutdown] Cleared queued work - ${cancelledFileWork} file task(s), ${cancelledImportActions} import action(s).`
    )

    cancelPendingLiveTranscodes(
      "Server is shutting down. Live transcode request was cancelled"
    )
    beginAniListOperationShutdown(
      "AniList operation was cancelled because server shutdown started"
    )

    await beginStreamServerShutdown()
    await Promise.all(runtimeWatchers.map((watcher) => watcher.close()))

    await waitForActiveShutdownWork()

    console.log("[Info] [Shutdown] Background workers stopped.")
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
    watchers: runtimeWatchers,
    startupChecksReady,
    startImportProcessing,
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
        console.warn(
          "[Warn] [Workers] Graceful shutdown is already running. Waiting for active work to finish."
        )
        return
      }

      processShutdownStarted = true
      process.exitCode = signalExitCode
      installProcessExitGuard()
      keepProcessAliveForShutdown()
      console.log("[Info] [Shutdown] Stopping gracefully.")

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
          console.log("[Info] [Shutdown] Graceful shutdown completed. Exiting process.")
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
