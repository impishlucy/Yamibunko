import { requireAdminApiUser, requireSameOriginRequest } from "@/server/auth/api"
import {
  getActiveStreamBandwidthSnapshot,
  toggleTemporaryUploadLimit,
} from "@/server/bandwidth/streamBandwidth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const auth = await requireAdminApiUser(request)

  if (!auth.ok) {
    return auth.response
  }

  return Response.json({
    ok: true,
    bandwidth: getActiveStreamBandwidthSnapshot(),
  })
}

export async function POST(request: Request) {
  const sameOriginError = await requireSameOriginRequest(request)

  if (sameOriginError) {
    return sameOriginError
  }

  const auth = await requireAdminApiUser(request)

  if (!auth.ok) {
    return auth.response
  }

  return Response.json({
    ok: true,
    bandwidth: toggleTemporaryUploadLimit(),
  })
}
