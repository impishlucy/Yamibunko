import { randomUUID } from "node:crypto"
import os from "node:os"

import { execa } from "execa"

import type { TranscodeStatus } from "@/lib/types"
import { getServerConfigResult } from "@/server/config"

export type LiveTranscodeLease = {
  id: string
  label: string
  release: () => void
}

type CpuSample = {
  idle: number
  total: number
}

const activeTranscodes = new Map<
  string,
  {
    label: string
    startedAt: number
  }
>()

let previousCpuSample: CpuSample | null = null

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
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

async function getNvidiaPressure() {
  try {
    const { stdout } = await execa(
      "nvidia-smi",
      [
        "--query-gpu=utilization.gpu,utilization.encoder",
        "--format=csv,noheader,nounits",
      ],
      {
        timeout: 1500,
        windowsHide: true,
      }
    )

    const values = stdout.split(/\r?\n/).flatMap((line) =>
      line
        .split(",")
        .map((value) => Number.parseFloat(value.trim()))
        .filter(Number.isFinite)
    )

    if (values.length === 0) {
      return null
    }

    return Math.min(Math.max(Math.max(...values) / 100, 0), 1)
  } catch {
    return null
  }
}

async function getHardwarePressure(acceleration: "nvenc" | "qsv" | "cpu") {
  if (acceleration === "nvenc") {
    return (await getNvidiaPressure()) ?? getCpuPressure()
  }

  return getCpuPressure()
}

function getBaseCapacity(acceleration: "nvenc" | "qsv" | "cpu") {
  if (acceleration === "cpu") {
    return Math.max(1, Math.floor(availableParallelism() / 2))
  }

  return 2
}

async function getDynamicCapacity() {
  const result = getServerConfigResult()

  if (!result.ok) {
    return 0
  }

  const acceleration = result.config.transcodeAccel
  const baseCapacity = getBaseCapacity(acceleration)
  const pressure = await getHardwarePressure(acceleration)

  if (pressure >= 0.9) {
    return 0
  }

  if (pressure >= 0.75) {
    return Math.min(baseCapacity, 1)
  }

  if (pressure >= 0.55) {
    return Math.min(baseCapacity, 2)
  }

  return baseCapacity
}

function createLease(label: string): LiveTranscodeLease {
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

export async function getLiveTranscodeStatus(): Promise<TranscodeStatus> {
  const dynamicCapacity = await getDynamicCapacity()
  const active = activeTranscodes.size
  const max = Math.max(dynamicCapacity, active)

  return {
    max,
    active,
    available: Math.max(dynamicCapacity - active, 0),
  }
}

export async function tryAcquireLiveTranscode(
  label: string
): Promise<LiveTranscodeLease | null> {
  const status = await getLiveTranscodeStatus()

  if (status.available <= 0) {
    return null
  }

  return createLease(label)
}

export async function acquireBackgroundTranscode(label: string) {
  for (;;) {
    const lease = await tryAcquireLiveTranscode(label)

    if (lease) {
      return lease
    }

    await delay(5000)
  }
}
