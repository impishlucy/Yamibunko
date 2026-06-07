type ParentMonitorGlobal = typeof globalThis & {
  __yamibunkoParentProcessMonitorStarted?: boolean
}

const parentPidEnvName = "YAMIBUNKO_START_PARENT_PID"
const parentProcessCheckIntervalMs = 1000

function parseParentPid(value: string | undefined) {
  if (!value) {
    return null
  }

  const pid = Number(value)

  return Number.isInteger(pid) && pid > 0 && pid !== process.pid ? pid : null
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

export function startParentProcessMonitor(onParentExit: () => Promise<void>) {
  const monitorGlobal = globalThis as ParentMonitorGlobal

  if (monitorGlobal.__yamibunkoParentProcessMonitorStarted) {
    return
  }

  const parentPid = parseParentPid(process.env[parentPidEnvName])

  if (!parentPid) {
    return
  }

  monitorGlobal.__yamibunkoParentProcessMonitorStarted = true
  let stopping = false

  const timer = setInterval(() => {
    if (stopping || isProcessAlive(parentPid)) {
      return
    }

    stopping = true
    clearInterval(timer)

    console.warn(
      `[Warn] [Startup] Parent start process exited. Stopping Next server gracefully - PID ${parentPid}`
    )

    void onParentExit()
      .catch((error) => {
        console.error(
          `[Error] [Startup] Parent-exit shutdown failed - ${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => process.exit(143))
  }, parentProcessCheckIntervalMs)

  timer.unref?.()
}
