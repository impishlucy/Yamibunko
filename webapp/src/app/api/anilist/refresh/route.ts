import { z } from "zod"

import { requireApiUser, requireSameOriginRequest } from "@/server/auth/api"
import { isAniListConfigured } from "@/server/anilist/client"
import {
  refreshAniListTrackingData,
  runFullAniListRefresh,
} from "@/server/anilist/sync"
import { getSafeAniListConnection } from "@/server/db/anilistConnections"
import {
  getUserAniListRefreshState,
  markUserAniListRefreshPressed,
} from "@/server/db/users"
import { errorMessage } from "@/server/utils/format"

import { getStartupBlockedResponse } from "@/server/startup/requestGuard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const refreshSchema = z.object({
  action: z.enum(["user", "all"]),
})

function getRefreshState(username: string, isAdmin: boolean) {
  const configured = isAniListConfigured()
  const connection = configured ? getSafeAniListConnection(username) : null
  const connected = Boolean(connection)
  const cooldown = getUserAniListRefreshState(username)
  const canPress = cooldown?.canPress ?? false

  return {
    configured,
    connected,
    visible: isAdmin || connected,
    canPress,
    cooldownSeconds: cooldown?.cooldownSeconds ?? 0,
    lastPressedAt: cooldown?.lastPressedAt ?? null,
    actions: {
      user: connected,
      all: isAdmin,
    },
  }
}

export async function GET() {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  return Response.json(getRefreshState(auth.user.username, auth.user.isAdmin))
}

export async function POST(request: Request) {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const body = await request.json().catch(() => null)
  const parsed = refreshSchema.safeParse(body)

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_REFRESH_PAYLOAD" },
      { status: 400 }
    )
  }

  const connection = isAniListConfigured()
    ? getSafeAniListConnection(auth.user.username)
    : null

  if (parsed.data.action === "user" && !connection) {
    return Response.json(
      { ok: false, error: "ANILIST_NOT_CONNECTED" },
      { status: 400 }
    )
  }

  if (parsed.data.action === "all" && !auth.user.isAdmin) {
    return Response.json({ ok: false, error: "FORBIDDEN" }, { status: 403 })
  }

  if (!markUserAniListRefreshPressed(auth.user.username)) {
    return Response.json(
      {
        ok: false,
        error: "REFRESH_COOLDOWN_ACTIVE",
        state: getRefreshState(auth.user.username, auth.user.isAdmin),
      },
      { status: 429 }
    )
  }

  try {
    if (parsed.data.action === "user") {
      await refreshAniListTrackingData(auth.user.username)
    } else {
      await runFullAniListRefresh("manual")
    }
  } catch (error) {
    console.error(
      `[Error] [Anilist] Manual refresh failed - refresh/route.ts - ${parsed.data.action} - ${auth.user.username} - ${errorMessage(error)}`
    )
    return Response.json(
      {
        ok: false,
        error: "ANILIST_REFRESH_FAILED",
        state: getRefreshState(auth.user.username, auth.user.isAdmin),
      },
      { status: 502 }
    )
  }

  return Response.json({
    ok: true,
    state: getRefreshState(auth.user.username, auth.user.isAdmin),
  })
}
