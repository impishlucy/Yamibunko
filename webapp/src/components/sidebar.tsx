"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { LibraryBig, Settings, Sparkles } from "lucide-react"

import { cn } from "@/lib/utils"

const navItems = [
  {
    href: "/library",
    label: "Library",
    icon: LibraryBig,
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
  },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="hidden w-64 shrink-0 border-r border-white/10 bg-zinc-950/80 px-3 py-4 md:block">
      <Link
        href="/library"
        className="mb-6 flex items-center gap-3 rounded-lg px-2 py-2"
      >
        <span className="flex size-9 items-center justify-center rounded-lg border border-violet-400/25 bg-violet-500/15 text-violet-200 shadow-[0_0_28px_rgba(139,92,246,0.25)]">
          <Sparkles className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold tracking-wide">
            Yamibunko
          </span>
          <span className="block truncate text-xs text-zinc-500">
            Local catalog
          </span>
        </span>
      </Link>

      <nav className="space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`)

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100",
                active &&
                  "bg-violet-500/15 text-violet-100 ring-1 ring-violet-400/20"
              )}
            >
              <Icon className="size-4" />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
