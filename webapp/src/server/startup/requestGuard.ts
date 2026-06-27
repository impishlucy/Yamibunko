import { NextResponse } from "next/server"

import { getServerStartupStatus } from "@/server/startup/readiness"

export function getStartupBlockedResponse() {
  const status = getServerStartupStatus()

  if (status.ready) {
    return null
  }

  return NextResponse.json(
    {
      error: "Server is starting up, please check back later",
      ready: false,
      failed: status.failed,
      phase: status.phase,
      message: status.message,
      estimatedWaitText: status.estimatedWaitText,
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Retry-After": "5",
      },
    }
  )
}
