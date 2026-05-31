export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorkers } = await import("./src/server/workers/startWorkers")
    startWorkers()
  }
}
