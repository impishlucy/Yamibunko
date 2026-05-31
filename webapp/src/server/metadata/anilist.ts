import { Anilist } from "@api-wrappers/anilist-wrapper"

const anilist = new Anilist()

export async function findAnimeMetadata(title: string) {
  const normalizedTitle = title.trim().replace(/\s+/g, " ")

  if (!normalizedTitle) {
    return null
  }

  const results = await anilist.anime.getAnimeBySearch(normalizedTitle, 1, 1)
  const media = results.Page?.media?.[0]

  if (!media) {
    return null
  }

  return {
    id: media.id,
    title:
      media.title?.userPreferred ??
      media.title?.english ??
      media.title?.romaji ??
      normalizedTitle,
    coverImage:
      media.coverImage?.large ?? media.coverImage?.medium ?? undefined,
    bannerImage: media.bannerImage ?? undefined,
    episodes: media.episodes ?? undefined,
    season: media.season ?? undefined,
    seasonYear: media.seasonYear ?? media.startDate?.year ?? undefined,
    siteUrl: media.siteUrl ?? undefined,
  }
}
