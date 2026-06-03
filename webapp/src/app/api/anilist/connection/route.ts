import { requireApiUser, requireSameOriginRequest } from "@/server/auth/api"
import { isAniListConfigured } from "@/server/anilist/client"
import { getAniListRateLimitState } from "@/server/anilist/transport"
import {
  deleteAniListConnection,
  getSafeAniListConnection,
} from "@/server/db/anilistConnections"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const configured = isAniListConfigured()
  const connection = getSafeAniListConnection(auth.user.username)

  return Response.json({
    configured,
    connected: configured && Boolean(connection),
    rateLimit: getAniListRateLimitState(),
    user:
      configured && connection
        ? {
            id: connection.aniListUserId,
            name: connection.aniListUsername,
            connectedAt: connection.connectedAt,
            lastListSyncAt: connection.lastListSyncAt,
          }
        : null,
  })
}

export async function DELETE(request: Request) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  deleteAniListConnection(auth.user.username)

  return Response.json({
    ok: true,
    configured: isAniListConfigured(),
    connected: false,
    rateLimit: getAniListRateLimitState(),
    user: null,
  })
}
