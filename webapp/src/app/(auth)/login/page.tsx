import { redirect } from "next/navigation"

import { AuthForm } from "@/components/auth-form"
import { getCurrentUser } from "@/server/auth/session"
import { hasAnyUsers } from "@/server/db/users"

export const dynamic = "force-dynamic"

export default async function LoginPage() {
  const user = await getCurrentUser()

  if (user) {
    redirect("/library")
  }

  return <AuthForm mode={hasAnyUsers() ? "login" : "registration"} />
}
