import type { AnimeDetailPayload } from "@/lib/types"
import { requireApiUser } from "@/server/auth/api"
import { getEpisodes, getLibraryEntry } from "@/server/media/libraryStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type AnimeLibraryEntryContext = {
  params: Promise<{
    slug: string
  }>
}

export async function GET(request: Request, context: AnimeLibraryEntryContext) {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const { slug } = await context.params
  const media = new URL(request.url).searchParams.get("media") ?? undefined
  const libraryEntry = getLibraryEntry(slug, media)

  if (!libraryEntry) {
    return Response.json({ error: "Library entry not found" }, { status: 404 })
  }

  const payload: AnimeDetailPayload = {
    libraryEntry,
    episodes: getEpisodes(libraryEntry.selected.id, auth.user.username),
    spoilers: auth.user.spoilerSettings,
  }

  return Response.json(payload)
}
