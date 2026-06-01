import path from "node:path"

const releaseGroupPattern = /^\[[^\]]+\]\s*/
const bracketPattern = /\[[^\]]*\]|\([^)]*\)/g
const hashPattern = /\b[A-F0-9]{8,}\b/gi

export type ParsedAnimeFileName = {
  title: string
  season: number
  episode: number
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

function toPositiveInteger(value: string | undefined) {
  if (!value) {
    return null
  }

  const number = Number.parseInt(value, 10)
  return Number.isInteger(number) && number > 0 ? number : null
}

export function parseAnimeFileName(
  filePath: string
): ParsedAnimeFileName | null {
  const baseName = path.basename(filePath, path.extname(filePath))
  const mainName = baseName.split("|")[0] ?? baseName
  const normalized = normalizeTitle(mainName)

  const seasonEpisode = /^(.+?)\s*[-\s]\s*S(\d{1,2})E(\d{1,4})\b/i.exec(
    normalized
  )

  if (seasonEpisode) {
    const season = toPositiveInteger(seasonEpisode[2])
    const episode = toPositiveInteger(seasonEpisode[3])

    if (season && episode) {
      return {
        title: normalizeTitle(seasonEpisode[1] ?? ""),
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
        title: normalizeTitle(seasonDashEpisode[1] ?? ""),
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
