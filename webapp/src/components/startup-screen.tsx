"use client"

import { useEffect, useState } from "react"

import type { StartupReadinessStatus } from "@/server/startup/readiness"

type StartupScreenProps = {
  initialStatus: StartupReadinessStatus
}

export function StartupScreen({ initialStatus }: StartupScreenProps) {
  const [status, setStatus] = useState(initialStatus)

  useEffect(() => {
    let cancelled = false

    async function refreshStatus() {
      try {
        const response = await fetch("/api/startup/status", {
          cache: "no-store",
        })

        if (!response.ok) {
          return
        }

        const nextStatus = (await response.json()) as StartupReadinessStatus

        if (cancelled) {
          return
        }

        if (nextStatus.ready) {
          window.location.reload()
          return
        }

        setStatus(nextStatus)
      } catch {
        return
      }
    }

    const interval = window.setInterval(refreshStatus, 5000)
    void refreshStatus()

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

  const message = status.message || "Server is starting up, please check back later"

  return (
    <main className="grid min-h-svh place-items-center bg-[#0d0d12] px-6 py-12 text-zinc-100">
      <section className="w-full max-w-xl rounded-3xl border border-white/10 bg-white/[0.04] px-8 py-10 text-center shadow-2xl shadow-black/30 backdrop-blur">
        <div className="mx-auto mb-6 h-12 w-12 rounded-full border-2 border-violet-300/30 border-t-violet-300 animate-spin" />
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{message}</h1>
        {status.estimatedWaitText ? (
          <p className="mt-4 text-base text-zinc-300">{status.estimatedWaitText}</p>
        ) : null}
        {status.failed ? (
          <p className="mt-4 text-sm text-red-300">Check the server console for details.</p>
        ) : (
          <p className="mt-6 text-sm text-zinc-500">This page refreshes automatically.</p>
        )}
      </section>
    </main>
  )
}
