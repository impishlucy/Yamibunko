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
  libraryTitle: string
  mediaTitle: string
  parsed: ParsedAnimeFileName
}

function isInsideDirectory(root: string, filePath: string) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath))

  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function getNotAnimeRoot(rootDir: string) {
  return path.resolve(rootDir, nonAnimeFolderName)
}

function getStableLocalMediaId(key: string) {
  let hash = 0

  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 131 + key.charCodeAt(index)) % localNonAnimeIdRange
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

function formatNonAnimeSeriesTitle(input: {
  libraryTitle: string
  season: number
  part?: number
}) {
  if (input.season <= 1 && !input.part) {
    return input.libraryTitle
  }

  return input.part
    ? `${input.libraryTitle} Season ${input.season} Part ${input.part}`
    : `${input.libraryTitle} Season ${input.season}`
}

function getNonAnimeMediaTitle(input: {
  libraryTitle: string
  parsed: ParsedAnimeFileName
}) {
  const title = input.parsed.mediaKind === "movie"
    ? sanitizeExportPathPart(input.parsed.title)
    : formatNonAnimeSeriesTitle({
        libraryTitle: input.libraryTitle,
        season: input.parsed.season,
        part: input.parsed.part,
      })

  return title || input.libraryTitle
}

function getNonAnimeRootId(libraryTitle: string) {
  return getStableLocalMediaId(libraryTitle.toLowerCase())
}

function getNonAnimeMediaId(input: {
  libraryTitle: string
  mediaTitle: string
  parsed: ParsedAnimeFileName
}) {
  if (input.parsed.mediaKind === "movie") {
    return getStableLocalMediaId(
      `${input.libraryTitle.toLowerCase()}|movie|${input.mediaTitle.toLowerCase()}`
    )
  }

  if (input.parsed.season <= 1 && !input.parsed.part) {
    return getNonAnimeRootId(input.libraryTitle)
  }

  return getStableLocalMediaId(
    `${input.libraryTitle.toLowerCase()}|series|season:${input.parsed.season}|part:${input.parsed.part ?? 0}`
  )
}

function createLocalNonAnimeRootMetadata(input: {
  libraryTitle: string
  librarySlug: string
  rootId: number
}): AnimeMetadataInput {
  return {
    id: input.rootId,
    format: "TV",
    library: {
      slug: input.librarySlug,
      title: input.libraryTitle,
      primaryAnimeId: input.rootId,
      relationKind: "LIBRARY_ROOT",
    },
    title: {
      english: input.libraryTitle,
      romaji: input.libraryTitle,
      userPreferred: input.libraryTitle,
    },
    status: null,
    description: "Local non-anime library entry.",
    episodes: null,
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

export function parseNonAnimeFilePath(
  filePath: string,
  rootDir: string
): ParsedNonAnimeFilePath | null {
  const parts = getNotAnimeRelativeParts(rootDir, filePath)

  if (!parts?.length) {
    return null
  }

  const libraryTitle = getNotAnimeFolderTitle(parts)
  const parsed = parseAnimeFilePath(filePath, {
    rootDir: getNotAnimeRoot(rootDir),
    fallbackTitles: libraryTitle ? [libraryTitle] : [],
  })

  if (!parsed) {
    return null
  }

  const title = sanitizeExportPathPart(libraryTitle ?? parsed.title)

  if (!title) {
    return null
  }

  const mediaTitle = getNonAnimeMediaTitle({ libraryTitle: title, parsed })

  return {
    title,
    libraryTitle: title,
    mediaTitle,
    parsed: {
      ...parsed,
      title: parsed.mediaKind === "movie" ? mediaTitle : title,
      titleSource: libraryTitle ? "folder" : parsed.titleSource,
    },
  }
}

export function createNonAnimeMetadata(input: {
  libraryTitle: string
  mediaTitle: string
  parsed: ParsedAnimeFileName
  episodeNumber: number
}): AnimeMetadataInput {
  const libraryTitle = sanitizeExportPathPart(input.libraryTitle) || "NotAnime"
  const mediaTitle = sanitizeExportPathPart(input.mediaTitle) || libraryTitle
  const rootId = getNonAnimeRootId(libraryTitle)
  const id = getNonAnimeMediaId({
    libraryTitle,
    mediaTitle,
    parsed: input.parsed,
  })
  const slugBase = slugifyAnimeTitle(libraryTitle) || String(rootId)
  const librarySlug = `not-anime-${slugBase}`
  const rootMetadata = createLocalNonAnimeRootMetadata({
    libraryTitle,
    librarySlug,
    rootId,
  })
  const isRoot = id === rootId
  const format = input.parsed.mediaKind === "movie" ? "MOVIE" : "TV"

  return {
    id,
    format,
    library: {
      slug: librarySlug,
      title: libraryTitle,
      primaryAnimeId: rootId,
      relationKind: isRoot ? "LIBRARY_ROOT" : "related",
    },
    title: {
      english: mediaTitle,
      romaji: mediaTitle,
      userPreferred: mediaTitle,
    },
    status: null,
    description: isRoot
      ? "Local non-anime library entry."
      : `Local non-anime entry for ${libraryTitle}.`,
    seasonYear: null,
    episodes: format === "MOVIE" ? 1 : input.episodeNumber,
    duration: null,
    coverImage: null,
    bannerImage: null,
    genres: [],
    tags: [],
    relations: isRoot
      ? []
      : [
          {
            relationType: "LIBRARY_ROOT",
            media: rootMetadata,
          },
        ],
    streamingEpisodes: [],
    rawMedia: null,
    anilistSyncedAt: null,
  }
}
