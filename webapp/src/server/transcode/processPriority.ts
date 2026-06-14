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

function getPriorityValues() {
  const priority = os.constants.priority

  return process.platform === "win32"
    ? {
        low: typeof priority.PRIORITY_LOW === "number"
          ? priority.PRIORITY_LOW
          : priority.PRIORITY_BELOW_NORMAL,
      }
    : {
        low: 10,
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
  const shouldLower = true

  if (shouldLower === entry.lowered) {
    return
  }

  if (setProcessPriority(pid, values.low)) {
    entry.lowered = shouldLower
  }
}

function refreshImportEncodingPriorities() {
  for (const entry of importEncodingProcesses.values()) {
    applyImportEncodingPriority(entry)
  }
}

export function registerLiveTranscodeProcessPriority() {
  refreshImportEncodingPriorities()

  return () => {
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
