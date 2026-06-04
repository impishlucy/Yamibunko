import { z } from "zod"

import { requireApiUser, requireSameOriginRequest } from "@/server/auth/api"
import {
  protectCurrentForcedDowngrade,
  subscribeStreamPriorityActions,
  type StreamPriorityAction,
} from "@/server/bandwidth/streamBandwidth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const priorityEventsQuerySchema = z.object({
  clientId: z.string().trim().min(8).max(128),
  protected: z.enum(["0", "1"]).optional(),
})

const priorityProtectionSchema = z.object({
  clientId: z.string().trim().min(8).max(128),
  protected: z.boolean(),
})

function encodeEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function encodeRetry(milliseconds: number) {
  return `retry: ${milliseconds}\n\n`
}

export async function GET(request: Request) {
  const auth = await requireApiUser(request)

  if (!auth.ok) {
    return auth.response
  }

  const url = new URL(request.url)
  const parsed = priorityEventsQuerySchema.safeParse({
    clientId: url.searchParams.get("clientId"),
    protected: url.searchParams.get("protected") ?? undefined,
  })

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_PRIORITY_EVENTS_QUERY" },
      { status: 400 }
    )
  }

  if (parsed.data.protected === "1") {
    protectCurrentForcedDowngrade(auth.user.username, parsed.data.clientId)
  }

  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup()
        }
      }

      const sendAction = (action: StreamPriorityAction) => {
        send(encodeEvent("priority", action))
      }

      const cleanup = () => {
        unsubscribe?.()
        unsubscribe = null

        if (heartbeatTimer) {
          clearInterval(heartbeatTimer)
          heartbeatTimer = null
        }

        request.signal.removeEventListener("abort", cleanup)
      }

      unsubscribe = subscribeStreamPriorityActions({
        username: auth.user.username,
        clientId: parsed.data.clientId,
        onAction: sendAction,
      })

      send(encodeRetry(3_000))
      send(encodeEvent("ready", { ok: true, now: Date.now() }))
      heartbeatTimer = setInterval(
        () => send(encodeEvent("heartbeat", { now: Date.now() })),
        25_000
      )
      heartbeatTimer.unref?.()
      request.signal.addEventListener("abort", cleanup, { once: true })
    },
    cancel() {
      unsubscribe?.()
      unsubscribe = null

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      Vary: "Cookie",
    },
  })
}

export async function POST(request: Request) {
  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const auth = await requireApiUser(request)

  if (!auth.ok) {
    return auth.response
  }

  const parsed = priorityProtectionSchema.safeParse(
    await request.json().catch(() => null)
  )

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_PRIORITY_PROTECTION_BODY" },
      { status: 400 }
    )
  }

  if (parsed.data.protected) {
    protectCurrentForcedDowngrade(auth.user.username, parsed.data.clientId)
  }

  return Response.json({ ok: true })
}
