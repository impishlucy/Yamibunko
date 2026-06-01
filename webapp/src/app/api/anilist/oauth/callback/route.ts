import { cookies } from "next/headers"

import { getCurrentUser } from "@/server/auth/session"
import {
  exchangeAniListAuthorizationCode,
  getAniListViewer,
  syncAniListLibraryProgress,
} from "@/server/anilist/client"
import { upsertAniListConnection } from "@/server/db/anilistConnections"
import { joinBaseUrl } from "@/server/http/baseUrl"
import { getPublicBaseUrl, getRequestOrigin } from "@/server/http/request"
import { serverLog } from "@/server/logger"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function settingsRedirect(
  _request: Request,
  params: Record<string, string>
) {
  const url = new URL(joinBaseUrl(await getPublicBaseUrl(), "/settings"))

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  return Response.redirect(url)
}

export async function GET(request: Request) {
  const user = await getCurrentUser()

  if (!user) {
    return settingsRedirect(request, { anilist: "login-required" })
  }

  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")
  const cookieStore = await cookies()
  const expectedState = cookieStore.get("yamibunko_anilist_oauth_state")?.value
  const secure = new URL(await getRequestOrigin(request)).protocol === "https:"

  cookieStore.set("yamibunko_anilist_oauth_state", "", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  })

  if (error) {
    return settingsRedirect(request, { anilist: "denied" })
  }

  if (!code || !state || !expectedState || state !== expectedState) {
    return settingsRedirect(request, { anilist: "invalid-state" })
  }

  try {
    const token = await exchangeAniListAuthorizationCode(request, code)
    const viewer = await getAniListViewer(token.accessToken)

    upsertAniListConnection({
      username: user.username,
      aniListUserId: viewer.id,
      aniListUsername: viewer.name,
      accessToken: token.accessToken,
      tokenType: token.tokenType,
    })

    await syncAniListLibraryProgress(user.username).catch((syncError) => {
      serverLog.error("Anilist", "Initial list sync failed.", {
        error: syncError,
      })
    })

    return settingsRedirect(request, { anilist: "connected" })
  } catch (callbackError) {
    serverLog.error("Anilist", "OAuth callback failed.", {
      error: callbackError,
    })
    return settingsRedirect(request, { anilist: "failed" })
  }
}
