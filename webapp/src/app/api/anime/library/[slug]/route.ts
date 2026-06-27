import { z } from "zod"

import type { AnimeDetailPayload } from "@/lib/types"
import {
  requireAdminApiUser,
  requireApiUser,
  requireSameOriginRequest,
} from "@/server/auth/api"
import { getEpisodes, getLibraryEntry } from "@/server/media/libraryStore"
import {
  correctAnimeLibraryEntry,
  LibraryAdminError,
  updateNonAnimeLibraryDetails,
} from "@/server/media/libraryAdmin"

import { getStartupBlockedResponse } from "@/server/startup/requestGuard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type AnimeLibraryEntryContext = {
  params: Promise<{
    slug: string
  }>
}

const libraryUpdateSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set-anilist-id"),
    animeId: z.coerce.number().int().positive().optional(),
    anilistId: z.coerce.number().int().positive(),
  }),
  z.object({
    action: z.literal("update-non-anime"),
    animeId: z.coerce.number().int().positive().optional(),
    title: z.string().trim().min(1).max(120),
    description: z.string().max(5000).default(""),
  }),
])

function libraryAdminErrorResponse(error: unknown) {
  if (error instanceof LibraryAdminError) {
    return Response.json(
      { ok: false, error: error.code, message: error.message },
      { status: error.status }
    )
  }

  console.error(error)

  return Response.json(
    { ok: false, error: "LIBRARY_ADMIN_UPDATE_FAILED" },
    { status: 500 }
  )
}

export async function GET(request: Request, context: AnimeLibraryEntryContext) {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

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

export async function PATCH(request: Request, context: AnimeLibraryEntryContext) {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const auth = await requireAdminApiUser(request)

  if (!auth.ok) {
    return auth.response
  }

  const body = await request.json().catch(() => null)
  const parsed = libraryUpdateSchema.safeParse(body)

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_LIBRARY_UPDATE_PAYLOAD" },
      { status: 400 }
    )
  }

  const { slug } = await context.params

  try {
    const result =
      parsed.data.action === "set-anilist-id"
        ? await correctAnimeLibraryEntry({
            slug,
            animeId: parsed.data.animeId,
            anilistId: parsed.data.anilistId,
          })
        : updateNonAnimeLibraryDetails({
            slug,
            animeId: parsed.data.animeId,
            title: parsed.data.title,
            description: parsed.data.description,
          })

    return Response.json({ ok: true, result })
  } catch (error) {
    return libraryAdminErrorResponse(error)
  }
}
