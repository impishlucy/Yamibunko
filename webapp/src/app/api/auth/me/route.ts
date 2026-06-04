import { requireApiUser } from "@/server/auth/api"
import { hasAnyUsers } from "@/server/db/users"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const user = auth.user

  return Response.json({
    hasUsers: hasAnyUsers(),
    user: {
      username: user.username,
      name: user.name,
      isAdmin: user.isAdmin,
      isVip: user.isVip,
      hasPassword: user.hasPassword,
    },
  })
}
