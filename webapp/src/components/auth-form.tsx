"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { BadgeInfo } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { HoverHint } from "@/components/ui/hover-hint"
import { useTvMode } from "@/components/tv-mode-provider"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isStrongPassword } from "@/lib/password-policy"
import { createQrSvg } from "@/lib/qr-code"

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


type TvLoginCodeResponse = {
  ok: boolean
  code: string
  url: string
  expiresAt: string
  pollAfterMs: number
}

type TvLoginPollResponse = {
  ok: boolean
  status: "pending" | "approved" | "expired"
}

function getSafeRedirectTarget(value: string | null) {
  if (!value?.startsWith("/") || value.startsWith("//")) {
    return "/library"
  }

  return value
}

function formatPairingCode(code: string) {
  return code.match(/.{1,4}/g)?.join(" ") ?? code
}

function TvLoginCard() {
  const [loginCode, setLoginCode] = useState<TvLoginCodeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const loginUrl = loginCode?.url ?? null
  const qrCode = useMemo(() => {
    if (!loginUrl) {
      return null
    }

    try {
      return createQrSvg(loginUrl)
    } catch {
      return null
    }
  }, [loginUrl])

  const createCode = useCallback(async function createCode() {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch("/api/auth/tv/code", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      })

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string
        } | null

        throw new Error(payload?.error ?? "Could not create TV login code.")
      }

      setLoginCode((await response.json()) as TvLoginCodeResponse)
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "Could not create TV login code."
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void createCode()
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [createCode])

  useEffect(() => {
    if (!loginCode?.code) {
      return
    }

    const code = loginCode.code
    const pollAfterMs = loginCode.pollAfterMs || 2_000
    let cancelled = false
    let timer: number | null = null

    async function poll() {
      try {
        const response = await fetch(
          `/api/auth/tv/code/${encodeURIComponent(code)}`,
          { cache: "no-store" }
        )

        if (!response.ok) {
          throw new Error("TV login check failed.")
        }

        const payload = (await response.json()) as TvLoginPollResponse

        if (cancelled) {
          return
        }

        if (payload.status === "approved") {
          window.location.assign("/library")
          return
        }

        if (payload.status === "expired") {
          setError(
            "The TV login code expired. Create a new code and scan it again."
          )
          setLoginCode(null)
          return
        }

        timer = window.setTimeout(poll, pollAfterMs)
      } catch {
        if (!cancelled) {
          timer = window.setTimeout(poll, 3_000)
        }
      }
    }

    timer = window.setTimeout(poll, pollAfterMs)

    return () => {
      cancelled = true

      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [loginCode?.code, loginCode?.pollAfterMs])
  return (
    <Card className="w-full rounded-lg border-white/10 bg-zinc-900/85 shadow-[0_24px_90px_rgba(124,58,237,0.18)]">
      <CardHeader>
        <CardTitle className="text-xl text-zinc-50">TV Login</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-zinc-300">
          Scan this QR code with a phone that is already logged into Yamibunko.
        </p>

        {qrCode ? (
          <div
            aria-label="TV login QR code"
            className="rounded-xl bg-white p-3 [&_svg]:mx-auto [&_svg]:aspect-square [&_svg]:w-full [&_svg]:max-w-64"
            role="img"
            dangerouslySetInnerHTML={{ __html: qrCode }}
          />
        ) : null}

        {loginCode ? (
          <div className="space-y-2 rounded-lg border border-white/10 bg-zinc-950/70 p-3 text-center">
            <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Pairing code</p>
            <p className="font-mono text-lg font-semibold tracking-[0.18em] text-zinc-100">
              {formatPairingCode(loginCode.code)}
            </p>
            <p className="break-all text-xs text-zinc-500">{loginCode.url}</p>
          </div>
        ) : null}

        {error ? <p className="text-sm text-red-300">{error}</p> : null}

        <Button
          type="button"
          variant="secondary"
          className="w-full rounded-lg"
          disabled={loading}
          onClick={() => void createCode()}
        >
          {loading ? "Creating code..." : loginCode ? "Create new code" : "Retry"}
        </Button>
      </CardContent>
    </Card>
  )
}

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
  const searchParams = useSearchParams()
  const { isTvLike } = useTvMode()
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

      window.location.assign(getSafeRedirectTarget(searchParams.get("next")))
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

  if (mode === "login" && isTvLike) {
    return <TvLoginCard />
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
