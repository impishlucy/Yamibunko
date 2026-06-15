import { constants } from "node:fs"
import { access, copyFile, mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises"
import path from "node:path"

import { isLocalNonAnimeId } from "@/lib/local-media"
import { getServerConfig } from "@/server/config"
import { deleteEpisodeByPath } from "@/server/db/library"
import { getDb } from "@/server/db/sqlite"
import {
  formatSeasonFolderName,
  parseAnimeFilePath,
  sanitizeExportPathPart,
} from "@/server/media/filename"
import {
  isMediaFile,
  pathExists,
  removeEpisodeThumbnails,
} from "@/server/media/mediaFiles"
import { subtitleSidecarPathForMediaFile } from "@/server/media/subtitles"
import { errorMessage, fileName } from "@/server/utils/format"
import { debugLog } from "@/server/utils/debugLog"

type EpisodePathRepairRow = {
  anime_id: number
  season_nr: number
  ep_nr: number
  file_path: string
  library_slug: string | null
  library_title: string | null
  title_romaji: string | null
  title_english: string | null
  title_native: string | null
  title_user_preferred: string
}

type LibraryPathRepairEntryRow = {
  slug: string
  title: string
  primary_anime_id: number
  title_romaji: string | null
  title_english: string | null
  title_native: string | null
  title_user_preferred: string | null
}

type LibraryPathRepairTarget = {
  title: string
  slug: string | null
  source: "current-library-entry" | "library-entry" | "physical-library-folder"
  useStoredEpisodeLocation: boolean
}

export type LibraryPathRepairResult = {
  scanned: number
  repaired: number
  missing: number
  skipped: number
  repairedPaths: string[]
}

type EpisodePathRepairResult =
  | { status: "repaired"; destinationPath: string }
  | { status: "missing" | "skipped" }

const variantSuffixPattern =
  /^(?:0|zero|ii|iii|iv|v|vi|vii|viii|ix|x|season\s+\d{1,2}|s\s*\d{1,2}|\d{1,2}(?:st|nd|rd|th)?\s+season|part\s+\d{1,2}|cour\s+\d{1,2}|movie|ova|special|final\s+season)(?:\s+.*)?$/i
const derivedBaseVariantSuffixPattern =
  /\s+(?:0|zero|ii|iii|iv|v|vi|vii|viii|ix|x|season\s+\d{1,2}|s\s*\d{1,2}|\d{1,2}(?:st|nd|rd|th)?\s+season|first\s+season|second\s+season|third\s+season|fourth\s+season|fifth\s+season|sixth\s+season|seventh\s+season|eighth\s+season|ninth\s+season|tenth\s+season|part\s+\d{1,2}|cour\s+\d{1,2}|final\s+season)\s*$/i
const localLibraryRepairRelationTypes = [
  "LIBRARY_ROOT",
  "PARENT",
  "PREQUEL",
  "SEQUEL",
  "SIDE_STORY",
  "SUMMARY",
  "SPIN_OFF",
  "COMPILATION",
  "CONTAINS",
]
const localLibraryRepairRelationCache = new Map<string, boolean>()

function debugLibraryPathRepair(message: string) {
  debugLog(`[Debug] [LibraryRepair] ${message}`)
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

async function fileExists(filePath: string) {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function normalizeComparableTitle(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function stripSeasonSuffix(value: string | null | undefined) {
  return normalizeComparableTitle(value)
    .replace(/\b(?:season|s)\s*\d{1,2}\b$/i, "")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+season\b$/i, "")
    .replace(
      /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season\b$/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim()
}

function titleTokens(value: string) {
  return normalizeComparableTitle(value)
    .split(" ")
    .filter((token) => token.length > 1)
}

function hasKnownBaseTitlePrefix(title: string, candidate: string) {
  if (!title.startsWith(`${candidate} `)) {
    return false
  }

  const candidateTokens = titleTokens(candidate)

  if (candidateTokens.length < 2) {
    return false
  }

  return titleTokens(title).length > candidateTokens.length
}

function hasVariantPrefix(title: string, candidate: string) {
  if (!hasKnownBaseTitlePrefix(title, candidate)) {
    return false
  }

  return variantSuffixPattern.test(title.slice(candidate.length).trim())
}

function isLikelyBaseTitleForVariant(title: string, candidate: string) {
  if (!hasKnownBaseTitlePrefix(title, candidate)) {
    return false
  }

  const candidateTokens = titleTokens(candidate)
  const titleTokenCount = titleTokens(title).length

  return candidateTokens.length >= 2 && titleTokenCount > candidateTokens.length
}

function stripDerivedBaseVariantSuffix(value: string) {
  const trimmed = value.replace(/\s+/g, " ").trim()
  const stripped = trimmed.replace(derivedBaseVariantSuffixPattern, "").trim()

  if (!stripped || normalizeComparableTitle(stripped) === normalizeComparableTitle(trimmed)) {
    return null
  }

  return stripped
}

function derivedBaseTitleCandidates(value: string) {
  const candidates: string[] = []
  const seen = new Set<string>()
  let current = value

  for (let index = 0; index < 4; index += 1) {
    const next = stripDerivedBaseVariantSuffix(current)

    if (!next) {
      break
    }

    const key = normalizeComparableTitle(next)

    if (!key || seen.has(key)) {
      break
    }

    seen.add(key)
    candidates.push(next)
    current = next
  }

  return candidates
}

function rowTitleValues(row: {
  title_user_preferred?: string | null
  title_english?: string | null
  title_romaji?: string | null
  title_native?: string | null
}) {
  return [
    row.title_english,
    row.title_user_preferred,
    row.title_romaji,
    row.title_native,
  ].filter((title): title is string => Boolean(title?.trim()))
}

function entryTitleValues(entry: LibraryPathRepairEntryRow) {
  return [entry.title, ...rowTitleValues(entry)]
}

function findBestEntryByFolderName(
  folderName: string,
  entries: LibraryPathRepairEntryRow[]
) {
  return entries
    .map((entry) => ({
      entry,
      score: bestTitleScore(folderName, entryTitleValues(entry)),
    }))
    .filter((candidate) => candidate.score <= 1)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score
      }

      return left.entry.title.length - right.entry.title.length
    })[0]?.entry ?? null
}

function localEntriesAreRelated(
  left: LibraryPathRepairEntryRow | null,
  right: LibraryPathRepairEntryRow | null
) {
  if (!left || !right || left.primary_anime_id === right.primary_anime_id) {
    return false
  }

  const [firstId, secondId] = [left.primary_anime_id, right.primary_anime_id].sort(
    (first, second) => first - second
  )
  const cacheKey = `${firstId}:${secondId}`
  const cached = localLibraryRepairRelationCache.get(cacheKey)

  if (typeof cached === "boolean") {
    return cached
  }

  const placeholders = localLibraryRepairRelationTypes.map(() => "?").join(", ")
  const relation = getDb()
    .query<{ count: number }>(
      `
      SELECT COUNT(*) AS count
      FROM anime_relations
      WHERE (
          (anime_id = ? AND related_anime_id = ?)
          OR (anime_id = ? AND related_anime_id = ?)
        )
        AND relation_type IN (${placeholders})
    `
    )
    .get(
      left.primary_anime_id,
      right.primary_anime_id,
      right.primary_anime_id,
      left.primary_anime_id,
      ...localLibraryRepairRelationTypes
    )

  const related = (relation?.count ?? 0) > 0
  localLibraryRepairRelationCache.set(cacheKey, related)
  return related
}

function episodeCurrentTitleValues(row: EpisodePathRepairRow): string[] {
  return [row.library_title, ...rowTitleValues(row)].filter(
    (title): title is string => Boolean(title?.trim())
  )
}

function bestTitleScore(searchTitle: string, titles: string[]) {
  const search = normalizeComparableTitle(searchTitle)
  const strippedSearch = stripSeasonSuffix(searchTitle)
  let best = Number.MAX_SAFE_INTEGER

  for (const title of titles) {
    const candidate = normalizeComparableTitle(title)
    const strippedCandidate = stripSeasonSuffix(title)

    if (!candidate) {
      continue
    }

    if (search === candidate) {
      best = Math.min(best, 0)
      continue
    }

    if (strippedSearch && strippedSearch === candidate) {
      best = Math.min(best, 0.25)
      continue
    }

    if (
      strippedSearch &&
      strippedCandidate &&
      strippedSearch === strippedCandidate
    ) {
      best = Math.min(best, 1)
      continue
    }

    if (search && strippedCandidate && search === strippedCandidate) {
      best = Math.min(best, 1.5)
      continue
    }

    if (
      hasVariantPrefix(search, candidate) ||
      hasVariantPrefix(search, strippedCandidate)
    ) {
      best = Math.min(best, 2)
      continue
    }

    if (
      hasKnownBaseTitlePrefix(search, candidate) ||
      hasKnownBaseTitlePrefix(search, strippedCandidate)
    ) {
      best = Math.min(best, 2.5)
    }
  }

  return best
}

function isCurrentLibraryMatch(row: EpisodePathRepairRow, parsedTitle: string) {
  const score = bestTitleScore(parsedTitle, episodeCurrentTitleValues(row))
  return score <= 1 || (score <= 2.5 && Boolean(row.library_slug))
}

function targetFromEntry(entry: LibraryPathRepairEntryRow): LibraryPathRepairTarget {
  return {
    title: entry.title,
    slug: entry.slug,
    source: "library-entry",
    useStoredEpisodeLocation: false,
  }
}

function targetFromCurrentLibrary(row: EpisodePathRepairRow): LibraryPathRepairTarget | null {
  if (!row.library_title?.trim()) {
    return null
  }

  return {
    title: row.library_title,
    slug: row.library_slug,
    source: "current-library-entry",
    useStoredEpisodeLocation: true,
  }
}

function entryForEpisodeRow(
  row: EpisodePathRepairRow,
  parsedTitle: string,
  entries: LibraryPathRepairEntryRow[]
) {
  return (
    entries.find((entry) => entry.slug === row.library_slug) ??
    findBestEntryByFolderName(row.library_title ?? parsedTitle, entries)
  )
}

function findBestEntryForTitle(
  title: string,
  row: EpisodePathRepairRow,
  entries: LibraryPathRepairEntryRow[],
  maxScore: number
) {
  return entries
    .filter((entry) => entry.slug !== row.library_slug)
    .map((entry) => ({
      entry,
      score: bestTitleScore(title, entryTitleValues(entry)),
    }))
    .filter((candidate) => candidate.score <= maxScore)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score
      }

      return right.entry.title.length - left.entry.title.length
    })[0]?.entry ?? null
}

function findBaseVariantTarget(
  parsedTitle: string,
  row: EpisodePathRepairRow,
  entries: LibraryPathRepairEntryRow[]
): LibraryPathRepairTarget | null {
  const search = normalizeComparableTitle(parsedTitle)

  if (!search) {
    return null
  }

  const strictPrefixEntry = entries
    .filter((candidate) => candidate.slug !== row.library_slug)
    .filter((candidate) =>
      entryTitleValues(candidate).some((title) =>
        hasVariantPrefix(search, normalizeComparableTitle(title))
      )
    )
    .sort((left, right) => left.title.length - right.title.length)[0]

  if (strictPrefixEntry) {
    return targetFromEntry(strictPrefixEntry)
  }

  const sourceEntry = entryForEpisodeRow(row, parsedTitle, entries)
  const broadPrefixEntry = entries
    .filter((candidate) => candidate.slug !== row.library_slug)
    .map((candidate) => {
      let bestScore: number | null = null

      for (const title of entryTitleValues(candidate)) {
        const candidateTitle = normalizeComparableTitle(title)
        let score: number | null = null

        if (hasVariantPrefix(search, candidateTitle)) {
          score = 0
        } else if (isLikelyBaseTitleForVariant(search, candidateTitle)) {
          score = localEntriesAreRelated(sourceEntry, candidate) ? 1 : 2
        }

        if (score !== null && (bestScore === null || score < bestScore)) {
          bestScore = score
        }
      }

      return bestScore === null ? null : { entry: candidate, score: bestScore }
    })
    .filter(
      (candidate): candidate is { entry: LibraryPathRepairEntryRow; score: number } =>
        candidate !== null
    )
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score
      }

      return left.entry.title.length - right.entry.title.length
    })[0]?.entry ?? null

  if (broadPrefixEntry) {
    return targetFromEntry(broadPrefixEntry)
  }

  for (const baseTitle of derivedBaseTitleCandidates(parsedTitle)) {
    const baseEntry = findBestEntryForTitle(baseTitle, row, entries, 1)

    if (baseEntry) {
      return targetFromEntry(baseEntry)
    }
  }

  return null
}

function findBestTargetEntry(
  parsedTitle: string,
  row: EpisodePathRepairRow,
  entries: LibraryPathRepairEntryRow[]
): LibraryPathRepairTarget | null {
  const baseVariantTarget = findBaseVariantTarget(parsedTitle, row, entries)

  if (baseVariantTarget) {
    return baseVariantTarget
  }

  const bestEntry = findBestEntryForTitle(parsedTitle, row, entries, 2)

  return bestEntry ? targetFromEntry(bestEntry) : null
}

function isSameLibraryFolderName(left: string | null | undefined, right: string | null | undefined) {
  return normalizeComparableTitle(left) === normalizeComparableTitle(right)
}

function findCurrentLibraryPhysicalTarget(
  parsedTitle: string,
  row: EpisodePathRepairRow,
  relativeParts: string[]
) {
  const currentTarget = targetFromCurrentLibrary(row)

  if (!currentTarget) {
    return null
  }

  const currentRootFolder = relativeParts[0]

  if (isSameLibraryFolderName(currentRootFolder, currentTarget.title)) {
    return null
  }

  return isCurrentLibraryMatch(row, parsedTitle) ? currentTarget : null
}

function targetLooksLikeBaseOfParsedTitle(
  target: LibraryPathRepairTarget,
  parsedTitle: string
) {
  return isLikelyBaseTitleForVariant(
    normalizeComparableTitle(parsedTitle),
    normalizeComparableTitle(target.title)
  )
}

function repairTargetRank(parsedTitle: string, target: LibraryPathRepairTarget) {
  if (targetLooksLikeBaseOfParsedTitle(target, parsedTitle)) {
    return 0
  }

  const directScore = bestTitleScore(parsedTitle, [target.title])

  if (directScore <= 1) {
    return target.source === "current-library-entry" ? 3 : 1
  }

  if (directScore <= 2.5) {
    return 2
  }

  return 4
}

function pickBestRepairTarget(
  parsedTitle: string,
  targets: Array<LibraryPathRepairTarget | null>
) {
  return targets
    .filter((target): target is LibraryPathRepairTarget => target !== null)
    .sort((left, right) => {
      const leftRank = repairTargetRank(parsedTitle, left)
      const rightRank = repairTargetRank(parsedTitle, right)

      if (leftRank !== rightRank) {
        return leftRank - rightRank
      }

      return left.title.length - right.title.length
    })[0] ?? null
}

function findPhysicalTargetForTitle(
  parsedTitle: string,
  relativeParts: string[],
  directories: PhysicalLibraryDirectory[],
  entries: LibraryPathRepairEntryRow[]
): LibraryPathRepairTarget | null {
  const normalizedParsedTitle = normalizeComparableTitle(parsedTitle)
  const currentRootName = relativeParts[0]

  if (!normalizedParsedTitle) {
    return null
  }

  const candidates = directories
    .filter((directory) => !isSameLibraryFolderName(directory.name, currentRootName))
    .map((directory): PhysicalDirectoryRepairCandidate | null => {
      const entry = findBestEntryByFolderName(directory.name, entries)
      const values = physicalDirectoryTitleValues(directory, entry)
      const normalizedDirectoryTitle = normalizeComparableTitle(directory.name)
      const exactScore = bestTitleScore(parsedTitle, values)
      const baseVariant = isLikelyBaseTitleForVariant(
        normalizedParsedTitle,
        normalizedDirectoryTitle
      )

      if (!baseVariant && exactScore > 1) {
        return null
      }

      return {
        directory,
        entry,
        score: baseVariant ? 0 : exactScore,
      }
    })
    .filter((candidate): candidate is PhysicalDirectoryRepairCandidate => candidate !== null)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score
      }

      return left.directory.name.length - right.directory.name.length
    })

  const candidate = candidates[0]

  return candidate ? physicalDirectoryTarget(candidate.directory, candidate.entry) : null
}

function findRepairTarget(
  parsedTitle: string,
  row: EpisodePathRepairRow,
  entries: LibraryPathRepairEntryRow[],
  directories: PhysicalLibraryDirectory[],
  relativeParts: string[]
) {
  const currentTarget = findCurrentLibraryPhysicalTarget(parsedTitle, row, relativeParts)
  const bestEntryTarget = findBestTargetEntry(parsedTitle, row, entries)
  const physicalTarget = findPhysicalTargetForTitle(
    parsedTitle,
    relativeParts,
    directories,
    entries
  )

  return pickBestRepairTarget(parsedTitle, [
    physicalTarget,
    bestEntryTarget,
    currentTarget,
  ])
}

function mediaRootRelativeParts(filePath: string) {
  const mediaRoot = path.resolve(getServerConfig().mediaDir)
  const relative = path.relative(mediaRoot, path.resolve(filePath))

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null
  }

  return relative.split(path.sep).filter(Boolean)
}

type PhysicalLibraryDirectory = {
  name: string
  path: string
}

type PhysicalDirectoryRepairCandidate = {
  directory: PhysicalLibraryDirectory
  entry: LibraryPathRepairEntryRow | null
  score: number
}

async function listTopLevelLibraryDirectories() {
  const mediaRoot = path.resolve(getServerConfig().mediaDir)
  const entries = await readdir(mediaRoot, { withFileTypes: true }).catch(() => [])

  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry): PhysicalLibraryDirectory => ({
      name: entry.name,
      path: path.join(mediaRoot, entry.name),
    }))
}

function physicalDirectoryTarget(
  directory: PhysicalLibraryDirectory,
  entry: LibraryPathRepairEntryRow | null
): LibraryPathRepairTarget {
  return {
    title: directory.name,
    slug: entry?.slug ?? null,
    source: "physical-library-folder",
    useStoredEpisodeLocation: false,
  }
}

function physicalDirectoryBaseCandidateScore(
  sourceTitle: string,
  candidateTitle: string,
  sourceEntry: LibraryPathRepairEntryRow | null,
  candidateEntry: LibraryPathRepairEntryRow | null
) {
  if (!hasKnownBaseTitlePrefix(sourceTitle, candidateTitle)) {
    return null
  }

  if (hasVariantPrefix(sourceTitle, candidateTitle)) {
    return 0
  }

  if (localEntriesAreRelated(sourceEntry, candidateEntry)) {
    return 1
  }

  if (isLikelyBaseTitleForVariant(sourceTitle, candidateTitle)) {
    return 2
  }

  return null
}

function findPhysicalDirectoryRepairTarget(
  source: PhysicalLibraryDirectory,
  directories: PhysicalLibraryDirectory[],
  entries: LibraryPathRepairEntryRow[]
): LibraryPathRepairTarget | null {
  const sourceTitle = normalizeComparableTitle(source.name)

  if (!sourceTitle) {
    return null
  }

  const sourceEntry = findBestEntryByFolderName(source.name, entries)
  const candidates = directories
    .filter((directory) => directory.path !== source.path)
    .map((directory): PhysicalDirectoryRepairCandidate | null => {
      const candidateTitle = normalizeComparableTitle(directory.name)

      if (!candidateTitle) {
        return null
      }

      const candidateEntry = findBestEntryByFolderName(directory.name, entries)
      const score = physicalDirectoryBaseCandidateScore(
        sourceTitle,
        candidateTitle,
        sourceEntry,
        candidateEntry
      )

      if (score === null) {
        return null
      }

      return {
        directory,
        entry: candidateEntry,
        score,
      }
    })
    .filter((candidate): candidate is PhysicalDirectoryRepairCandidate => candidate !== null)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score
      }

      return left.directory.name.length - right.directory.name.length
    })

  const candidate = candidates[0]

  return candidate ? physicalDirectoryTarget(candidate.directory, candidate.entry) : null
}


function physicalDirectoryTitleValues(
  directory: PhysicalLibraryDirectory,
  entry: LibraryPathRepairEntryRow | null
) {
  return entry ? [directory.name, ...entryTitleValues(entry)] : [directory.name]
}

function physicalDirectoryMatchesParsedTitle(
  directory: PhysicalLibraryDirectory,
  parsedTitle: string
) {
  const normalizedParsedTitle = normalizeComparableTitle(parsedTitle)
  const normalizedDirectoryTitle = normalizeComparableTitle(directory.name)

  return (
    bestTitleScore(parsedTitle, [directory.name]) <= 1 ||
    isLikelyBaseTitleForVariant(normalizedParsedTitle, normalizedDirectoryTitle)
  )
}

function findPhysicalFileRepairTarget(
  parsedTitle: string,
  sourceDirectory: PhysicalLibraryDirectory,
  directories: PhysicalLibraryDirectory[],
  entries: LibraryPathRepairEntryRow[]
): LibraryPathRepairTarget | null {
  const normalizedParsedTitle = normalizeComparableTitle(parsedTitle)

  if (!normalizedParsedTitle || physicalDirectoryMatchesParsedTitle(sourceDirectory, parsedTitle)) {
    return null
  }

  const candidates = directories
    .filter((directory) => directory.path !== sourceDirectory.path)
    .map((directory): PhysicalDirectoryRepairCandidate | null => {
      const entry = findBestEntryByFolderName(directory.name, entries)
      const values = physicalDirectoryTitleValues(directory, entry)
      const normalizedDirectoryTitle = normalizeComparableTitle(directory.name)
      const baseVariant = isLikelyBaseTitleForVariant(
        normalizedParsedTitle,
        normalizedDirectoryTitle
      )
      const titleScore = bestTitleScore(parsedTitle, values)

      if (!baseVariant && titleScore > 1) {
        return null
      }

      return {
        directory,
        entry,
        score: baseVariant ? 0 : 1,
      }
    })
    .filter((candidate): candidate is PhysicalDirectoryRepairCandidate => candidate !== null)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score
      }

      return left.directory.name.length - right.directory.name.length
    })

  const candidate = candidates[0]

  return candidate ? physicalDirectoryTarget(candidate.directory, candidate.entry) : null
}

async function walkLibraryMediaFiles(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files: string[] = []

  for (const [index, entry] of entries.entries()) {
    if (index > 0 && index % 50 === 0) {
      await yieldToEventLoop()
    }

    const entryPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      files.push(...(await walkLibraryMediaFiles(entryPath)))
      continue
    }

    if (entry.isFile() && isMediaFile(entryPath)) {
      files.push(entryPath)
    }
  }

  return files
}

async function directoryHasMediaFiles(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => null)

  if (!entries) {
    return false
  }

  for (const [index, entry] of entries.entries()) {
    if (index > 0 && index % 50 === 0) {
      await yieldToEventLoop()
    }

    const entryPath = path.join(directory, entry.name)

    if (entry.isFile() && isMediaFile(entryPath)) {
      return true
    }

    if (entry.isDirectory() && (await directoryHasMediaFiles(entryPath))) {
      return true
    }
  }

  return false
}

async function removeDirectoryTreeIfNoMedia(directory: string) {
  const mediaRoot = path.resolve(getServerConfig().mediaDir)
  const resolvedDirectory = path.resolve(directory)

  if (!isInsideDirectory(mediaRoot, resolvedDirectory)) {
    return false
  }

  if (await directoryHasMediaFiles(resolvedDirectory)) {
    return false
  }

  await rm(resolvedDirectory, { recursive: true, force: true })
  return true
}

const romanSeasonValues: Record<string, number> = {
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
}

function inferSeasonFromVariantTitle(title: string) {
  const normalized = normalizeComparableTitle(title)
  const explicitSeason = /\b(?:season|s)\s*(\d{1,2})\b/i.exec(normalized)?.[1]
  const ordinalSeason = /\b(\d{1,2})(?:st|nd|rd|th)?\s+season\b/i.exec(normalized)?.[1]
  const numericSeason = Number.parseInt(explicitSeason ?? ordinalSeason ?? "", 10)

  if (Number.isFinite(numericSeason) && numericSeason > 1) {
    return numericSeason
  }

  const suffix = normalized.split(" ").filter(Boolean).at(-1)

  if (!suffix) {
    return null
  }

  if (suffix === "0" || suffix === "zero") {
    return 2
  }

  return romanSeasonValues[suffix] ?? null
}

function targetLocationFromParsedTitle(
  parsed: NonNullable<ReturnType<typeof parseAnimeFilePath>>
) {
  const inferredSeason = inferSeasonFromVariantTitle(parsed.title)

  if (inferredSeason) {
    return { season: inferredSeason, part: parsed.part }
  }

  return { season: parsed.season, part: parsed.part }
}

function targetLocationForRepair(input: {
  target: LibraryPathRepairTarget
  row: EpisodePathRepairRow
  parsed: NonNullable<ReturnType<typeof parseAnimeFilePath>>
}) {
  if (input.target.useStoredEpisodeLocation) {
    return { season: input.row.season_nr, part: undefined }
  }

  return targetLocationFromParsedTitle(input.parsed)
}

function targetPathForRepair(input: {
  target: LibraryPathRepairTarget
  sourcePath: string
  season: number
  part?: number
}) {
  const mediaRoot = path.resolve(getServerConfig().mediaDir)
  const safeLibraryTitle = sanitizeExportPathPart(input.target.title)
  const sourceFileName = path.basename(input.sourcePath)

  if (!safeLibraryTitle || !sourceFileName) {
    return null
  }

  return path.join(
    mediaRoot,
    safeLibraryTitle,
    formatSeasonFolderName(input.season, input.part),
    sourceFileName
  )
}

function samePath(left: string, right: string) {
  const leftPath = path.resolve(left)
  const rightPath = path.resolve(right)

  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath
}

function isInsideDirectory(root: string, targetPath: string) {
  const relative = path.relative(path.resolve(root), path.resolve(targetPath))

  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  )
}

async function removeEmptyLibraryParents(startDirectory: string) {
  const mediaRoot = path.resolve(getServerConfig().mediaDir)
  let current = path.resolve(startDirectory)

  while (isInsideDirectory(mediaRoot, current)) {
    const entries = await readdir(current).catch(() => null)

    if (!entries || entries.length > 0) {
      return
    }

    await rmdir(current).catch(() => undefined)
    current = path.dirname(current)
  }
}

async function moveFile(sourcePath: string, destinationPath: string) {
  await mkdir(path.dirname(destinationPath), { recursive: true })

  try {
    await rename(sourcePath, destinationPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error
    }

    await copyFile(sourcePath, destinationPath)
    await rm(sourcePath, { force: true })
  }
}

async function moveSubtitleSidecarIfNeeded(sourcePath: string, destinationPath: string) {
  const sourceSidecar = subtitleSidecarPathForMediaFile(sourcePath)

  if (!(await fileExists(sourceSidecar))) {
    return
  }

  const destinationSidecar = subtitleSidecarPathForMediaFile(destinationPath)

  if (samePath(sourceSidecar, destinationSidecar)) {
    return
  }

  if (await pathExists(destinationSidecar)) {
    console.warn(
      `[Warn] [Library] Skipped subtitle sidecar relocation because destination already exists - ${destinationSidecar}`
    )
    return
  }

  await moveFile(sourceSidecar, destinationSidecar)
  await removeEmptyLibraryParents(path.dirname(sourceSidecar))
}

async function filesHaveSameSize(leftPath: string, rightPath: string) {
  const [left, right] = await Promise.all([
    stat(leftPath).catch(() => null),
    stat(rightPath).catch(() => null),
  ])

  return Boolean(left && right && left.isFile() && right.isFile() && left.size === right.size)
}

async function removeDuplicateSourceFile(sourcePath: string, destinationPath: string) {
  if (!(await filesHaveSameSize(sourcePath, destinationPath))) {
    return false
  }

  await moveSubtitleSidecarIfNeeded(sourcePath, destinationPath)
  await rm(sourcePath, { force: true })
  return true
}

function listEpisodePathRepairRows() {
  return getDb()
    .query<EpisodePathRepairRow>(
      `
      SELECT
        e.anime_id,
        e.season_nr,
        e.ep_nr,
        e.file_path,
        a.library_slug,
        le.title AS library_title,
        a.title_romaji,
        a.title_english,
        a.title_native,
        a.title_user_preferred
      FROM episodes e
      INNER JOIN anime a ON a.id = e.anime_id
      LEFT JOIN library_entries le ON le.slug = a.library_slug
      ORDER BY e.file_path ASC
    `
    )
    .all()
}

function listLibraryPathRepairEntries() {
  return getDb()
    .query<LibraryPathRepairEntryRow>(
      `
      SELECT
        le.slug,
        le.title,
        le.primary_anime_id,
        a.title_romaji,
        a.title_english,
        a.title_native,
        a.title_user_preferred
      FROM library_entries le
      LEFT JOIN anime a ON a.id = le.primary_anime_id
      ORDER BY le.title ASC
    `
    )
    .all()
}

async function repairPhysicalLibraryFile(
  sourcePath: string,
  sourceDirectory: PhysicalLibraryDirectory,
  target: LibraryPathRepairTarget
): Promise<EpisodePathRepairResult> {
  const parsed = parseAnimeFilePath(sourcePath, {
    rootDir: getServerConfig().mediaDir,
    fallbackTitles: [sourceDirectory.name],
  })

  if (!parsed?.title || !parsed.season || !parsed.episode) {
    return { status: "skipped" }
  }

  const targetLocation = targetLocationFromParsedTitle(parsed)
  const destinationPath = targetPathForRepair({
    target,
    sourcePath,
    season: targetLocation.season,
    part: targetLocation.part,
  })

  if (!destinationPath || samePath(sourcePath, destinationPath)) {
    return { status: "skipped" }
  }

  if (await pathExists(destinationPath)) {
    if (await removeDuplicateSourceFile(sourcePath, destinationPath)) {
      deleteEpisodeByPath(sourcePath)
      await removeEpisodeThumbnails(sourcePath).catch(() => undefined)
      await removeEmptyLibraryParents(path.dirname(sourcePath))

      console.warn(
        `[Warn] [Library] Removed duplicate misplaced physical library file because the corrected destination already exists - ${fileName(sourcePath)} -> ${destinationPath}`
      )

      return { status: "repaired", destinationPath }
    }

    console.warn(
      `[Warn] [Library] Skipped physical library folder repair because destination already exists with different size - ${fileName(sourcePath)} -> ${destinationPath}`
    )
    return { status: "skipped" }
  }

  console.warn(
    `[Warn] [Library] Repairing misplaced physical library file without AniList lookup - ${fileName(sourcePath)}: ${sourceDirectory.name} -> ${target.title}`
  )

  await moveFile(sourcePath, destinationPath)
  await moveSubtitleSidecarIfNeeded(sourcePath, destinationPath)
  deleteEpisodeByPath(sourcePath)
  await removeEpisodeThumbnails(sourcePath).catch(() => undefined)
  await removeEmptyLibraryParents(path.dirname(sourcePath))

  console.log(
    `[Info] [Library] Moved misplaced physical library file for resync - ${destinationPath}`
  )

  return { status: "repaired", destinationPath }
}

async function repairPhysicalDirectoryMismatchedFiles(
  directory: PhysicalLibraryDirectory,
  directories: PhysicalLibraryDirectory[],
  entries: LibraryPathRepairEntryRow[]
): Promise<LibraryPathRepairResult> {
  const mediaFiles = await walkLibraryMediaFiles(directory.path)
  const result: LibraryPathRepairResult = {
    scanned: mediaFiles.length,
    repaired: 0,
    missing: 0,
    skipped: 0,
    repairedPaths: [],
  }

  for (const [index, mediaFile] of mediaFiles.entries()) {
    try {
      const parsed = parseAnimeFilePath(mediaFile, {
        rootDir: getServerConfig().mediaDir,
        fallbackTitles: [directory.name],
      })

      if (!parsed?.title || !parsed.season || !parsed.episode) {
        result.skipped += 1
        continue
      }

      const target = findPhysicalFileRepairTarget(
        parsed.title,
        directory,
        directories,
        entries
      )

      if (!target) {
        result.skipped += 1
        continue
      }

      const repair = await repairPhysicalLibraryFile(mediaFile, directory, target)
      result[repair.status] += 1

      if (repair.status === "repaired") {
        result.repairedPaths.push(repair.destinationPath)
      }
    } catch (error) {
      result.skipped += 1
      console.error(
        `[Error] [Library] Physical library file mismatch repair failed - ${mediaFile} - ${errorMessage(error)}`
      )
    }

    if (index % 25 === 24) {
      await yieldToEventLoop()
    }
  }

  await removeDirectoryTreeIfNoMedia(directory.path).catch(() => false)

  return result
}

function mergeLibraryPathRepairResult(
  target: LibraryPathRepairResult,
  source: LibraryPathRepairResult
) {
  target.scanned += source.scanned
  target.repaired += source.repaired
  target.missing += source.missing
  target.skipped += source.skipped
  target.repairedPaths.push(...source.repairedPaths)
}

async function consolidatePhysicalLibraryFolders(
  entries: LibraryPathRepairEntryRow[]
): Promise<LibraryPathRepairResult> {
  const directories = await listTopLevelLibraryDirectories()
  const result: LibraryPathRepairResult = {
    scanned: 0,
    repaired: 0,
    missing: 0,
    skipped: 0,
    repairedPaths: [],
  }

  for (const [directoryIndex, directory] of directories.entries()) {
    const target = findPhysicalDirectoryRepairTarget(directory, directories, entries)

    if (!target) {
      continue
    }

    const mediaFiles = await walkLibraryMediaFiles(directory.path)
    result.scanned += mediaFiles.length

    if (mediaFiles.length === 0) {
      const removed = await removeDirectoryTreeIfNoMedia(directory.path).catch(() => false)

      if (removed) {
        console.warn(
          `[Warn] [Library] Removed empty misplaced library folder without AniList lookup - ${directory.name} -> ${target.title}`
        )
      } else {
        result.skipped += 1
      }

      continue
    }

    console.warn(
      `[Warn] [Library] Consolidating misplaced library folder without AniList lookup - ${directory.name} -> ${target.title}`
    )

    for (const [fileIndex, mediaFile] of mediaFiles.entries()) {
      try {
        const repair = await repairPhysicalLibraryFile(mediaFile, directory, target)
        result[repair.status] += 1

        if (repair.status === "repaired") {
          result.repairedPaths.push(repair.destinationPath)
        }
      } catch (error) {
        result.skipped += 1
        console.error(
          `[Error] [Library] Physical library folder repair failed - ${mediaFile} - ${errorMessage(error)}`
        )
      }

      if (fileIndex % 25 === 24) {
        await yieldToEventLoop()
      }
    }

    const removed = await removeDirectoryTreeIfNoMedia(directory.path).catch(() => false)

    if (removed) {
      console.warn(
        `[Warn] [Library] Removed empty misplaced library folder after consolidation - ${directory.name}`
      )
    }

    if (directoryIndex % 10 === 9) {
      await yieldToEventLoop()
    }
  }

  return result
}

async function repairPhysicalDirectoryFileMismatches(
  entries: LibraryPathRepairEntryRow[]
): Promise<LibraryPathRepairResult> {
  const directories = await listTopLevelLibraryDirectories()
  const result: LibraryPathRepairResult = {
    scanned: 0,
    repaired: 0,
    missing: 0,
    skipped: 0,
    repairedPaths: [],
  }

  for (const [index, directory] of directories.entries()) {
    const directoryResult = await repairPhysicalDirectoryMismatchedFiles(
      directory,
      directories,
      entries
    )

    mergeLibraryPathRepairResult(result, directoryResult)

    if (index % 10 === 9) {
      await yieldToEventLoop()
    }
  }

  return result
}

async function repairPhysicalLibraryFolders(
  entries: LibraryPathRepairEntryRow[]
): Promise<LibraryPathRepairResult> {
  const result: LibraryPathRepairResult = {
    scanned: 0,
    repaired: 0,
    missing: 0,
    skipped: 0,
    repairedPaths: [],
  }

  for (let pass = 0; pass < 2; pass += 1) {
    const folderRepair = await consolidatePhysicalLibraryFolders(entries)
    mergeLibraryPathRepairResult(result, folderRepair)

    const mismatchRepair = await repairPhysicalDirectoryFileMismatches(entries)
    mergeLibraryPathRepairResult(result, mismatchRepair)

    if (folderRepair.repaired === 0 && mismatchRepair.repaired === 0) {
      break
    }
  }

  return result
}


async function repairEpisodePath(
  row: EpisodePathRepairRow,
  entries: LibraryPathRepairEntryRow[],
  directories: PhysicalLibraryDirectory[]
): Promise<EpisodePathRepairResult> {
  const sourcePath = path.resolve(row.file_path)

  if (isLocalNonAnimeId(row.anime_id) || !isMediaFile(sourcePath)) {
    return { status: "skipped" }
  }

  if (!(await pathExists(sourcePath))) {
    return { status: "missing" }
  }

  const relativeParts = mediaRootRelativeParts(sourcePath)

  if (!relativeParts || relativeParts.length < 3) {
    return { status: "skipped" }
  }

  const parsed = parseAnimeFilePath(sourcePath, {
    rootDir: getServerConfig().mediaDir,
    fallbackTitles: episodeCurrentTitleValues(row),
  })

  if (!parsed?.title || !parsed.season || !parsed.episode) {
    return { status: "skipped" }
  }

  const target = findRepairTarget(parsed.title, row, entries, directories, relativeParts)

  if (!target) {
    return { status: "skipped" }
  }

  const targetLocation = targetLocationForRepair({ target, row, parsed })
  const destinationPath = targetPathForRepair({
    target,
    sourcePath,
    season: targetLocation.season,
    part: targetLocation.part,
  })

  if (!destinationPath || samePath(sourcePath, destinationPath)) {
    return { status: "skipped" }
  }

  if (await pathExists(destinationPath)) {
    if (await removeDuplicateSourceFile(sourcePath, destinationPath)) {
      deleteEpisodeByPath(row.file_path)
      await removeEpisodeThumbnails(row.file_path).catch(() => undefined)
      await removeEmptyLibraryParents(path.dirname(sourcePath))

      console.warn(
        `[Warn] [Library] Removed duplicate misplaced library file because the corrected destination already exists - ${fileName(sourcePath)} -> ${destinationPath}`
      )

      return { status: "repaired", destinationPath }
    }

    console.warn(
      `[Warn] [Library] Skipped library mismatch repair because destination already exists with different size - ${fileName(sourcePath)} -> ${destinationPath}`
    )
    return { status: "skipped" }
  }

  console.warn(
    `[Warn] [Library] Repairing misplaced library file without AniList lookup - ${fileName(sourcePath)}: ${row.library_title ?? row.library_slug ?? "unknown"} -> ${target.title}`
  )

  await moveFile(sourcePath, destinationPath)
  await moveSubtitleSidecarIfNeeded(sourcePath, destinationPath)
  deleteEpisodeByPath(row.file_path)
  await removeEpisodeThumbnails(row.file_path).catch(() => undefined)
  await removeEmptyLibraryParents(path.dirname(sourcePath))

  console.log(
    `[Info] [Library] Moved misplaced library file for resync - ${destinationPath}`
  )

  return { status: "repaired", destinationPath }
}

export async function repairLibraryPathMismatches(): Promise<LibraryPathRepairResult> {
  const rows = listEpisodePathRepairRows()
  const entries = listLibraryPathRepairEntries()
  const directories = await listTopLevelLibraryDirectories()
  const result: LibraryPathRepairResult = {
    scanned: rows.length,
    repaired: 0,
    missing: 0,
    skipped: 0,
    repairedPaths: [],
  }

  for (const [index, row] of rows.entries()) {
    try {
      const repair = await repairEpisodePath(row, entries, directories)
      result[repair.status] += 1

      if (repair.status === "repaired") {
        result.repairedPaths.push(repair.destinationPath)
      }
    } catch (error) {
      result.skipped += 1
      console.error(
        `[Error] [Library] Library path repair failed - ${row.file_path} - ${errorMessage(error)}`
      )
    }

    if (index % 25 === 24) {
      await yieldToEventLoop()
    }
  }

  const physicalRepair = await repairPhysicalLibraryFolders(entries)
  result.scanned += physicalRepair.scanned
  result.repaired += physicalRepair.repaired
  result.missing += physicalRepair.missing
  result.skipped += physicalRepair.skipped
  result.repairedPaths.push(...physicalRepair.repairedPaths)

  debugLibraryPathRepair(
    `Finished library path repair scan - Scanned ${result.scanned}, Repaired ${result.repaired}, Missing ${result.missing}, Skipped ${result.skipped}`
  )

  return result
}
