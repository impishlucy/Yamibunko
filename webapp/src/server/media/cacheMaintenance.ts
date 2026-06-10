import { readdir, rmdir, rm } from "node:fs/promises"
import path from "node:path"

import { listActiveJobIds } from "@/server/db/jobs"
import { activeCachePreviewPathKeys } from "@/server/media/cacheActivity"
import { listEpisodeThumbnailCacheReferences } from "@/server/db/library"
import { getServerConfig } from "@/server/config"
import {
  previewDirectoryPath,
  thumbnailPathForEpisode,
} from "@/server/media/mediaFiles"
import { debugLog } from "@/server/utils/debugLog"
import { errorMessage } from "@/server/utils/format"

type CleanupSummary = {
  removedEntries: number
  removedBytes: number
  skippedEntries: number
}

const activeJobDirectoryCounts = new Map<string, number>()
let cacheMaintenancePromise: Promise<void> | null = null

function debugCache(message: string) {
  debugLog(`[Debug] [CacheMaintenance] ${message}`)
}

function normalizeCachePath(filePath: string) {
  const resolvedPath = path.resolve(filePath)

  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath
}

function isInsideDirectory(rootDirectory: string, targetPath: string) {
  const relativePath = path.relative(
    path.resolve(rootDirectory),
    path.resolve(targetPath)
  )

  return (
    Boolean(relativePath) &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  )
}

function isDirectChildOfDirectory(rootDirectory: string, targetPath: string) {
  return path.dirname(path.resolve(targetPath)) === path.resolve(rootDirectory)
}

function cacheJobsDirectoryPath() {
  return path.join(getServerConfig().tempDir, "jobs")
}

function activeJobDirectoryKeys() {
  return new Set(activeJobDirectoryCounts.keys())
}

export function registerActiveCacheJobDirectory(directoryPath: string) {
  const key = normalizeCachePath(directoryPath)
  const currentCount = activeJobDirectoryCounts.get(key) ?? 0
  activeJobDirectoryCounts.set(key, currentCount + 1)

  return () => {
    const nextCount = (activeJobDirectoryCounts.get(key) ?? 1) - 1

    if (nextCount <= 0) {
      activeJobDirectoryCounts.delete(key)
      return
    }

    activeJobDirectoryCounts.set(key, nextCount)
  }
}

export async function removeCacheJobDirectory(
  directoryPath: string,
  options: { allowActive?: boolean } = {}
) {
  const jobsDirectory = cacheJobsDirectoryPath()
  const resolvedDirectoryPath = path.resolve(directoryPath)

  if (!isDirectChildOfDirectory(jobsDirectory, resolvedDirectoryPath)) {
    throw new Error(
      `Refusing to remove cache job directory outside cache/jobs: ${resolvedDirectoryPath}`
    )
  }

  const activeDirectories = activeJobDirectoryKeys()

  if (
    !options.allowActive &&
    activeDirectories.has(normalizeCachePath(resolvedDirectoryPath))
  ) {
    debugCache(`Skipped active job cache directory - ${resolvedDirectoryPath}`)
    return false
  }

  await rm(resolvedDirectoryPath, { force: true, recursive: true })
  debugCache(`Removed job cache directory - ${resolvedDirectoryPath}`)
  return true
}

async function cleanupJobCache(): Promise<CleanupSummary> {
  const jobsDirectory = cacheJobsDirectoryPath()
  const entries = await readdir(jobsDirectory, { withFileTypes: true }).catch(
    () => null
  )

  if (!entries) {
    return { removedEntries: 0, removedBytes: 0, skippedEntries: 0 }
  }

  const activeDirectories = activeJobDirectoryKeys()
  const activeDbJobIds = new Set(listActiveJobIds())
  let removedEntries = 0
  const removedBytes = 0
  let skippedEntries = 0

  for (const entry of entries) {
    const entryPath = path.join(jobsDirectory, entry.name)
    const normalizedEntryPath = normalizeCachePath(entryPath)

    if (activeDirectories.has(normalizedEntryPath)) {
      skippedEntries += 1
      continue
    }

    if (activeDbJobIds.has(entry.name)) {
      debugCache(
        `Removing stale job cache directory that still has an unfinished DB row - ${entryPath}`
      )
    }

    await rm(entryPath, { force: true, recursive: true })
    removedEntries += 1
  }

  return { removedEntries, removedBytes, skippedEntries }
}

function referencedPreviewPaths() {
  const previewDirectory = previewDirectoryPath()
  const referencedPaths = new Set<string>()

  for (const reference of listEpisodeThumbnailCacheReferences()) {
    const generatedPath = thumbnailPathForEpisode(reference.file_path)

    if (isInsideDirectory(previewDirectory, generatedPath)) {
      referencedPaths.add(normalizeCachePath(generatedPath))
    }

    if (
      reference.thumbnail_path &&
      isInsideDirectory(previewDirectory, reference.thumbnail_path)
    ) {
      referencedPaths.add(normalizeCachePath(reference.thumbnail_path))
    }
  }

  return referencedPaths
}

type PreviewCacheEntries = {
  files: string[]
  directories: string[]
  skippedEntries: number
}

async function listPreviewCacheEntries(input: {
  directoryPath: string
  rootDirectory: string
}): Promise<PreviewCacheEntries> {
  const entries = await readdir(input.directoryPath, { withFileTypes: true }).catch(
    () => null
  )

  if (!entries) {
    return { files: [], directories: [], skippedEntries: 0 }
  }

  const files: string[] = []
  const directories: string[] = []
  let skippedEntries = 0

  for (const entry of entries) {
    const entryPath = path.join(input.directoryPath, entry.name)

    if (!isInsideDirectory(input.rootDirectory, entryPath)) {
      skippedEntries += 1
      continue
    }

    if (entry.isDirectory()) {
      const childEntries = await listPreviewCacheEntries({
        directoryPath: entryPath,
        rootDirectory: input.rootDirectory,
      })

      files.push(...childEntries.files)
      directories.push(...childEntries.directories, entryPath)
      skippedEntries += childEntries.skippedEntries
      continue
    }

    if (entry.isFile()) {
      files.push(entryPath)
      continue
    }

    skippedEntries += 1
  }

  return { files, directories, skippedEntries }
}

async function cleanupPreviewCache(): Promise<CleanupSummary> {
  const previewDirectory = previewDirectoryPath()
  const referencedPaths = referencedPreviewPaths()

  for (const activePreviewPath of activeCachePreviewPathKeys()) {
    referencedPaths.add(normalizeCachePath(activePreviewPath))
  }

  const cacheEntries = await listPreviewCacheEntries({
    directoryPath: previewDirectory,
    rootDirectory: previewDirectory,
  })
  let removedEntries = 0
  let skippedEntries = cacheEntries.skippedEntries

  for (const filePath of cacheEntries.files) {
    if (referencedPaths.has(normalizeCachePath(filePath))) {
      skippedEntries += 1
      continue
    }

    await rm(filePath, { force: true })
    removedEntries += 1
  }

  for (const directoryPath of cacheEntries.directories) {
    const removed = await rmdir(directoryPath)
      .then(() => true)
      .catch(() => false)

    if (removed) {
      removedEntries += 1
    }
  }

  return { removedEntries, removedBytes: 0, skippedEntries }
}

async function runCacheMaintenanceInternal() {
  debugCache("Starting cache maintenance.")

  const jobs = await cleanupJobCache()
  const previews = await cleanupPreviewCache()
  const removedEntries = jobs.removedEntries + previews.removedEntries

  console.log(
    `[Info] [Cache] Cache maintenance completed - removed ${removedEntries} item(s). Jobs removed ${jobs.removedEntries}, previews removed ${previews.removedEntries}, active/referenced skipped ${jobs.skippedEntries + previews.skippedEntries}. File sizes were not pre-scanned to reduce cache-drive I/O.`
  )
  debugCache(
    `Cache maintenance completed - Jobs removed ${jobs.removedEntries}, skipped ${jobs.skippedEntries}; previews removed ${previews.removedEntries}, skipped ${previews.skippedEntries}. Cleanup used DB/reference set comparison without media-library file checks or cache-file size scans.`
  )
}

export async function runCacheMaintenance() {
  if (cacheMaintenancePromise) {
    debugCache("Cache maintenance is already running; joining current run.")
    return cacheMaintenancePromise
  }

  cacheMaintenancePromise = runCacheMaintenanceInternal().finally(() => {
    cacheMaintenancePromise = null
  })

  return cacheMaintenancePromise
}

export async function tryRunCacheMaintenance() {
  try {
    await runCacheMaintenance()
  } catch (error) {
    console.error(
      `[Error] [Cache] Cache maintenance failed - cacheMaintenance.ts - ${errorMessage(error)}`
    )
  }
}
