import { requireApiUser } from "@/server/auth/api"
import { getMediaImportProcessingState } from "@/server/media/importProcessingStatus"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  return Response.json(getMediaImportProcessingState())
}
