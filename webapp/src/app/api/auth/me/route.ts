import { requireApiUser } from "@/server/auth/api"
import { hasAnyUsers } from "@/server/db/users"

import { getStartupBlockedResponse } from "@/server/startup/requestGuard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const user = auth.user

  return Response.json({
    hasUsers: hasAnyUsers(),
    user: {
      username: user.username,
      name: user.name,
      isAdmin: user.isAdmin,
      isVip: user.isVip,
      hasPassword: user.hasPassword,
    },
  })
}
