import { z } from "zod"

import { requireApiUser, requireSameOriginRequest } from "@/server/auth/api"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const castLogSchema = z.object({
  error: z.string().trim().min(1).max(4000),
})

export async function POST(request: Request) {
  const sameOriginError = await requireSameOriginRequest(request)

  if (sameOriginError) {
    return sameOriginError
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const parsed = castLogSchema.safeParse(await request.json().catch(() => null))

  if (!parsed.success) {
    return Response.json({ ok: false, error: "BAD_REQUEST" }, { status: 400 })
  }

  console.error(
    `[Error] [Cast] ${auth.user.username} Cast error: ${parsed.data.error}`
  )

  return Response.json({ ok: true })
}
