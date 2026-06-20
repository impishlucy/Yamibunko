"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { formatSeriesEntryLabel, getAnimeRealTitleSuffix } from "@/lib/anime-title"
import type { AnimeVariant } from "@/lib/types"

function variantLabel(variant: AnimeVariant, libraryTitle: string) {
  const titleSuffix = getAnimeRealTitleSuffix({
    libraryTitle,
    mediaTitle: variant.title,
  })
  const title = titleSuffix ?? variant.title

  switch (variant.format) {
    case "MOVIE":
      return `[Movie] ${title}`
    case "SPECIAL":
    case "OVA":
      return `[Special] ${title}`
    default:
      return `[Series] ${formatSeriesEntryLabel({
        libraryTitle,
        mediaTitle: variant.title,
        seasonNumber: variant.seasonNumber,
      })}`
  }
}

export function AnimeVariantSelect({
  variants,
  selectedId,
  libraryTitle,
  onSelect,
}: {
  variants: AnimeVariant[]
  selectedId: number
  libraryTitle: string
  onSelect?: (animeId: number) => void
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  if (variants.length <= 1) {
    return null
  }

  return (
    <label className="w-full max-w-sm space-y-1.5">
      <span className="text-xs font-medium text-zinc-500">Library entry</span>
      <select
        value={selectedId}
        onChange={(event) => {
          const nextSelectedId = Number(event.target.value)
          const params = new URLSearchParams(searchParams)
          params.set("media", event.target.value)
          onSelect?.(nextSelectedId)
          router.push(`${pathname}?${params.toString()}`)
        }}
        className="h-9 w-full rounded-lg border border-white/10 bg-zinc-950/80 px-3 text-sm text-zinc-100 outline-none"
      >
        {variants.map((variant) => (
          <option key={variant.id} value={variant.id}>
            {variantLabel(variant, libraryTitle)}
          </option>
        ))}
      </select>
    </label>
  )
}
