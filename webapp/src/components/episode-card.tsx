"use client"

import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { Clock3, PlayCircle } from "lucide-react"

import { StreamLimitDialog } from "@/components/stream-limit-dialog"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { getEpisodeBadgeLabel } from "@/lib/media-labels"
import { cn } from "@/lib/utils"
import {
  defaultSpoilerSettings,
  type Episode,
  type SpoilerSettings,
} from "@/lib/types"

function formatDuration(seconds?: number) {
  if (!seconds) {
    return "Unknown"
  }

  const minutes = Math.round(seconds / 60)
  return `${minutes} min`
}

function fallbackEpisodeTitle(episode: Episode) {
  return `Episode ${String(episode.episodeNumber).padStart(2, "0")}`
}

function isWatchedEpisode(episode: Episode) {
  if (episode.progress?.completed) {
    return true
  }

  return (episode.progress?.ratio ?? 0) >= 0.8
}

async function hasActiveStream() {
  const response = await fetch("/api/stream/session", {
    cache: "no-store",
  })

  if (!response.ok) {
    return false
  }

  const payload = (await response.json()) as { hasActiveStream?: boolean }
  return payload.hasActiveStream === true
}

async function replaceActiveStream() {
  const response = await fetch("/api/stream/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "replace" }),
  })

  if (!response.ok) {
    throw new Error(`Stream replacement failed: ${response.status}`)
  }
}

export function EpisodeCard({
  episode,
  spoilerSettings = defaultSpoilerSettings,
}: {
  episode: Episode
  spoilerSettings?: SpoilerSettings
}) {
  const router = useRouter()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingHref, setPendingHref] = useState<string | null>(null)
  const [replacing, setReplacing] = useState(false)
  const href = `/watch/${episode.animeId}/${episode.episodeNumber}?season=${episode.seasonNumber}`
  const progressRatio = episode.progress?.completed
    ? 1
    : (episode.progress?.ratio ?? 0)
  const shouldProtectEpisode = !isWatchedEpisode(episode)
  const shouldBlurThumbnail =
    spoilerSettings.blurEpisodeThumbnails && shouldProtectEpisode
  const shouldHideTitle =
    spoilerSettings.removeUnwatchedEpisodeTitles &&
    shouldProtectEpisode &&
    Boolean(episode.title)
  const displayTitle = shouldHideTitle
    ? fallbackEpisodeTitle(episode)
    : episode.title ?? episode.fileName
  const episodeBadgeLabel = getEpisodeBadgeLabel({
    fileName: episode.fileName,
    filePath: episode.filePath,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
  })

  async function openEpisode() {
    try {
      if (await hasActiveStream()) {
        setPendingHref(href)
        setConfirmOpen(true)
        return
      }
    } catch {
      router.push(href)
      return
    }

    router.push(href)
  }

  async function confirmReplace() {
    if (!pendingHref) {
      setConfirmOpen(false)
      return
    }

    setReplacing(true)

    try {
      await replaceActiveStream()
      setConfirmOpen(false)
      router.push(pendingHref)
    } finally {
      setReplacing(false)
    }
  }

  return (
    <>
      <Link
        href={href}
        prefetch={false}
        className="group block"
        onClick={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return
          }

          event.preventDefault()
          void openEpisode()
        }}
      >
        <Card className="rounded-lg border-white/10 bg-zinc-900/75 py-0 transition hover:border-violet-400/40 hover:bg-zinc-900">
          <div className="grid grid-cols-[104px_1fr] overflow-hidden sm:grid-cols-[148px_1fr] lg:grid-cols-[200px_1fr]">
            <div className="relative overflow-hidden bg-zinc-800">
              {episode.thumbnail ? (
                <Image
                  src={episode.thumbnail}
                  alt=""
                  fill
                  unoptimized
                  sizes="(min-width: 1024px) 185px, (min-width: 640px) 148px, 104px"
                  className={cn(
                    "h-full w-full object-cover opacity-80 transition group-hover:opacity-100",
                    shouldBlurThumbnail ? "scale-105 blur-md" : null
                  )}
                />
              ) : (
                <div className="h-full w-full bg-[linear-gradient(135deg,#272333,#121217)]" />
              )}
              {episode.progress?.completed ? (
                <span className="absolute inset-0 bg-zinc-950/55" />
              ) : null}
              <span className="absolute inset-0 grid place-items-center text-violet-100 opacity-0 transition group-hover:opacity-100">
                <PlayCircle className="size-8 drop-shadow" />
              </span>
              {progressRatio > 0 ? (
                <span
                  className="absolute bottom-0 left-0 h-1 bg-red-600"
                  style={{ width: `${Math.round(progressRatio * 100)}%` }}
                />
              ) : null}
            </div>
            <CardContent className="flex min-w-0 flex-col justify-between p-3">
              <div className="min-h-full min-w-0 space-y-1">
                <Badge
                  variant="outline"
                  className="border-violet-400/25 text-sm text-violet-200"
                >
                  {episodeBadgeLabel}
                </Badge>
                <h3 className="truncate px-2 py-0.5 text-lg font-medium text-zinc-100 lg:text-base">
                  {displayTitle}
                </h3>
                <p className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-zinc-500 lg:text-base">
                  <Clock3 className="size-3.5" />
                  {formatDuration(episode.durationSeconds)}
                </p>
              </div>
            </CardContent>
          </div>
        </Card>
      </Link>
      <StreamLimitDialog
        open={confirmOpen}
        onConfirm={confirmReplace}
        onDismiss={() => setConfirmOpen(false)}
        loading={replacing}
        dismissible={!replacing}
      />
    </>
  )
}
