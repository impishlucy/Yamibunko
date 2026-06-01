import { requireApiUser } from "@/server/auth/api"
import { getSafeServerSettings } from "@/server/config"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  return Response.json(
    getSafeServerSettings({
      userName: auth.user.username,
      isAdmin: auth.user.isAdmin,
    })
  )
}
