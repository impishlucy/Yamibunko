import { z } from "zod"

import { getSafeServerSettings, getServerConfigResult } from "@/server/config"

export const dynamic = "force-dynamic"

const settingsPatchSchema = z.object({
  appearance: z
    .object({
      theme: z.literal("dark").optional(),
    })
    .optional(),
})

export async function GET() {
  const configResult = getServerConfigResult()

  if (!configResult.ok) {
    return Response.json(
      {
        ok: false,
        error: "SERVER_CONFIG_INVALID",
        issues: configResult.issues,
      },
      { status: 500 }
    )
  }

  return Response.json(getSafeServerSettings())
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => ({}))
  const patch = settingsPatchSchema.parse(body)
  const configResult = getServerConfigResult()

  if (!configResult.ok) {
    return Response.json(
      {
        ok: false,
        error: "SERVER_CONFIG_INVALID",
        issues: configResult.issues,
      },
      { status: 500 }
    )
  }

  return Response.json({
    ok: true,
    settings: {
      ...getSafeServerSettings(),
      ...patch,
    },
  })
}
