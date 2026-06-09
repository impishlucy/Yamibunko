import {
  formatSeasonPartCompactLabel,
  formatSeasonPartLabel,
  isSeasonPartOnlyText,
  parseSeasonPartFromText,
  stripLeadingSeasonPartText,
  type ParsedSeasonPart,
} from "@/lib/media-labels"

const seasonTitlePattern =
  /^(.*?)\b(?:season|s)\s*0*\d{1,2}(?:(?:\s*(?:part|pt\.?|p|cour|c)\s*(?:\d{1,2}|[ivx]+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|[4-9]th|10th))|(?:\s*(?:\d{1,2}|[ivx]+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|[4-9]th|10th)\s*(?:cour|half)))?\b(.*)$/i

function normalizeForPrefix(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function trimTitleSeparator(value: string) {
  return value.replace(/^\s*(?:[:：\-–—]+\s*)+/, "").trim()
}

function cleanRealSubtitle(value: string | null) {
  if (!value || isSeasonPartOnlyText(value)) {
    return null
  }

  const subtitle = stripLeadingSeasonPartText(value)

  if (!subtitle || isSeasonPartOnlyText(subtitle)) {
    return null
  }

  return subtitle
}

function getSeriesSeasonPart(input: {
  mediaTitle: string
  seasonNumber?: number
}): ParsedSeasonPart {
  return parseSeasonPartFromText(input.mediaTitle) ?? { season: input.seasonNumber ?? 1 }
}

function splitSeasonTitle(value: string) {
  const match = seasonTitlePattern.exec(value.trim())
  const seasonPart = parseSeasonPartFromText(value)

  if (!match || !seasonPart) {
    return null
  }

  const title = match[1].trim().replace(/\s*(?:[:：\-–—]+\s*)+$/, "")
  const subtitle = cleanRealSubtitle(match[2])

  return {
    title: title || value.trim(),
    seasonPart,
    subtitle,
  }
}

export function getAnimeTitleSuffix(input: {
  libraryTitle: string
  mediaTitle: string
}) {
  const libraryTitle = input.libraryTitle.trim()
  const mediaTitle = input.mediaTitle.trim()

  if (!libraryTitle || !mediaTitle) {
    return null
  }

  if (normalizeForPrefix(libraryTitle) === normalizeForPrefix(mediaTitle)) {
    return null
  }

  if (mediaTitle.toLowerCase().startsWith(libraryTitle.toLowerCase())) {
    const suffix = trimTitleSeparator(mediaTitle.slice(libraryTitle.length))

    if (suffix && !isSeasonPartOnlyText(suffix)) {
      return suffix
    }
  }

  const normalizedLibrary = normalizeForPrefix(libraryTitle)
  const normalizedMedia = normalizeForPrefix(mediaTitle)

  if (normalizedMedia.startsWith(`${normalizedLibrary} `)) {
    const mediaWords = mediaTitle.split(/\s+/)
    const libraryWordCount = libraryTitle.split(/\s+/).length
    const suffix = trimTitleSeparator(mediaWords.slice(libraryWordCount).join(" "))

    if (suffix && !isSeasonPartOnlyText(suffix)) {
      return suffix
    }
  }

  return null
}

export function getAnimeRealTitleSuffix(input: {
  libraryTitle: string
  mediaTitle: string
}) {
  return cleanRealSubtitle(getAnimeTitleSuffix(input))
}

export function formatSeriesEntryLabel(input: {
  libraryTitle: string
  mediaTitle: string
  seasonNumber?: number
}) {
  const subtitle = getAnimeRealTitleSuffix(input)
  const seasonPart = getSeriesSeasonPart(input)

  if (subtitle) {
    return `${formatSeasonPartCompactLabel(seasonPart)} - ${subtitle}`
  }

  return formatSeasonPartLabel(seasonPart)
}

export function formatWatchSeriesTitle(input: {
  mediaTitle: string
  seasonPart: ParsedSeasonPart
}) {
  const splitTitle = splitSeasonTitle(input.mediaTitle)

  if (splitTitle) {
    const title = `${splitTitle.title} ${formatSeasonPartLabel(splitTitle.seasonPart)}`
    return splitTitle.subtitle ? `${title} • ${splitTitle.subtitle}` : title
  }

  return `${input.mediaTitle} ${formatSeasonPartLabel(input.seasonPart)}`
}

export function animeVariantSecondTitle(input: {
  libraryTitle: string
  mediaTitle: string
}) {
  return getAnimeRealTitleSuffix(input) ?? input.mediaTitle
}
