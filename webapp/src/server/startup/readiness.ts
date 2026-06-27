type StartupReadinessStatus = {
  ready: boolean
  failed: boolean
  phase: string
  message: string | null
  estimatedWaitSeconds: number | null
  estimatedWaitText: string | null
  updatedAt: string
}

type StartupReadinessGlobal = typeof globalThis & {
  __yamibunkoStartupReadiness?: StartupReadinessStatus
}

const startingMessage = "Server is starting up, please check back later"

function nowIso() {
  return new Date().toISOString()
}

function formatEtaText(seconds: number | null | undefined) {
  if (!Number.isFinite(seconds ?? Number.NaN) || (seconds ?? 0) < 0) {
    return null
  }

  const totalMinutes = Math.max(1, Math.ceil((seconds ?? 0) / 60))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  const paddedHours = String(hours).padStart(2, "0")
  const paddedMinutes = String(minutes).padStart(2, "0")

  return `This might take a while, est. ${paddedHours}:${paddedMinutes} left`
}

function defaultStatus(): StartupReadinessStatus {
  return {
    ready: false,
    failed: false,
    phase: "starting",
    message: startingMessage,
    estimatedWaitSeconds: null,
    estimatedWaitText: null,
    updatedAt: nowIso(),
  }
}

function getStore() {
  const readinessGlobal = globalThis as StartupReadinessGlobal
  readinessGlobal.__yamibunkoStartupReadiness ??= defaultStatus()

  return readinessGlobal.__yamibunkoStartupReadiness
}

function updateStore(update: Partial<StartupReadinessStatus>) {
  const readinessGlobal = globalThis as StartupReadinessGlobal
  const current = getStore()
  readinessGlobal.__yamibunkoStartupReadiness = {
    ...current,
    ...update,
    updatedAt: nowIso(),
  }

  return readinessGlobal.__yamibunkoStartupReadiness
}

export type { StartupReadinessStatus }

export function getServerStartupStatus(): StartupReadinessStatus {
  return { ...getStore() }
}

export function markServerStartupStarted(phase = "starting") {
  updateStore({
    ready: false,
    failed: false,
    phase,
    message: startingMessage,
    estimatedWaitSeconds: null,
    estimatedWaitText: null,
  })
}

export function setServerStartupPhase(phase: string) {
  updateStore({ phase })
}

export function setServerStartupEstimate(seconds: number | null) {
  updateStore({
    estimatedWaitSeconds:
      Number.isFinite(seconds ?? Number.NaN) && (seconds ?? 0) >= 0
        ? seconds ?? null
        : null,
    estimatedWaitText: formatEtaText(seconds),
  })
}

export function clearServerStartupEstimate() {
  setServerStartupEstimate(null)
}

export function markServerStartupReady() {
  updateStore({
    ready: true,
    failed: false,
    phase: "ready",
    message: null,
    estimatedWaitSeconds: null,
    estimatedWaitText: null,
  })
}

export function markServerStartupFailed() {
  updateStore({
    ready: false,
    failed: true,
    phase: "failed",
    message: "Server startup failed. Check the server console for details.",
    estimatedWaitSeconds: null,
    estimatedWaitText: null,
  })
}
