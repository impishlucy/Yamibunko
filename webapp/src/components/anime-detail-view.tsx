"use client"

import Image from "next/image"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ImageUp, Pencil, X } from "lucide-react"

import { AniListTracking } from "@/components/anilist-tracking"
import { AnimeVariantSelect } from "@/components/anime-variant-select"
import { EpisodeCard } from "@/components/episode-card"
import { MobileDescription } from "@/components/mobile-description"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { animeVariantSecondTitle, formatSeriesEntryLabel } from "@/lib/anime-title"
import { apiGet } from "@/lib/api"
import {
  clientLibraryRefreshEvent,
  libraryEventsPath,
  type LibraryChangeEvent,
} from "@/lib/library-events"
import type { AnimeDetailPayload, Episode } from "@/lib/types"

const coverAspectRatio = 3 / 4
const coverOutputWidth = 900
const coverOutputHeight = 1200

type LibraryUpdateResponse = {
  ok: boolean
  result?: {
    slug?: string
    animeId?: number
    coverImage?: string
    movedFiles?: number
  }
  error?: string
  message?: string
}

function isSeriesFormat(format?: string) {
  return !format || format === "TV" || format === "TV_SHORT" || format === "ONA"
}

function selectedSubtitle(input: {
  format?: string
  libraryTitle: string
  title: string
  seasonNumber?: number
}) {
  if (isSeriesFormat(input.format)) {
    return formatSeriesEntryLabel({
      libraryTitle: input.libraryTitle,
      mediaTitle: input.title,
      seasonNumber: input.seasonNumber,
    })
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

function parseLibraryChangeEvent(event: Event) {
  const message = event as MessageEvent<string>

  try {
    return JSON.parse(message.data) as LibraryChangeEvent
  } catch {
    return null
  }
}

function affectsCurrentEntry(input: {
  event: LibraryChangeEvent
  data: AnimeDetailPayload
}) {
  const { event, data } = input
  const libraryEntry = data.libraryEntry
  const knownAnimeIds = new Set([
    libraryEntry.selected.id,
    ...libraryEntry.variants.map((variant) => variant.id),
  ])

  return (
    event.librarySlug === libraryEntry.slug ||
    knownAnimeIds.has(event.animeId) ||
    knownAnimeIds.has(event.rootAnimeId)
  )
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob)
        } else {
          reject(new Error("Image crop failed"))
        }
      },
      "image/webp",
      0.9
    )
  })
}

async function cropCoverImage(file: File) {
  if (!file.type.startsWith("image/")) {
    throw new Error("Select an image file")
  }

  const bitmap = await createImageBitmap(file)
  const inputRatio = bitmap.width / bitmap.height
  const sourceWidth = inputRatio > coverAspectRatio ? bitmap.height * coverAspectRatio : bitmap.width
  const sourceHeight = inputRatio > coverAspectRatio ? bitmap.height : bitmap.width / coverAspectRatio
  const sourceX = (bitmap.width - sourceWidth) / 2
  const sourceY = (bitmap.height - sourceHeight) / 2
  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d")

  if (!context) {
    throw new Error("Image crop failed")
  }

  canvas.width = coverOutputWidth
  canvas.height = coverOutputHeight
  context.drawImage(
    bitmap,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    coverOutputWidth,
    coverOutputHeight
  )
  bitmap.close()

  return canvasToBlob(canvas)
}

async function readLibraryUpdateError(response: Response) {
  const body = (await response.json().catch(() => null)) as LibraryUpdateResponse | null

  return body?.message ?? body?.error ?? `Request failed: ${response.status}`
}

function animeDetailUrl(slug: string, animeId?: number) {
  const media = animeId ? `?media=${encodeURIComponent(String(animeId))}` : ""
  return `/anime/${encodeURIComponent(slug)}${media}`
}

export function AnimeDetailView({
  initialData,
  isAdmin = false,
}: {
  initialData: AnimeDetailPayload
  isAdmin?: boolean
}) {
  const router = useRouter()
  const [data, setData] = useState(initialData)
  const [editOpen, setEditOpen] = useState(false)
  const [editTitle, setEditTitle] = useState("")
  const [editDescription, setEditDescription] = useState("")
  const [anilistId, setAnilistId] = useState("")
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [coverUploading, setCoverUploading] = useState(false)
  const [coverError, setCoverError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dataRef = useRef(initialData)
  const refreshTimerRef = useRef<number | null>(null)
  const loadingRef = useRef(false)
  const rerunAfterLoadRef = useRef(false)
  const loadDetailRef = useRef<() => Promise<void>>(async () => undefined)
  const libraryEntry = data.libraryEntry
  const anime = libraryEntry.selected
  const selectedVariant = libraryEntry.variants.find(
    (variant) => variant.id === anime.id
  )
  const localEpisodeCount = selectedVariant?.episodeCount ?? data.episodes.length
  const subtitle = selectedSubtitle({
    format: anime.format,
    libraryTitle: libraryEntry.title,
    title: selectedVariant?.title ?? anime.title,
    seasonNumber: selectedVariant?.seasonNumber,
  })
  const episodesBySeason = useMemo(() => {
    const seasons = new Map<number, Episode[]>()

    for (const episode of data.episodes) {
      const seasonEpisodes = seasons.get(episode.seasonNumber) ?? []
      seasonEpisodes.push(episode)
      seasons.set(episode.seasonNumber, seasonEpisodes)
    }

    return seasons
  }, [data.episodes])

  useEffect(() => {
    dataRef.current = data
  }, [data])

  const loadDetail = useCallback(async () => {
    if (loadingRef.current) {
      rerunAfterLoadRef.current = true
      return
    }

    loadingRef.current = true

    try {
      const current = dataRef.current
      const params = new URLSearchParams()
      params.set("media", String(current.libraryEntry.selected.id))
      const nextData = await apiGet<AnimeDetailPayload>(
        `/api/anime/library/${encodeURIComponent(current.libraryEntry.slug)}?${params.toString()}`
      )
      dataRef.current = nextData
      setData(nextData)
    } catch {
    } finally {
      loadingRef.current = false

      if (rerunAfterLoadRef.current) {
        rerunAfterLoadRef.current = false
        void loadDetailRef.current()
      }
    }
  }, [])

  useEffect(() => {
    loadDetailRef.current = loadDetail
  }, [loadDetail])

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      return
    }

    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null
      void loadDetail()
    }, 250)
  }, [loadDetail])

  useEffect(() => {
    const source = new EventSource(libraryEventsPath)

    const onLibraryChange = (event: Event) => {
      const payload = parseLibraryChangeEvent(event)

      if (!payload) {
        return
      }

      if (affectsCurrentEntry({ event: payload, data: dataRef.current })) {
        scheduleRefresh()
      }
    }

    const onClientRefresh = () => {
      scheduleRefresh()
    }

    source.addEventListener("library-change", onLibraryChange)
    window.addEventListener(clientLibraryRefreshEvent, onClientRefresh)

    return () => {
      source.removeEventListener("library-change", onLibraryChange)
      source.close()
      window.removeEventListener(clientLibraryRefreshEvent, onClientRefresh)

      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [scheduleRefresh])

  const openEditDialog = useCallback(() => {
    setEditTitle(anime.title)
    setEditDescription(anime.description ?? "")
    setAnilistId("")
    setEditError(null)
    setEditOpen(true)
  }, [anime.description, anime.title])

  const closeEditDialog = useCallback(() => {
    if (editSaving) {
      return
    }

    setEditOpen(false)
    setEditError(null)
    setAnilistId("")
  }, [editSaving])

  const submitEdit = useCallback(async () => {
    setEditSaving(true)
    setEditError(null)

    try {
      const current = dataRef.current
      const selected = current.libraryEntry.selected
      const payload = selected.isLocalNonAnime
        ? {
            action: "update-non-anime",
            animeId: selected.id,
            title: editTitle,
            description: editDescription,
          }
        : {
            action: "set-anilist-id",
            animeId: selected.id,
            anilistId,
          }
      const response = await fetch(
        `/api/anime/library/${encodeURIComponent(current.libraryEntry.slug)}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      )

      if (!response.ok) {
        throw new Error(await readLibraryUpdateError(response))
      }

      const body = (await response.json().catch(() => null)) as LibraryUpdateResponse | null
      setEditOpen(false)
      setEditError(null)
      setAnilistId("")
      window.dispatchEvent(new Event(clientLibraryRefreshEvent))

      if (body?.result?.slug && body.result.animeId) {
        router.replace(animeDetailUrl(body.result.slug, body.result.animeId))
        router.refresh()
      } else {
        await loadDetailRef.current()
      }
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Update failed")
    } finally {
      setEditSaving(false)
    }
  }, [anilistId, editDescription, editTitle, router])

  const openCoverUpload = useCallback(() => {
    setCoverError(null)
    fileInputRef.current?.click()
  }, [])

  const uploadCover = useCallback(
    async (file: File) => {
      const current = dataRef.current
      const selected = current.libraryEntry.selected

      if (!selected.isLocalNonAnime) {
        return
      }

      setCoverUploading(true)
      setCoverError(null)

      try {
        const cropped = await cropCoverImage(file)
        const formData = new FormData()
        const params = new URLSearchParams()
        params.set("media", String(selected.id))
        formData.set("image", cropped, "cover.webp")

        const response = await fetch(
          `/api/anime/library/${encodeURIComponent(current.libraryEntry.slug)}/cover?${params.toString()}`,
          {
            method: "POST",
            body: formData,
          }
        )

        if (!response.ok) {
          throw new Error(await readLibraryUpdateError(response))
        }

        window.dispatchEvent(new Event(clientLibraryRefreshEvent))
        await loadDetailRef.current()
      } catch (error) {
        setCoverError(error instanceof Error ? error.message : "Cover upload failed")
      } finally {
        setCoverUploading(false)
      }
    },
    []
  )

  return (
    <div className="space-y-6 lg:space-y-8">
      <section className="relative overflow-hidden rounded-lg border border-white/10 bg-zinc-900">
        {anime.bannerImage ? (
          <Image
            src={anime.bannerImage}
            alt=""
            fill
            priority
            unoptimized
            sizes="100vw"
            className="absolute inset-0 h-full w-full object-cover opacity-35"
          />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-r from-zinc-950 via-zinc-950/80 to-zinc-950/30" />
        <div className="relative grid grid-cols-[96px_1fr] gap-3 p-4 sm:grid-cols-[160px_1fr] sm:gap-5 sm:p-6 lg:grid-cols-[200px_1fr] lg:gap-7 lg:p-8">
          <div className="space-y-2">
            <div className="relative aspect-[3/4] overflow-hidden rounded-lg border border-white/10 bg-zinc-800 shadow-2xl">
              {anime.coverImage ? (
                <Image
                  src={anime.coverImage}
                  alt=""
                  width={320}
                  height={427}
                  priority
                  unoptimized
                  className="h-full w-full object-cover"
                />
              ) : null}
              {isAdmin && anime.isLocalNonAnime ? (
                <button
                  type="button"
                  onClick={openCoverUpload}
                  disabled={coverUploading}
                  aria-label="Upload image for this entry"
                  className="absolute right-2 bottom-2 inline-flex size-9 items-center justify-center rounded-full border border-white/15 bg-black/75 text-zinc-100 shadow-lg backdrop-blur transition hover:border-violet-300/60 hover:bg-violet-500/30 focus-visible:ring-2 focus-visible:ring-violet-300/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <ImageUp className="size-4" />
                </button>
              ) : null}
            </div>
            {isAdmin ? (
              <Button
                type="button"
                variant="outline"
                onClick={openEditDialog}
                className="w-full border-white/10 bg-black/30 text-zinc-200 hover:bg-white/10 hover:text-zinc-50"
              >
                <Pencil className="mr-2 size-4" />
                Edit entry
              </Button>
            ) : null}
            {coverUploading ? (
              <p className="text-xs text-violet-200">Uploading image...</p>
            ) : null}
            {coverError ? <p className="text-xs text-red-300">{coverError}</p> : null}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.currentTarget.value = ""

                if (file) {
                  void uploadCover(file)
                }
              }}
            />
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
                  spoilerSettings={data.spoilers}
                  onProgressChange={scheduleRefresh}
                />
              ))}
            </div>
          </div>
        ))}
      </section>

      {editOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-xl border border-white/10 bg-zinc-950 p-5 shadow-2xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-zinc-50">
                  {anime.isLocalNonAnime ? "Edit non-anime entry" : "Correct AniList entry"}
                </h2>
                <p className="mt-1 text-sm text-zinc-400">{anime.title}</p>
              </div>
              <button
                type="button"
                onClick={closeEditDialog}
                className="rounded-full p-1.5 text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"
              >
                <X className="size-4" />
              </button>
            </div>

            {anime.isLocalNonAnime ? (
              <div className="space-y-3">
                <label className="block space-y-1.5 text-sm">
                  <span className="text-zinc-300">Title</span>
                  <Input
                    value={editTitle}
                    onChange={(event) => setEditTitle(event.target.value)}
                    disabled={editSaving}
                    className="border-white/10 bg-zinc-900 text-zinc-100"
                  />
                </label>
                <label className="block space-y-1.5 text-sm">
                  <span className="text-zinc-300">Description</span>
                  <textarea
                    value={editDescription}
                    onChange={(event) => setEditDescription(event.target.value)}
                    disabled={editSaving}
                    rows={6}
                    className="w-full resize-none rounded-md border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-violet-400/50 focus:ring-2 focus:ring-violet-400/20"
                  />
                </label>
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block space-y-1.5 text-sm">
                  <span className="text-zinc-300">AniList ID</span>
                  <Input
                    value={anilistId}
                    onChange={(event) => setAnilistId(event.target.value.replace(/[^0-9]/g, ""))}
                    inputMode="numeric"
                    disabled={editSaving}
                    placeholder="105333"
                    className="border-white/10 bg-zinc-900 text-zinc-100"
                  />
                </label>
                <p className="text-xs leading-5 text-zinc-500">
                  This corrects only the currently selected entry, moves that entry&apos;s files into the corrected library folder, and updates its database rows.
                </p>
              </div>
            )}

            {editError ? <p className="mt-3 text-sm text-red-300">{editError}</p> : null}

            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={closeEditDialog}
                disabled={editSaving}
                className="border-white/10 bg-transparent text-zinc-200 hover:bg-white/10"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void submitEdit()}
                disabled={editSaving || (!anime.isLocalNonAnime && !anilistId)}
                className="bg-violet-600 text-white hover:bg-violet-500"
              >
                {editSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
