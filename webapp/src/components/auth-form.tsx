"use client"

import { useEffect, useMemo, useState } from "react"
import { BadgeInfo } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { HoverHint } from "@/components/ui/hover-hint"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isStrongPassword } from "@/lib/password-policy"

type AuthFormProps = {
  mode: "registration" | "login"
}

const passwordRequirements = [
  "At least 12 characters",
  "One lowercase letter from a-z",
  "One uppercase letter from A-Z",
  "One number from 0-9",
  "One special character, such as ! @ # $ % ^ & *",
]

function PasswordRequirementsHint() {
  return (
    <HoverHint
      align="end"
      side="top"
      label={
        <span className="block text-left">
          <span className="block font-medium text-zinc-100">
            Password needs:
          </span>
          <span className="mt-1 block space-y-0.5">
            {passwordRequirements.map((requirement) => (
              <span key={requirement} className="block">
                • {requirement}
              </span>
            ))}
          </span>
        </span>
      }
    >
      <span
        aria-label="Password requirements"
        className="inline-flex size-5 cursor-help items-center justify-center rounded-full text-zinc-400 transition-colors hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
        role="button"
        tabIndex={0}
      >
        <BadgeInfo className="size-4" aria-hidden="true" />
      </span>
    </HoverHint>
  )
}

export function AuthForm({ mode }: AuthFormProps) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [pendingPasswordSetupUsername, setPendingPasswordSetupUsername] =
    useState<string | null>(null)

  const normalizedUsername = username.trim()
  const pendingPasswordSetup =
    mode === "login" && pendingPasswordSetupUsername === normalizedUsername
  const title =
    mode === "registration" || pendingPasswordSetup ? "Register" : "Login"
  const endpoint =
    mode === "registration" ? "/api/auth/register" : "/api/auth/login"
  const canSubmit = useMemo(
    () => username.trim().length >= 3 && isStrongPassword(password),
    [password, username]
  )

  useEffect(() => {
    if (mode !== "login" || normalizedUsername.length < 3) {
      return
    }

    const controller = new AbortController()

    fetch(
      `/api/auth/state?username=${encodeURIComponent(normalizedUsername)}`,
      {
        cache: "no-store",
        signal: controller.signal,
      }
    )
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { pendingPasswordSetup?: boolean } | null) => {
        setPendingPasswordSetupUsername(
          payload?.pendingPasswordSetup ? normalizedUsername : null
        )
      })
      .catch(() => undefined)

    return () => {
      controller.abort()
    }
  }, [mode, normalizedUsername])

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (!canSubmit) {
      setError("Password does not meet the account policy.")
      return
    }

    setSubmitting(true)

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          username,
          password,
        }),
      })

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string
        } | null

        throw new Error(payload?.error ?? "Authentication failed")
      }

      window.location.assign("/library")
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Authentication failed"
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="w-full rounded-lg border-white/10 bg-zinc-900/85 shadow-[0_24px_90px_rgba(124,58,237,0.18)]">
      <CardHeader>
        <CardTitle className="text-xl text-zinc-50">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="username" className="text-zinc-400">
              Username
            </Label>
            <Input
              id="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              className="rounded-lg border-white/10 bg-zinc-950/70"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="password" className="text-zinc-400">
                Password
              </Label>
              {mode === "registration" ? <PasswordRequirementsHint /> : null}
            </div>
            <Input
              id="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete={
                mode === "registration" || pendingPasswordSetup
                  ? "new-password"
                  : "current-password"
              }
              className="rounded-lg border-white/10 bg-zinc-950/70"
            />
          </div>

          {error ? <p className="text-sm text-red-300">{error}</p> : null}

          <Button
            type="submit"
            className="w-full rounded-lg"
            disabled={!canSubmit || submitting}
          >
            {submitting ? "Working..." : "Continue"}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
