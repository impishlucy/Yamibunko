import { requireApiUser } from "@/server/auth/api"

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
  return gone(request)
}

export async function POST(request: Request) {
  return gone(request)
}
