import Link from "next/link"
import Image from "next/image"
import { Calendar, PlayCircle } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import type { AnimeSummary } from "@/lib/types"

type AnimeCardProps = {
  anime: AnimeSummary
  priority?: boolean
}

export function AnimeCard({ anime, priority = false }: AnimeCardProps) {
  return (
    <Card className="group relative rounded-lg border-white/10 bg-zinc-900/80 py-0 transition hover:-translate-y-0.5 hover:border-violet-400/40 hover:shadow-[0_18px_60px_rgba(124,58,237,0.18)]">
      <Link href={`/anime/${anime.slug}`} prefetch={false} className="block">
        <div className="relative aspect-[3/4] overflow-hidden bg-zinc-800">
          {anime.coverImage ? (
            <Image
              src={anime.coverImage}
              alt=""
              fill
              priority={priority}
              unoptimized
              sizes="(min-width: 1536px) 14vw, (min-width: 1280px) 16vw, (min-width: 1024px) 20vw, (min-width: 640px) 20vw, 50vw"
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="h-full w-full bg-[linear-gradient(135deg,#292034,#111116)]" />
          )}
        </div>
        <CardContent className="space-y-1.5 p-2">
          <h2 className="line-clamp-2 min-h-8 text-xs font-semibold text-zinc-100">
            {anime.title}
          </h2>
          <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-500">
            <span className="inline-flex items-center gap-1">
              <Calendar className="size-3" />
              {anime.year ?? "Unknown"}
            </span>
            <span className="inline-flex items-center gap-1 text-violet-300">
              <PlayCircle className="size-3" />
              Open
            </span>
          </div>
        </CardContent>
      </Link>
    </Card>
  )
}
