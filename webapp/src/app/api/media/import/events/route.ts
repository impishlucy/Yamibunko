import { requireApiUser } from "@/server/auth/api"
import {
  getMediaImportProcessingState,
  subscribeMediaImportProcessing,
} from "@/server/media/importProcessingStatus"

import { getStartupBlockedResponse } from "@/server/startup/requestGuard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

  const auth = await requireApiUser()

  if (!auth.ok) {
    return auth.response
  }

  const encoder = new TextEncoder()
  let cleanup: () => void = () => undefined

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let unsubscribe: () => void = () => undefined

      const write = (chunk: string) => {
        if (closed) {
          return
        }

        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup()
        }
      }

      const writeState = () => {
        write(
          `event: processing-state\ndata: ${JSON.stringify(getMediaImportProcessingState())}\n\n`
        )
      }
      const keepAliveTimer = setInterval(() => {
        write(": keep-alive\n\n")
      }, 25000)

      cleanup = () => {
        if (closed) {
          return
        }

        closed = true
        unsubscribe()
        clearInterval(keepAliveTimer)
      }

      write(": connected\n\n")
      writeState()
      unsubscribe = subscribeMediaImportProcessing((state) => {
        write(`event: processing-state\ndata: ${JSON.stringify(state)}\n\n`)
      })
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  })
}
