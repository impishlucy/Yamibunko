"use client"

import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { type MouseEvent, useState } from "react"
import { Clock3, Eye, EyeOff, PlayCircle } from "lucide-react"

import { StreamLimitDialog } from "@/components/stream-limit-dialog"
import { Card, CardContent } from "@/components/ui/card"
import { clientLibraryRefreshEvent } from "@/lib/library-events"
import { formatEpisodeDisplayTitle } from "@/lib/media-labels"
import { episodeCompletionRatio } from "@/lib/watch-progress"
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

function isWatchedEpisode(episode: Episode) {
  if (episode.progress?.completed) {
    return true
  }

  return (episode.progress?.ratio ?? 0) >= episodeCompletionRatio
}

function hasWatchProgress(episode: Episode) {
  return Boolean(
    episode.progress?.completed ||
      (episode.progress?.watchedSeconds ?? 0) > 0 ||
      (episode.progress?.ratio ?? 0) > 0
  )
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

async function saveWatchState(episode: Episode, watched: boolean) {
  const response = await fetch(
    `/api/anime/${episode.animeId}/episodes/${episode.episodeNumber}/watch-state`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        season: episode.seasonNumber,
        watched,
      }),
    }
  )

  if (!response.ok) {
    throw new Error(`Watch state update failed: ${response.status}`)
  }
}

export function EpisodeCard({
  episode,
  spoilerSettings = defaultSpoilerSettings,
  onProgressChange,
}: {
  episode: Episode
  spoilerSettings?: SpoilerSettings
  onProgressChange?: () => void
}) {
  const router = useRouter()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingHref, setPendingHref] = useState<string | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [watchStateBusy, setWatchStateBusy] = useState(false)
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
  const displayTitle = formatEpisodeDisplayTitle({
    episodeNumber: episode.episodeNumber,
    title: shouldHideTitle ? null : episode.title,
  })
  const hasProgress = hasWatchProgress(episode)
  const nextWatchedState = !hasProgress
  const watchStateLabel = nextWatchedState ? "Mark watched" : "Mark not watched"
  const WatchStateIcon = nextWatchedState ? Eye : EyeOff

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

  async function updateWatchState() {
    setWatchStateBusy(true)

    try {
      await saveWatchState(episode, nextWatchedState)
      window.dispatchEvent(new Event(clientLibraryRefreshEvent))
      onProgressChange?.()
    } finally {
      setWatchStateBusy(false)
    }
  }

  const linkProps = {
    href,
    prefetch: false,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
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
    },
  }

  return (
    <>
      <Card className="group rounded-lg border-white/10 bg-zinc-900/75 py-0 transition hover:border-violet-400/40 hover:bg-zinc-900">
        <div className="grid grid-cols-[104px_1fr_48px] overflow-hidden sm:grid-cols-[148px_1fr_56px] lg:grid-cols-[200px_1fr_64px]">
          <Link {...linkProps} className="relative overflow-hidden bg-zinc-800">
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
          </Link>
          <Link {...linkProps} className="min-w-0">
            <CardContent className="flex min-h-full min-w-0 flex-col justify-between p-3">
              <div className="min-h-full min-w-0 space-y-1">
                <h3 className="truncate px-2 py-0.5 text-lg font-medium text-zinc-100 lg:text-base">
                  {displayTitle}
                </h3>
                <p className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-zinc-500 lg:text-base">
                  <Clock3 className="size-3.5" />
                  {formatDuration(episode.durationSeconds)}
                </p>
              </div>
            </CardContent>
          </Link>
          <button
            type="button"
            title={watchStateLabel}
            aria-label={watchStateLabel}
            disabled={watchStateBusy}
            className="flex min-h-full items-center justify-center border-l border-white/5 px-2 text-zinc-300 transition hover:bg-violet-500/15 hover:text-violet-100 disabled:pointer-events-none disabled:opacity-50"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void updateWatchState()
            }}
          >
            <WatchStateIcon className="size-5" />
          </button>
        </div>
      </Card>
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
