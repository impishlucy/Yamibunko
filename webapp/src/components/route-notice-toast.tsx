"use client"

import { useEffect, useState } from "react"
import { routeNoticeEventName, takeRouteNotice } from "@/components/route-notice-redirect"

const noticeMessages: Record<string, string> = {
  "not-found": "Oops that page got isekai'd.",
  "not-allowed": "Not allowed to acces that Dungeon.",
}

function takeVisibleRouteNoticeMessage() {
  if (typeof window === "undefined") {
    return null
  }

  const notice = takeRouteNotice()

  return notice ? noticeMessages[notice] ?? null : null
}

export function RouteNoticeToast() {
  const [visibleMessage, setVisibleMessage] = useState<string | null>(
    takeVisibleRouteNoticeMessage
  )

  useEffect(() => {
    const onRouteNotice = () => {
      const message = takeVisibleRouteNoticeMessage()

      if (message) {
        setVisibleMessage(message)
      }
    }

    window.addEventListener(routeNoticeEventName, onRouteNotice)

    return () => {
      window.removeEventListener(routeNoticeEventName, onRouteNotice)
    }
  }, [])

  useEffect(() => {
    if (!visibleMessage) {
      return
    }

    const timer = window.setTimeout(() => {
      setVisibleMessage(null)
    }, 3500)

    return () => {
      window.clearTimeout(timer)
    }
  }, [visibleMessage])

  if (!visibleMessage) {
    return null
  }

  return (
    <div className="fixed right-4 top-20 z-50 max-w-[calc(100vw-2rem)] rounded-lg border border-red-300/20 bg-red-500/15 px-4 py-3 text-sm font-medium text-red-100 shadow-2xl shadow-black/30 backdrop-blur sm:right-6">
      {visibleMessage}
    </div>
  )
}
