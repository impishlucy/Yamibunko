import Image from "next/image"
import { notFound } from "next/navigation"

import { EpisodeCard } from "@/components/episode-card"
import { Badge } from "@/components/ui/badge"
import { getAnimeInfo, getEpisodes } from "@/server/media/libraryStore"

type AnimePageProps = {
  params: Promise<{
    animeId: string
  }>
}

export default async function AnimePage({ params }: AnimePageProps) {
  const { animeId } = await params
  const anime = getAnimeInfo(animeId)

  if (!anime) {
    notFound()
  }

  const episodes = getEpisodes(animeId)

  return (
    <div className="space-y-6">
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
        <div className="relative grid gap-5 p-5 sm:grid-cols-[160px_1fr] sm:p-6">
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
                variant="outline"
                className="border-violet-400/25 text-violet-100"
              >
                {anime.episodeCount} episodes
              </Badge>
            </div>
            <h1 className="max-w-3xl text-3xl font-semibold text-zinc-50">
              {anime.title}
            </h1>
            {anime.description ? (
              <p className="max-w-2xl text-sm leading-6 text-zinc-300">
                {anime.description}
              </p>
            ) : null}
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
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-zinc-50">Episodes</h2>
        <div className="grid gap-3 xl:grid-cols-2">
          {episodes.map((episode) => (
            <EpisodeCard
              key={`${episode.animeId}-${episode.episodeNumber}`}
              episode={episode}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
