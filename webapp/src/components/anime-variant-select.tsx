"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"

import type { AnimeVariant } from "@/lib/types"

function variantLabel(variant: AnimeVariant) {
  if (variant.format === "MOVIE") {
    return `[Movie] ${variant.title}`
  }

  if (variant.format === "SPECIAL" || variant.format === "OVA") {
    return `[Special] ${variant.title}`
  }

  return `[Series] Season ${String(variant.seasonNumber ?? 1).padStart(2, "0")}`
}

export function AnimeVariantSelect({
  variants,
  selectedId,
}: {
  variants: AnimeVariant[]
  selectedId: number
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
            {variantLabel(variant)}
          </option>
        ))}
      </select>
    </label>
  )
}
