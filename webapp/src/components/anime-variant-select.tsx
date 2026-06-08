"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { animeVariantSecondTitle, getAnimeTitleSuffix } from "@/lib/anime-title"
import type { AnimeVariant } from "@/lib/types"

function seasonLabel(seasonNumber?: number) {
  return `Season ${String(seasonNumber ?? 1).padStart(2, "0")}`
}

function shortSeasonLabel(seasonNumber?: number) {
  return `S${seasonNumber ?? 1}`
}

function normalizeTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function isSameOrSeasonOnlyTitle(input: {
  libraryTitle: string
  mediaTitle: string
  seasonNumber?: number
}) {
  const libraryTitle = normalizeTitle(input.libraryTitle)
  const mediaTitle = normalizeTitle(input.mediaTitle)

  if (!libraryTitle || !mediaTitle) {
    return false
  }

  if (libraryTitle === mediaTitle) {
    return true
  }

  if (!input.seasonNumber || !mediaTitle.startsWith(`${libraryTitle} `)) {
    return false
  }

  const suffix = mediaTitle.slice(libraryTitle.length + 1)
  const seasonOnlyPattern = new RegExp(
    String.raw`^(?:season\s*0*${input.seasonNumber}|s\s*0*${input.seasonNumber})(?:\s*(?:part|cour|pt|p)\s*0*\d{1,2})?$`,
    "i"
  )

  return seasonOnlyPattern.test(suffix)
}

function variantLabel(variant: AnimeVariant, libraryTitle: string) {
  const title = animeVariantSecondTitle({
    libraryTitle,
    mediaTitle: variant.title,
  })

  if (variant.format === "MOVIE") {
    return `[Movie] ${title}`
  }

  if (variant.format === "SPECIAL" || variant.format === "OVA") {
    return `[Special] ${title}`
  }

  const titleSuffix = getAnimeTitleSuffix({
    libraryTitle,
    mediaTitle: variant.title,
  })
  const seasonNumber = variant.seasonNumber ?? 1
  const hasSeasonPrefix = seasonNumber > 1
  const seriesTitle = titleSuffix ?? title

  if (hasSeasonPrefix) {
    const isSeasonOnlyTitle = isSameOrSeasonOnlyTitle({
      libraryTitle,
      mediaTitle: seriesTitle,
      seasonNumber,
    })

    if (!seriesTitle || isSeasonOnlyTitle) {
      return `[Series] ${shortSeasonLabel(seasonNumber)}`
    }

    return `[Series] ${shortSeasonLabel(seasonNumber)} - ${seriesTitle}`
  }

  return `[Series] ${seriesTitle || seasonLabel(variant.seasonNumber)}`
}

export function AnimeVariantSelect({
  variants,
  selectedId,
  libraryTitle,
}: {
  variants: AnimeVariant[]
  selectedId: number
  libraryTitle: string
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
          const params = new URLSearchParams(searchParams)
          params.set("media", event.target.value)
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
