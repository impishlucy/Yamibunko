import { requireApiUser } from "@/server/auth/api"
import { getServerCastStatus } from "@/server/media/serverCast"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim()

  if (!sessionId) {
    return Response.json({ ok: false, error: "BAD_REQUEST" }, { status: 400 })
  }

  try {
    const state = await getServerCastStatus(sessionId, auth.user.username)
    return Response.json({ ok: true, state })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chromecast status failed."
    return Response.json({ ok: false, error: message }, { status: 502 })
  }
}
