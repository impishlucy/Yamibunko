import type { ReactNode } from "react"

import { Sidebar } from "@/components/sidebar"
import { Topbar } from "@/components/topbar"
import type { CurrentUser } from "@/server/auth/session"

export function AppShell({
  children,
  user,
}: {
  children: ReactNode
  user: CurrentUser
}) {
  return (
    <div className="min-h-svh bg-[#0d0d12] text-zinc-100">
      <div className="mx-auto flex min-h-svh w-full max-w-[1800px]">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar user={user} />
          <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8">
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}
