import { requireApiUser } from "@/server/auth/api"
import { getServerCastDevices } from "@/server/media/serverCast"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  try {
    const receiverBaseUrl = new URL(request.url).searchParams.get("receiverBaseUrl") ?? undefined
    return Response.json({ devices: await getServerCastDevices({ receiverBaseUrl }) })
  } catch (error) {
    console.error(`[Error] [Cast] Server-side Chromecast discovery failed - ${error instanceof Error ? error.message : String(error)}`)
    return Response.json({ devices: [] })
  }
}
