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

type AniListMediaNode = {
  id: number
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
    format
    title {
      romaji
      english
      native
      userPreferred
    }
    status
    description
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


const seriesFormats = new Set(["TV", "TV_SHORT", "ONA"])
const sideStoryFormats = new Set(["MOVIE", "SPECIAL", "OVA"])

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

    if (!normalized || seen.has(normalized.toLowerCase())) {
      return false
    }

    seen.add(normalized.toLowerCase())
    return true
  })
}

function getSearchCandidates(title: string, season?: number, part?: number) {
  const normalizedTitle = title.trim().replace(/\s+/g, " ")

  if (!normalizedTitle) {
    return []
  }

  if (!season || season <= 1) {
    return [normalizedTitle]
  }

  const seasonCandidates = [
    `${normalizedTitle} Season ${season}`,
    `${normalizedTitle} S${season}`,
    normalizedTitle,
  ]

  if (!part || part <= 1) {
    return seasonCandidates
  }

  const ordinalPart = getOrdinalPartLabel(part)
  const wordPart = getWordPartLabel(part)
  const romanPart = getRomanPartLabel(part)
  const partCandidates = [
    `${normalizedTitle} Season ${season} Part ${part}`,
    `${normalizedTitle} Season ${season} Cour ${part}`,
    `${normalizedTitle} Season ${season} ${ordinalPart} Cour`,
    `${normalizedTitle} S${season} Part ${part}`,
    `${normalizedTitle} S${season} Cour ${part}`,
    `${normalizedTitle} S${season} ${ordinalPart} Cour`,
  ]

  if (romanPart) {
    partCandidates.push(
      `${normalizedTitle} Season ${season} Part ${romanPart}`,
      `${normalizedTitle} S${season} Part ${romanPart}`
    )
  }

  if (wordPart) {
    partCandidates.push(
      `${normalizedTitle} Season ${season} ${wordPart} Cour`,
      `${normalizedTitle} Season ${season} ${wordPart} Half`,
      `${normalizedTitle} S${season} ${wordPart} Cour`,
      `${normalizedTitle} S${season} ${wordPart} Half`
    )
  }

  return uniqueCandidates([...partCandidates, ...seasonCandidates])
}

function pickRootCandidate(metadata: AnimeMetadataInput) {
  const relations = metadata.relations ?? []
  const format = metadata.format ?? ""
  const parent = relations.find((relation) => relation.relationType === "PARENT")

  if (parent) {
    return parent
  }

  const prequel = relations.find(
    (relation) =>
      relation.relationType === "PREQUEL" &&
      seriesFormats.has(relation.media.format ?? "")
  )

  if (prequel) {
    return prequel
  }

  const anyPrequel = relations.find(
    (relation) => relation.relationType === "PREQUEL"
  )

  if (anyPrequel) {
    return anyPrequel
  }

  if (sideStoryFormats.has(format)) {
    return (
      relations.find((relation) =>
        seriesFormats.has(relation.media.format ?? "")
      ) ?? null
    )
  }

  return null
}

async function fetchAnimeMetadataById(id: number) {
  const animeResult = await queueAniListOperation(() =>
    getAniListClient().graphql.request<
      { Media: AniListMediaNode | null },
      { id: number }
    >(AnimeWithStreamingEpisodesDocument, { id })
  )
  const media = animeResult.Media

  if (!media) {
    return null
  }

  return toMetadata(media, true)
}

async function resolveLibraryRoot(
  metadata: AnimeMetadataInput,
  depth = 0
): Promise<AnimeMetadataInput> {
  if (depth >= 4) {
    return metadata
  }

  const candidate = pickRootCandidate(metadata)

  if (!candidate || candidate.media.id === metadata.id) {
    return metadata
  }

  const fullCandidate =
    (await fetchAnimeMetadataById(candidate.media.id).catch(() => null)) ??
    candidate.media

  return resolveLibraryRoot(fullCandidate, depth + 1)
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
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function titleTokens(value: string) {
  return normalizeComparableTitle(value)
    .split(" ")
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

function mediaHasPartMarker(media: AniListMediaNode, part?: number) {
  if (!part || part <= 1) {
    return true
  }

  return [
    media.title?.userPreferred,
    media.title?.english,
    media.title?.romaji,
    media.title?.native,
  ]
    .filter((title): title is string => Boolean(title))
    .some((title) => hasPartMarker(title, part))
}

function scoreMediaCandidate(
  media: AniListMediaNode,
  search: string,
  part?: number
) {
  const normalizedSearch = normalizeComparableTitle(search)
  const titles = [
    media.title?.userPreferred,
    media.title?.english,
    media.title?.romaji,
    media.title?.native,
  ]
    .filter((title): title is string => Boolean(title))
    .map(normalizeComparableTitle)

  const score = (() => {
    if (titles.some((title) => title === normalizedSearch)) {
      return 0
    }

    if (titles.some((title) => title.includes(normalizedSearch))) {
      return 1
    }

    const bestOverlap = Math.max(
      ...titles.map((title) => tokenOverlap(normalizedSearch, title)),
      0
    )

    return bestOverlap >= 0.5 ? 2 : 3
  })()

  if (part && part > 1 && !mediaHasPartMarker(media, part)) {
    return 3
  }

  return score
}

function needsFullCachedRefresh(metadata: AnimeMetadataInput, episode?: number) {
  if (!metadata.rawMedia) {
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
  part?: number
) {
  const cached = findCachedAnimeMetadataForFile(title, season, part)

  if (cached) {
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
    return cached
  }

  for (const candidate of getSearchCandidates(title, season, part)) {
    console.log(`[Info] [Anilist] Searching anime metadata - ${candidate}`)

    const result = await queueAniListOperation(() =>
      getAniListClient().anime.getAnimeBySearch(candidate, 1, 5)
    )
    const rankedMedia = ((result.Page?.media ?? []) as Array<
      AniListMediaNode | null
    >)
      .filter((item): item is AniListMediaNode => Boolean(item))
      .map((item) => ({
        item,
        score: scoreMediaCandidate(item, candidate, part),
      }))
      .sort((left, right) => left.score - right.score)
    const match = rankedMedia.find((item) => item.score <= 2)
    const media = match?.item

    if (media) {
      const metadata =
        (await fetchAnimeMetadataById(media.id).catch(() => null)) ??
        toMetadata(media, false)

      console.log(
        `[Info] [Anilist] Found match ${
          media.title?.userPreferred ??
          media.title?.english ??
          media.title?.romaji ??
          candidate
        } - id ${media.id}`
      )
      return attachLibraryInfo(metadata)
    }
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

export async function refreshCachedAniListMetadata() {
  const animeIds = listAnimeIdsForAniListRefresh()
  let refreshed = 0

  for (const animeId of animeIds) {
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
  }

  console.log(
    `[Info] [Anilist] Cached metadata sync completed - Refreshed: ${refreshed}/${animeIds.length}`
  )

  return { refreshed, total: animeIds.length }
}
