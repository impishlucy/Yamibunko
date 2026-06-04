import type { CurrentUser } from "@/server/auth/session"
import { getCurrentUser } from "@/server/auth/session"
import { isSameOriginRequest } from "@/server/http/request"
import {
  guardApiRequest,
  guardRequest,
  recordBadOrigin,
} from "@/server/security/abuseGuard"

export function unauthorized() {
  return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 })
}

export function forbidden() {
  return Response.json({ ok: false, error: "FORBIDDEN" }, { status: 403 })
}

export async function requireSameOriginRequest(request: Request) {
  const blocked = await guardRequest(request, { kind: "api", count: false })

  if (blocked) {
    return blocked
  }

  if (await isSameOriginRequest(request)) {
    return null
  }

  await recordBadOrigin(request)

  return Response.json({ ok: false, error: "BAD_ORIGIN" }, { status: 403 })
}

export async function requireApiUser(request?: Request): Promise<
  | {
      ok: true
      user: CurrentUser
    }
  | {
      ok: false
      response: Response
    }
> {
  const blocked = await guardApiRequest(request)

  if (blocked) {
    return { ok: false, response: blocked }
  }

  const user = await getCurrentUser()

  if (!user) {
    return { ok: false, response: unauthorized() }
  }

  return { ok: true, user }
}

export async function requireAdminApiUser(request?: Request) {
  const result = await requireApiUser(request)

  if (!result.ok) {
    return result
  }

  if (!result.user.isAdmin) {
    return { ok: false as const, response: forbidden() }
  }

  return result
}
