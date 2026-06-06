import Image from "next/image"
import { notFound } from "next/navigation"

import { AniListTracking } from "@/components/anilist-tracking"
import { AnimeVariantSelect } from "@/components/anime-variant-select"
import { MobileDescription } from "@/components/mobile-description"
import { EpisodeCard } from "@/components/episode-card"
import { Badge } from "@/components/ui/badge"
import { getAnimeTitleSuffix, animeVariantSecondTitle } from "@/lib/anime-title"
import { getCurrentUser } from "@/server/auth/session"
import { getEpisodes, getLibraryEntry } from "@/server/media/libraryStore"

type AnimePageProps = {
  params: Promise<{
    slug: string
  }>
  searchParams: Promise<{
    media?: string
  }>
}

function isSeriesFormat(format?: string) {
  return !format || format === "TV" || format === "TV_SHORT" || format === "ONA"
}

function seasonLabel(seasonNumber?: number) {
  return `Season ${String(seasonNumber ?? 1).padStart(2, "0")}`
}

function selectedSubtitle(input: {
  format?: string
  libraryTitle: string
  title: string
  seasonNumber?: number
}) {
  if (isSeriesFormat(input.format)) {
    const suffix = getAnimeTitleSuffix({
      libraryTitle: input.libraryTitle,
      mediaTitle: input.title,
    })

    if (suffix) {
      return suffix
    }

    const seasonNumber = input.seasonNumber ?? 1

    return seasonNumber > 1 ? seasonLabel(seasonNumber) : null
  }

  return animeVariantSecondTitle({
    libraryTitle: input.libraryTitle,
    mediaTitle: input.title,
  })
}

function episodeCountBadgeClass(localCount: number, anilistCount: number) {
  if (anilistCount <= 0 || localCount === anilistCount) {
    return "bg-violet-500/90 text-white"
  }

  if (localCount < anilistCount) {
    return "bg-red-500/90 text-white"
  }

  return "bg-orange-500/90 text-white"
}

export default async function AnimePage({
  params,
  searchParams,
}: AnimePageProps) {
  const { slug } = await params
  const { media } = await searchParams
  const libraryEntry = getLibraryEntry(slug, media)

  if (!libraryEntry) {
    return notFound()
  }

  const anime = libraryEntry.selected
  const selectedVariant = libraryEntry.variants.find(
    (variant) => variant.id === anime.id
  )
  const user = await getCurrentUser()
  const episodes = getEpisodes(anime.id, user?.username)
  const localEpisodeCount = selectedVariant?.episodeCount ?? episodes.length
  const subtitle = selectedSubtitle({
    format: anime.format,
    libraryTitle: libraryEntry.title,
    title: anime.title,
    seasonNumber: selectedVariant?.seasonNumber,
  })
  const episodesBySeason = new Map<number, typeof episodes>()

  for (const episode of episodes) {
    const seasonEpisodes = episodesBySeason.get(episode.seasonNumber) ?? []
    seasonEpisodes.push(episode)
    episodesBySeason.set(episode.seasonNumber, seasonEpisodes)
  }

  return (
    <div className="space-y-6 lg:space-y-8">
      <section className="relative overflow-hidden rounded-lg border border-white/10 bg-zinc-900">
        {anime.bannerImage ? (
          <Image
            src={anime.bannerImage}
            alt=""
            fill
            priority
            sizes="100vw"
            className="absolute inset-0 h-full w-full object-cover opacity-35"
          />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-r from-zinc-950 via-zinc-950/80 to-zinc-950/30" />
        <div className="relative grid grid-cols-[96px_1fr] gap-3 p-4 sm:grid-cols-[160px_1fr] sm:gap-5 sm:p-6 lg:grid-cols-[200px_1fr] lg:gap-7 lg:p-8">
          <div className="aspect-[3/4] overflow-hidden rounded-lg border border-white/10 bg-zinc-800 shadow-2xl">
            {anime.coverImage ? (
              <Image
                src={anime.coverImage}
                alt=""
                width={320}
                height={427}
                priority
                className="h-full w-full object-cover"
              />
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col justify-end gap-3">
            <div className="flex flex-wrap gap-2">
              {anime.year ? (
                <Badge className="bg-violet-500/90 text-white">
                  {anime.year}
                </Badge>
              ) : null}
              <Badge
                className={episodeCountBadgeClass(
                  localEpisodeCount,
                  anime.episodeCount
                )}
              >
                {anime.episodeCount > 0
                  ? `${localEpisodeCount}/${anime.episodeCount} episodes`
                  : `${localEpisodeCount} episodes`}
              </Badge>
              {anime.format ? (
                <Badge
                  variant="outline"
                  className="border-white/10 bg-black/20 text-zinc-300"
                >
                  {anime.format.replace("_", " ")}
                </Badge>
              ) : null}
            </div>
            <h1 className="max-w-3xl text-2xl font-semibold text-zinc-50 sm:text-3xl lg:text-4xl">
              {libraryEntry.title}
            </h1>
            {subtitle ? (
              <p className="text-sm font-medium text-violet-200">{subtitle}</p>
            ) : null}
            {anime.description ? (
              <>
                <MobileDescription text={anime.description} />
                <p className="hidden max-w-2xl text-sm leading-6 text-zinc-300 sm:block lg:max-w-3xl lg:text-base lg:leading-7">
                  {anime.description}
                </p>
              </>
            ) : null}
            <AnimeVariantSelect
              variants={libraryEntry.variants}
              selectedId={anime.id}
              libraryTitle={libraryEntry.title}
            />
            {anime.genres?.length ? (
              <div className="flex flex-wrap gap-2">
                {anime.genres.map((genre) => (
                  <Badge
                    key={genre}
                    variant="outline"
                    className="border-white/10 bg-black/20 text-zinc-300"
                  >
                    {genre}
                  </Badge>
                ))}
              </div>
            ) : null}
            <AniListTracking animeId={anime.id} />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-zinc-50 lg:text-xl">Episodes</h2>
        {[...episodesBySeason.entries()].map(([season, seasonEpisodes]) => (
          <div key={season} className="space-y-3">
            <div className="grid gap-3">
              {seasonEpisodes.map((episode) => (
                <EpisodeCard
                  key={`${episode.animeId}-${episode.seasonNumber}-${episode.episodeNumber}`}
                  episode={episode}
                />
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
