import chokidar, { type FSWatcher } from "chokidar"
import PQueue from "p-queue"

import { getServerConfigResult } from "@/server/config"
import { processInputFile } from "@/server/media/processInputFile"

type WorkerRuntime = {
  queue: PQueue
  watcher: FSWatcher
}

let runtime: WorkerRuntime | undefined

export function startWorkers() {
  if (runtime) {
    return runtime
  }

  const configResult = getServerConfigResult()

  if (!configResult.ok) {
    console.warn("[workers] Background watcher not started.", {
      issues: configResult.issues,
    })
    return undefined
  }

  const config = configResult.config
  const queue = new PQueue({
    concurrency: 1,
  })

  const watcher = chokidar.watch(config.inputDir, {
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 3000,
      pollInterval: 1000,
    },
  })

  watcher.on("add", (filePath) => {
    queue
      .add(() => processInputFile(filePath))
      .catch((error: unknown) => {
        console.error("[workers] Background file processing failed.", {
          filePath,
          error,
        })
      })
  })

  watcher.on("error", (error) => {
    console.error("[workers] File watcher failed.", error)
  })

  runtime = { queue, watcher }
  return runtime
}
