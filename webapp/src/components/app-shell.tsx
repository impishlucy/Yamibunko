"use client"

import type { ReactNode } from "react"
import { usePathname } from "next/navigation"

import { RouteNoticeToast } from "@/components/route-notice-toast"
import { Topbar } from "@/components/topbar"
import { useTvMode } from "@/components/tv-mode-provider"
import { cn } from "@/lib/utils"
import type { CurrentUser } from "@/server/auth/session"

export function AppShell({
  children,
  user,
}: {
  children: ReactNode
  user: CurrentUser
}) {
  const pathname = usePathname()
  const isWatchRoute = pathname.startsWith("/watch")
  const { isTvLike } = useTvMode()

  return (
    <div className="min-h-svh bg-[#0d0d12] text-zinc-100">
      <div
        className={cn(
          "mx-auto flex min-h-svh w-full max-w-[1800px] flex-col",
          isTvLike ? "yami-tv-shell max-w-none" : null
        )}
      >
        {isTvLike ? null : <Topbar user={user} />}
        <main
          className={cn(
            "yami-app-main min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8",
            isWatchRoute ? "yami-watch-main" : null,
            isTvLike ? "yami-tv-main" : null
          )}
        >
          {children}
        </main>
        {isTvLike ? null : <RouteNoticeToast />}
      </div>
    </div>
  )
}
