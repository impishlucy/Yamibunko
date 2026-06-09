"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { getAnimeTitleSuffix } from "@/lib/anime-title"
import {
  formatSeasonPartCompactLabel,
  parseSeasonPartFromText,
  type ParsedSeasonPart,
} from "@/lib/media-labels"
import type { AnimeVariant } from "@/lib/types"

const numberMarkerPattern =
  String.raw`(?:\d{1,2}|[ivx]+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|[4-9]th|10th)`
const seasonPartSeparatorPattern = String.raw`(?:\s|[:：\-–—])*`
const leadingSeasonPartPattern = new RegExp(
  String.raw`^\s*(?:season|s)\s*0*\d{1,2}(?:(?:${seasonPartSeparatorPattern}(?:part|pt\.?|p|cour|c)\s*${numberMarkerPattern})|(?:${seasonPartSeparatorPattern}${numberMarkerPattern}\s*(?:cour|half)))?(?:\s*(?::|[-–—])\s*|\s+)?`,
  "i"
)
const seasonPartOnlyPattern = new RegExp(
  String.raw`^\s*(?:season|s)\s*0*\d{1,2}(?:(?:${seasonPartSeparatorPattern}(?:part|pt\.?|p|cour|c)\s*${numberMarkerPattern})|(?:${seasonPartSeparatorPattern}${numberMarkerPattern}\s*(?:cour|half)))?\s*$`,
  "i"
)

function cleanSubtitle(value: string) {
  return value
    .replace(/^\s*(?:[:：\-–—]+\s*)+/, "")
    .replace(/\s*(?:[:：\-–—]+\s*)+$/, "")
    .replace(/\s+/g, " ")
    .trim()
}

function stripRedundantSeasonPartPrefix(value: string) {
  return cleanSubtitle(value.replace(leadingSeasonPartPattern, ""))
}

function getSeriesSeasonPart(variant: AnimeVariant): ParsedSeasonPart {
  const titleSeasonPart = parseSeasonPartFromText(variant.title)

  if (titleSeasonPart) {
    return titleSeasonPart
  }

  return { season: variant.seasonNumber ?? 1 }
}

function getSeriesSubtitle(input: { libraryTitle: string; mediaTitle: string }) {
  const titleSuffix = getAnimeTitleSuffix(input)

  if (!titleSuffix) {
    return null
  }

  if (seasonPartOnlyPattern.test(titleSuffix)) {
    return null
  }

  const strippedSubtitle = stripRedundantSeasonPartPrefix(titleSuffix)

  if (!strippedSubtitle || seasonPartOnlyPattern.test(strippedSubtitle)) {
    return null
  }

  return strippedSubtitle
}

function variantLabel(variant: AnimeVariant, libraryTitle: string) {
  const titleSuffix = getAnimeTitleSuffix({
    libraryTitle,
    mediaTitle: variant.title,
  })
  const title = titleSuffix ?? variant.title

  if (variant.format === "MOVIE") {
    return `[Movie] ${title}`
  }

  if (variant.format === "SPECIAL" || variant.format === "OVA") {
    return `[Special] ${title}`
  }

  const seasonPartLabel = formatSeasonPartCompactLabel(getSeriesSeasonPart(variant))
  const subtitle = getSeriesSubtitle({
    libraryTitle,
    mediaTitle: variant.title,
  })

  return `[Series] ${subtitle ? `${seasonPartLabel} - ${subtitle}` : seasonPartLabel}`
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
