import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import os from "node:os"

import { execa } from "execa"

import type { TranscodeStatus } from "@/lib/types"
import {
  getServerConfigResult,
  type TranscodeAcceleration,
} from "@/server/config"

export type LiveTranscodeLease = {
  id: string
  label: string
  release: () => void
}

type CpuSample = {
  idle: number
  total: number
}

type TranscodeKind = "live" | "import-video" | "import-remux"
export type ImportTranscodeCapacityKind = "video" | "remux"

type PendingTranscodeRequest = {
  id: string
  label: string
  kind: TranscodeKind
  priority: number
  sequence: number
  signal?: AbortSignal
  resolve: (lease: LiveTranscodeLease) => void
  reject: (error: Error) => void
}

type HardwarePressureSnapshot = {
  pressure: number
  source: string
}

const activeTranscodes = new Map<
  string,
  {
    label: string
    kind: TranscodeKind
    cost: number
    startedAt: number
  }
>()

let previousCpuSample: CpuSample | null = null
let cachedHardwarePressure:
  | {
      acceleration: TranscodeAcceleration
      snapshot: HardwarePressureSnapshot
      readAt: number
    }
  | undefined

const pressureCacheMs = 2000

const hardwarePressureLimit = 0.9
const queueRetryMs = 2000
let pendingSequence = 0
let queueRetryTimer: ReturnType<typeof setTimeout> | null = null
let drainingQueue = false
const pendingTranscodes: PendingTranscodeRequest[] = []

function isIntelAcceleration(acceleration: TranscodeAcceleration) {
  return acceleration === "intel_gpu" || acceleration === "intel_cpu"
}

function isAmdAcceleration(acceleration: TranscodeAcceleration) {
  return acceleration === "amd_gpu" || acceleration === "amd_cpu"
}

function availableParallelism() {
  return Math.max(os.availableParallelism?.() ?? os.cpus().length ?? 1, 1)
}

function readCpuSample(): CpuSample {
  return os.cpus().reduce(
    (total, cpu) => {
      const idle = cpu.times.idle
      const cpuTotal = Object.values(cpu.times).reduce(
        (sum, value) => sum + value,
        0
      )

      return {
        idle: total.idle + idle,
        total: total.total + cpuTotal,
      }
    },
    { idle: 0, total: 0 }
  )
}

function getCpuPressure() {
  const current = readCpuSample()
  const previous = previousCpuSample
  previousCpuSample = current

  if (!previous) {
    const loadAverage = os.loadavg()[0] ?? 0
    return Math.min(loadAverage / availableParallelism(), 1)
  }

  const idleDelta = current.idle - previous.idle
  const totalDelta = current.total - previous.total

  if (totalDelta <= 0) {
    return 0
  }

  return Math.min(Math.max(1 - idleDelta / totalDelta, 0), 1)
}

async function getNvidiaPressureSnapshot(): Promise<HardwarePressureSnapshot | null> {
  try {
    const { stdout } = await execa(
      "nvidia-smi",
      [
        "--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total",
        "--format=csv,noheader,nounits",
      ],
      {
        timeout: 1500,
        windowsHide: true,
      }
    )
    const gpuPressures = stdout.split(/\r?\n/).map((line) => {
      const values = line
        .split(",")
        .map((value) => Number.parseFloat(value.trim()))

      if (
        values.length < 5 ||
        values.some((value) => !Number.isFinite(value))
      ) {
        return 0
      }

      const [gpu, encoder, decoder, memoryUsed, memoryTotal] = values
      const memoryPressure = memoryTotal > 0 ? memoryUsed / memoryTotal : 0

      return Math.max(gpu / 100, encoder / 100, decoder / 100, memoryPressure)
    })

    if (gpuPressures.length === 0) {
      return null
    }

    return {
      pressure: clamp01(Math.max(...gpuPressures)),
      source: "nvidia-smi",
    }
  } catch {
    return null
  }
}

async function getWindowsGpuPressureSnapshot(): Promise<HardwarePressureSnapshot | null> {
  if (process.platform !== "win32") {
    return null
  }

  try {
    const { stdout } = await execa(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$samples=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples | Where-Object { $_.InstanceName -match 'engtype_(VideoEncode|VideoDecode|Compute|3D)' } | Select-Object -ExpandProperty CookedValue; $sum=($samples | Measure-Object -Sum).Sum; $max=($samples | Measure-Object -Maximum).Maximum; [Console]::Out.Write(\"$sum,$max\")",
      ],
      {
        timeout: 1800,
        windowsHide: true,
      }
    )
    const [sum, max] = stdout
      .trim()
      .split(",")
      .map((value) => Number.parseFloat(value))

    if (!Number.isFinite(sum) && !Number.isFinite(max)) {
      return null
    }

    return {
      pressure: clamp01(Math.max(sum || 0, max || 0) / 100),
      source: "windows-gpu-counters",
    }
  } catch {
    return null
  }
}

function readLinuxGpuBusyPressure(vendorId: string) {
  if (process.platform !== "linux") {
    return null
  }

  try {
    const cardNames = readdirSync("/sys/class/drm").filter((entry) =>
      /^card\d+$/.test(entry)
    )

    for (const cardName of cardNames) {
      const vendorPath = `/sys/class/drm/${cardName}/device/vendor`
      const busyPath = `/sys/class/drm/${cardName}/device/gpu_busy_percent`

      if (!existsSync(vendorPath) || !existsSync(busyPath)) {
        continue
      }

      const vendor = readFileSync(vendorPath, "utf8").trim().toLowerCase()

      if (vendor !== vendorId) {
        continue
      }

      const busyPercent = Number.parseFloat(readFileSync(busyPath, "utf8"))

      if (Number.isFinite(busyPercent)) {
        return clamp01(busyPercent / 100)
      }
    }
  } catch {
    return null
  }

  return null
}

function clamp01(value: number) {
  return Math.min(Math.max(value, 0), 1)
}

async function getHardwarePressureSnapshot(
  acceleration: TranscodeAcceleration
): Promise<HardwarePressureSnapshot> {
  const cached = cachedHardwarePressure

  if (
    cached &&
    cached.acceleration === acceleration &&
    Date.now() - cached.readAt < pressureCacheMs
  ) {
    return cached.snapshot
  }

  const snapshot =
    acceleration === "nvenc"
      ? ((await getNvidiaPressureSnapshot()) ?? {
          pressure: getCpuPressure(),
          source: "cpu-fallback",
        })
      : isAmdAcceleration(acceleration)
        ? ((await getWindowsGpuPressureSnapshot()) ??
          amdLinuxPressureSnapshot() ?? {
            pressure: getCpuPressure(),
            source: "cpu-fallback",
          })
        : isIntelAcceleration(acceleration)
          ? ((await getWindowsGpuPressureSnapshot()) ??
            intelLinuxPressureSnapshot() ?? {
              pressure: getCpuPressure(),
              source: "cpu-fallback",
            })
          : {
              pressure: getCpuPressure(),
              source: "cpu",
            }

  cachedHardwarePressure = {
    acceleration,
    snapshot,
    readAt: Date.now(),
  }

  return snapshot
}

function amdLinuxPressureSnapshot(): HardwarePressureSnapshot | null {
  const pressure = readLinuxGpuBusyPressure("0x1002")

  if (pressure === null) {
    return null
  }

  return {
    pressure,
    source: "linux-amd-gpu-busy",
  }
}

function intelLinuxPressureSnapshot(): HardwarePressureSnapshot | null {
  const pressure = readLinuxGpuBusyPressure("0x8086")

  if (pressure === null) {
    return null
  }

  return {
    pressure,
    source: "linux-intel-gpu-busy",
  }
}

function getTranscodeCost(
  acceleration: TranscodeAcceleration,
  kind: TranscodeKind
) {
  if (kind === "import-video") {
    return 0.5
  }

  if (kind === "import-remux") {
    return acceleration === "cpu" ? 0.18 : 0.12
  }

  if (acceleration === "cpu") {
    return 0.35
  }

  return 0.16
}

function getActiveCost() {
  return [...activeTranscodes.values()].reduce(
    (total, transcode) => total + transcode.cost,
    0
  )
}

function getActiveLiveCount() {
  return [...activeTranscodes.values()].filter(
    (transcode) => transcode.kind === "live"
  ).length
}

function scheduleQueueDrain() {
  if (queueRetryTimer) {
    return
  }

  queueRetryTimer = setTimeout(() => {
    queueRetryTimer = null
    void drainPendingTranscodes()
  }, queueRetryMs)
  queueRetryTimer.unref?.()
}

async function getCanFitTranscode(kind: TranscodeKind) {
  const result = getServerConfigResult()

  if (!result.ok) {
    return false
  }

  const acceleration = result.config.transcodeAccel

  if (acceleration === "cpu" && kind === "import-video") {
    return false
  }

  const snapshot = await getHardwarePressureSnapshot(acceleration)
  const candidateCost = getTranscodeCost(acceleration, kind)
  const activeCost = getActiveCost()
  const localPressureFloor = activeCost
  const effectivePressure = Math.max(snapshot.pressure, localPressureFloor)

  return effectivePressure + candidateCost <= hardwarePressureLimit
}

function removePendingRequest(id: string) {
  const index = pendingTranscodes.findIndex((request) => request.id === id)

  if (index >= 0) {
    pendingTranscodes.splice(index, 1)
  }
}

export function cancelPendingLiveTranscodes(
  reason = "Live transcode request was cancelled"
) {
  const pendingLiveRequests = pendingTranscodes.splice(0)

  for (const request of pendingLiveRequests) {
    request.reject(new Error(reason))
  }

  if (pendingLiveRequests.length > 0) {
    console.log(
      `[Info] [Transcode] Cancelled ${pendingLiveRequests.length} pending live transcode request(s).`
    )
  }
}

function sortPendingTranscodes() {
  pendingTranscodes.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority
    }

    return left.sequence - right.sequence
  })
}

async function drainPendingTranscodes() {
  if (drainingQueue) {
    return
  }

  drainingQueue = true

  try {
    for (;;) {
      sortPendingTranscodes()
      const request = pendingTranscodes[0]

      if (!request) {
        return
      }

      if (request.signal?.aborted) {
        removePendingRequest(request.id)
        request.reject(new Error("Transcode request was cancelled"))
        continue
      }

      const result = getServerConfigResult()

      if (!result.ok || !(await getCanFitTranscode(request.kind))) {
        scheduleQueueDrain()
        return
      }

      removePendingRequest(request.id)
      request.resolve(
        createLease(
          request.label,
          request.kind,
          getTranscodeCost(result.config.transcodeAccel, request.kind)
        )
      )
    }
  } finally {
    drainingQueue = false
  }
}

async function getDynamicLiveCapacity() {
  const result = getServerConfigResult()

  if (!result.ok) {
    return 0
  }

  const acceleration = result.config.transcodeAccel

  const snapshot = await getHardwarePressureSnapshot(acceleration)
  const liveCost = getTranscodeCost(acceleration, "live")
  const activeCost = getActiveCost()
  const effectivePressure = Math.max(snapshot.pressure, activeCost)
  const remainingPressure = Math.max(
    hardwarePressureLimit - effectivePressure,
    0
  )

  return Math.floor(remainingPressure / liveCost)
}

function createLease(
  label: string,
  kind: TranscodeKind,
  cost: number
): LiveTranscodeLease {
  const id = randomUUID()
  let released = false
  activeTranscodes.set(id, {
    label,
    kind,
    cost,
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
      void drainPendingTranscodes()
    },
  }
}

export function registerImportTranscodeCapacity(
  label: string,
  kind: ImportTranscodeCapacityKind
): LiveTranscodeLease {
  const result = getServerConfigResult()
  const transcodeKind: TranscodeKind =
    kind === "video" ? "import-video" : "import-remux"
  const cost = result.ok
    ? getTranscodeCost(result.config.transcodeAccel, transcodeKind)
    : kind === "video"
      ? 0.5
      : 0.12

  return createLease(label, transcodeKind, cost)
}

export async function getLiveTranscodeStatus(): Promise<TranscodeStatus> {
  const available = await getDynamicLiveCapacity()
  const active = getActiveLiveCount()
  const queued = pendingTranscodes.length

  return {
    max: active + available,
    active,
    available,
    queued,
  }
}

function acquireQueuedTranscode(input: {
  label: string
  kind: TranscodeKind
  signal?: AbortSignal
  isVip?: boolean
}) {
  const id = randomUUID()

  return new Promise<LiveTranscodeLease>((resolve, reject) => {
    const request: PendingTranscodeRequest = {
      id,
      label: input.label,
      kind: input.kind,
      priority: input.isVip ? -1 : 0,
      sequence: pendingSequence++,
      signal: input.signal,
      resolve,
      reject,
    }

    const onAbort = () => {
      removePendingRequest(id)
      reject(new Error("Transcode request was cancelled"))
    }

    if (input.signal?.aborted) {
      reject(new Error("Transcode request was cancelled"))
      return
    }

    input.signal?.addEventListener("abort", onAbort, { once: true })
    pendingTranscodes.push(request)

    void drainPendingTranscodes().finally(() => {
      if (!pendingTranscodes.some((pending) => pending.id === id)) {
        input.signal?.removeEventListener("abort", onAbort)
      }
    })
  })
}

export function acquireLiveTranscode(
  label: string,
  signal?: AbortSignal,
  options?: { isVip?: boolean }
) {
  return acquireQueuedTranscode({
    label,
    kind: "live",
    signal,
    isVip: options?.isVip,
  })
}
