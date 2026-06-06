import type {
  MediaImportProcessingItem,
  MediaImportProcessingState,
} from "@/lib/import-processing"
import { debugLog } from "@/server/utils/debugLog"
import { errorMessage } from "@/server/utils/format"

type MediaImportProcessingListener = (state: MediaImportProcessingState) => void

type MediaImportProcessingGlobal = typeof globalThis & {
  __yamibunkoMediaImportProcessingItems?: Map<string, MediaImportProcessingItem>
  __yamibunkoMediaImportProcessingListeners?: Set<MediaImportProcessingListener>
}

type RegisterMediaImportProcessingItemInput = Omit<
  MediaImportProcessingItem,
  "status" | "queuedAt" | "startedAt"
>

const mediaImportProcessingGlobal = globalThis as MediaImportProcessingGlobal
const processingItems =
  mediaImportProcessingGlobal.__yamibunkoMediaImportProcessingItems ??
  new Map<string, MediaImportProcessingItem>()
const processingListeners =
  mediaImportProcessingGlobal.__yamibunkoMediaImportProcessingListeners ??
  new Set<MediaImportProcessingListener>()

mediaImportProcessingGlobal.__yamibunkoMediaImportProcessingItems = processingItems
mediaImportProcessingGlobal.__yamibunkoMediaImportProcessingListeners =
  processingListeners

function createSnapshot(): MediaImportProcessingState {
  const items = [...processingItems.values()].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === "active" ? -1 : 1
    }

    return Date.parse(left.queuedAt) - Date.parse(right.queuedAt)
  })

  return {
    count: items.length,
    items,
    updatedAt: new Date().toISOString(),
  }
}

function emitProcessingState() {
  const snapshot = createSnapshot()

  debugLog(
    `[Debug] [ImportProcessing] State changed - ${snapshot.count} active/queued media addition(s).`
  )

  for (const listener of processingListeners) {
    try {
      listener(snapshot)
    } catch (error) {
      console.error(
        `[Error] [ImportProcessing] Listener failed - importProcessingStatus.ts - ${errorMessage(error)}`
      )
    }
  }
}

export function getMediaImportProcessingState() {
  return createSnapshot()
}

export function subscribeMediaImportProcessing(
  listener: MediaImportProcessingListener
) {
  processingListeners.add(listener)

  return () => {
    processingListeners.delete(listener)
  }
}

export function registerMediaImportProcessingItem(
  input: RegisterMediaImportProcessingItemInput
) {
  let finished = false
  const now = new Date().toISOString()

  processingItems.set(input.id, {
    ...input,
    status: "queued",
    queuedAt: now,
    startedAt: null,
  })
  emitProcessingState()

  return {
    start() {
      if (finished) {
        return
      }

      const current = processingItems.get(input.id)

      if (!current || current.status === "active") {
        return
      }

      processingItems.set(input.id, {
        ...current,
        status: "active",
        startedAt: new Date().toISOString(),
      })
      emitProcessingState()
    },
    finish() {
      if (finished) {
        return
      }

      finished = true
      processingItems.delete(input.id)
      emitProcessingState()
    },
  }
}
