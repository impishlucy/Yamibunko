import { NextResponse } from "next/server"

import { getServerStartupStatus } from "@/server/startup/readiness"

export const dynamic = "force-dynamic"

export function GET() {
  return NextResponse.json(getServerStartupStatus(), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  })
}
