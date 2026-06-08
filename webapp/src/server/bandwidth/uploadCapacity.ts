type UploadCapacityState =
  | {
      status: "idle" | "running"
      measuredAt: null
      maxUploadBitsPerSecond: null
      error: null
    }
  | {
      status: "ready"
      measuredAt: string
      maxUploadBitsPerSecond: number
      error: null
    }
  | {
      status: "failed"
      measuredAt: string
      maxUploadBitsPerSecond: null
      error: string
    }

type UploadCapacityStore = {
  capacityState: UploadCapacityState
  measurementPromise: Promise<void> | null
}

const uploadMeasurementBytes = 4e7

const uploadEndpoint = "https://speed.cloudflare.com/__up"
const requestTimeoutMs = 120_000
const usableUploadCapacityFactor = 0.95
const measuredUploadEnvName = "YAMIBUNKO_MEASURED_UPLOAD_BPS"
const globalUploadCapacity = globalThis as typeof globalThis & {
  __yamibunkoUploadCapacityStore?: UploadCapacityStore
}
const uploadCapacityStore = globalUploadCapacity.__yamibunkoUploadCapacityStore ??= {
  capacityState: {
    status: "idle",
    measuredAt: null,
    maxUploadBitsPerSecond: null,
    error: null,
  },
  measurementPromise: null,
}

type UploadCapacityMeasurementReason = "startup" | "scheduled" | "manual"

function readMeasuredUploadBitsPerSecondFromEnv() {
  const rawValue = process.env[measuredUploadEnvName]

  if (!rawValue) {
    return null
  }

  const parsedValue = Number(rawValue)

  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : null
}

function createAbortSignal() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)

  timeout.unref?.()

  return { controller, timeout }
}

async function measureUpload(bytes: number) {
  const payload = new Uint8Array(bytes)
  const { controller, timeout } = createAbortSignal()
  const startedAt = performance.now()

  try {
    const response = await fetch(uploadEndpoint, {
      method: "POST",
      body: payload,
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Cloudflare upload probe failed with HTTP ${response.status}`)
    }

    const durationSeconds = (performance.now() - startedAt) / 1000

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("Cloudflare upload probe returned an invalid duration")
    }

    return (bytes * 8) / durationSeconds
  } finally {
    clearTimeout(timeout)
  }
}

async function runUploadCapacityProbe(reason: UploadCapacityMeasurementReason) {
  uploadCapacityStore.capacityState = {
    status: "running",
    measuredAt: null,
    maxUploadBitsPerSecond: null,
    error: null,
  }

  console.log(
    reason === "startup"
      ? "[Info] [Startup] Starting Bandwidth Test (Upload)."
      : "[Info] [Bandwidth] Starting scheduled upload capacity recheck."
  )

  try {
    const measuredUploadBitsPerSecond = await measureUpload(uploadMeasurementBytes)

    if (!Number.isFinite(measuredUploadBitsPerSecond) || measuredUploadBitsPerSecond <= 0) {
      throw new Error("Cloudflare upload speed test returned no upload result")
    }

    const maxUploadBitsPerSecond = Math.floor(
      measuredUploadBitsPerSecond * usableUploadCapacityFactor
    )

    uploadCapacityStore.capacityState = {
      status: "ready",
      measuredAt: new Date().toISOString(),
      maxUploadBitsPerSecond,
      error: null,
    }

    process.env[measuredUploadEnvName] = String(maxUploadBitsPerSecond)

    console.log(
      `[Info] [Bandwidth] Measured upload capacity: ${(measuredUploadBitsPerSecond / 8 / 1_000_000).toFixed(2)} MB/s. Using ${(maxUploadBitsPerSecond / 8 / 1_000_000).toFixed(2)} MB/s max upload target.`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    uploadCapacityStore.capacityState = {
      status: "failed",
      measuredAt: new Date().toISOString(),
      maxUploadBitsPerSecond: null,
      error: message,
    }

    console.warn(
      `[Warn] [Bandwidth] Upload capacity measurement failed - uploadCapacity.ts - ${message}`
    )
  }
}

export function startUploadCapacityMeasurement(
  reason: UploadCapacityMeasurementReason = "manual"
) {
  uploadCapacityStore.measurementPromise ??= runUploadCapacityProbe(reason).finally(() => {
    uploadCapacityStore.measurementPromise = null
  })

  return uploadCapacityStore.measurementPromise
}

export function getUploadCapacityState() {
  const envMeasuredUploadBitsPerSecond = readMeasuredUploadBitsPerSecondFromEnv()

  if (uploadCapacityStore.capacityState.status === "ready" || !envMeasuredUploadBitsPerSecond) {
    return uploadCapacityStore.capacityState
  }

  return {
    status: "ready",
    measuredAt: new Date().toISOString(),
    maxUploadBitsPerSecond: envMeasuredUploadBitsPerSecond,
    error: null,
  } satisfies UploadCapacityState
}

export function getMaxUploadKbps() {
  const capacityState = getUploadCapacityState()

  return capacityState.status === "ready"
    ? Math.floor(capacityState.maxUploadBitsPerSecond / 1000)
    : null
}
