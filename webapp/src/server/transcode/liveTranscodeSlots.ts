import { randomUUID } from "node:crypto"

import type { TranscodeStatus } from "@/lib/types"
import { getServerConfigResult } from "@/server/config"

export type LiveTranscodeLease = {
  id: string
  label: string
  release: () => void
}

const activeTranscodes = new Map<
  string,
  {
    label: string
    startedAt: number
  }
>()

function getConfiguredSlotCount() {
  const result = getServerConfigResult()
  return result.ok ? result.config.liveTranscodeSlots : 0
}

export function getLiveTranscodeStatus(): TranscodeStatus {
  const max = getConfiguredSlotCount()
  const active = activeTranscodes.size

  return {
    max,
    active,
    available: Math.max(max - active, 0),
  }
}

export function tryAcquireLiveTranscode(
  label: string
): LiveTranscodeLease | null {
  const status = getLiveTranscodeStatus()

  if (status.available <= 0) {
    return null
  }

  const id = randomUUID()
  let released = false
  activeTranscodes.set(id, {
    label,
    startedAt: Date.now(),
  })

  return {
    id,
    label,
    release() {
      if (released) {
        return
      }

      released = true
      activeTranscodes.delete(id)
    },
  }
}
