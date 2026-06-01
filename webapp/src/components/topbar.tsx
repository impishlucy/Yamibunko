"use client"

import { useState } from "react"
import Link from "next/link"
import { LogOut, Settings, UserRound } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import type { CurrentUser } from "@/server/auth/session"

function initials(username: string) {
  return username.slice(0, 2).toUpperCase()
}

export function Topbar({ user }: { user: CurrentUser }) {
  const [open, setOpen] = useState(false)

  async function logout() {
    await fetch("/api/auth/logout", {
      method: "POST",
    }).catch(() => undefined)

    window.location.assign("/login")
  }

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-[#0d0d12]/85 px-4 py-3 backdrop-blur sm:px-6 lg:px-8">
      <div className="relative flex items-center justify-between gap-3">
        <Link
          href="/library"
          prefetch={false}
          className="text-sm font-semibold tracking-normal text-zinc-100 transition hover:text-violet-200"
        >
          Yamibunko
        </Link>

        <div className="relative">
          <Button
            type="button"
            variant="ghost"
            className="h-9 gap-2 rounded-lg px-2"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <Avatar className="size-7 border border-violet-400/25">
              <AvatarFallback className="bg-violet-500/15 text-xs text-violet-100">
                {initials(user.username)}
              </AvatarFallback>
            </Avatar>
            <span className="hidden text-sm text-zinc-300 sm:inline">
              {user.username}
            </span>
          </Button>

          {open ? (
            <div className="absolute top-full right-0 mt-2 w-56 overflow-hidden rounded-lg border border-white/10 bg-zinc-950 shadow-2xl shadow-black/40">
              <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-sm text-zinc-200">
                <UserRound className="size-4 text-zinc-500" />
                <span className="min-w-0 truncate">{user.username}</span>
              </div>
              <Link
                href="/settings"
                prefetch={false}
                className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 transition hover:bg-white/5 hover:text-zinc-50"
                onClick={() => setOpen(false)}
              >
                <Settings className="size-4 text-zinc-500" />
                Settings
              </Link>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 transition hover:bg-white/5 hover:text-zinc-50"
                onClick={logout}
              >
                <LogOut className="size-4 text-zinc-500" />
                Log out
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  )
}
