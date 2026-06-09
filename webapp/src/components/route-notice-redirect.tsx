"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

export type RouteNoticeKind = "not-found" | "not-allowed"

export const routeNoticeEventName = "yamibunko.route-notice"

const noticeStorageKey = "yamibunko.route-notice"

export function storeRouteNotice(kind: RouteNoticeKind) {
  window.sessionStorage.setItem(noticeStorageKey, kind)
  window.dispatchEvent(new CustomEvent(routeNoticeEventName))
}

export function takeRouteNotice() {
  const value = window.sessionStorage.getItem(noticeStorageKey)

  if (value) {
    window.sessionStorage.removeItem(noticeStorageKey)
  }

  return value
}

export function RouteNoticeRedirect({ kind }: { kind: RouteNoticeKind }) {
  const router = useRouter()

  useEffect(() => {
    storeRouteNotice(kind)
    router.replace("/library")
  }, [kind, router])

  return null
}
