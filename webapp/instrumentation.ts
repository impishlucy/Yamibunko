export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrapEnvironment } =
      await import("./src/server/startup/environment")
    const { startWorkers } = await import("./src/server/workers/startWorkers")
    const { getDb } = await import("./src/server/db/sqlite")
    const { runStartupFileMigrations } = await import("./src/server/media/fileMigration")
    const { startUploadCapacityMeasurement } = await import(
      "./src/server/bandwidth/uploadCapacity"
    )
    const { startParentProcessMonitor } = await import(
      "./src/server/startup/parentProcessMonitor"
    )

    bootstrapEnvironment()
    getDb()
    await runStartupFileMigrations()
    const workerRuntime = startWorkers()

    await workerRuntime?.startupChecksReady
    await startUploadCapacityMeasurement("startup")
    workerRuntime?.startImportProcessing()

    startParentProcessMonitor(async () => {
      await workerRuntime?.stop()
    })
  }
}
