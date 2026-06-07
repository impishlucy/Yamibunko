import path from "node:path"

import { parsePositiveInt } from "@/server/utils/format"

const releaseGroupPattern = /^\[[^\]]+\]\s*/
const bracketPattern = /\[[^\]]*\]|\([^)]*\)/g
const hashPattern = /\b[A-F0-9]{8,}\b/gi

export type ParsedAnimeFileName = {
  title: string
  season: number
  episode: number
  part?: number
  episodeTitle?: string | null
}

type ParsedAnimeEpisodeIdentifier = Omit<ParsedAnimeFileName, "title">

const fileInfoPattern = /\b(?:480p|576p|720p|1080p|1440p|2160p|4k|uhd|hdr|hdr10|sdr|bluray|blu[-\s]?ray|bdremux|bdrip|bd|web[-\s]?dl|webdl|webrip|remux|hdtv|dvd|dvdrip|x264|x265|h\.?264|h\.?265|hevc|avc|av1|aac|flac|opus|mp3|ac3|eac3|dd|ddp|dts|truehd|atmos|audio|dual[-\s]*audio|multi[-\s]*audio|multi[-\s]*subs?|dubbed|subbed|subs?|\d{1,2}[-\s]*bits?|hi10p|proper|repack|batch)\b/gi
const releaseSuffixPattern = /\s*[-–—]\s*[A-Z0-9][A-Z0-9._-]{1,}$/g

function normalizeTitle(value: string) {
  return value
    .replace(releaseGroupPattern, "")
    .replace(bracketPattern, " ")
    .replace(hashPattern, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
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
          String.raw`\s+(?:part|pt\.?|cour)\s*(?:0?${part}|[ivx]+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|[4-9]th|10th)$`,
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
      new RegExp(String.raw`\s+(?:season\s*0?${season}|s0?${season})$`, "i"),
      ""
    )
  }

  return cleanTitleSegment(title)
}

function cleanSeriesTitleSegment(value: string, season?: number, part?: number) {
  return cleanAnimeTitleCandidate(value, { season, part })
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

function parseRomanNumeral(value: string) {
  const romanValues: Record<string, number> = {
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

  return romanValues[value.toLowerCase()] ?? null
}

function parseWordNumber(value: string) {
  const wordValues: Record<string, number> = {
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

  return wordValues[value.toLowerCase()] ?? null
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

type EpisodeMarkerMatch = {
  index: number
  end: number
  season: number
  episode: number
  part?: number
  suffix: string
}

const seasonEpisodeMarkerPattern = new RegExp(
  String.raw`\b(?:Season\s*(\d{1,2})|S\s*(\d{1,2}))\s*[-–—]?\s*(?:(?:${partLabelPattern})\s*(${partNumberPattern})\s*[-–—]?\s*|(${partNumberPattern})\s*(?:cour|half)\s*[-–—]?\s*)?(?:E|EP|Episode)\s*(\d{1,4})${episodeVersionSuffixPattern}\b`,
  "i"
)

const seasonDashEpisodeMarkerPattern = /\bS\s*(\d{1,2})\s*[-–—]\s*(\d{1,4})(?:v\d+)?\b/i

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

function getTitleBeforeEpisodeMarker(value: string, marker: EpisodeMarkerMatch) {
  const titleSegment = value.slice(0, marker.index)

  return cleanSeriesTitleSegment(titleSegment, marker.season, marker.part)
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
  const cleanedTitle = cleanSeriesTitleSegment(title, episode?.season, episode?.part)

  if (!episode || !cleanedTitle) {
    return null
  }

  return {
    title: cleanedTitle,
    season: episode.season,
    episode: episode.episode,
    part: episode.part,
    episodeTitle: episode.episodeTitle,
  }
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
    const episode = toPositiveInteger(movieDashEpisode[2])
    const titlePrefix = cleanTitleSegment(
      (movieDashEpisode[1] ?? "").replace(/\bMovie$/i, "")
    )
    const titleSuffix = cleanTitleSegment(movieDashEpisode[3] ?? "")

    if (episode && titlePrefix && titleSuffix) {
      return {
        title: `${titlePrefix} ${titleSuffix}`,
        season: 1,
        episode,
      }
    }
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
      }
    }
  }

  const dashEpisode = /^(.+?)\s*-\s*(\d{1,4})(?:v\d+)?(?:\b|$)/i.exec(normalized)

  if (dashEpisode) {
    const episode = toPositiveInteger(dashEpisode[2])

    const title = cleanSeriesTitleSegment(dashEpisode[1] ?? "", 1)

    if (episode && title) {
      return {
        title,
        season: 1,
        episode,
      }
    }
  }

  return null
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
}) {
  const season = String(input.season).padStart(2, "0")
  const episode = String(input.episode).padStart(2, "0")
  const safeTitle = sanitizeExportPathPart(input.title) || "Anime"
  const extension = input.extension.startsWith(".")
    ? input.extension
    : `.${input.extension}`

  return `${safeTitle} - S${season}E${episode}${extension.toLowerCase()}`
}

export function formatSeasonFolderName(season: number) {
  return `Season ${String(season).padStart(2, "0")}`
}
