export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrapEnvironment } =
      await import("./src/server/startup/environment")
    const { startWorkers } = await import("./src/server/workers/startWorkers")
    const { startUploadCapacityMeasurement } = await import(
      "./src/server/bandwidth/uploadCapacity"
    )
    const { startScheduledUploadCapacityRechecks } = await import(
      "./src/server/bandwidth/uploadCapacityRechecks"
    )

    bootstrapEnvironment()
    await startUploadCapacityMeasurement("startup")
    startScheduledUploadCapacityRechecks()
    startWorkers()
  }
}
