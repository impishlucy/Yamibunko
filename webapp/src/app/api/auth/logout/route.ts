import { requireSameOriginRequest } from "@/server/auth/api"
import { clearSessionCookie } from "@/server/auth/session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  await clearSessionCookie()

  return Response.json({ ok: true })
}
