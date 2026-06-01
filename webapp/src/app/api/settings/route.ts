import { requireApiUser } from "@/server/auth/api"
import { getSafeServerSettings, getServerConfigResult } from "@/server/config"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const configResult = getServerConfigResult()

  if (!configResult.ok) {
    return Response.json(
      {
        ok: false,
        error: "SERVER_CONFIG_INVALID",
        issues: configResult.issues,
      },
      { status: 500 }
    )
  }

  return Response.json(
    getSafeServerSettings({
      userName: auth.user.username,
      isAdmin: auth.user.isAdmin,
    })
  )
}
