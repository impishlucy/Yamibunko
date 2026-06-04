import { runUploadCapacityRecheckWithStreamHold } from "@/server/bandwidth/streamBandwidth"
import { startUploadCapacityMeasurement } from "@/server/bandwidth/uploadCapacity"

const uploadCapacityRecheckIntervalMs = 3 * 60 * 60 * 1000

let recheckTimer: ReturnType<typeof setTimeout> | null = null
let recheckRunning = false

async function runScheduledRecheck() {
  if (recheckRunning) {
    scheduleNextUploadCapacityRecheck()
    return
  }

  recheckRunning = true

  try {
    await runUploadCapacityRecheckWithStreamHold(() =>
      startUploadCapacityMeasurement("scheduled")
    )
  } finally {
    recheckRunning = false
    scheduleNextUploadCapacityRecheck()
  }
}

function scheduleNextUploadCapacityRecheck() {
  if (recheckTimer) {
    clearTimeout(recheckTimer)
  }

  recheckTimer = setTimeout(() => {
    recheckTimer = null
    void runScheduledRecheck()
  }, uploadCapacityRecheckIntervalMs)

  recheckTimer.unref?.()
}

export function startScheduledUploadCapacityRechecks() {
  if (recheckTimer || recheckRunning) {
    return
  }

  scheduleNextUploadCapacityRecheck()
}
