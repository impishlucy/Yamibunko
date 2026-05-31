import Link from "next/link"
import Image from "next/image"
import { Clock3, PlayCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import type { Episode } from "@/lib/types"

function formatDuration(seconds?: number) {
  if (!seconds) {
    return "Unknown"
  }

  const minutes = Math.round(seconds / 60)
  return `${minutes} min`
}

export function EpisodeCard({ episode }: { episode: Episode }) {
  return (
    <Link
      href={`/watch/${episode.animeId}/${episode.episodeNumber}`}
      className="group block"
    >
      <Card className="rounded-lg border-white/10 bg-zinc-900/75 py-0 transition hover:border-violet-400/40 hover:bg-zinc-900">
        <div className="grid grid-cols-[104px_1fr] overflow-hidden sm:grid-cols-[148px_1fr]">
          <div className="relative aspect-video bg-zinc-800">
            {episode.thumbnail ? (
              <Image
                src={episode.thumbnail}
                alt=""
                fill
                sizes="(min-width: 640px) 148px, 104px"
                className="h-full w-full object-cover opacity-80 transition group-hover:opacity-100"
              />
            ) : (
              <div className="h-full w-full bg-[linear-gradient(135deg,#272333,#121217)]" />
            )}
            <span className="absolute inset-0 grid place-items-center text-violet-100 opacity-0 transition group-hover:opacity-100">
              <PlayCircle className="size-8 drop-shadow" />
            </span>
          </div>
          <CardContent className="flex min-w-0 flex-col justify-between p-3">
            <div className="min-w-0 space-y-1">
              <Badge
                variant="outline"
                className="border-violet-400/25 text-violet-200"
              >
                Episode {episode.episodeNumber}
              </Badge>
              <h3 className="truncate text-sm font-medium text-zinc-100">
                {episode.title ?? episode.fileName}
              </h3>
            </div>
            <p className="mt-3 inline-flex items-center gap-1 text-xs text-zinc-500">
              <Clock3 className="size-3.5" />
              {formatDuration(episode.durationSeconds)}
            </p>
          </CardContent>
        </div>
      </Card>
    </Link>
  )
}
