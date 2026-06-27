import { getLibrary } from "@/server/media/libraryStore"
import { requireApiUser } from "@/server/auth/api"

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

  return Response.json(getLibrary())
}
