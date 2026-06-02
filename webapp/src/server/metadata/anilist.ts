import { slugifyAnimeTitle } from "@/lib/slug"
import {
  getAniListClient,
  queueAniListOperation,
} from "@/server/anilist/transport"
import type { AnimeMetadataInput } from "@/server/db/library"

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
  relations?: {
    edges?: Array<{
      relationType?: string | null
      node?: AniListMediaNode | null
    } | null> | null
  } | null
}

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

function toMetadata(media: AniListMediaNode): AnimeMetadataInput {
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
    coverImage: media.coverImage?.extraLarge ?? null,
    bannerImage: media.bannerImage ?? null,
    genres: (media.genres ?? []).filter((item): item is string =>
      Boolean(item)
    ),
    averageScore: media.averageScore ?? null,
    tags: (media.tags ?? []).filter((item): item is NonNullable<typeof item> =>
      Boolean(item)
    ),
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
        media: toMetadata(edge.node),
      })),
  }
}

function getSearchCandidates(title: string, season?: number) {
  const normalizedTitle = title.trim().replace(/\s+/g, " ")

  if (!normalizedTitle) {
    return []
  }

  if (!season || season <= 1) {
    return [normalizedTitle]
  }

  return [
    `${normalizedTitle} Season ${season}`,
    `${normalizedTitle} S${season}`,
    normalizedTitle,
  ]
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
    getAniListClient().anime.getAnimeById(id)
  )
  const media = animeResult.Media as AniListMediaNode | null

  if (!media) {
    return null
  }

  const relationsResult = await queueAniListOperation(() =>
    getAniListClient().anime.getRelations(id)
  )
  const relationEdges =
    (relationsResult.Media?.relations?.edges ?? []) as NonNullable<
      AniListMediaNode["relations"]
    >["edges"]

  return toMetadata({
    ...media,
    relations: {
      edges: relationEdges ?? [],
    },
  })
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

function scoreMediaCandidate(media: AniListMediaNode, search: string) {
  const normalizedSearch = normalizeComparableTitle(search)
  const titles = [
    media.title?.userPreferred,
    media.title?.english,
    media.title?.romaji,
    media.title?.native,
  ]
    .filter((title): title is string => Boolean(title))
    .map(normalizeComparableTitle)

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
}

export async function findAnimeMetadata(title: string, season?: number) {
  for (const candidate of getSearchCandidates(title, season)) {
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
        score: scoreMediaCandidate(item, candidate),
      }))
      .sort((left, right) => left.score - right.score)
    const match = rankedMedia.find((item) => item.score <= 2)
    const media = match?.item

    if (media) {
      const metadata =
        (await fetchAnimeMetadataById(media.id).catch(() => null)) ??
        toMetadata(media)

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
