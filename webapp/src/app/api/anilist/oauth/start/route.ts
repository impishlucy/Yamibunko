import { randomBytes } from "node:crypto"

import { cookies } from "next/headers"

import { requireApiUser, requireSameOriginRequest } from "@/server/auth/api"
import { getAniListAuthorizationUrl } from "@/server/anilist/client"
import { getRequestOrigin } from "@/server/http/request"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  try {
    const state = randomBytes(32).toString("base64url")
    const cookieStore = await cookies()
    const secure =
      new URL(await getRequestOrigin(request)).protocol === "https:"

    cookieStore.set("yamibunko_anilist_oauth_state", state, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: 10 * 60,
    })

    return Response.redirect(await getAniListAuthorizationUrl(request, state))
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "AniList OAuth is unavailable"

    return Response.json({ ok: false, error: message }, { status: 400 })
  }
}
