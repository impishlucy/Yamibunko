import { z } from "zod"

import { requireApiUser } from "@/server/auth/api"
import {
  subscribeStreamPriorityActions,
  type StreamPriorityAction,
} from "@/server/bandwidth/streamBandwidth"

import { getStartupBlockedResponse } from "@/server/startup/requestGuard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const priorityEventsQuerySchema = z.object({
  clientId: z.string().trim().min(8).max(128),
})

function encodeEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function encodeRetry(milliseconds: number) {
  return `retry: ${milliseconds}\n\n`
}

export async function GET(request: Request) {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

  const auth = await requireApiUser(request)

  if (!auth.ok) {
    return auth.response
  }

  const url = new URL(request.url)
  const parsed = priorityEventsQuerySchema.safeParse({
    clientId: url.searchParams.get("clientId"),
  })

  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "INVALID_PRIORITY_EVENTS_QUERY" },
      { status: 400 }
    )
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
