import path from "node:path"

import { localNonAnimeIdBase, localNonAnimeIdRange } from "@/lib/local-media"
import { slugifyAnimeTitle } from "@/lib/slug"
import type { AnimeMetadataInput } from "@/server/db/library"
import {
  cleanFolderTitleCandidate,
  parseAnimeFilePath,
  sanitizeExportPathPart,
  type ParsedAnimeFileName,
} from "@/server/media/filename"

export const nonAnimeFolderName = "NotAnime"

export type ParsedNonAnimeFilePath = {
  title: string
  parsed: ParsedAnimeFileName
}

function isInsideDirectory(root: string, filePath: string) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath))

  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function getNotAnimeRoot(rootDir: string) {
  return path.resolve(rootDir, nonAnimeFolderName)
}

function getStableLocalMediaId(title: string) {
  let hash = 0

  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 131 + title.charCodeAt(index)) % localNonAnimeIdRange
  }

  return localNonAnimeIdBase + hash
}

function getNotAnimeRelativeParts(rootDir: string, filePath: string) {
  const notAnimeRoot = getNotAnimeRoot(rootDir)

  if (!isInsideDirectory(notAnimeRoot, filePath)) {
    return null
  }

  return path.relative(notAnimeRoot, path.resolve(filePath)).split(path.sep).filter(Boolean)
}

function getNotAnimeFolderTitle(parts: string[]) {
  const rawTitle = parts.length >= 2 ? parts[0] : null

  if (!rawTitle) {
    return null
  }

  const title = sanitizeExportPathPart(cleanFolderTitleCandidate(rawTitle))

  return title || null
}

export function parseNonAnimeFilePath(
  filePath: string,
  rootDir: string
): ParsedNonAnimeFilePath | null {
  const parts = getNotAnimeRelativeParts(rootDir, filePath)

  if (!parts?.length) {
    return null
  }

  const folderTitle = getNotAnimeFolderTitle(parts)
  const parsed = parseAnimeFilePath(filePath, {
    rootDir: getNotAnimeRoot(rootDir),
    fallbackTitles: folderTitle ? [folderTitle] : [],
  })

  if (!parsed) {
    return null
  }

  const title = sanitizeExportPathPart(folderTitle ?? parsed.title)

  if (!title) {
    return null
  }

  return {
    title,
    parsed: {
      ...parsed,
      title,
      titleSource: folderTitle ? "folder" : parsed.titleSource,
    },
  }
}

export function createNonAnimeMetadata(input: {
  title: string
  episodeNumber: number
}): AnimeMetadataInput {
  const safeTitle = sanitizeExportPathPart(input.title) || "NotAnime"
  const id = getStableLocalMediaId(safeTitle.toLowerCase())
  const slugBase = slugifyAnimeTitle(safeTitle) || String(id)

  return {
    id,
    format: "TV",
    library: {
      slug: `not-anime-${slugBase}`,
      title: safeTitle,
      primaryAnimeId: id,
      relationKind: "LIBRARY_ROOT",
    },
    title: {
      english: safeTitle,
      romaji: safeTitle,
      userPreferred: safeTitle,
    },
    status: null,
    description: "Local non-anime library entry.",
    episodes: input.episodeNumber,
    duration: null,
    coverImage: null,
    bannerImage: null,
    genres: [],
    tags: [],
    relations: [],
    streamingEpisodes: [],
    rawMedia: null,
    anilistSyncedAt: null,
  }
}
