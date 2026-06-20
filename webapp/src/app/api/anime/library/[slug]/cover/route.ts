import {
  requireAdminApiUser,
  requireApiUser,
  requireSameOriginRequest,
} from "@/server/auth/api"
import {
  getLibraryCoverResponse,
  LibraryAdminError,
  saveNonAnimeLibraryCover,
} from "@/server/media/libraryAdmin"
import { parsePositiveInt } from "@/server/utils/format"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type LibraryCoverContext = {
  params: Promise<{
    slug: string
  }>
}

function libraryAdminErrorResponse(error: unknown) {
  if (error instanceof LibraryAdminError) {
    return Response.json(
      { ok: false, error: error.code, message: error.message },
      { status: error.status }
    )
  }

  console.error(error)

  return Response.json(
    { ok: false, error: "LIBRARY_COVER_UPDATE_FAILED" },
    { status: 500 }
  )
}

function selectedAnimeId(request: Request) {
  return parsePositiveInt(new URL(request.url).searchParams.get("media"))
}

export async function GET(request: Request, context: LibraryCoverContext) {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const { slug } = await context.params

  try {
    const response = await getLibraryCoverResponse({
      slug,
      animeId: selectedAnimeId(request),
    })

    if (!response) {
      return Response.json({ ok: false, error: "COVER_NOT_FOUND" }, { status: 404 })
    }

    return response
  } catch (error) {
    return libraryAdminErrorResponse(error)
  }
}

export async function POST(request: Request, context: LibraryCoverContext) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const auth = await requireAdminApiUser(request)

  if (!auth.ok) {
    return auth.response
  }

  const formData = await request.formData().catch(() => null)
  const file = formData?.get("image")

  if (!(file instanceof File)) {
    return Response.json(
      { ok: false, error: "INVALID_COVER_UPLOAD" },
      { status: 400 }
    )
  }

  const { slug } = await context.params

  try {
    const bytes = Buffer.from(await file.arrayBuffer())
    const result = await saveNonAnimeLibraryCover({
      slug,
      animeId: selectedAnimeId(request),
      bytes,
    })

    return Response.json({ ok: true, result })
  } catch (error) {
    return libraryAdminErrorResponse(error)
  }
}
