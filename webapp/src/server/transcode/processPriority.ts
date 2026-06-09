import os from "node:os"

type TrackedProcess = {
  pid?: number
  once: (event: "exit", listener: () => void) => unknown
}

type ImportEncodingProcess = {
  process: TrackedProcess
  lowered: boolean
}

const importEncodingProcesses = new Map<number, ImportEncodingProcess>()
let activeLiveTranscodes = 0

function getPriorityValues() {
  const priority = os.constants.priority

  return process.platform === "win32"
    ? {
        low: priority.PRIORITY_BELOW_NORMAL,
        normal: priority.PRIORITY_NORMAL,
      }
    : {
        low: 10,
        normal: 0,
      }
}

function setProcessPriority(pid: number, priority: number) {
  try {
    os.setPriority(pid, priority)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `[Warn] [Transcode] Unable to update ffmpeg process priority for PID ${pid} - ${message}`
    )
    return false
  }
}

function applyImportEncodingPriority(entry: ImportEncodingProcess) {
  const pid = entry.process.pid

  if (!pid) {
    return
  }

  const values = getPriorityValues()
  const shouldLower = activeLiveTranscodes > 0

  if (shouldLower === entry.lowered) {
    return
  }

  if (setProcessPriority(pid, shouldLower ? values.low : values.normal)) {
    entry.lowered = shouldLower
  }
}

function refreshImportEncodingPriorities() {
  for (const entry of importEncodingProcesses.values()) {
    applyImportEncodingPriority(entry)
  }
}

export function registerLiveTranscodeProcessPriority() {
  activeLiveTranscodes += 1
  refreshImportEncodingPriorities()

  return () => {
    activeLiveTranscodes = Math.max(activeLiveTranscodes - 1, 0)
    refreshImportEncodingPriorities()
  }
}

export function registerImportEncodingProcess(process: TrackedProcess) {
  const pid = process.pid

  if (!pid) {
    return
  }

  const entry: ImportEncodingProcess = {
    process,
    lowered: false,
  }

  importEncodingProcesses.set(pid, entry)
  applyImportEncodingPriority(entry)
  process.once("exit", () => {
    importEncodingProcesses.delete(pid)
  })
}
