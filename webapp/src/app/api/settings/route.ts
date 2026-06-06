import { defaultSpoilerSettings, type SpoilerSettings } from "@/lib/types"
import { forbidden, requireApiUser, requireSameOriginRequest } from "@/server/auth/api"
import { getSafeServerSettings } from "@/server/config"
import {
  setUserDisableUpdateBadges,
  setUserSpoilerSettings,
} from "@/server/db/users"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function safeSettingsForUser(user: {
  username: string
  isAdmin: boolean
  disableUpdateBadges?: boolean
  spoilerSettings?: SpoilerSettings
}) {
  return getSafeServerSettings({
    account: {
      userName: user.username,
      isAdmin: user.isAdmin,
      disableUpdateBadges: user.disableUpdateBadges ?? false,
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

function parseDisableUpdateBadges(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const input = payload as { disableUpdateBadges?: unknown }

  return typeof input.disableUpdateBadges === "boolean"
    ? input.disableUpdateBadges
    : null
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
    account?: unknown
    spoilers?: unknown
  } | null
  const hasSpoilers = Boolean(
    payload && Object.prototype.hasOwnProperty.call(payload, "spoilers")
  )
  const hasAccount = Boolean(
    payload && Object.prototype.hasOwnProperty.call(payload, "account")
  )

  if (!hasSpoilers && !hasAccount) {
    return Response.json(
      { ok: false, error: "INVALID_SETTINGS" },
      { status: 400 }
    )
  }

  const spoilers = hasSpoilers
    ? parseSpoilerSettings(payload?.spoilers)
    : null
  const disableUpdateBadges = hasAccount
    ? parseDisableUpdateBadges(payload?.account)
    : null

  if ((hasSpoilers && !spoilers) || (hasAccount && disableUpdateBadges === null)) {
    return Response.json(
      { ok: false, error: "INVALID_SETTINGS" },
      { status: 400 }
    )
  }

  if (hasAccount && !auth.user.isAdmin) {
    return forbidden()
  }

  const nextSpoilers = spoilers
    ? setUserSpoilerSettings(auth.user.username, spoilers)
    : auth.user.spoilerSettings
  const nextDisableUpdateBadges =
    disableUpdateBadges === null
      ? auth.user.disableUpdateBadges
      : setUserDisableUpdateBadges(auth.user.username, disableUpdateBadges)

  return Response.json({
    ok: true,
    settings: getSafeServerSettings({
      account: {
        userName: auth.user.username,
        isAdmin: auth.user.isAdmin,
        disableUpdateBadges: nextDisableUpdateBadges,
      },
      spoilers: nextSpoilers,
    }),
  })
}
