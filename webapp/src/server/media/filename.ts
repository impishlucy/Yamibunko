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
}

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
  return normalizeTitle(value).replace(/(?:\s*-\s*)+$/g, "").trim()
}

function cleanSeriesTitleSegment(value: string, season?: number, part?: number) {
  let title = cleanTitleSegment(value)

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

  if (season) {
    title = title.replace(
      new RegExp(String.raw`\s+(?:season\s*0?${season}|s0?${season})$`, "i"),
      ""
    )
  }

  return cleanTitleSegment(title)
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
const seasonPartEpisodePatterns = [
  new RegExp(
    String.raw`^(.+?)${separatorPattern}Season\s*(\d{1,2})${optionalSeparatorPattern}${partLabelPattern}\s*(${partNumberPattern})${separatorPattern}S\d{1,2}E(\d{1,4})\b`,
    "i"
  ),
  new RegExp(
    String.raw`^(.+?)${separatorPattern}S(\d{1,2})${optionalSeparatorPattern}${partLabelPattern}\s*(${partNumberPattern})${separatorPattern}S\d{1,2}E(\d{1,4})\b`,
    "i"
  ),
  new RegExp(
    String.raw`^(.+?)${separatorPattern}S(\d{1,2})${optionalSeparatorPattern}${partLabelPattern}\s*(${partNumberPattern})${optionalSeparatorPattern}E?\s*(\d{1,4})\b`,
    "i"
  ),
  new RegExp(
    String.raw`^(.+?)${separatorPattern}S(\d{1,2})${optionalSeparatorPattern}(${partNumberPattern})\s*(?:cour|half)${optionalSeparatorPattern}E?\s*(\d{1,4})\b`,
    "i"
  ),
  new RegExp(
    String.raw`^(.+?)${separatorPattern}Season\s*(\d{1,2})${optionalSeparatorPattern}${partLabelPattern}\s*(${partNumberPattern})${optionalSeparatorPattern}E?\s*(\d{1,4})\b`,
    "i"
  ),
  new RegExp(
    String.raw`^(.+?)${separatorPattern}Season\s*(\d{1,2})${optionalSeparatorPattern}(${partNumberPattern})\s*(?:cour|half)${optionalSeparatorPattern}E?\s*(\d{1,4})\b`,
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

  for (const pattern of seasonPartEpisodePatterns) {
    const seasonPartEpisode = pattern.exec(normalized)

    if (!seasonPartEpisode) {
      continue
    }

    const season = toPositiveInteger(seasonPartEpisode[2])
    const part = parsePartNumber(seasonPartEpisode[3])
    const episode = toPositiveInteger(seasonPartEpisode[4])

    if (season && part && episode) {
      return {
        title: cleanSeriesTitleSegment(seasonPartEpisode[1] ?? "", season, part),
        season,
        episode,
        part,
      }
    }
  }

  const seasonEpisode = /^(.+?)\s*[-\s]\s*S(\d{1,2})E(\d{1,4})\b/i.exec(
    normalized
  )

  if (seasonEpisode) {
    const season = toPositiveInteger(seasonEpisode[2])
    const episode = toPositiveInteger(seasonEpisode[3])

    if (season && episode) {
      return {
        title: cleanSeriesTitleSegment(seasonEpisode[1] ?? "", season),
        season,
        episode,
      }
    }
  }

  const seasonDashEpisode = /^(.+?)\s+S(\d{1,2})\s*-\s*(\d{1,4})\b/i.exec(
    normalized
  )

  if (seasonDashEpisode) {
    const season = toPositiveInteger(seasonDashEpisode[2])
    const episode = toPositiveInteger(seasonDashEpisode[3])

    if (season && episode) {
      return {
        title: cleanSeriesTitleSegment(seasonDashEpisode[1] ?? "", season),
        season,
        episode,
      }
    }
  }

  const dashEpisode = /^(.+?)\s*-\s*(\d{1,4})(?:\b|$)/i.exec(normalized)

  if (dashEpisode) {
    const episode = toPositiveInteger(dashEpisode[2])

    if (episode) {
      return {
        title: normalizeTitle(dashEpisode[1] ?? ""),
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

export function formatEpisodeFileName(input: {
  title: string
  season: number
  episode: number
  extension: string
}) {
  const season = String(input.season).padStart(2, "0")
  const episode = String(input.episode).padStart(2, "0")
  const safeTitle = sanitizePathPart(input.title) || "Anime"
  const extension = input.extension.startsWith(".")
    ? input.extension
    : `.${input.extension}`

  return `${safeTitle} - S${season}E${episode}${extension.toLowerCase()}`
}

export function formatSeasonFolderName(season: number) {
  return `Season ${String(season).padStart(2, "0")}`
}
