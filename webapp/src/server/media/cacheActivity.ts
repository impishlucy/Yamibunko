import path from "node:path"

const activePreviewPathCounts = new Map<string, number>()

function normalizeCachePath(filePath: string) {
  const resolvedPath = path.resolve(filePath)

  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath
}

export function registerActiveCachePreviewPath(filePath: string) {
  const key = normalizeCachePath(filePath)
  const currentCount = activePreviewPathCounts.get(key) ?? 0
  activePreviewPathCounts.set(key, currentCount + 1)

  return () => {
    const nextCount = (activePreviewPathCounts.get(key) ?? 1) - 1

    if (nextCount <= 0) {
      activePreviewPathCounts.delete(key)
      return
    }

    activePreviewPathCounts.set(key, nextCount)
  }
}

export function activeCachePreviewPathKeys() {
  return new Set(activePreviewPathCounts.keys())
}
