import { notFound } from "next/navigation"

import { AnimeDetailView } from "@/components/anime-detail-view"
import { defaultSpoilerSettings, type AnimeDetailPayload } from "@/lib/types"
import { getCurrentUser } from "@/server/auth/session"
import { getEpisodes, getLibraryEntry } from "@/server/media/libraryStore"

type AnimePageProps = {
  params: Promise<{
    slug: string
  }>
  searchParams: Promise<{
    media?: string
  }>
}

export default async function AnimePage({
  params,
  searchParams,
}: AnimePageProps) {
  const { slug } = await params
  const { media } = await searchParams
  const libraryEntry = getLibraryEntry(slug, media)

  if (!libraryEntry) {
    return notFound()
  }

  const user = await getCurrentUser()
  const initialData: AnimeDetailPayload = {
    libraryEntry,
    episodes: getEpisodes(libraryEntry.selected.id, user?.username),
    spoilers: user?.spoilerSettings ?? defaultSpoilerSettings,
  }

  return (
    <AnimeDetailView
      key={`${libraryEntry.slug}:${libraryEntry.selected.id}`}
      initialData={initialData}
      isAdmin={Boolean(user?.isAdmin)}
    />
  )
}
