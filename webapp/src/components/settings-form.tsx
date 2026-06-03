"use client"

import { useEffect, useMemo, useState } from "react"
import { KeyRound, Link2Off, UserRound } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isStrongPassword } from "@/lib/password-policy"
import type { SafeSettings } from "@/lib/types"

type SettingsFormProps = {
  settings: SafeSettings
}

type AniListConnectionResponse = {
  configured: boolean
  connected: boolean
  user: {
    id: number
    name: string
    connectedAt: string
    lastListSyncAt: string | null
  } | null
}

type AniListOAuthStatus =
  | "connected"
  | "failed"
  | "invalid-state"
  | "denied"
  | "login-required"

function getAniListOAuthMessage(status: AniListOAuthStatus | null) {
  if (!status) {
    return null
  }

  if (status === "connected") {
    return { kind: "success" as const, text: "AniList connected." }
  }

  if (status === "invalid-state") {
    return {
      kind: "error" as const,
      text: "AniList connection failed because the OAuth state expired or did not match.",
    }
  }

  if (status === "denied") {
    return { kind: "error" as const, text: "AniList authorization was denied." }
  }

  if (status === "login-required") {
    return { kind: "error" as const, text: "Log in before connecting AniList." }
  }

  return {
    kind: "error" as const,
    text: "AniList connection failed. Check the OAuth app settings and server logs.",
  }
}

function getInitialAniListOAuthStatus(): AniListOAuthStatus | null {
  if (typeof window === "undefined") {
    return null
  }

  const status = new URLSearchParams(window.location.search).get("anilist")

  if (
    status === "connected" ||
    status === "failed" ||
    status === "invalid-state" ||
    status === "denied" ||
    status === "login-required"
  ) {
    return status
  }

  return null
}

export function SettingsForm({ settings }: SettingsFormProps) {
  const [password, setPassword] = useState("")
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [aniList, setAniList] = useState<AniListConnectionResponse | null>(null)
  const [aniListOAuthStatus] = useState<AniListOAuthStatus | null>(
    getInitialAniListOAuthStatus
  )
  const aniListAvailable = aniList?.configured ?? false
  const aniListOAuthMessage = getAniListOAuthMessage(aniListOAuthStatus)

  const canSavePassword = useMemo(() => isStrongPassword(password), [password])

  useEffect(() => {
    let cancelled = false

    fetch("/api/anilist/connection", {
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: AniListConnectionResponse | null) => {
        if (!cancelled && payload) {
          setAniList(payload)
        }
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [])

  async function savePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage(null)
    setError(null)

    if (!canSavePassword) {
      setError("Password does not meet the account policy.")
      return
    }

    setSubmitting(true)

    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          password,
        }),
      })

      if (!response.ok) {
        throw new Error("Unable to update password")
      }

      setPassword("")
      setMessage("Password updated.")
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to update password"
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function disconnectAniList() {
    const response = await fetch("/api/anilist/connection", {
      method: "DELETE",
    })

    if (response.ok) {
      setAniList((await response.json()) as AniListConnectionResponse)
    }
  }

  return (
    <div className="space-y-5">
      <Card className="rounded-lg border-white/10 bg-zinc-900/75">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <UserRound className="size-4 text-violet-300" />
            Account
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={savePassword}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="settings-username" className="text-zinc-400">
                  Username
                </Label>
                <Input
                  id="settings-username"
                  value={settings.account.userName}
                  readOnly
                  className="h-9 rounded-lg border-white/10 bg-zinc-950/70 text-zinc-100"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-password" className="text-zinc-400">
                  Password
                </Label>
                <Input
                  id="settings-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  className="h-9 rounded-lg border-white/10 bg-zinc-950/70 text-zinc-100"
                />
              </div>
            </div>

            {error ? <p className="text-sm text-red-300">{error}</p> : null}
            {message ? (
              <p className="text-sm text-emerald-300">{message}</p>
            ) : null}

            <Button
              type="submit"
              disabled={!canSavePassword || submitting}
              className="rounded-lg"
            >
              <KeyRound className="size-4" />
              {submitting ? "Saving..." : "Change password"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card
        className={`rounded-lg border-white/10 bg-zinc-900/75 ${
          aniList && !aniListAvailable ? "opacity-55" : ""
        }`}
        aria-disabled={aniList && !aniListAvailable ? true : undefined}
      >
        <CardHeader>
          <CardTitle className="text-zinc-100">AniList</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-zinc-100">
              {aniList?.connected
                ? `Connected as ${aniList.user?.name}`
                : "Not connected"}
            </p>
            {!aniList?.configured ? (
              <p className="text-sm text-zinc-400">
                OAuth app id and secret are not configured.
              </p>
            ) : null}
            {aniListOAuthMessage ? (
              <p
                className={`text-sm ${
                  aniListOAuthMessage.kind === "success"
                    ? "text-emerald-300"
                    : "text-red-300"
                }`}
              >
                {aniListOAuthMessage.text}
              </p>
            ) : null}
          </div>

          {aniListAvailable && aniList?.connected ? (
            <Button
              type="button"
              variant="outline"
              className="rounded-lg"
              onClick={disconnectAniList}
            >
              <Link2Off className="size-4" />
              Disconnect
            </Button>
          ) : (
            <Button
              type="button"
              className="rounded-lg"
              disabled={!aniListAvailable}
              onClick={() => {
                window.location.assign("/api/anilist/oauth/start")
              }}
            >
              Connect AniList
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
