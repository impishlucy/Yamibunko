import { slugifyAnimeTitle } from "@/lib/slug"
import {
  getAniListClient,
  queueAniListOperation,
} from "@/server/anilist/transport"
import {
  findCachedAnimeMetadataForFile,
  getAnimeMetadataById,
  getMaxCachedStreamingEpisodeNumber,
  listAnimeIdsForAniListRefresh,
  upsertAnime,
  type AnimeMetadataInput,
  type AnimeStreamingEpisodeInput,
} from "@/server/db/library"
import { errorMessage } from "@/server/utils/format"
import { debugLog } from "@/server/utils/debugLog"

type AniListMediaNode = {
  id: number
  type?: string | null
  format?: string | null
  title?: {
    romaji?: string | null
    english?: string | null
    native?: string | null
    userPreferred?: string | null
  } | null
  status?: string | null
  description?: string | null
  seasonYear?: number | null
  episodes?: number | null
  duration?: number | null
  coverImage?: {
    extraLarge?: string | null
    large?: string | null
    medium?: string | null
  } | null
  bannerImage?: string | null
  genres?: Array<string | null> | null
  averageScore?: number | null
  tags?: Array<{
    id: number
    name: string
    description?: string | null
    category?: string | null
    rank?: number | null
    isAdult?: boolean | null
  } | null> | null
  streamingEpisodes?: Array<{
    title?: string | null
    thumbnail?: string | null
    url?: string | null
    site?: string | null
  } | null> | null
  synonyms?: Array<string | null> | null
  relations?: {
    edges?: Array<{
      relationType?: string | null
      node?: AniListMediaNode | null
    } | null> | null
  } | null
}


const AnimeWithStreamingEpisodesDocument = `
  query YamibunkoAnimeWithStreamingEpisodes($id: Int!) {
    Media(id: $id, type: ANIME) {
      ...YamibunkoAnimeMedia
      streamingEpisodes {
        title
        thumbnail
        url
        site
      }
      relations {
        edges {
          relationType
          node {
            ...YamibunkoAnimeMedia
          }
        }
      }
    }
  }

  fragment YamibunkoAnimeMedia on Media {
    id
    type
    format
    title {
      romaji
      english
      native
      userPreferred
    }
    status
    description
    synonyms
    seasonYear
    episodes
    duration
    coverImage {
      extraLarge
      large
      medium
    }
    bannerImage
    genres
    averageScore
    tags {
      id
      name
      description
      category
      rank
      isAdult
    }
  }
`


const seriesFormats = new Set(["TV"])
const libraryMediaFormats = new Set([
  "TV",
  "TV_SHORT",
  "MOVIE",
  "SPECIAL",
  "OVA",
  "ONA",
])
const rootRelationPriority = new Map([
  ["PARENT", 0],
  ["PREQUEL", 1],
  ["SEQUEL", 2],
  ["SIDE_STORY", 3],
  ["SUMMARY", 4],
  ["SPIN_OFF", 5],
  ["ALTERNATIVE", 6],
  ["COMPILATION", 7],
  ["CONTAINS", 8],
])
const metadataLookupCacheMs = 10 * 60 * 1000

const inFlightMetadataLookups = new Map<
  string,
  Promise<AnimeMetadataInput | null>
>()
const recentMetadataLookups = new Map<
  string,
  { metadata: AnimeMetadataInput | null; createdAt: number }
>()

type MetadataLookupOptions = {
  mediaKind?: "episode" | "movie"
}

function metadataLookupKindKey(options?: MetadataLookupOptions) {
  return options?.mediaKind ?? ""
}

function isStandaloneMetadataLookup(options?: MetadataLookupOptions) {
  return options?.mediaKind === "movie"
}

function isLookupCompatibleMediaFormat(
  format: string | null | undefined,
  options?: MetadataLookupOptions
) {
  if (!isStandaloneMetadataLookup(options)) {
    return true
  }

  return format !== "TV" && format !== "TV_SHORT"
}

export class AniListMetadataLookupUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AniListMetadataLookupUnavailableError"
  }
}

export function isAniListMetadataLookupUnavailableError(error: unknown) {
  return error instanceof AniListMetadataLookupUnavailableError
}

function normalizeMetadataLookupTitle(title: string) {
  return title.trim().replace(/\s+/g, " ").toLowerCase()
}

function metadataLookupKey(title: string, season?: number, part?: number) {
  return [normalizeMetadataLookupTitle(title), season ?? "", part ?? ""].join("|")
}

function cleanDescription(value?: string | null) {
  if (!value) {
    return null
  }

  return value
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function titleForMetadata(metadata: AnimeMetadataInput) {
  const title =
    metadata.title.english ??
    metadata.title.userPreferred ??
    metadata.title.romaji ??
    metadata.title.native

  if (!title) {
    throw new Error(`AniList media ${metadata.id} did not include a usable title`)
  }

  return title
}

function toStreamingEpisodes(
  episodes: AniListMediaNode["streamingEpisodes"]
): AnimeStreamingEpisodeInput[] {
  return (episodes ?? [])
    .filter((episode): episode is NonNullable<typeof episode> => Boolean(episode))
    .map((episode) => ({
      title: episode.title ?? null,
      thumbnail: episode.thumbnail ?? null,
      url: episode.url ?? null,
      site: episode.site ?? null,
    }))
}

function toMetadata(media: AniListMediaNode, fullPayload = false): AnimeMetadataInput {
  const syncedAt = fullPayload ? new Date().toISOString() : null

  return {
    id: media.id,
    format: media.format ?? null,
    title: {
      romaji: media.title?.romaji ?? null,
      english: media.title?.english ?? null,
      native: media.title?.native ?? null,
      userPreferred: media.title?.userPreferred ?? null,
    },
    status: media.status ?? null,
    description: cleanDescription(media.description),
    seasonYear: media.seasonYear ?? null,
    episodes: media.episodes ?? null,
    duration: media.duration ?? null,
    coverImage:
      media.coverImage?.extraLarge ??
      media.coverImage?.large ??
      media.coverImage?.medium ??
      null,
    bannerImage: media.bannerImage ?? null,
    genres: (media.genres ?? []).filter((item): item is string => Boolean(item)),
    averageScore: media.averageScore ?? null,
    tags: (media.tags ?? []).filter((item): item is NonNullable<typeof item> =>
      Boolean(item)
    ),
    streamingEpisodes: toStreamingEpisodes(media.streamingEpisodes),
    synonyms: (media.synonyms ?? []).filter((item): item is string => Boolean(item)),
    relations: (media.relations?.edges ?? [])
      .filter(
        (
          edge
        ): edge is {
          relationType: string
          node: AniListMediaNode
        } => Boolean(edge?.relationType && edge.node)
      )
      .map((edge) => ({
        relationType: edge.relationType,
        media: toMetadata(edge.node, false),
      })),
    rawMedia: fullPayload ? media : undefined,
    anilistSyncedAt: syncedAt,
  }
}

function getOrdinalPartLabel(part: number) {
  const ordinals: Record<number, string> = {
    1: "1st",
    2: "2nd",
    3: "3rd",
  }

  return ordinals[part] ?? `${part}th`
}

function getWordPartLabel(part: number) {
  const labels: Record<number, string> = {
    1: "First",
    2: "Second",
    3: "Third",
    4: "Fourth",
    5: "Fifth",
    6: "Sixth",
    7: "Seventh",
    8: "Eighth",
    9: "Ninth",
    10: "Tenth",
  }

  return labels[part] ?? null
}

function getRomanPartLabel(part: number) {
  const labels: Record<number, string> = {
    1: "I",
    2: "II",
    3: "III",
    4: "IV",
    5: "V",
    6: "VI",
    7: "VII",
    8: "VIII",
    9: "IX",
    10: "X",
  }

  return labels[part] ?? null
}

function uniqueCandidates(candidates: string[]) {
  const seen = new Set<string>()

  return candidates.filter((candidate) => {
    const normalized = candidate.trim().replace(/\s+/g, " ")
    const key = normalized.toLowerCase()

    if (!normalized || seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function isAsciiAlphaNumeric(value: string) {
  return /^[A-Za-z0-9]$/.test(value)
}

function isSearchPunctuation(value: string) {
  return value === "?" ||
    value === "!" ||
    value === "*" ||
    value === "'" ||
    value === '"' ||
    value === "~" ||
    value === "`" ||
    value === "’" ||
    value === "´"
}

function normalizeSearchUnicode(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
}

function normalizeSearchPunctuation(value: string) {
  const normalizedValue = normalizeSearchUnicode(value)
  let output = ""

  for (let index = 0; index < normalizedValue.length; index += 1) {
    const char = normalizedValue[index] ?? ""

    if (!isSearchPunctuation(char)) {
      output += char
      continue
    }

    const previous = normalizedValue[index - 1] ?? ""
    const next = normalizedValue[index + 1] ?? ""

    if (isAsciiAlphaNumeric(previous) && isAsciiAlphaNumeric(next)) {
      output += "_"
    }
  }

  return output.replace(/\s+/g, " ").trim()
}

function getPossessiveSearchVariants(title: string) {
  const words = title.split(/\s+/).filter(Boolean)
  const variants: string[] = []

  for (let index = 0; index < words.length && variants.length < 6; index += 1) {
    const word = words[index] ?? ""

    if (!/^[A-Za-z]{3,}s$/.test(word)) {
      continue
    }

    if (!word.endsWith("ss")) {
      const singularPossessive = [...words]
      singularPossessive[index] = `${word.slice(0, -1)}_s`
      variants.push(singularPossessive.join(" "))
    }

    const pluralPossessive = [...words]
    pluralPossessive[index] = `${word}_`
    variants.push(pluralPossessive.join(" "))
  }

  return variants
}

function getDecimalVersionSearchVariants(title: string) {
  const normalized = normalizeSearchUnicode(title)
  const fallback = normalized.replace(/\b(\d+)\.\d{1,2}\b/g, "$1.0")

  return fallback === normalized ? [] : [fallback]
}

function getSearchTitleVariants(title: string) {
  const unicodeTitle = normalizeSearchUnicode(title)
  const exactTitleVariants = [
    normalizeSearchPunctuation(unicodeTitle),
    unicodeTitle,
    ...getPossessiveSearchVariants(unicodeTitle),
  ]
  const decimalFallbackVariants = getDecimalVersionSearchVariants(unicodeTitle)
    .flatMap((variant) => [
      normalizeSearchPunctuation(variant),
      variant,
      ...getPossessiveSearchVariants(variant),
    ])

  return uniqueCandidates([...exactTitleVariants, ...decimalFallbackVariants])
}

function pluralizeSimpleSearchNoun(value: string) {
  const trimmed = value.trim()

  if (!trimmed || /s$/i.test(trimmed)) {
    return trimmed
  }

  if (/[^aeiou]y$/i.test(trimmed)) {
    return `${trimmed.slice(0, -1)}ies`
  }

  return `${trimmed}s`
}

function getDirectionalSubjectVariants(subject: string) {
  const cleanedSubject = subject.trim().replace(/\s+/g, " ")

  if (!cleanedSubject) {
    return []
  }

  const words = cleanedSubject.split(/\s+/).filter(Boolean)
  const variants = [cleanedSubject]

  if (words.length > 1) {
    const pluralizedLastWord = pluralizeSimpleSearchNoun(words[words.length - 1] ?? "")

    if (pluralizedLastWord) {
      variants.push([...words.slice(0, -1), pluralizedLastWord].join(" "))
    }
  }

  return uniqueCandidates(variants)
}

function getDirectionalMovieTitleVariants(title: string) {
  const normalizedTitle = title.trim().replace(/\s+/g, " ")
  const variants: string[] = []
  const adventureMatch = /^(.+?)\s+adventures?\s+(?:on|in|of)\s+(.+)$/i.exec(normalizedTitle)

  if (adventureMatch) {
    const prefix = adventureMatch[1]?.trim() ?? ""
    const subject = adventureMatch[2]?.trim() ?? ""

    if (prefix && subject) {
      for (const subjectVariant of getDirectionalSubjectVariants(subject)) {
        variants.push(`${prefix} ${subjectVariant} Adventure`)
        variants.push(`${prefix} ${subjectVariant} Adventures`)
        variants.push(`${prefix} ${subjectVariant}`)
      }
    }
  }

  const islandLocationMatch = /^(.+?)\s+(?:in|on)\s+the\s+(.+?)\s+island$/i.exec(normalizedTitle)

  if (islandLocationMatch) {
    const prefix = islandLocationMatch[1]?.trim() ?? ""
    const subject = islandLocationMatch[2]?.trim() ?? ""

    if (prefix && subject) {
      for (const subjectVariant of getDirectionalSubjectVariants(subject)) {
        variants.push(`${prefix} on the Island of ${subjectVariant}`)
        variants.push(`${prefix} on ${subjectVariant} Island`)
        variants.push(`${prefix} in ${subjectVariant} Island`)
      }
    }
  }

  const locationMatch = /^(.+?)\s+(?:in|on|at)\s+the\s+(.+)$/i.exec(normalizedTitle)

  if (locationMatch) {
    const prefix = locationMatch[1]?.trim() ?? ""
    const subject = locationMatch[2]?.trim() ?? ""

    if (prefix && subject) {
      variants.push(`${prefix} ${subject}`)
    }
  }

  return uniqueCandidates(variants)
}

function getStandaloneTitleSearchVariants(title: string) {
  const withoutMovieLabel = title
    .replace(/\b(?:the\s+)?movie(?:\s+\d{1,2})?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()

  const standaloneVariants = uniqueCandidates([
    ...(withoutMovieLabel && withoutMovieLabel !== title.trim() ? [withoutMovieLabel] : []),
    ...getDirectionalMovieTitleVariants(title),
    ...(withoutMovieLabel ? getDirectionalMovieTitleVariants(withoutMovieLabel) : []),
  ])

  return standaloneVariants.flatMap((variant) => getSearchTitleVariants(variant))
}

function stripParsedSeasonPartFromTitle(
  title: string,
  season?: number,
  part?: number
) {
  let normalizedTitle = title.trim().replace(/\s+/g, " ")

  if (part && part > 1) {
    const ordinalPart = getOrdinalPartLabel(part)
    const wordPart = getWordPartLabel(part)
    const romanPart = getRomanPartLabel(part)
    const partLabels = [String(part), ordinalPart]

    if (wordPart) {
      partLabels.push(wordPart)
    }

    if (romanPart) {
      partLabels.push(romanPart)
    }

    for (const label of partLabels) {
      normalizedTitle = normalizedTitle
        .replace(
          new RegExp(
            String.raw`\s+(?:part|pt\.?|cour|p|c)\s*${label}$`,
            "i"
          ),
          ""
        )
        .replace(
          new RegExp(
            String.raw`\s+${label}\s+(?:cour|half)$`,
            "i"
          ),
          ""
        )
    }
  }

  if (season && season > 0) {
    normalizedTitle = normalizedTitle.replace(
      new RegExp(String.raw`\s+(?:season\s*0?${season}|s0?${season})$`, "i"),
      ""
    )
  }

  return normalizedTitle.trim().replace(/\s+/g, " ")
}

function getSearchCandidates(
  title: string,
  season?: number,
  part?: number,
  options?: MetadataLookupOptions
) {
  const normalizedTitle = stripParsedSeasonPartFromTitle(title, season, part)

  if (!normalizedTitle) {
    return []
  }

  const titleVariants = uniqueCandidates([
    ...getSearchTitleVariants(normalizedTitle),
    ...(isStandaloneMetadataLookup(options)
      ? getStandaloneTitleSearchVariants(normalizedTitle)
      : []),
  ])

  if (!season || season <= 1) {
    return titleVariants
  }

  const seasonCandidates = titleVariants.flatMap((titleVariant) => [
    `${titleVariant} Season ${season}`,
    `${titleVariant} S${season}`,
    titleVariant,
  ])

  if (!part || part <= 1) {
    return uniqueCandidates(seasonCandidates)
  }

  const ordinalPart = getOrdinalPartLabel(part)
  const wordPart = getWordPartLabel(part)
  const romanPart = getRomanPartLabel(part)
  const partCandidates = titleVariants.flatMap((titleVariant) => {
    const candidates = [
      `${titleVariant} Season ${season} Part ${part}`,
      `${titleVariant} Season ${season} Cour ${part}`,
      `${titleVariant} Season ${season} ${ordinalPart} Cour`,
      `${titleVariant} S${season} Part ${part}`,
      `${titleVariant} S${season} Cour ${part}`,
      `${titleVariant} S${season} ${ordinalPart} Cour`,
    ]

    if (romanPart) {
      candidates.push(
        `${titleVariant} Season ${season} Part ${romanPart}`,
        `${titleVariant} S${season} Part ${romanPart}`
      )
    }

    if (wordPart) {
      candidates.push(
        `${titleVariant} Season ${season} ${wordPart} Cour`,
        `${titleVariant} Season ${season} ${wordPart} Half`,
        `${titleVariant} S${season} ${wordPart} Cour`,
        `${titleVariant} S${season} ${wordPart} Half`
      )
    }

    return candidates
  })

  return uniqueCandidates([...partCandidates, ...seasonCandidates])
}

function isAllowedLibraryMedia(media: AnimeMetadataInput) {
  return libraryMediaFormats.has(media.format ?? "")
}

function isSeriesRootMedia(media: AnimeMetadataInput) {
  return seriesFormats.has(media.format ?? "")
}

function titleValuesForRootResolution(metadata: AnimeMetadataInput) {
  return uniqueTitleValues([
    metadata.title.english,
    metadata.title.romaji,
    metadata.title.userPreferred,
    metadata.title.native,
  ])
}

function normalizedTitleValuesForRootResolution(metadata: AnimeMetadataInput) {
  return titleValuesForRootResolution(metadata).map(normalizeComparableTitle)
}

function stripRootResolutionSeasonMarkers(value: string) {
  return value
    .replace(/\b(?:season|part|cour|pt\.?|half)\s*\d+\b/gi, " ")
    .replace(/\bs\s*\d+\b/gi, " ")
    .replace(/\b\d+(?:st|nd|rd|th)\s+(?:season|part|cour|half)\b/gi, " ")
    .replace(/\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:season|part|cour|half)\b/gi, " ")
    .replace(/\b(?:part|pt\.?|cour)\s+(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function titleRootValuesForRootResolution(metadata: AnimeMetadataInput) {
  return uniqueCandidates(
    titleValuesForRootResolution(metadata).flatMap((title) => {
      const titleHead = title.split(/[:：]/)[0] ?? title

      return [
        normalizeComparableTitle(titleHead),
        normalizeComparableTitle(stripRootResolutionSeasonMarkers(titleHead)),
      ]
    })
  ).filter((title) => titleTokens(title).length >= 2)
}

function hasSharedTitleTokenPrefix(title: string, candidateTitle: string) {
  const titleParts = titleTokens(title)
  const candidateTitleParts = titleTokens(candidateTitle)
  let sharedPrefixParts = 0

  for (
    let index = 0;
    index < Math.min(titleParts.length, candidateTitleParts.length);
    index += 1
  ) {
    if (titleParts[index] !== candidateTitleParts[index]) {
      break
    }

    sharedPrefixParts += 1
  }

  return sharedPrefixParts >= 2
}

function hasSharedRootTitle(metadata: AnimeMetadataInput, candidate: AnimeMetadataInput) {
  const titles = normalizedTitleValuesForRootResolution(metadata)
  const candidateTitles = normalizedTitleValuesForRootResolution(candidate)
  const titleRoots = titleRootValuesForRootResolution(metadata)
  const candidateTitleRoots = titleRootValuesForRootResolution(candidate)

  if (
    titleRoots.some((titleRoot) =>
      candidateTitleRoots.some((candidateTitleRoot) => titleRoot === candidateTitleRoot)
    )
  ) {
    return true
  }

  return titles.some((title) =>
    candidateTitles.some(
      (candidateTitle) =>
        title === candidateTitle ||
        title.startsWith(`${candidateTitle} `) ||
        candidateTitle.startsWith(`${title} `) ||
        hasSharedTitleTokenPrefix(title, candidateTitle) ||
        tokenOverlap(title, candidateTitle) >= 0.65 ||
        tokenOverlap(candidateTitle, title) >= 0.65
    )
  )
}

function hasRootTitlePrefix(metadata: AnimeMetadataInput, candidate: AnimeMetadataInput) {
  const titles = normalizedTitleValuesForRootResolution(metadata)
  const candidateTitles = normalizedTitleValuesForRootResolution(candidate)
  const titleRoots = titleRootValuesForRootResolution(metadata)
  const candidateTitleRoots = titleRootValuesForRootResolution(candidate)

  return (
    titles.some((title) =>
      candidateTitles.some(
        (candidateTitle) =>
          title !== candidateTitle && title.startsWith(`${candidateTitle} `)
      )
    ) ||
    titleRoots.some((titleRoot) =>
      candidateTitleRoots.some(
        (candidateTitleRoot) =>
          titleRoot === candidateTitleRoot ||
          titleRoot.startsWith(`${candidateTitleRoot} `) ||
          hasSharedTitleTokenPrefix(titleRoot, candidateTitleRoot)
      )
    )
  )
}

function relationRootPriority(
  relation: NonNullable<AnimeMetadataInput["relations"]>[number]
) {
  return rootRelationPriority.get(relation.relationType) ?? Number.MAX_SAFE_INTEGER
}

function relationHasValidYearDirection(
  metadata: AnimeMetadataInput,
  relation: NonNullable<AnimeMetadataInput["relations"]>[number]
) {
  const metadataYear = metadata.seasonYear ?? null
  const relationYear = relation.media.seasonYear ?? null

  if (metadataYear === null || relationYear === null) {
    return true
  }

  if (relation.relationType === "PREQUEL") {
    return relationYear <= metadataYear
  }

  if (relation.relationType === "SEQUEL") {
    return !isSeriesRootMedia(metadata)
  }

  if (isSeriesRootMedia(metadata) && isSeriesRootMedia(relation.media)) {
    return relationYear <= metadataYear
  }

  return true
}

function relationRootScore(
  metadata: AnimeMetadataInput,
  relation: NonNullable<AnimeMetadataInput["relations"]>[number]
) {
  const relationPriority = relationRootPriority(relation)

  if (
    relationPriority === Number.MAX_SAFE_INTEGER ||
    !isAllowedLibraryMedia(relation.media) ||
    !relationHasValidYearDirection(metadata, relation)
  ) {
    return null
  }

  const relationYear = relation.media.seasonYear ?? null
  const relationIsRootFormat = isSeriesRootMedia(relation.media)
  const rootTitlePrefix = hasRootTitlePrefix(metadata, relation.media)
  const sharedRootTitle = hasSharedRootTitle(metadata, relation.media)
  const trustedParentRelation = relation.relationType === "PARENT"

  if (!trustedParentRelation && !rootTitlePrefix && !sharedRootTitle) {
    return null
  }

  let score = relationPriority * 100

  if (relationIsRootFormat) {
    score -= 60
  } else {
    score += 15
  }

  if (relation.relationType === "PARENT") {
    score -= 35
  }

  if (rootTitlePrefix) {
    score -= 25
  } else if (sharedRootTitle) {
    score -= 10
  }

  return {
    score,
    yearSort: relationYear ?? Number.MAX_SAFE_INTEGER,
  }
}

function compareRootRelations(
  left: {
    relation: NonNullable<AnimeMetadataInput["relations"]>[number]
    rootScore: { score: number; yearSort: number }
  },
  right: {
    relation: NonNullable<AnimeMetadataInput["relations"]>[number]
    rootScore: { score: number; yearSort: number }
  }
) {
  const scoreDelta = left.rootScore.score - right.rootScore.score

  if (scoreDelta !== 0) {
    return scoreDelta
  }

  if (left.rootScore.yearSort !== right.rootScore.yearSort) {
    return left.rootScore.yearSort - right.rootScore.yearSort
  }

  return left.relation.media.id - right.relation.media.id
}

function pickBestRootRelation(
  metadata: AnimeMetadataInput,
  relationTypes: string[]
) {
  const scoredRelations = (metadata.relations ?? [])
    .filter((relation) => relationTypes.includes(relation.relationType))
    .map((relation) => ({ relation, rootScore: relationRootScore(metadata, relation) }))
    .filter(
      (item): item is {
        relation: NonNullable<AnimeMetadataInput["relations"]>[number]
        rootScore: { score: number; yearSort: number }
      } => Boolean(item.rootScore)
    )

  return scoredRelations.sort(compareRootRelations)[0]?.relation ?? null
}

function isTrustedTelevisionRootRelation(
  metadata: AnimeMetadataInput,
  relation: NonNullable<AnimeMetadataInput["relations"]>[number]
) {
  if (
    !isSeriesRootMedia(relation.media) ||
    !isAllowedLibraryMedia(relation.media) ||
    !relationHasValidYearDirection(metadata, relation)
  ) {
    return false
  }

  const hasTrustedTitleRoot =
    hasRootTitlePrefix(metadata, relation.media) ||
    hasSharedRootTitle(metadata, relation.media)

  if (relation.relationType === "PARENT") {
    return true
  }

  if (relation.relationType === "PREQUEL") {
    return hasTrustedTitleRoot
  }

  if (relation.relationType === "SEQUEL") {
    return !isSeriesRootMedia(metadata) && hasTrustedTitleRoot
  }

  return hasTrustedTitleRoot
}

function pickBestTelevisionRootRelation(
  metadata: AnimeMetadataInput,
  relationTypes: string[]
) {
  const scoredRelations = (metadata.relations ?? [])
    .filter((relation) => relationTypes.includes(relation.relationType))
    .filter((relation) => isTrustedTelevisionRootRelation(metadata, relation))
    .map((relation) => {
      const rootScore = relationRootScore(metadata, relation) ?? {
        score: relationRootPriority(relation) * 100 - 120,
        yearSort: relation.media.seasonYear ?? Number.MAX_SAFE_INTEGER,
      }

      return { relation, rootScore }
    })

  return scoredRelations.sort(compareRootRelations)[0]?.relation ?? null
}

function pickRootCandidate(metadata: AnimeMetadataInput) {
  const televisionParentOrPrequel = pickBestTelevisionRootRelation(metadata, [
    "PARENT",
    "PREQUEL",
  ])

  if (televisionParentOrPrequel) {
    return televisionParentOrPrequel
  }

  const primaryRelation = pickBestRootRelation(metadata, ["PARENT", "PREQUEL"])

  if (primaryRelation) {
    return primaryRelation
  }

  if (!isSeriesRootMedia(metadata)) {
    const televisionSequel = pickBestTelevisionRootRelation(metadata, ["SEQUEL"])

    if (televisionSequel) {
      return televisionSequel
    }

    const sequelRelation = pickBestRootRelation(metadata, ["SEQUEL"])

    if (sequelRelation) {
      return sequelRelation
    }
  }

  const relatedTelevisionRoot = pickBestTelevisionRootRelation(metadata, [
    "SIDE_STORY",
    "SUMMARY",
    "SPIN_OFF",
    "ALTERNATIVE",
    "COMPILATION",
    "CONTAINS",
  ])

  if (relatedTelevisionRoot) {
    return relatedTelevisionRoot
  }

  return pickBestRootRelation(metadata, [
    "SIDE_STORY",
    "SUMMARY",
    "SPIN_OFF",
    "ALTERNATIVE",
    "COMPILATION",
    "CONTAINS",
  ])
}

async function fetchAnimeMetadataById(id: number) {
  const animeResult = await queueAniListOperation(
    () =>
      getAniListClient().graphql.request<
        { Media: AniListMediaNode | null },
        { id: number }
      >(AnimeWithStreamingEpisodesDocument, { id }),
    { label: `Fetch AniList metadata by id ${id}` }
  )
  const media = animeResult.Media

  if (!media) {
    return null
  }

  return toMetadata(media, true)
}

async function resolveLibraryRoot(
  metadata: AnimeMetadataInput,
  visited = new Set<number>()
): Promise<AnimeMetadataInput> {
  if (visited.has(metadata.id) || visited.size >= 12) {
    return metadata
  }

  const nextVisited = new Set(visited)
  nextVisited.add(metadata.id)

  const candidate = pickRootCandidate(metadata)

  if (
    !candidate ||
    candidate.media.id === metadata.id ||
    nextVisited.has(candidate.media.id)
  ) {
    return metadata
  }

  const fullCandidate =
    (await fetchAnimeMetadataById(candidate.media.id).catch((error) => {
      console.warn(
        `[Warn] [Anilist] Related root metadata fetch failed - ${candidate.media.id} - ${errorMessage(error)}`
      )
      return null
    })) ?? candidate.media

  const root = await resolveLibraryRoot(fullCandidate, nextVisited)

  if (root.id === metadata.id || !isAllowedLibraryMedia(root)) {
    return metadata
  }

  return isSeriesRootMedia(root) || !isSeriesRootMedia(metadata) ? root : metadata
}

async function attachLibraryInfo(metadata: AnimeMetadataInput) {
  const root = await resolveLibraryRoot(metadata)
  const rootTitle = titleForMetadata(root)
  const rootSlug = slugifyAnimeTitle(rootTitle)

  if (!rootSlug) {
    throw new Error(
      `AniList media ${root.id} title "${rootTitle}" did not produce a usable slug`
    )
  }

  const relationKind = root.id === metadata.id ? "self" : "related"
  const relations =
    root.id === metadata.id
      ? (metadata.relations ?? [])
      : [
          ...(metadata.relations ?? []),
          {
            relationType: "LIBRARY_ROOT",
            media: root,
          },
        ]

  return {
    ...metadata,
    library: {
      slug: rootSlug,
      title: rootTitle,
      primaryAnimeId: root.id,
      relationKind,
    },
    relations,
  }
}

function normalizeComparableTitle(value: string) {
  return normalizeSearchPunctuation(value)
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function comparableTitleToken(value: string) {
  if (value === "s") {
    return ""
  }

  if (value.length > 3 && value.endsWith("s")) {
    return value.slice(0, -1)
  }

  return value
}

function titleTokens(value: string) {
  return normalizeComparableTitle(value)
    .split(" ")
    .map(comparableTitleToken)
    .filter((token) => token.length > 2)
}

function tokenOverlap(search: string, title: string) {
  const searchTokens = titleTokens(search)

  if (searchTokens.length === 0) {
    return 0
  }

  const candidateTokens = new Set(titleTokens(title))
  const matches = searchTokens.filter((token) => candidateTokens.has(token))

  return matches.length / searchTokens.length
}

function hasUnrequestedTitleSuffix(normalizedTitle: string, normalizedSearch: string) {
  const searchTokens = normalizedSearch.split(" ").filter(Boolean)

  if (searchTokens.length < 4 || normalizedTitle === normalizedSearch) {
    return false
  }

  return normalizedTitle.startsWith(`${normalizedSearch} `)
}

function isTooGenericForSearch(normalizedTitle: string, normalizedSearch: string) {
  if (!normalizedTitle || !normalizedSearch || normalizedTitle === normalizedSearch) {
    return false
  }

  if (!normalizedSearch.startsWith(`${normalizedTitle} `)) {
    return false
  }

  const titleTokens = normalizedTitle.split(" ").filter(Boolean)
  const searchTokens = normalizedSearch.split(" ").filter(Boolean)
  const extraTokens = searchTokens.slice(titleTokens.length)

  return extraTokens.some((token) => token.length > 2)
}

function hasPartMarker(value: string, part: number) {
  const normalized = normalizeComparableTitle(value)
  const ordinalPart = getOrdinalPartLabel(part)
  const wordPart = getWordPartLabel(part)
  const romanPart = getRomanPartLabel(part)
  const markers = [
    `part ${part}`,
    `cour ${part}`,
    `${ordinalPart} cour`,
    `pt ${part}`,
    `p ${part}`,
    `c ${part}`,
  ]

  if (wordPart) {
    markers.push(`${wordPart} cour`, `${wordPart} half`)
  }

  if (romanPart) {
    markers.push(`part ${romanPart}`, `pt ${romanPart}`, `p ${romanPart}`)
  }

  return markers.some((marker) =>
    normalized.includes(normalizeComparableTitle(marker))
  )
}

type PreferredTitleValues = {
  english: string[]
  romaji: string[]
  fallback: string[]
  all: string[]
}

function uniqueTitleValues(values: Array<string | null | undefined>) {
  const seen = new Set<string>()

  return values.filter((value): value is string => {
    const normalized = value?.trim()

    if (!normalized) {
      return false
    }

    const key = normalizeComparableTitle(normalized)

    if (!key || seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function mediaTitleValues(media: AniListMediaNode): PreferredTitleValues {
  const english = uniqueTitleValues([media.title?.english])
  const romaji = uniqueTitleValues([media.title?.romaji])
  const fallback = uniqueTitleValues([
    media.title?.userPreferred,
    media.title?.native,
    ...(media.synonyms ?? []),
  ])

  return {
    english,
    romaji,
    fallback,
    all: uniqueTitleValues([...english, ...romaji, ...fallback]),
  }
}

function metadataTitleValues(metadata: AnimeMetadataInput): PreferredTitleValues {
  const english = uniqueTitleValues([metadata.title.english])
  const romaji = uniqueTitleValues([metadata.title.romaji])
  const fallback = uniqueTitleValues([
    metadata.title.userPreferred,
    metadata.title.native,
    ...(metadata.synonyms ?? []),
  ])

  return {
    english,
    romaji,
    fallback,
    all: uniqueTitleValues([...english, ...romaji, ...fallback]),
  }
}

function titlesHavePartMarker(titles: PreferredTitleValues, part?: number) {
  if (!part || part <= 1) {
    return true
  }

  return titles.all.some((title) => hasPartMarker(title, part))
}

function scoreTitleGroup(
  titles: string[],
  normalizedSearch: string,
  options?: { allowSearchSuperset?: boolean }
) {
  const normalizedTitles = titles.map(normalizeComparableTitle).filter(Boolean)

  if (normalizedTitles.length === 0 || !normalizedSearch) {
    return 3
  }

  if (normalizedTitles.some((title) => title === normalizedSearch)) {
    return 0
  }

  if (normalizedTitles.some((title) => title.includes(normalizedSearch))) {
    const bestContainingTitle = normalizedTitles
      .filter((title) => title.includes(normalizedSearch))
      .sort((left, right) => left.length - right.length)[0]

    return hasUnrequestedTitleSuffix(bestContainingTitle, normalizedSearch) ? 3 : 1
  }

  if (normalizedTitles.some((title) => isTooGenericForSearch(title, normalizedSearch))) {
    return 3
  }

  const bestOverlap = Math.max(
    ...normalizedTitles.map((title) => tokenOverlap(normalizedSearch, title)),
    0
  )

  if (bestOverlap >= 0.65) {
    return 2
  }

  if (options?.allowSearchSuperset) {
    const bestSupersetOverlap = Math.max(
      ...normalizedTitles.map((title) => {
        const tokens = titleTokens(title)

        if (tokens.length < 3 || title.length < 12) {
          return 0
        }

        return tokenOverlap(title, normalizedSearch)
      }),
      0
    )

    if (bestSupersetOverlap >= 0.85) {
      return 2.2
    }
  }

  return 3
}

function isAcceptableCandidateScore(score: number) {
  return score < 3
}

function scoreTitlesCandidate(
  titles: PreferredTitleValues,
  search: string,
  options?: {
    part?: number
    requirePartMarker?: boolean
    metadataLookupOptions?: MetadataLookupOptions
  }
) {
  if (options?.requirePartMarker && options.part && options.part > 1) {
    if (!titlesHavePartMarker(titles, options.part)) {
      return 3
    }
  }

  const normalizedSearch = normalizeComparableTitle(search)
  const titleScoreOptions = {
    allowSearchSuperset: isStandaloneMetadataLookup(options?.metadataLookupOptions),
  }
  const englishScore = scoreTitleGroup(
    titles.english,
    normalizedSearch,
    titleScoreOptions
  )

  if (isAcceptableCandidateScore(englishScore)) {
    return englishScore
  }

  const romajiScore = scoreTitleGroup(
    titles.romaji,
    normalizedSearch,
    titleScoreOptions
  )

  if (isAcceptableCandidateScore(romajiScore)) {
    return romajiScore + 0.1
  }

  const fallbackScore = scoreTitleGroup(
    titles.fallback,
    normalizedSearch,
    titleScoreOptions
  )

  return isAcceptableCandidateScore(fallbackScore) ? fallbackScore + 0.2 : 3
}

function scoreMediaCandidate(
  media: AniListMediaNode,
  search: string,
  options?: {
    part?: number
    requirePartMarker?: boolean
    metadataLookupOptions?: MetadataLookupOptions
  }
) {
  return scoreTitlesCandidate(mediaTitleValues(media), search, options)
}

function scoreMetadataCandidate(
  metadata: AnimeMetadataInput,
  search: string,
  options?: {
    part?: number
    requirePartMarker?: boolean
    metadataLookupOptions?: MetadataLookupOptions
  }
) {
  return scoreTitlesCandidate(metadataTitleValues(metadata), search, options)
}

async function findFullMetadataSearchMatch(
  rankedMedia: Array<{ item: AniListMediaNode; score: number }>,
  search: string,
  options?: {
    part?: number
    requirePartMarker?: boolean
    metadataLookupOptions?: MetadataLookupOptions
  }
) {
  const scoredMetadata: Array<{
    metadata: AnimeMetadataInput
    score: number
    searchScore: number
  }> = []

  for (const result of rankedMedia.slice(0, 5)) {
    const metadata =
      (await fetchAnimeMetadataById(result.item.id).catch((error) => {
        console.warn(
          `[Warn] [Anilist] Full metadata fetch failed after unresolved search result - ${result.item.id} - ${errorMessage(error)}`
        )
        return null
      })) ?? toMetadata(result.item, false)

    if (!isLookupCompatibleMediaFormat(metadata.format, options?.metadataLookupOptions)) {
      debugLog(
        `[Debug] [Anilist] Ignored full metadata search candidate with incompatible format ${metadata.format ?? "unknown"} for ${search} - id ${metadata.id}`
      )
      continue
    }

    scoredMetadata.push({
      metadata,
      score: scoreMetadataCandidate(metadata, search, {
        part: options?.part,
        requirePartMarker: options?.requirePartMarker,
        metadataLookupOptions: options?.metadataLookupOptions,
      }),
      searchScore: result.score,
    })
  }

  return (
    scoredMetadata
      .filter((result) => isAcceptableCandidateScore(result.score))
      .sort((left, right) => {
        const scoreDelta = left.score - right.score

        if (scoreDelta !== 0) {
          return scoreDelta
        }

        const searchScoreDelta = left.searchScore - right.searchScore

        if (searchScoreDelta !== 0) {
          return searchScoreDelta
        }

        return left.metadata.id - right.metadata.id
      })[0] ?? null
  )
}

function needsFullCachedRefresh(metadata: AnimeMetadataInput, episode?: number) {
  if (!metadata.rawMedia) {
    return true
  }

  if ((metadata.relations ?? []).length === 0) {
    return true
  }

  if (!episode || episode <= 0) {
    return false
  }

  const maxCachedEpisode = getMaxCachedStreamingEpisodeNumber(metadata.id)

  return maxCachedEpisode <= 0 || episode > maxCachedEpisode
}

export async function findAnimeMetadata(
  title: string,
  season?: number,
  episode?: number,
  part?: number,
  options?: MetadataLookupOptions
) {
  const normalizedTitle = stripParsedSeasonPartFromTitle(title, season, part)
  const key = [metadataLookupKey(normalizedTitle, season, part), metadataLookupKindKey(options)].join("|")
  const recentLookup = recentMetadataLookups.get(key)

  if (recentLookup && Date.now() - recentLookup.createdAt < metadataLookupCacheMs) {
    debugLog(`[Debug] [Anilist] Reusing recent metadata lookup - ${key}`)
    return recentLookup.metadata
  }

  const inFlightLookup = inFlightMetadataLookups.get(key)

  if (inFlightLookup) {
    debugLog(`[Debug] [Anilist] Reusing in-flight metadata lookup - ${key}`)
    return inFlightLookup
  }

  const lookup = findAnimeMetadataUncached(normalizedTitle, season, episode, part, options)
  inFlightMetadataLookups.set(key, lookup)

  try {
    const metadata = await lookup

    recentMetadataLookups.set(key, { metadata, createdAt: Date.now() })

    return metadata
  } finally {
    inFlightMetadataLookups.delete(key)
  }
}

async function findAnimeMetadataUncached(
  title: string,
  season?: number,
  episode?: number,
  part?: number,
  options?: MetadataLookupOptions
) {
  const cached = findCachedAnimeMetadataForFile(title, season, part)

  if (cached && isLookupCompatibleMediaFormat(cached.format, options)) {
    if (needsFullCachedRefresh(cached, episode)) {
      const refreshed = await fetchAnimeMetadataById(cached.id).catch((error) => {
        console.warn(
          `[Warn] [Anilist] Cached metadata refresh failed - ${cached.id} - ${errorMessage(error)}`
        )
        return null
      })

      if (refreshed) {
        return attachLibraryInfo(refreshed)
      }
    }

    console.log(
      `[Info] [Anilist] Resolved anime metadata from local cache - ${title} - id ${cached.id}`
    )

    return attachLibraryInfo(cached)
  }

  const lookupErrors: string[] = []

  for (const candidate of getSearchCandidates(title, season, part, options)) {
    console.log(`[Info] [Anilist] Searching anime metadata - ${candidate}`)

    let result: {
      Page?: {
        media?: Array<AniListMediaNode | null> | null
      } | null
    } | null = null

    try {
      result = await queueAniListOperation(
        () => getAniListClient().anime.getAnimeBySearch(candidate, 1, 10),
        { label: `Search AniList metadata for "${candidate}"` }
      )
    } catch (error) {
      const message = errorMessage(error)
      lookupErrors.push(`${candidate}: ${message}`)
      console.warn(
        `[Warn] [Anilist] Anime metadata search failed - ${candidate} - ${message}`
      )
      continue
    }

    if (!result) {
      continue
    }

    const requirePartMarker = Boolean(
      part && part > 1 && hasPartMarker(candidate, part)
    )
    const rankedMedia = ((result.Page?.media ?? []) as Array<
      AniListMediaNode | null
    >)
      .filter((item): item is AniListMediaNode =>
        Boolean(item) && isLookupCompatibleMediaFormat(item?.format, options)
      )
      .map((item) => ({
        item,
        score: scoreMediaCandidate(item, candidate, {
          part,
          requirePartMarker,
          metadataLookupOptions: options,
        }),
      }))
      .sort((left, right) => left.score - right.score)

    debugLog(
      `[Debug] [Anilist] Search candidate returned ${rankedMedia.length} result(s) - ${candidate}`
    )

    const match = rankedMedia.find((item) => isAcceptableCandidateScore(item.score))
    const media = match?.item

    if (media) {
      const metadata =
        (await fetchAnimeMetadataById(media.id).catch((error) => {
          console.warn(
            `[Warn] [Anilist] Full metadata fetch failed after search match - ${media.id} - ${errorMessage(error)}`
          )
          return null
        })) ?? toMetadata(media, false)

      if (!isLookupCompatibleMediaFormat(metadata.format, options)) {
        debugLog(
          `[Debug] [Anilist] Ignored metadata match with incompatible format ${metadata.format ?? "unknown"} for ${candidate} - id ${metadata.id}`
        )
        continue
      }

      console.log(
        `[Info] [Anilist] Found match ${
          media.title?.english ??
          media.title?.romaji ??
          media.title?.userPreferred ??
          candidate
        } - id ${media.id}`
      )
      return attachLibraryInfo(metadata)
    }

    const fullMetadataMatch = await findFullMetadataSearchMatch(rankedMedia, candidate, {
      part,
      requirePartMarker,
      metadataLookupOptions: options,
    })

    if (fullMetadataMatch) {
      console.log(
        `[Info] [Anilist] Found full metadata match ${
          fullMetadataMatch.metadata.title.english ??
          fullMetadataMatch.metadata.title.romaji ??
          fullMetadataMatch.metadata.title.userPreferred ??
          candidate
        } - id ${fullMetadataMatch.metadata.id}`
      )
      return attachLibraryInfo(fullMetadataMatch.metadata)
    }

    if (rankedMedia.length === 1) {
      const onlyMedia = rankedMedia[0].item
      const metadata =
        (await fetchAnimeMetadataById(onlyMedia.id).catch((error) => {
          console.warn(
            `[Warn] [Anilist] Full metadata fetch failed for single search result - ${onlyMedia.id} - ${errorMessage(error)}`
          )
          return null
        })) ?? toMetadata(onlyMedia, false)
      if (!isLookupCompatibleMediaFormat(metadata.format, options)) {
        debugLog(
          `[Debug] [Anilist] Ignored single search result with incompatible format ${metadata.format ?? "unknown"} for ${candidate} - id ${metadata.id}`
        )
        continue
      }

      const fullScore = scoreMetadataCandidate(metadata, candidate, {
        part,
        requirePartMarker,
        metadataLookupOptions: options,
      })

      if (isAcceptableCandidateScore(fullScore) || isStandaloneMetadataLookup(options)) {
        console.log(
          `[Info] [Anilist] Found single-result match ${
            metadata.title.english ??
            metadata.title.romaji ??
            metadata.title.userPreferred ??
            candidate
          } - id ${metadata.id}`
        )
        return attachLibraryInfo(metadata)
      }
    }
  }

  if (lookupErrors.length > 0) {
    throw new AniListMetadataLookupUnavailableError(
      `AniList metadata lookup was incomplete for "${title}": ${lookupErrors.join("; ")}`
    )
  }

  if (part && part > 1) {
    console.warn(
      `[Warn] [Anilist] No part-specific metadata match found - ${title} S${season ?? 1} Part ${part}`
    )

    return null
  }

  console.warn(`[Warn] [Anilist] No anime metadata match found - ${title}`)

  return null
}

export async function findAnimeMetadataById(id: number) {
  const cached = getAnimeMetadataById(id)

  if (cached && !needsFullCachedRefresh(cached)) {
    return cached
  }

  const metadata = await fetchAnimeMetadataById(id)

  return metadata ? attachLibraryInfo(metadata) : null
}

type CachedAniListRefreshMode = "startup" | "daily" | "manual"

function yieldAniListMaintenanceTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

export async function refreshCachedAniListMetadata(
  mode: CachedAniListRefreshMode = "daily"
) {
  const animeIds = listAnimeIdsForAniListRefresh(mode)
  let refreshed = 0

  console.log(
    `[Info] [Anilist] Cached metadata sync started - Mode: ${mode}; Candidates: ${animeIds.length}.`
  )

  for (const [index, animeId] of animeIds.entries()) {
    try {
      const metadata = await fetchAnimeMetadataById(animeId)

      if (!metadata) {
        continue
      }

      upsertAnime(await attachLibraryInfo(metadata))
      refreshed += 1
    } catch (error) {
      console.warn(
        `[Warn] [Anilist] Cached metadata sync failed - ${animeId} - ${errorMessage(error)}`
      )
    }

    if (animeIds.length > 0 && ((index + 1) % 10 === 0 || index + 1 === animeIds.length)) {
      console.log(
        `[Info] [Anilist] Cached metadata sync progress - ${index + 1}/${animeIds.length} checked, ${refreshed} refreshed.`
      )
    }

    await yieldAniListMaintenanceTurn()
  }

  console.log(
    `[Info] [Anilist] Cached metadata sync completed - Mode: ${mode}; Refreshed: ${refreshed}/${animeIds.length}.`
  )

  return { refreshed, total: animeIds.length }
}
