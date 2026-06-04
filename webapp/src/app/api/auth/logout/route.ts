import { requireSameOriginRequest } from "@/server/auth/api"
import { clearSessionCookie, getCurrentUser } from "@/server/auth/session"
import { guardApiRequest } from "@/server/security/abuseGuard"
import { closeActiveStreamsForUser } from "@/server/bandwidth/streamBandwidth"
import { deleteSessionsByUsername } from "@/server/db/sessions"
import { deleteCastStreamTokensForUser } from "@/server/media/castTokens"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const abuseError = await guardApiRequest(request)

  if (abuseError) {
    return abuseError
  }

  const user = await getCurrentUser()

  if (user) {
    closeActiveStreamsForUser(user.username)
    deleteSessionsByUsername(user.username)
    deleteCastStreamTokensForUser(user.username)
  }

  await clearSessionCookie()

  return Response.json({ ok: true })
}
