import os from "node:os"

type TrackedProcess = {
  pid?: number
  once: (event: "exit", listener: () => void) => unknown
}

type FileEncodingProcess = {
  process: TrackedProcess
  lowered: boolean
}

const fileEncodingProcesses = new Map<number, FileEncodingProcess>()

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

function applyFileEncodingPriority(entry: FileEncodingProcess) {
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

function refreshFileEncodingPriorities() {
  for (const entry of fileEncodingProcesses.values()) {
    applyFileEncodingPriority(entry)
  }
}

export function registerLiveTranscodeProcessPriority() {
  refreshFileEncodingPriorities()

  return () => {
    refreshFileEncodingPriorities()
  }
}

export function registerFileEncodingProcess(process: TrackedProcess) {
  const pid = process.pid

  if (!pid) {
    return
  }

  const entry: FileEncodingProcess = {
    process,
    lowered: false,
  }

  fileEncodingProcesses.set(pid, entry)
  applyFileEncodingPriority(entry)
  process.once("exit", () => {
    fileEncodingProcesses.delete(pid)
  })
}
