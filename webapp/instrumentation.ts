export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrapEnvironment } =
      await import("./src/server/startup/environment")
    const { startWorkers } = await import("./src/server/workers/startWorkers")
    const { getDb } = await import("./src/server/db/sqlite")
    const { runStartupFileMigrations } = await import("./src/server/media/fileMigration")
    const {
      isStartupUpgradeShutdownError,
      runVersionDependentStartupUpgrades,
    } = await import("./src/server/startup/versionUpgrades")
    const { startParentProcessMonitor } = await import(
      "./src/server/startup/parentProcessMonitor"
    )
    const {
      markServerStartupFailed,
      markServerStartupReady,
      markServerStartupStarted,
      setServerStartupPhase,
    } = await import("./src/server/startup/readiness")

    bootstrapEnvironment()
    getDb()
    markServerStartupStarted("startup checks")
    const workerRuntime = startWorkers()

    startParentProcessMonitor(async () => {
      await workerRuntime?.stop()
    })

    void (async () => {
      try {
        setServerStartupPhase("startup checks")
        await workerRuntime?.startupChecksReady
        setServerStartupPhase("file migrations")
        await runStartupFileMigrations()
        setServerStartupPhase("version upgrades")
        await runVersionDependentStartupUpgrades()
        setServerStartupPhase("startup input scan and upload test")
        await workerRuntime?.startImportProcessing()
        markServerStartupReady()
      } catch (error) {
        if (isStartupUpgradeShutdownError(error)) {
          return
        }

        markServerStartupFailed()
        console.error(
          `[Error] [Startup] Server startup failed - instrumentation.ts - ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    })()
  }
}
