export type ParsedSeasonPart = {
  season: number
  part?: number
}

export type ParsedSeasonPartEpisode = ParsedSeasonPart & {
  episode?: number
}

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

const partNumberPattern =
  String.raw`(?:\d{1,2}|[ivx]+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|[4-9]th|10th)`
const seasonPartSeparatorPattern = String.raw`(?:\s|[:：\-–—])*`
const seasonPartPattern = new RegExp(
  String.raw`\b(?:season|s)\s*0*(\d{1,2})(?:(?:\s*(?:part|pt|p|cour|c)\s*(${partNumberPattern}))|(?:\s*(${partNumberPattern})\s*(?:cour|half)))?\b`,
  "gi"
)
const seasonPartEpisodePattern = new RegExp(
  String.raw`\b(?:season|s)\s*0*(\d{1,2})(?:(?:\s*(?:part|pt|p|cour|c)\s*(${partNumberPattern}))|(?:\s*(${partNumberPattern})\s*(?:cour|half)))?\s*(?:e|ep|episode)\s*0*(\d{1,4})\b`,
  "i"
)
const leadingSeasonPartPattern = new RegExp(
  String.raw`^\s*(?:season|s)\s*0*\d{1,2}(?:(?:${seasonPartSeparatorPattern}(?:part|pt\.?|p|cour|c)\s*${partNumberPattern})|(?:${seasonPartSeparatorPattern}${partNumberPattern}\s*(?:cour|half)))?(?:\s*(?::|[-–—])\s*|\s+)?`,
  "i"
)
const seasonPartOnlyPattern = new RegExp(
  String.raw`^\s*(?:season|s)\s*0*\d{1,2}(?:(?:${seasonPartSeparatorPattern}(?:part|pt\.?|p|cour|c)\s*${partNumberPattern})|(?:${seasonPartSeparatorPattern}${partNumberPattern}\s*(?:cour|half)))?\s*$`,
  "i"
)

function normalizeMarkerText(value: string) {
  return value
    .replace(/\\/g, "/")
    .replace(/\.[A-Za-z0-9]{1,8}$/g, " ")
    .replace(/[\[\](){}]/g, " ")
    .replace(/[._-]+/g, " ")
    .replace(/([a-z])([0-9])/gi, "$1 $2")
    .replace(/([0-9])([a-z])/gi, "$1 $2")
    .replace(/[^a-z0-9/]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function parseNumberMarker(value: string | undefined) {
  if (!value) {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  const numeric = Number.parseInt(normalized.replace(/(?:st|nd|rd|th)$/i, ""), 10)

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric
  }

  return wordNumberValues[normalized] ?? romanNumberValues[normalized]
}

function toPositiveInteger(value: string | undefined) {
  if (!value) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function cleanLabelSubtitle(value: string) {
  return value
    .replace(/^\s*(?:[:：\-–—]+\s*)+/, "")
    .replace(/\s*(?:[:：\-–—]+\s*)+$/, "")
    .replace(/\s+/g, " ")
    .trim()
}

function isGenericEpisodeTitle(title: string, episodeNumber: number) {
  const escapedEpisode = String(episodeNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(
    String.raw`^(?:episode|ep\.?)\s*0*${escapedEpisode}$`,
    "i"
  )

  return pattern.test(title.trim())
}

export function parseSeasonPartFromText(value: string): ParsedSeasonPart | null {
  const normalized = normalizeMarkerText(value)
  let fallback: ParsedSeasonPart | null = null
  let match: RegExpExecArray | null

  seasonPartPattern.lastIndex = 0

  while ((match = seasonPartPattern.exec(normalized)) !== null) {
    const season = toPositiveInteger(match[1])

    if (!season) {
      continue
    }

    const part = parseNumberMarker(match[2] ?? match[3])
    const parsed = part && part > 0 ? { season, part } : { season }

    if (parsed.part && parsed.part > 1) {
      return parsed
    }

    fallback = parsed
  }

  return fallback
}

export function parseSeasonPartEpisodeFromText(
  value: string
): ParsedSeasonPartEpisode | null {
  const match = seasonPartEpisodePattern.exec(normalizeMarkerText(value))
  const season = toPositiveInteger(match?.[1])
  const episode = toPositiveInteger(match?.[4])

  if (!season) {
    return null
  }

  const part = parseNumberMarker(match?.[2] ?? match?.[3])

  return {
    season,
    part: part && part > 0 ? part : undefined,
    episode,
  }
}

export function formatSeasonPartLabel(input: ParsedSeasonPart) {
  const season = `Season ${input.season}`

  if (!input.part || input.part <= 1) {
    return season
  }

  return `${season} Part ${input.part}`
}

export function formatSeasonPartCompactLabel(input: ParsedSeasonPart) {
  const season = `S${input.season}`

  if (!input.part || input.part <= 1) {
    return season
  }

  return `${season}.${input.part}`
}

export function formatEpisodeDisplayTitle(input: {
  episodeNumber: number
  title?: string | null
}) {
  const episodeNumber = input.episodeNumber
  const title = input.title?.trim()

  if (!title || isGenericEpisodeTitle(title, episodeNumber)) {
    return `Episode ${episodeNumber}`
  }

  return `Ep. ${episodeNumber} - ${title}`
}

export function formatEpisodeBadgeLabel(input: ParsedSeasonPartEpisode) {
  const season = String(input.season).padStart(2, "0")
  const part = input.part && input.part > 1 ? `P${String(input.part).padStart(2, "0")}` : ""
  const episode = input.episode ? ` E${String(input.episode).padStart(2, "0")}` : ""

  return `S${season}${part}${episode}`
}

export function getEpisodeBadgeLabel(input: {
  fileName?: string | null
  filePath?: string | null
  seasonNumber: number
  episodeNumber: number
}) {
  const parsedFileName = input.fileName
    ? parseSeasonPartEpisodeFromText(input.fileName)
    : null
  const parsedFilePath = input.filePath
    ? parseSeasonPartFromText(input.filePath)
    : null
  const season = parsedFileName?.season ?? parsedFilePath?.season ?? input.seasonNumber
  const part = parsedFileName?.part ?? parsedFilePath?.part
  const episode = parsedFileName?.episode ?? input.episodeNumber

  return formatEpisodeBadgeLabel({ season, part, episode })
}

export function isSeasonPartOnlyText(value: string) {
  return seasonPartOnlyPattern.test(value)
}

export function stripLeadingSeasonPartText(value: string) {
  return cleanLabelSubtitle(value.replace(leadingSeasonPartPattern, ""))
}

export function getSeasonPartLabelFromTitle(value: string) {
  const parsed = parseSeasonPartFromText(value)
  return parsed ? formatSeasonPartLabel(parsed) : null
}
