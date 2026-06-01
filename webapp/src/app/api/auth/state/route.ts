import { getCurrentUser } from "@/server/auth/session"
import { hasAnyUsers } from "@/server/db/users"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const user = await getCurrentUser()

  return Response.json({
    hasUsers: hasAnyUsers(),
    user: user
      ? {
          username: user.username,
          isAdmin: user.isAdmin,
          hasPassword: user.hasPassword,
        }
      : null,
  })
}
