import { z } from "zod"

import { requireSameOriginRequest } from "@/server/auth/api"
import { getCurrentUser } from "@/server/auth/session"
import { getUser, hasAnyUsers } from "@/server/db/users"
import { guardAuthRequest } from "@/server/security/abuseGuard"
import { optionalUsernameSchema } from "@/server/security/input"

import { getStartupBlockedResponse } from "@/server/startup/requestGuard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const authStateQuerySchema = z.object({
  username: optionalUsernameSchema.optional().default(""),
})

export async function GET(request: Request) {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const abuseError = await guardAuthRequest(request)

  if (abuseError) {
    return abuseError
  }

  const user = await getCurrentUser()
  const url = new URL(request.url)
  const parsed = authStateQuerySchema.safeParse({
    username: url.searchParams.get("username") ?? "",
  })
  const username = parsed.success ? parsed.data.username : ""
  const loginUser = username ? getUser(username) : null

  return Response.json({
    hasUsers: hasAnyUsers(),
    pendingPasswordSetup: Boolean(loginUser && !loginUser.passwordHash),
    user: user
      ? {
          username: user.username,
          isAdmin: user.isAdmin,
          isVip: user.isVip,
          hasPassword: user.hasPassword,
        }
      : null,
  })
}
