import type { ReactNode } from "react"

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative grid min-h-svh place-items-center overflow-hidden bg-[#0d0d12] px-4 py-8 text-zinc-100">
      <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_top,rgba(124,58,237,0.22),transparent_34%),linear-gradient(180deg,#15151d,#0d0d12)]" />
      <div className="relative z-10 w-full max-w-sm">{children}</div>
    </main>
  )
}
