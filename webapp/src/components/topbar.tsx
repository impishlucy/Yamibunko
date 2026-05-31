import Link from "next/link"
import { LibraryBig, Settings } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { buttonVariants } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export function Topbar() {
  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-[#0d0d12]/85 px-4 py-3 backdrop-blur sm:px-6 lg:px-8">
      <div className="flex items-center justify-between gap-3">
        <nav className="flex items-center gap-1 md:hidden">
          <Link
            href="/library"
            title="Library"
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}
          >
            <LibraryBig className="size-4" />
          </Link>
          <Link
            href="/settings"
            title="Settings"
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}
          >
            <Settings className="size-4" />
          </Link>
        </nav>

        <div className="hidden min-w-0 md:block">
          <p className="truncate text-sm font-medium text-zinc-100">
            Yamibunko
          </p>
          <p className="truncate text-xs text-zinc-500">
            Self-hosted local anime library
          </p>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <Separator
            orientation="vertical"
            className="hidden h-6 bg-white/10 sm:block"
          />
          <div className="flex items-center gap-2">
            <Avatar className="size-8 border border-violet-400/25">
              <AvatarFallback className="bg-violet-500/15 text-xs text-violet-100">
                LU
              </AvatarFallback>
            </Avatar>
            <span className="hidden text-sm text-zinc-300 sm:inline">
              Local User
            </span>
          </div>
        </div>
      </div>
    </header>
  )
}
