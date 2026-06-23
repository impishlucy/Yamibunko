"use client"

import { useEffect, useState } from "react"
import { CheckCircle2, Loader2, XCircle } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function TvLoginApproval({ code }: { code: string }) {
  const [status, setStatus] = useState<"approving" | "success" | "error">("approving")
  const [message, setMessage] = useState("Approving TV login...")

  useEffect(() => {
    let cancelled = false

    async function approveLogin() {
      try {
        const response = await fetch(`/api/auth/tv/code/${encodeURIComponent(code)}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
        })

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string
          } | null

          throw new Error(payload?.error ?? "TV login code is no longer valid.")
        }

        if (!cancelled) {
          setStatus("success")
          setMessage("Login Successful")
        }
      } catch (error) {
        if (!cancelled) {
          setStatus("error")
          setMessage(error instanceof Error ? error.message : "TV login failed.")
        }
      }
    }

    void approveLogin()

    return () => {
      cancelled = true
    }
  }, [code])

  return (
    <Card className="w-full rounded-lg border-white/10 bg-zinc-900/85 shadow-[0_24px_90px_rgba(124,58,237,0.18)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl text-zinc-50">
          {status === "approving" ? <Loader2 className="size-5 animate-spin" /> : null}
          {status === "success" ? <CheckCircle2 className="size-5 text-emerald-300" /> : null}
          {status === "error" ? <XCircle className="size-5 text-red-300" /> : null}
          TV Login
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-zinc-300">{message}</p>
      </CardContent>
    </Card>
  )
}
