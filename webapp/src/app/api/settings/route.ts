import { defaultSpoilerSettings, type SpoilerSettings } from "@/lib/types"
import { requireApiUser, requireSameOriginRequest } from "@/server/auth/api"
import { getSafeServerSettings } from "@/server/config"
import { setUserSpoilerSettings } from "@/server/db/users"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function safeSettingsForUser(user: {
  username: string
  isAdmin: boolean
  spoilerSettings?: SpoilerSettings
}) {
  return getSafeServerSettings({
    account: {
      userName: user.username,
      isAdmin: user.isAdmin,
    },
    spoilers: user.spoilerSettings ?? defaultSpoilerSettings,
  })
}

function parseSpoilerSettings(payload: unknown): SpoilerSettings | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const input = payload as Partial<Record<keyof SpoilerSettings, unknown>>

  if (
    typeof input.blurEpisodeThumbnails !== "boolean" ||
    typeof input.removeUnwatchedEpisodeTitles !== "boolean"
  ) {
    return null
  }

  return {
    blurEpisodeThumbnails: input.blurEpisodeThumbnails,
    removeUnwatchedEpisodeTitles: input.removeUnwatchedEpisodeTitles,
  }
}

export async function GET() {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  return Response.json(safeSettingsForUser(auth.user))
}

export async function PATCH(request: Request) {
  const sameOriginError = await requireSameOriginRequest(request)

  if (sameOriginError) {
    return sameOriginError
  }

  const auth = await requireApiUser(request)

  if (!auth.ok) {
    return auth.response
  }

  const payload = (await request.json().catch(() => null)) as {
    spoilers?: unknown
  } | null
  const spoilers = parseSpoilerSettings(payload?.spoilers)

  if (!spoilers) {
    return Response.json({ ok: false, error: "INVALID_SETTINGS" }, { status: 400 })
  }

  const nextSpoilers = setUserSpoilerSettings(auth.user.username, spoilers)

  return Response.json({
    ok: true,
    settings: getSafeServerSettings({
      account: {
        userName: auth.user.username,
        isAdmin: auth.user.isAdmin,
      },
      spoilers: nextSpoilers,
    }),
  })
}
