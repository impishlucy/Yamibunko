export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrapEnvironment } =
      await import("./src/server/startup/environment")
    const { startWorkers } = await import("./src/server/workers/startWorkers")

    bootstrapEnvironment()
    startWorkers()
  }
}
