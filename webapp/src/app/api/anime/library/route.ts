import { getLibrary } from "@/server/media/libraryStore"
import { requireApiUser } from "@/server/auth/api"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  return Response.json(getLibrary())
}
