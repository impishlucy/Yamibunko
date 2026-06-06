const seasonOnlyPattern = /^(?:season|s)\s*0*\d{1,2}(?:\s*(?:part|cour|pt\.?|p)\s*0*\d{1,2})?$/i

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

    if (suffix && !seasonOnlyPattern.test(suffix)) {
      return suffix
    }
  }

  const normalizedLibrary = normalizeForPrefix(libraryTitle)
  const normalizedMedia = normalizeForPrefix(mediaTitle)

  if (normalizedMedia.startsWith(`${normalizedLibrary} `)) {
    const mediaWords = mediaTitle.split(/\s+/)
    const libraryWordCount = libraryTitle.split(/\s+/).length
    const suffix = trimTitleSeparator(mediaWords.slice(libraryWordCount).join(" "))

    if (suffix && !seasonOnlyPattern.test(suffix)) {
      return suffix
    }
  }

  return null
}

export function animeVariantSecondTitle(input: {
  libraryTitle: string
  mediaTitle: string
}) {
  return getAnimeTitleSuffix(input) ?? input.mediaTitle
}
