import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { AppShell } from "@/components/app-shell"
import { getCurrentUser } from "@/server/auth/session"

export const dynamic = "force-dynamic"

export default async function ProtectedAppLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await getCurrentUser()

  if (!user) {
    redirect("/login")
  }

  return <AppShell user={user}>{children}</AppShell>
}
