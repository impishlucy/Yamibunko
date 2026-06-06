import type { LibraryChangeEvent } from "@/lib/library-events"
import { debugLog } from "@/server/utils/debugLog"
import { errorMessage } from "@/server/utils/format"

type LibraryEventListener = (event: LibraryChangeEvent) => void
type LibraryEventsGlobal = typeof globalThis & {
  __yamibunkoLibraryEventListeners?: Set<LibraryEventListener>
}

const libraryEventsGlobal = globalThis as LibraryEventsGlobal
const listeners =
  libraryEventsGlobal.__yamibunkoLibraryEventListeners ??
  new Set<LibraryEventListener>()
libraryEventsGlobal.__yamibunkoLibraryEventListeners = listeners

export function subscribeLibraryEvents(listener: LibraryEventListener) {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

export function emitLibraryChange(event: Omit<LibraryChangeEvent, "changedAt">) {
  const payload: LibraryChangeEvent = {
    ...event,
    changedAt: new Date().toISOString(),
  }

  debugLog(
    `[Debug] [LibraryEvents] Emitting ${payload.type} - Anime id ${payload.animeId}, Root id ${payload.rootAnimeId}, Slug ${payload.librarySlug}`
  )

  for (const listener of listeners) {
    try {
      listener(payload)
    } catch (error) {
      console.error(
        `[Error] [LibraryEvents] Listener failed - libraryEvents.ts - ${errorMessage(error)}`
      )
    }
  }
}
