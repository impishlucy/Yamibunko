import { redirect } from "next/navigation"

import { TvLoginApproval } from "@/components/tv-login-approval"
import { getCurrentUser } from "@/server/auth/session"

export const dynamic = "force-dynamic"

type TvCodePageProps = {
  params: Promise<{
    code: string
  }>
}

export default async function TvCodePage({ params }: TvCodePageProps) {
  const { code } = await params
  const user = await getCurrentUser()

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/auth/code/${code}`)}`)
  }

  return <TvLoginApproval code={code} />
}
