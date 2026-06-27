import { requireApiUser } from "@/server/auth/api"

import { getStartupBlockedResponse } from "@/server/startup/requestGuard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function gone(request: Request) {
  const auth = await requireApiUser(request)

  if (!auth.ok) {
    return auth.response
  }

  return Response.json(
    { ok: false, error: "PRIORITY_POLLING_REMOVED" },
    { status: 410 }
  )
}

export async function GET(request: Request) {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

  return gone(request)
}

export async function POST(request: Request) {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

  return gone(request)
}
