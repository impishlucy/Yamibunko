import type { CurrentUser } from "@/server/auth/session"
import { getCurrentUser } from "@/server/auth/session"
import { isSameOriginRequest } from "@/server/http/request"

export function unauthorized() {
  return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 })
}

export function forbidden() {
  return Response.json({ ok: false, error: "FORBIDDEN" }, { status: 403 })
}

export async function requireSameOriginRequest(request: Request) {
  if (await isSameOriginRequest(request)) {
    return null
  }

  return Response.json({ ok: false, error: "BAD_ORIGIN" }, { status: 403 })
}

export async function requireApiUser(): Promise<
  | {
      ok: true
      user: CurrentUser
    }
  | {
      ok: false
      response: Response
    }
> {
  const user = await getCurrentUser()

  if (!user) {
    return { ok: false, response: unauthorized() }
  }

  return { ok: true, user }
}

export async function requireAdminApiUser() {
  const result = await requireApiUser()

  if (!result.ok) {
    return result
  }

  if (!result.user.isAdmin) {
    return { ok: false as const, response: forbidden() }
  }

  return result
}
