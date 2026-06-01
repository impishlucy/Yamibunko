import { gql } from "@api-wrappers/anilist-wrapper"

import type { AnimeMetadataInput } from "@/server/db/library"
import { requestAniListGraphQL } from "@/server/anilist/transport"
import { serverLog } from "@/server/logger"

type AniListSearchResponse = {
  Page?: {
    media?: Array<{
      id: number
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
    } | null> | null
  } | null
}

const searchAnimeQuery = gql`
  query YamibunkoAnimeSearch($search: String!) {
    Page(page: 1, perPage: 1) {
      media(search: $search, type: ANIME) {
        id
        title {
          romaji
          english
          native
          userPreferred
        }
        status
        description(asHtml: false)
        seasonYear
        episodes
        duration
        coverImage {
          extraLarge
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
    }
  }
`

function cleanDescription(value?: string | null) {
  if (!value) {
    return null
  }

  return value
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function toMetadata(
  media: NonNullable<
    NonNullable<NonNullable<AniListSearchResponse["Page"]>["media"]>[number]
  >
): AnimeMetadataInput {
  return {
    id: media.id,
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

export async function findAnimeMetadata(title: string, season?: number) {
  for (const candidate of getSearchCandidates(title, season)) {
    serverLog.info("Anilist", "Searching anime metadata.", {
      title,
      season,
      candidate,
    })

    const result = await requestAniListGraphQL<
      AniListSearchResponse,
      { search: string }
    >({
      query: searchAnimeQuery,
      variables: {
        search: candidate,
      },
    })

    const media = result.Page?.media?.find(Boolean)

    if (media) {
      serverLog.info("Anilist", "Found anime metadata match.", {
        title,
        season,
        candidate,
        anilistId: media.id,
        matchedTitle:
          media.title?.userPreferred ??
          media.title?.english ??
          media.title?.romaji,
      })
      return toMetadata(media)
    }
  }

  serverLog.warn("Anilist", "No anime metadata match found.", {
    title,
    season,
  })

  return null
}
