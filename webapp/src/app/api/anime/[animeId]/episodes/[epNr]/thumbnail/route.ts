import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"

import { requireApiUser } from "@/server/auth/api"
import { getEpisodeThumbnailPath } from "@/server/db/library"
import { getEpisode } from "@/server/media/libraryStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type ThumbnailContext = {
  params: Promise<{
    animeId: string
    epNr: string
  }>
}

const fallbackThumbnail = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
)

function thumbnailPathForEpisode(filePath: string) {
  const extension = path.extname(filePath)
  return `${filePath.slice(0, -extension.length)}.jpg`
}

function fallbackThumbnailResponse() {
  return new Response(fallbackThumbnail, {
    headers: {
      "content-type": "image/png",
      "content-length": String(fallbackThumbnail.length),
      "cache-control": "private, max-age=300",
    },
  })
}

export async function GET(request: Request, context: ThumbnailContext) {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const { animeId, epNr } = await context.params
  const url = new URL(request.url)
  const season = url.searchParams.get("season") ?? "1"
  const episode = getEpisode(animeId, season, epNr)

  if (!episode) {
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 })
  }

  const thumbnailPath =
    getEpisodeThumbnailPath(animeId, season, epNr) ??
    thumbnailPathForEpisode(episode.filePath)

  try {
    const fileStat = await stat(/*turbopackIgnore: true*/ thumbnailPath)

    if (!fileStat.isFile()) {
      return fallbackThumbnailResponse()
    }

    const fileStream = createReadStream(/*turbopackIgnore: true*/ thumbnailPath)

    return new Response(
      Readable.toWeb(fileStream) as ReadableStream<Uint8Array>,
      {
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(fileStat.size),
          "cache-control": "private, max-age=3600",
        },
      }
    )
  } catch {
    return fallbackThumbnailResponse()
  }
}
