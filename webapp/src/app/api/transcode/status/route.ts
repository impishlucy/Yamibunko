import { getLiveTranscodeStatus } from "@/server/transcode/liveTranscodeSlots"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json(getLiveTranscodeStatus())
}
