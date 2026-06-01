import { getCurrentUser } from "@/server/auth/session"
import { getUser, hasAnyUsers } from "@/server/db/users"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const user = await getCurrentUser()
  const url = new URL(request.url)
  const username = url.searchParams.get("username")?.trim() ?? ""
  const loginUser = username ? getUser(username) : null

  return Response.json({
    hasUsers: hasAnyUsers(),
    pendingPasswordSetup: Boolean(loginUser && !loginUser.passwordHash),
    user: user
      ? {
          username: user.username,
          isAdmin: user.isAdmin,
          hasPassword: user.hasPassword,
        }
      : null,
  })
}
