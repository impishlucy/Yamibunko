"use client"

import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type AuthFormProps = {
  mode: "admin-registration" | "login"
}

function isStrongPassword(password: string) {
  return (
    password.length >= 32 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  )
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", bytes)

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

export function AuthForm({ mode }: AuthFormProps) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const title = mode === "admin-registration" ? "Admin registration" : "Sign in"
  const endpoint =
    mode === "admin-registration" ? "/api/auth/register" : "/api/auth/login"
  const canSubmit = useMemo(
    () => username.trim().length >= 3 && isStrongPassword(password),
    [password, username]
  )

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (!canSubmit) {
      setError("Password does not meet the account policy.")
      return
    }

    setSubmitting(true)

    try {
      const passwordHash = await sha256Hex(password)
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          username,
          passwordHash,
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
            <Label htmlFor="password" className="text-zinc-400">
              Password
            </Label>
            <Input
              id="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete={
                mode === "admin-registration"
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
