import path from "node:path"

import { parsePositiveInt } from "@/server/utils/format"

const leadingBracketSegmentPattern = /^\s*(?:\[[^\]]*\]|\{[^}]*\}|\([^)]*\))[\s._-]*/
const squareOrCurlyBracketPattern = /\[[^\]]*\]|\{[^}]*\}/g
const parentheticalPattern = /\(([^)]*)\)/g
const hashPattern = /\b[A-F0-9]{8,}\b/gi
const ignoredLeadingStrings = [
  "Anime Time",
  "Erai-raws",
  "Judas",
  "EMBER",
  "TRC",
  "DKB",
  "sam",
].sort((left, right) => right.length - left.length)

export type ParsedAnimeFileName = {
  title: string
  season: number
  episode: number
  part?: number
  episodeTitle?: string | null
  hasExplicitSeason?: boolean
  titleSource?: "filename" | "folder"
  mediaKind?: "episode" | "movie"
}

type ParsedAnimeEpisodeIdentifier = Omit<ParsedAnimeFileName, "title">

const fileInfoPattern = /\b(?:480p|576p|720p|1080p|1440p|2160p|4k|uhd|hdr|hdr10|sdr|bluray|blu[-\s]?ray|bdremux|bdrip|bd|web[-\s]?dl|webdl|webrip|remux|hdtv|dvd|dvdrip|x264|x265|h\.?264|h\.?265|hevc|avc|av1|aac|flac|opus|mp3|ac3|eac3|dd|ddp|dts|truehd|atmos|audio|dual[-\s]*audio|multi[-\s]*audio|multi[-\s]*subs?|dubbed|subbed|subs?|\d{1,2}[-\s]*bits?|hi10p|proper|repack|batch)\b/gi
const releaseSuffixPattern = /\s*[-–—]\s*[A-Z0-9][A-Z0-9._-]{1,}$/gi

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function toCaseFold(value: string) {
  return value.toLowerCase()
}

function normalizeUnicode(value: string) {
  return value.normalize("NFKC")
}

function releaseGroupPatternFor(value: string) {
  const normalized = toCaseFold(value.trim())
  const pattern = normalized
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => escapeRegExp(part))
    .join("[\\s._-]+")

  return pattern
    ? new RegExp(String.raw`^${pattern}(?=$|[\s._-]+)`, "i")
    : /^$/
}

const ignoredLeadingReleaseGroupPatterns = ignoredLeadingStrings.map((releaseGroup) =>
  releaseGroupPatternFor(releaseGroup)
)

function stripLeadingIgnoredReleaseGroups(value: string) {
  let title = value.trim()

  for (;;) {
    const previous = title

    for (const releaseGroupPattern of ignoredLeadingReleaseGroupPatterns) {
      title = title
        .replace(releaseGroupPattern, "")
        .replace(/^[\s._-]+/, "")
        .trim()
    }

    if (title === previous) {
      return title
    }
  }
}

function isIgnoredReleaseGroupName(value: string) {
  const normalized = toCaseFold(value).replace(/[\s._-]+/g, " ").trim()

  return ignoredLeadingStrings.some(
    (releaseGroup) =>
      normalized === toCaseFold(releaseGroup).replace(/[\s._-]+/g, " ").trim()
  )
}

function isTitleDisambiguationYear(value: string) {
  return /^(?:19|20)\d{2}$/.test(value.trim())
}

function shouldStripParentheticalSegment(value: string) {
  const segment = value.trim()

  if (!segment) {
    return true
  }

  if (isTitleDisambiguationYear(segment)) {
    return false
  }

  if (isIgnoredReleaseGroupName(segment)) {
    return true
  }

  if (/^\d{1,3}$/.test(segment)) {
    return true
  }

  if (/^(?:v\d+|vol\.?\s*\d+|disc\s*\d+|cd\s*\d+)$/i.test(segment)) {
    return true
  }

  if (/^[A-F0-9]{8,}$/i.test(segment)) {
    return true
  }

  if (/\b(?:complete|collection|batch|seasons?|movies?|films?|specials?|ovas?|onas?)\b/i.test(segment)) {
    return true
  }

  fileInfoPattern.lastIndex = 0

  if (fileInfoPattern.test(segment)) {
    fileInfoPattern.lastIndex = 0
    return true
  }

  fileInfoPattern.lastIndex = 0

  return false
}

function stripLeadingBracketSegments(value: string) {
  let title = value

  for (;;) {
    const strippedTitle = title.replace(leadingBracketSegmentPattern, "")

    if (strippedTitle === title) {
      return title
    }

    title = strippedTitle
  }
}

function stripIgnoredBracketSegments(value: string) {
  return stripLeadingIgnoredReleaseGroups(stripLeadingBracketSegments(value))
    .replace(squareOrCurlyBracketPattern, " ")
    .replace(parentheticalPattern, (match, segment: string) =>
      shouldStripParentheticalSegment(segment) ? " " : match
    )
}

function normalizeTitle(value: string) {
  return stripLeadingIgnoredReleaseGroups(
    stripIgnoredBracketSegments(normalizeUnicode(value))
      .replace(hashPattern, " ")
      .replace(/[._]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  )
}

function cleanTitleSegment(value: string) {
  let title = normalizeTitle(value)
    .replace(fileInfoPattern, " ")
    .replace(releaseSuffixPattern, " ")
    .replace(/\b(?:v\d+)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()

  for (;;) {
    const nextTitle = title
      .replace(releaseSuffixPattern, " ")
      .replace(/(?:\s*[-–—]\s*)+$/g, "")
      .replace(/^[\s:;,.\-–—]+|[\s:;,.\-–—]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()

    if (nextTitle === title) {
      return title
    }

    title = nextTitle
  }
}

export function cleanAnimeTitleCandidate(
  value: string,
  options?: { season?: number; part?: number; removeLooseSeasonMarkers?: boolean }
) {
  let title = cleanTitleSegment(value)
  const { season, part, removeLooseSeasonMarkers } = options ?? {}

  if (part && part > 1) {
    title = title
      .replace(
        new RegExp(
          String.raw`\s+(?:part|pt\.?|cour|p|c)\s*(?:0?${part}|[ivx]+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|[4-9]th|10th)$`,
          "i"
        ),
        ""
      )
      .replace(
        new RegExp(
          String.raw`\s+(?:0?${part}|[ivx]+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|[4-9]th|10th)\s+(?:cour|half)$`,
          "i"
        ),
        ""
      )
  }

  if (removeLooseSeasonMarkers) {
    title = title.replace(/\b(?:season|s)\s*\d{1,2}\b/gi, " ")
  } else if (season) {
    title = title.replace(
      new RegExp(String.raw`\s+(?:season\s*0?${season}|s\s*0?${season})$`, "i"),
      ""
    )
  }

  return cleanTitleSegment(title)
}

function romanNumeralForSeason(season: number) {
  switch (season) {
    case 1:
      return "i"
    case 2:
      return "ii"
    case 3:
      return "iii"
    case 4:
      return "iv"
    case 5:
      return "v"
    case 6:
      return "vi"
    case 7:
      return "vii"
    case 8:
      return "viii"
    case 9:
      return "ix"
    case 10:
      return "x"
    default:
      return null
  }
}

function cleanSeriesTitleSegment(value: string, season?: number, part?: number) {
  let title = cleanAnimeTitleCandidate(value, { season, part })

  if (season && season > 0) {
    const seasonRoman = romanNumeralForSeason(season)

    title = title
      .replace(/\s+(?:season\s*\d{1,2}|s\s*\d{1,2})$/i, "")
      .replace(/\s+\d{1,2}(?:st|nd|rd|th)?\s+season$/i, "")
      .replace(
        /\s+(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season$/i,
        ""
      )
      .trim()

    if (seasonRoman) {
      title = title
        .replace(new RegExp(String.raw`\s+${seasonRoman}$`, "i"), "")
        .trim()
    }
  }

  return cleanTitleSegment(title)
}

function cleanEpisodeTitleSegment(value: string | undefined) {
  if (!value) {
    return null
  }

  const title = cleanTitleSegment(value)
    .replace(/^(?:-|–|—|:)+/g, "")
    .replace(/\s+/g, " ")
    .trim()

  return title || null
}

function toPositiveInteger(value: string | undefined) {
  return parsePositiveInt(value)
}

const ordinalPartPattern =
  /^(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|[4-9]th|10th)$/i
const romanPartPattern = /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)$/i
const partNumberPattern = String.raw`(?:\d{1,2}|[ivx]+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|[4-9]th|10th)`
const partLabelPattern = String.raw`(?:part|pt\.?|cour|p|c)`
const separatorPattern = String.raw`(?:\s*-\s*|\s+)`
const optionalSeparatorPattern = String.raw`(?:\s*-\s*|\s*)`
const episodeVersionSuffixPattern = String.raw`(?:v\d+)?`
const seasonPartEpisodePatterns = [
  new RegExp(
    String.raw`^(.+?)${separatorPattern}Season\s*(\d{1,2})${optionalSeparatorPattern}${partLabelPattern}\s*(${partNumberPattern})${separatorPattern}S\s*\d{1,2}E(\d{1,4})${episodeVersionSuffixPattern}\b`,
    "i"
  ),
  new RegExp(
    String.raw`^(.+?)${separatorPattern}S\s*(\d{1,2})${optionalSeparatorPattern}${partLabelPattern}\s*(${partNumberPattern})${separatorPattern}S\s*\d{1,2}E(\d{1,4})${episodeVersionSuffixPattern}\b`,
    "i"
  ),
  new RegExp(
    String.raw`^(.+?)${separatorPattern}S\s*(\d{1,2})${optionalSeparatorPattern}${partLabelPattern}\s*(${partNumberPattern})${optionalSeparatorPattern}E?\s*(\d{1,4})${episodeVersionSuffixPattern}\b`,
    "i"
  ),
  new RegExp(
    String.raw`^(.+?)${separatorPattern}S\s*(\d{1,2})${optionalSeparatorPattern}(${partNumberPattern})\s*(?:cour|half)${optionalSeparatorPattern}E?\s*(\d{1,4})${episodeVersionSuffixPattern}\b`,
    "i"
  ),
  new RegExp(
    String.raw`^(.+?)${separatorPattern}Season\s*(\d{1,2})${optionalSeparatorPattern}${partLabelPattern}\s*(${partNumberPattern})${optionalSeparatorPattern}E?\s*(\d{1,4})${episodeVersionSuffixPattern}\b`,
    "i"
  ),
  new RegExp(
    String.raw`^(.+?)${separatorPattern}Season\s*(\d{1,2})${optionalSeparatorPattern}(${partNumberPattern})\s*(?:cour|half)${optionalSeparatorPattern}E?\s*(\d{1,4})${episodeVersionSuffixPattern}\b`,
    "i"
  ),
]

const noTitleSeasonPartEpisodePatterns = [
  new RegExp(
    String.raw`^Season\s*(\d{1,2})${optionalSeparatorPattern}${partLabelPattern}\s*(${partNumberPattern})${optionalSeparatorPattern}E?\s*(\d{1,4})${episodeVersionSuffixPattern}(?:\s*[-–—]\s*(.+))?$`,
    "i"
  ),
  new RegExp(
    String.raw`^S\s*(\d{1,2})${optionalSeparatorPattern}${partLabelPattern}\s*(${partNumberPattern})${optionalSeparatorPattern}E?\s*(\d{1,4})${episodeVersionSuffixPattern}(?:\s*[-–—]\s*(.+))?$`,
    "i"
  ),
  new RegExp(
    String.raw`^S\s*(\d{1,2})${optionalSeparatorPattern}(${partNumberPattern})\s*(?:cour|half)${optionalSeparatorPattern}E?\s*(\d{1,4})${episodeVersionSuffixPattern}(?:\s*[-–—]\s*(.+))?$`,
    "i"
  ),
]

const romanNumberValues: Record<string, number> = {
  i: 1,
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

const wordNumberValues: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
}

function parseRomanNumeral(value: string) {
  return romanNumberValues[toCaseFold(value)] ?? null
}

function parseWordNumber(value: string) {
  return wordNumberValues[toCaseFold(value)] ?? null
}

function parsePartNumber(value: string | undefined) {
  if (!value) {
    return null
  }

  const normalized = value.trim()
  const numeric = parsePositiveInt(normalized.replace(/(?:st|nd|rd|th)$/i, ""))

  if (numeric) {
    return numeric
  }

  if (ordinalPartPattern.test(normalized)) {
    return parseWordNumber(normalized)
  }

  if (romanPartPattern.test(normalized)) {
    return parseRomanNumeral(normalized)
  }

  return null
}

export type SeasonPartMarker = {
  season?: number
  part?: number
}

function normalizeSeasonPartMarkerValue(value: string) {
  return normalizeTitle(value)
    .replace(/([a-z])([0-9])/gi, "$1 $2")
    .replace(/([0-9])([a-z])/gi, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
}

function parsePartMarkerFromValue(value: string) {
  const labeledPartPattern = new RegExp(
    String.raw`\b(?:part|pt|p|cour|c)\s*(${partNumberPattern})\b`,
    "i"
  )
  const reversePartPattern = new RegExp(
    String.raw`\b(${partNumberPattern})\s*(?:cour|half)\b`,
    "i"
  )
  const match = labeledPartPattern.exec(value) ?? reversePartPattern.exec(value)

  return parsePartNumber(match?.[1]) ?? undefined
}

export function parseSeasonPartMarker(value: string): SeasonPartMarker | null {
  const normalized = normalizeSeasonPartMarkerValue(value)

  if (!normalized) {
    return null
  }

  const seasonMatch = /\b(?:season|s)\s*0*(\d{1,2})\b/i.exec(normalized)
  const season = toPositiveInteger(seasonMatch?.[1]) ?? undefined
  const part = parsePartMarkerFromValue(normalized)

  if (!season && !part) {
    return null
  }

  return { season, part }
}

function mergeSeasonPartMarker(
  left: SeasonPartMarker | null,
  right: SeasonPartMarker | null
): SeasonPartMarker | null {
  if (!left) {
    return right
  }

  if (!right) {
    return left
  }

  return {
    season: right.season ?? left.season,
    part: right.part ?? left.part,
  }
}

function getDirectorySeasonPartMarker(rootDir: string, filePath: string) {
  const root = path.resolve(rootDir)
  const fileDirectory = path.dirname(path.resolve(filePath))
  const relativeDirectory = path.relative(root, fileDirectory)

  if (
    !relativeDirectory ||
    relativeDirectory.startsWith("..") ||
    path.isAbsolute(relativeDirectory)
  ) {
    return null
  }

  return relativeDirectory
    .split(path.sep)
    .filter(Boolean)
    .reduce<SeasonPartMarker | null>((marker, segment) => {
      const next = parseSeasonPartMarker(segment)

      if (!next) {
        return marker
      }

      return mergeSeasonPartMarker(marker, next)
    }, null)
}

function applySeasonPartMarker(
  parsed: ParsedAnimeFileName,
  marker: SeasonPartMarker | null
): ParsedAnimeFileName {
  if (!marker || parsed.mediaKind === "movie") {
    return parsed
  }

  const season =
    !parsed.hasExplicitSeason && marker.season ? marker.season : parsed.season
  const part =
    parsed.part ??
    (marker.part && (!marker.season || marker.season === season)
      ? marker.part
      : undefined)

  if (season === parsed.season && part === parsed.part) {
    return parsed
  }

  return {
    ...parsed,
    season,
    part,
    hasExplicitSeason: parsed.hasExplicitSeason || Boolean(marker.season),
  }
}

type EpisodeMarkerMatch = {
  index: number
  end: number
  season: number
  episode: number
  part?: number
  suffix: string
}

type NoSeasonEpisodeMarkerMatch = {
  index: number
  end: number
  episode: number
  suffix: string
}

const seasonEpisodeMarkerPattern = new RegExp(
  String.raw`\b(?:Season\s*(\d{1,2})|S\s*(\d{1,2}))\s*[-–—]?\s*(?:(?:${partLabelPattern})\s*(${partNumberPattern})\s*[-–—]?\s*|(${partNumberPattern})\s*(?:cour|half)\s*[-–—]?\s*)?(?:E|EP|Episode)\s*(\d{1,4})${episodeVersionSuffixPattern}\b`,
  "i"
)

const seasonDashEpisodeMarkerPattern = /\bS\s*(\d{1,2})\s*[-–—]\s*(\d{1,4})(?:v\d+)?\b/i
const noSeasonNamedEpisodeMarkerPattern = /\b(?:E|EP|Episode)\s*(\d{1,4})(?:v\d+)?\b/i

function findEpisodeMarker(value: string): EpisodeMarkerMatch | null {
  const seasonEpisode = seasonEpisodeMarkerPattern.exec(value)

  if (seasonEpisode) {
    const season = toPositiveInteger(seasonEpisode[1] ?? seasonEpisode[2])
    const part = parsePartNumber(seasonEpisode[3] ?? seasonEpisode[4])
    const episode = toPositiveInteger(seasonEpisode[5])

    if (season && episode) {
      const end = seasonEpisode.index + seasonEpisode[0].length

      return {
        index: seasonEpisode.index,
        end,
        season,
        episode,
        part: part ?? undefined,
        suffix: value.slice(end),
      }
    }
  }

  const seasonDashEpisode = seasonDashEpisodeMarkerPattern.exec(value)

  if (seasonDashEpisode) {
    const season = toPositiveInteger(seasonDashEpisode[1])
    const episode = toPositiveInteger(seasonDashEpisode[2])

    if (season && episode) {
      const end = seasonDashEpisode.index + seasonDashEpisode[0].length

      return {
        index: seasonDashEpisode.index,
        end,
        season,
        episode,
        suffix: value.slice(end),
      }
    }
  }

  return null
}

function findNoSeasonEpisodeMarker(value: string): NoSeasonEpisodeMarkerMatch | null {
  const noSeasonEpisode = noSeasonNamedEpisodeMarkerPattern.exec(value)

  if (!noSeasonEpisode) {
    return null
  }

  const episode = toPositiveInteger(noSeasonEpisode[1])

  if (!episode) {
    return null
  }

  const end = noSeasonEpisode.index + noSeasonEpisode[0].length

  return {
    index: noSeasonEpisode.index,
    end,
    episode,
    suffix: value.slice(end),
  }
}

function getTitleBeforeEpisodeMarker(value: string, marker: EpisodeMarkerMatch) {
  const titleSegment = value.slice(0, marker.index)

  return cleanSeriesTitleSegment(titleSegment, marker.season, marker.part)
}

type InferredSeriesTitle = {
  title: string
  season: number
  hasExplicitSeason: boolean
}

function inferTrailingSeasonTitleMarker(
  value: string
): { title: string; season: number } | null {
  const title = cleanTitleSegment(value)

  if (!title) {
    return null
  }

  const labeledSeason = /^(.+?)\s+(?:season|s)\s*0*(\d{1,2})$/i.exec(title)

  if (labeledSeason) {
    const season = toPositiveInteger(labeledSeason[2])
    const cleanedTitle = cleanSeriesTitleSegment(
      labeledSeason[1] ?? "",
      season ?? undefined
    )

    if (season && cleanedTitle) {
      return { title: cleanedTitle, season }
    }
  }

  const ordinalSeason = new RegExp(
    String.raw`^(.+?)\s+(${partNumberPattern})\s+season$`,
    "i"
  ).exec(title)

  if (ordinalSeason) {
    const season = parsePartNumber(ordinalSeason[2])
    const cleanedTitle = cleanSeriesTitleSegment(
      ordinalSeason[1] ?? "",
      season ?? undefined
    )

    if (season && cleanedTitle) {
      return { title: cleanedTitle, season }
    }
  }

  const romanSeason = /^(.+?)\s+(ii|iii|iv|v|vi|vii|viii|ix|x)$/i.exec(title)

  if (romanSeason) {
    const season = parseRomanNumeral(romanSeason[2] ?? "")
    const cleanedTitle = cleanSeriesTitleSegment(
      romanSeason[1] ?? "",
      season ?? undefined
    )

    if (season && season > 1 && cleanedTitle) {
      return { title: cleanedTitle, season }
    }
  }

  return null
}

function cleanSeriesTitleSegmentWithInferredSeason(
  value: string,
  fallbackSeason = 1,
  part?: number
): InferredSeriesTitle | null {
  const inferred = inferTrailingSeasonTitleMarker(value)

  if (inferred) {
    return {
      title: inferred.title,
      season: inferred.season,
      hasExplicitSeason: true,
    }
  }

  const title = cleanSeriesTitleSegment(value, fallbackSeason, part)

  if (!title) {
    return null
  }

  return {
    title,
    season: fallbackSeason,
    hasExplicitSeason: false,
  }
}

export function parseAnimeEpisodeIdentifier(
  filePath: string
): ParsedAnimeEpisodeIdentifier | null {
  const baseName = path.basename(filePath, path.extname(filePath))
  const mainName = baseName.split("|")[0] ?? baseName
  const normalized = normalizeTitle(mainName)
  const marker = findEpisodeMarker(normalized)

  if (marker) {
    return {
      season: marker.season,
      episode: marker.episode,
      part: marker.part,
      episodeTitle: cleanEpisodeTitleSegment(marker.suffix),
      hasExplicitSeason: true,
    }
  }

  for (const pattern of noTitleSeasonPartEpisodePatterns) {
    const match = pattern.exec(normalized)

    if (!match) {
      continue
    }

    const season = toPositiveInteger(match[1])
    const part = parsePartNumber(match[2])
    const episode = toPositiveInteger(match[3])

    if (season && part && episode) {
      return {
        season,
        episode,
        part,
        episodeTitle: cleanEpisodeTitleSegment(match[4]),
        hasExplicitSeason: true,
      }
    }
  }

  const noTitleSeasonEpisode = /^S\s*(\d{1,2})\s*(?:E|EP|Episode)\s*(\d{1,4})(?:v\d+)?(?:\s*[-–—]\s*(.+))?$/i.exec(
    normalized
  )

  if (noTitleSeasonEpisode) {
    const season = toPositiveInteger(noTitleSeasonEpisode[1])
    const episode = toPositiveInteger(noTitleSeasonEpisode[2])

    if (season && episode) {
      return {
        season,
        episode,
        episodeTitle: cleanEpisodeTitleSegment(noTitleSeasonEpisode[3]),
        hasExplicitSeason: true,
      }
    }
  }

  const noTitleSeasonDashEpisode = /^S\s*(\d{1,2})\s*[-\s]\s*(\d{1,4})(?:v\d+)?(?:\s*[-–—]\s*(.+))?$/i.exec(
    normalized
  )

  if (noTitleSeasonDashEpisode) {
    const season = toPositiveInteger(noTitleSeasonDashEpisode[1])
    const episode = toPositiveInteger(noTitleSeasonDashEpisode[2])

    if (season && episode) {
      return {
        season,
        episode,
        episodeTitle: cleanEpisodeTitleSegment(noTitleSeasonDashEpisode[3]),
        hasExplicitSeason: true,
      }
    }
  }

  const noTitleNamedEpisode = /^(?:E|EP|Episode)\s*(\d{1,4})(?:v\d+)?(?:\s*[-–—]\s*(.+))?$/i.exec(
    normalized
  )

  if (noTitleNamedEpisode) {
    const episode = toPositiveInteger(noTitleNamedEpisode[1])

    if (episode) {
      return {
        season: 1,
        episode,
        episodeTitle: cleanEpisodeTitleSegment(noTitleNamedEpisode[2]),
        hasExplicitSeason: false,
      }
    }
  }

  const noTitleDashEpisode = /^(\d{1,3})(?:v\d+)?\s*[-–—]\s*(.+)$/i.exec(
    normalized
  )

  if (noTitleDashEpisode) {
    const episode = toPositiveInteger(noTitleDashEpisode[1])

    if (episode) {
      return {
        season: 1,
        episode,
        episodeTitle: cleanEpisodeTitleSegment(noTitleDashEpisode[2]),
        hasExplicitSeason: false,
      }
    }
  }

  const noTitlePlainEpisode = /^(\d{1,3})(?:v\d+)?$/i.exec(normalized)

  if (noTitlePlainEpisode) {
    const episode = toPositiveInteger(noTitlePlainEpisode[1])

    if (episode) {
      return {
        season: 1,
        episode,
        episodeTitle: null,
        hasExplicitSeason: false,
      }
    }
  }

  return null
}

export function parseAnimeFileNameWithFallbackTitle(
  filePath: string,
  title: string
): ParsedAnimeFileName | null {
  const episode = parseAnimeEpisodeIdentifier(filePath)

  if (!episode) {
    return null
  }

  const titleWithSeason = episode.hasExplicitSeason
    ? {
        title: cleanSeriesTitleSegment(title, episode.season, episode.part),
        season: episode.season,
        hasExplicitSeason: true,
      }
    : cleanSeriesTitleSegmentWithInferredSeason(title, episode.season, episode.part)

  if (!titleWithSeason?.title) {
    return null
  }

  return {
    title: titleWithSeason.title,
    season: titleWithSeason.season,
    episode: episode.episode,
    part: episode.part,
    episodeTitle: episode.episodeTitle,
    hasExplicitSeason: episode.hasExplicitSeason || titleWithSeason.hasExplicitSeason,
    titleSource: "folder",
  }
}

export function cleanFolderTitleCandidate(value: string) {
  const marker = parseSeasonPartMarker(value)
  const expandedValue = value
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")

  return cleanAnimeTitleCandidate(expandedValue, {
    season: marker?.season,
    part: marker?.part,
    removeLooseSeasonMarkers: !marker?.season,
  })
    .replace(/\b(?:movies|films)\b$/i, " ")
    .replace(/\b(?:complete\s+series|complete\s+collection|complete|batch)\b$/i, " ")
    .replace(/[-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

const ignoredFolderTitleCandidates = new Set([
  "_failed_imports",
  "season",
  "seasons",
  "special",
  "specials",
  "ova",
  "ovas",
  "movie",
  "movies",
  "extra",
  "extras",
  "episode",
  "episodes",
  "done",
])

function isIgnoredFolderTitleCandidate(value: string) {
  const normalized = toCaseFold(value.trim())
  const marker = parseSeasonPartMarker(normalized)
  const markerOnly = marker
    ? !cleanAnimeTitleCandidate(normalized, {
        season: marker.season,
        part: marker.part,
        removeLooseSeasonMarkers: !marker.season,
      })
    : false

  return (
    !normalized ||
    markerOnly ||
    ignoredFolderTitleCandidates.has(normalized) ||
    /^s\d{1,2}$/i.test(normalized) ||
    /^season\s*\d{1,2}$/i.test(normalized)
  )
}

function hasMovieMarker(value: string) {
  const normalized = toCaseFold(value)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  return /\b(?:movies?|films?|specials?|ovas?|onas?)\b/i.test(normalized)
}

function isMoviePathContext(filePath: string) {
  return path
    .normalize(filePath)
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => hasMovieMarker(segment))
}

function comparableTitleTokens(value: string) {
  return toCaseFold(normalizeTitle(value))
    .replace(/\b(?:a|an|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 0)
}

function hasSharedLeadingTitleTokens(title: string, prefix: string) {
  const titleTokens = comparableTitleTokens(title)
  const prefixTokens = comparableTitleTokens(prefix)

  if (titleTokens.length === 0 || prefixTokens.length === 0) {
    return false
  }

  const requiredMatches = Math.min(4, titleTokens.length, prefixTokens.length)

  if (requiredMatches < 2) {
    return false
  }

  for (let index = 0; index < requiredMatches; index += 1) {
    if (titleTokens[index] !== prefixTokens[index]) {
      return false
    }
  }

  return true
}

function titleHasPrefix(title: string, prefix: string) {
  const normalizedTitle = toCaseFold(normalizeTitle(title))
  const normalizedPrefix = toCaseFold(normalizeTitle(prefix))

  return (
    Boolean(normalizedTitle) &&
    Boolean(normalizedPrefix) &&
    (normalizedTitle === normalizedPrefix ||
      normalizedTitle.startsWith(`${normalizedPrefix} `) ||
      hasSharedLeadingTitleTokens(title, prefix))
  )
}

function isBareEpisodeMarkerTitle(value: string) {
  const normalized = toCaseFold(normalizeTitle(value))
    .replace(/[-–—:_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  return (
    /^(?:season\s*\d{1,2}|s\s*\d{1,2})\s*(?:e|ep|episode)\s*\d{1,4}$/i.test(normalized) ||
    /^(?:e|ep|episode)\s*\d{1,4}$/i.test(normalized) ||
    /^0\d{1,3}$/.test(normalized) ||
    /^\d{1,3}$/.test(normalized)
  )
}

function createParsedMovieFileName(title: string): ParsedAnimeFileName | null {
  const cleanedTitle = cleanTitleSegment(title)

  if (!cleanedTitle || /^\d+$/.test(cleanedTitle)) {
    return null
  }

  return {
    title: cleanedTitle,
    season: 1,
    episode: 1,
    episodeTitle: null,
    hasExplicitSeason: false,
    titleSource: "filename",
    mediaKind: "movie",
  }
}

function formatExplicitMovieTitle(
  prefix: string | undefined,
  movieLabel: string | undefined,
  suffix: string | undefined
) {
  const titlePrefix = prefix ?? ""
  const label = movieLabel ?? ""
  const titleSuffix = suffix ?? ""
  const shouldKeepMovieLabel = /^the\s+movie/i.test(label.trim())

  return shouldKeepMovieLabel
    ? `${titlePrefix} ${label} ${titleSuffix}`
    : `${titlePrefix} ${titleSuffix}`
}

function parseExplicitMovieFileName(filePath: string): ParsedAnimeFileName | null {
  const baseName = path.basename(filePath, path.extname(filePath))
  const mainName = baseName.split("|")[0] ?? baseName
  const normalized = normalizeTitle(mainName)
  const movieTitle = /^(.+?)\s+((?:the\s+)?movie(?:\s+\d{1,2})?)\s*[-–—:]\s*(.+)$/i.exec(
    normalized
  )

  if (movieTitle) {
    return createParsedMovieFileName(
      formatExplicitMovieTitle(movieTitle[1], movieTitle[2], movieTitle[3])
    )
  }

  const movieTitleWithoutSeparator = /^(.+?)\s+((?:the\s+)?movie(?:\s+\d{1,2})?)\s+(.+)$/i.exec(
    normalized
  )

  if (movieTitleWithoutSeparator) {
    return createParsedMovieFileName(
      formatExplicitMovieTitle(
        movieTitleWithoutSeparator[1],
        movieTitleWithoutSeparator[2],
        movieTitleWithoutSeparator[3]
      )
    )
  }

  const titledMovie = /^(.+?)\s*[-–—:]\s*((?:the\s+)?movie(?:\s+.+)?)$/i.exec(
    normalized
  )

  if (titledMovie) {
    return createParsedMovieFileName(
      `${titledMovie[1] ?? ""} ${titledMovie[2] ?? ""}`
    )
  }

  return null
}

function rawComparableMovieName(filePath: string) {
  const baseName = path.basename(filePath, path.extname(filePath))
  const mainName = baseName.split("|")[0] ?? baseName

  return stripLeadingIgnoredReleaseGroups(
    stripIgnoredBracketSegments(normalizeUnicode(mainName))
      .replace(hashPattern, " ")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  )
}

function parseDecimalMovieFileName(filePath: string): ParsedAnimeFileName | null {
  const rawName = rawComparableMovieName(filePath)
  const decimalMovie = /^(.+?)\s+(\d(?:\.\d{1,2})(?:\s*\+?\s*\d(?:\.\d{1,2}))?)(?:\s*[-–—]?\s*(.+))?$/i.exec(
    rawName
  )

  if (!decimalMovie) {
    return null
  }

  return createParsedMovieFileName(
    `${decimalMovie[1] ?? ""} ${decimalMovie[2] ?? ""} ${decimalMovie[3] ?? ""}`
  )
}

function parseStandaloneMovieFileName(filePath: string): ParsedAnimeFileName | null {
  const baseName = path.basename(filePath, path.extname(filePath))
  const mainName = baseName.split("|")[0] ?? baseName
  const normalized = normalizeTitle(mainName)
  const dashTitle = /^(.+?)\s*[-–—:]\s*(.+)$/i.exec(normalized)

  if (dashTitle) {
    const titlePrefix = cleanTitleSegment(dashTitle[1] ?? "")
    const titleSuffix = cleanTitleSegment(dashTitle[2] ?? "")
    const numericSpecialSuffix = /^\d{1,4}['’′]+$/u.test(titleSuffix.trim())

    if (
      titlePrefix &&
      titleSuffix &&
      !isBareEpisodeMarkerTitle(titlePrefix) &&
      (numericSpecialSuffix || !/^\d{1,4}\b/.test(titleSuffix))
    ) {
      return createParsedMovieFileName(`${titlePrefix} ${titleSuffix}`)
    }
  }

  if (!isMoviePathContext(filePath)) {
    return null
  }

  return createParsedMovieFileName(normalized)
}

function parseMovieFileNameWithFallbackTitle(
  filePath: string,
  fallbackTitle?: string
): ParsedAnimeFileName | null {
  const parsedMovie =
    parseDecimalMovieFileName(filePath) ??
    parseExplicitMovieFileName(filePath) ??
    parseStandaloneMovieFileName(filePath)

  if (parsedMovie) {
    return parsedMovie
  }

  const baseName = path.basename(filePath, path.extname(filePath))
  const mainName = baseName.split("|")[0] ?? baseName
  const baseTitle = cleanTitleSegment(mainName)

  if (!baseTitle) {
    return null
  }

  if (fallbackTitle && titleHasPrefix(baseTitle, fallbackTitle)) {
    return createParsedMovieFileName(baseTitle)
  }

  if (!isMoviePathContext(filePath)) {
    return null
  }

  const title = fallbackTitle && !titleHasPrefix(baseTitle, fallbackTitle)
    ? `${fallbackTitle} ${baseTitle}`
    : baseTitle

  return createParsedMovieFileName(title)
}

export function getStandaloneMediaTitleFallbackCandidates(
  rootDir: string,
  filePath: string,
  parsedTitle: string
) {
  const candidates: string[] = []
  const seen = new Set<string>()

  for (const fallbackTitle of getFolderTitleFallbackCandidates(rootDir, filePath, parsedTitle)) {
    const combinedTitle = titleHasPrefix(parsedTitle, fallbackTitle)
      ? parsedTitle
      : `${fallbackTitle} ${parsedTitle}`
    const cleaned = cleanTitleSegment(combinedTitle)
    const key = toCaseFold(cleaned)

    if (!cleaned || key === toCaseFold(parsedTitle) || seen.has(key)) {
      continue
    }

    seen.add(key)
    candidates.push(cleaned)
  }

  return candidates
}

export function getFolderTitleFallbackCandidates(
  rootDir: string,
  filePath: string,
  parsedTitle?: string
) {
  const root = path.resolve(rootDir)
  const fileDirectory = path.dirname(path.resolve(filePath))
  const relativeDirectory = path.relative(root, fileDirectory)

  if (!relativeDirectory || relativeDirectory.startsWith("..") || path.isAbsolute(relativeDirectory)) {
    return []
  }

  const parsedTitleNormalized = parsedTitle ? toCaseFold(parsedTitle.trim()) : undefined
  const candidates: string[] = []
  const seen = new Set<string>()
  const parts = relativeDirectory.split(path.sep).filter(Boolean)

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const cleaned = cleanFolderTitleCandidate(parts[index] ?? "")
    const key = toCaseFold(cleaned)

    if (cleaned.length < 2 || isIgnoredFolderTitleCandidate(cleaned)) {
      continue
    }

    if (parsedTitleNormalized) {
      const cleanedTokenCount = comparableTitleTokens(cleaned).length

      if (
        key === parsedTitleNormalized ||
        (cleanedTokenCount <= 3 && titleHasPrefix(parsedTitleNormalized, cleaned))
      ) {
        continue
      }
    }

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    candidates.push(cleaned)
  }

  return candidates
}

export function parseAnimeFilePath(
  filePath: string,
  options?: { rootDir?: string; fallbackTitles?: string[] }
): ParsedAnimeFileName | null {
  const directoryMarker = options?.rootDir
    ? getDirectorySeasonPartMarker(options.rootDir, filePath)
    : null
  const fallbackTitles = [
    ...(options?.fallbackTitles ?? []),
    ...(options?.rootDir ? getFolderTitleFallbackCandidates(options.rootDir, filePath) : []),
  ]

  if (isMoviePathContext(filePath)) {
    const contextMovieParsed = parseMovieFileNameWithFallbackTitle(filePath)

    if (contextMovieParsed) {
      return applySeasonPartMarker(contextMovieParsed, directoryMarker)
    }

    for (const fallbackTitle of fallbackTitles) {
      const fallbackMovieParsed = parseMovieFileNameWithFallbackTitle(
        filePath,
        fallbackTitle
      )

      if (fallbackMovieParsed) {
        return applySeasonPartMarker(
          { ...fallbackMovieParsed, titleSource: "folder" },
          directoryMarker
        )
      }
    }
  }

  const parsed = parseAnimeFileName(filePath)

  if (parsed) {
    return applySeasonPartMarker(parsed, directoryMarker)
  }

  const seen = new Set<string>()

  for (const fallbackTitle of fallbackTitles) {
    const key = toCaseFold(fallbackTitle.trim())

    if (!key || seen.has(key)) {
      continue
    }

    seen.add(key)
    const fallbackParsed = parseAnimeFileNameWithFallbackTitle(filePath, fallbackTitle)

    if (fallbackParsed) {
      return applySeasonPartMarker(fallbackParsed, directoryMarker)
    }

    const fallbackMovieParsed = parseMovieFileNameWithFallbackTitle(
      filePath,
      fallbackTitle
    )

    if (fallbackMovieParsed) {
      return applySeasonPartMarker(
        { ...fallbackMovieParsed, titleSource: "folder" },
        directoryMarker
      )
    }
  }

  const movieParsed = parseMovieFileNameWithFallbackTitle(filePath)

  return movieParsed ? applySeasonPartMarker(movieParsed, directoryMarker) : null
}

export function getAnimeMetadataLookupSeason(parsed: ParsedAnimeFileName) {
  return parsed.hasExplicitSeason ? parsed.season : undefined
}

export function parseAnimeFileName(
  filePath: string
): ParsedAnimeFileName | null {
  const baseName = path.basename(filePath, path.extname(filePath))
  const mainName = baseName.split("|")[0] ?? baseName
  const normalized = normalizeTitle(mainName)

  const movieDashEpisode = /^(.+?\bMovie)\s*-\s*(\d{1,4})\s*-\s*(.+)$/i.exec(
    normalized
  )

  if (movieDashEpisode) {
    const titlePrefix = cleanTitleSegment(
      (movieDashEpisode[1] ?? "").replace(/\bMovie$/i, "")
    )
    const titleSuffix = cleanTitleSegment(movieDashEpisode[3] ?? "")

    if (titlePrefix && titleSuffix) {
      return createParsedMovieFileName(`${titlePrefix} ${titleSuffix}`)
    }
  }

  const movieParsed = parseExplicitMovieFileName(filePath)

  if (movieParsed) {
    return movieParsed
  }

  const marker = findEpisodeMarker(normalized)

  if (marker) {
    const title = getTitleBeforeEpisodeMarker(normalized, marker)

    if (title) {
      return {
        title,
        season: marker.season,
        episode: marker.episode,
        part: marker.part,
        episodeTitle: cleanEpisodeTitleSegment(marker.suffix),
        hasExplicitSeason: true,
        titleSource: "filename",
      }
    }
  }

  const noSeasonMarker = findNoSeasonEpisodeMarker(normalized)

  if (noSeasonMarker) {
    const titleSegment = normalized.slice(0, noSeasonMarker.index)
    const titleWithSeason = cleanSeriesTitleSegmentWithInferredSeason(titleSegment)

    if (titleWithSeason) {
      return {
        title: titleWithSeason.title,
        season: titleWithSeason.season,
        episode: noSeasonMarker.episode,
        episodeTitle: cleanEpisodeTitleSegment(noSeasonMarker.suffix),
        hasExplicitSeason: titleWithSeason.hasExplicitSeason,
        titleSource: "filename",
      }
    }
  }

  for (const pattern of seasonPartEpisodePatterns) {
    const seasonPartEpisode = pattern.exec(normalized)

    if (!seasonPartEpisode) {
      continue
    }

    const season = toPositiveInteger(seasonPartEpisode[2])
    const part = parsePartNumber(seasonPartEpisode[3])
    const episode = toPositiveInteger(seasonPartEpisode[4])

    const title = cleanSeriesTitleSegment(seasonPartEpisode[1] ?? "", season ?? undefined, part ?? undefined)

    if (season && part && episode && title) {
      return {
        title,
        season,
        episode,
        part,
        hasExplicitSeason: true,
        titleSource: "filename",
      }
    }
  }

  const seasonEpisode = /^(.+?)\s*[-\s]\s*S\s*(\d{1,2})\s*(?:E|EP|Episode)\s*(\d{1,4})(?:v\d+)?\b/i.exec(
    normalized
  )

  if (seasonEpisode) {
    const season = toPositiveInteger(seasonEpisode[2])
    const episode = toPositiveInteger(seasonEpisode[3])

    const title = cleanSeriesTitleSegment(seasonEpisode[1] ?? "", season ?? undefined)

    if (season && episode && title) {
      return {
        title,
        season,
        episode,
        hasExplicitSeason: true,
        titleSource: "filename",
      }
    }
  }

  const seasonDashEpisode = /^(.+?)\s+S\s*(\d{1,2})\s*-\s*(\d{1,4})(?:v\d+)?\b/i.exec(
    normalized
  )

  if (seasonDashEpisode) {
    const season = toPositiveInteger(seasonDashEpisode[2])
    const episode = toPositiveInteger(seasonDashEpisode[3])

    const title = cleanSeriesTitleSegment(seasonDashEpisode[1] ?? "", season ?? undefined)

    if (season && episode && title) {
      return {
        title,
        season,
        episode,
        hasExplicitSeason: true,
        titleSource: "filename",
      }
    }
  }

  const dashEpisode = /^(.+?)\s*-\s*(\d{1,4})(?:v\d+)?(?:\b|$)/i.exec(normalized)

  if (dashEpisode) {
    const episode = toPositiveInteger(dashEpisode[2])
    const titleWithSeason = cleanSeriesTitleSegmentWithInferredSeason(
      dashEpisode[1] ?? ""
    )

    if (episode && titleWithSeason) {
      return {
        title: titleWithSeason.title,
        season: titleWithSeason.season,
        episode,
        hasExplicitSeason: titleWithSeason.hasExplicitSeason,
        titleSource: "filename",
      }
    }
  }

  const decimalMovieParsed = parseDecimalMovieFileName(filePath)

  if (decimalMovieParsed) {
    return decimalMovieParsed
  }

  const trailingEpisode = /^(.+?)\s+(\d{1,3})(?:v\d+)?(?:\s*[-–—]\s*(.+))?$/i.exec(
    normalized
  )

  if (trailingEpisode) {
    const episode = toPositiveInteger(trailingEpisode[2])
    const titleWithSeason = cleanSeriesTitleSegmentWithInferredSeason(
      trailingEpisode[1] ?? ""
    )

    if (episode && titleWithSeason) {
      return {
        title: titleWithSeason.title,
        season: titleWithSeason.season,
        episode,
        episodeTitle: cleanEpisodeTitleSegment(trailingEpisode[3]),
        hasExplicitSeason: titleWithSeason.hasExplicitSeason,
        titleSource: "filename",
      }
    }
  }

  return parseStandaloneMovieFileName(filePath)
}

export function sanitizePathPart(value: string) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
}

const reservedWindowsPathNames = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
])

function isAllowedExportPathChar(value: string) {
  return /^[A-Za-z0-9 .,_\-!&()]$/.test(value)
}

function isExportPathSeparatorChar(value: string) {
  return /[\s'’`´]/.test(value)
}

export function sanitizeExportPathPart(value: string) {
  let output = ""

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? ""

    if (isAllowedExportPathChar(char)) {
      output += char
      continue
    }

    const nextChar = value[index + 1] ?? ""

    if (isExportPathSeparatorChar(char) || isExportPathSeparatorChar(nextChar)) {
      continue
    }

    output += " "
  }

  output = output
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[ .]+$/g, "")
    .slice(0, 120)
    .trim()

  if (reservedWindowsPathNames.has(output.toUpperCase())) {
    return `${output}_`
  }

  return output
}

export function formatEpisodeFileName(input: {
  title: string
  season: number
  episode: number
  extension: string
  part?: number
}) {
  const season = String(input.season).padStart(2, "0")
  const part =
    input.part && input.part > 1
      ? `P${String(input.part).padStart(2, "0")}`
      : ""
  const episode = String(input.episode).padStart(2, "0")
  const safeTitle = sanitizeExportPathPart(input.title) || "Anime"
  const extension = input.extension.startsWith(".")
    ? input.extension
    : `.${input.extension}`

  return `${safeTitle} - S${season}${part}E${episode}${toCaseFold(extension)}`
}

export function formatStandaloneMediaFileName(input: {
  title: string
  extension: string
}) {
  const safeTitle = sanitizeExportPathPart(input.title) || "Anime"
  const extension = input.extension.startsWith(".")
    ? input.extension
    : `.${input.extension}`

  return `${safeTitle}${toCaseFold(extension)}`
}

export function formatSeasonFolderName(season: number, part?: number) {
  const seasonLabel = `Season ${String(season).padStart(2, "0")}`

  if (!part || part <= 1) {
    return seasonLabel
  }

  return `${seasonLabel} Part ${String(part).padStart(2, "0")}`
}
