"use client"

import { useEffect, useMemo, useState } from "react"
import { BellOff, EyeOff, KeyRound, Link2Off, UserRound } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isStrongPassword } from "@/lib/password-policy"
import { appUpdatePreferenceChangedEvent } from "@/lib/app-update"
import type { SafeSettings, SpoilerSettings } from "@/lib/types"

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

const aniListOAuthMessages: Record<
  AniListOAuthStatus,
  { kind: "success" | "error"; text: string }
> = {
  connected: { kind: "success", text: "AniList connected." },
  failed: {
    kind: "error",
    text: "AniList connection failed. Check the OAuth app settings and server logs.",
  },
  "invalid-state": {
    kind: "error",
    text: "AniList connection failed because the OAuth state expired or did not match.",
  },
  denied: { kind: "error", text: "AniList authorization was denied." },
  "login-required": { kind: "error", text: "Log in before connecting AniList." },
}

const aniListOAuthStatuses = new Set<string>(Object.keys(aniListOAuthMessages))

function getAniListOAuthMessage(status: AniListOAuthStatus | null) {
  return status ? aniListOAuthMessages[status] : null
}

function getInitialAniListOAuthStatus(): AniListOAuthStatus | null {
  if (typeof window === "undefined") {
    return null
  }

  const status = new URLSearchParams(window.location.search).get("anilist")
  return aniListOAuthStatuses.has(status ?? "")
    ? (status as AniListOAuthStatus)
    : null
}

export function SettingsForm({ settings }: SettingsFormProps) {
  const [password, setPassword] = useState("")
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [disableUpdateBadges, setDisableUpdateBadges] = useState(
    settings.account.disableUpdateBadges
  )
  const [updateBadgeSaving, setUpdateBadgeSaving] = useState(false)
  const [updateBadgeMessage, setUpdateBadgeMessage] = useState<string | null>(null)
  const [updateBadgeError, setUpdateBadgeError] = useState<string | null>(null)
  const [spoilerSettings, setSpoilerSettings] = useState(settings.spoilers)
  const [spoilerSaving, setSpoilerSaving] = useState(false)
  const [spoilerMessage, setSpoilerMessage] = useState<string | null>(null)
  const [spoilerError, setSpoilerError] = useState<string | null>(null)
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

  async function saveUpdateBadgeSetting(disabled: boolean) {
    const previousDisabled = disableUpdateBadges
    setDisableUpdateBadges(disabled)
    setUpdateBadgeSaving(true)
    setUpdateBadgeMessage(null)
    setUpdateBadgeError(null)

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          account: {
            disableUpdateBadges: disabled,
          },
        }),
      })
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        settings?: SafeSettings
      } | null

      if (!response.ok || !payload?.ok || !payload.settings) {
        throw new Error("Unable to update badge setting")
      }

      const nextDisabled = payload.settings.account.disableUpdateBadges
      setDisableUpdateBadges(nextDisabled)
      setUpdateBadgeMessage("Update badge setting updated.")
      window.dispatchEvent(
        new CustomEvent(appUpdatePreferenceChangedEvent, {
          detail: { disableUpdateBadges: nextDisabled },
        })
      )
    } catch (saveError) {
      setDisableUpdateBadges(previousDisabled)
      setUpdateBadgeError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to update badge setting"
      )
    } finally {
      setUpdateBadgeSaving(false)
    }
  }

  async function saveSpoilerSettings(nextSettings: SpoilerSettings) {
    const previousSettings = spoilerSettings
    setSpoilerSettings(nextSettings)
    setSpoilerSaving(true)
    setSpoilerMessage(null)
    setSpoilerError(null)

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          spoilers: nextSettings,
        }),
      })
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        settings?: SafeSettings
      } | null

      if (!response.ok || !payload?.ok || !payload.settings) {
        throw new Error("Unable to update spoiler settings")
      }

      setSpoilerSettings(payload.settings.spoilers)
      setSpoilerMessage("Spoiler settings updated.")
    } catch (saveError) {
      setSpoilerSettings(previousSettings)
      setSpoilerError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to update spoiler settings"
      )
    } finally {
      setSpoilerSaving(false)
    }
  }

  function updateSpoilerSetting<Key extends keyof SpoilerSettings>(
    key: Key,
    value: SpoilerSettings[Key]
  ) {
    void saveSpoilerSettings({
      ...spoilerSettings,
      [key]: value,
    })
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

          {settings.account.isAdmin ? (
            <div className="mt-5 border-t border-white/10 pt-4">
              <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-white/10 bg-zinc-950/40 px-3 py-3">
                <span>
                  <span className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                    <BellOff className="size-4 text-amber-300" />
                    Disable Update badges
                  </span>
                  <span className="mt-1 block text-sm text-zinc-400">
                    Not recommended. Hide admin update badges even when a newer Yamibunko release is available.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={disableUpdateBadges}
                  disabled={updateBadgeSaving}
                  onChange={(event) =>
                    void saveUpdateBadgeSetting(event.target.checked)
                  }
                  className="mt-1 size-4 accent-violet-500"
                />
              </label>

              {updateBadgeError ? (
                <p className="mt-2 text-sm text-red-300">{updateBadgeError}</p>
              ) : null}
              {updateBadgeMessage ? (
                <p className="mt-2 text-sm text-emerald-300">
                  {updateBadgeMessage}
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="rounded-lg border-white/10 bg-zinc-900/75">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <EyeOff className="size-4 text-violet-300" />
            Spoilers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-white/10 bg-zinc-950/40 px-3 py-3">
            <span>
              <span className="block text-sm font-medium text-zinc-100">
                Blur Episode Thumbnails
              </span>
              <span className="mt-1 block text-sm text-zinc-400">
                Blur previews for episodes watched less than 80%.
              </span>
            </span>
            <input
              type="checkbox"
              checked={spoilerSettings.blurEpisodeThumbnails}
              disabled={spoilerSaving}
              onChange={(event) =>
                updateSpoilerSetting(
                  "blurEpisodeThumbnails",
                  event.target.checked
                )
              }
              className="mt-1 size-4 accent-violet-500"
            />
          </label>

          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-white/10 bg-zinc-950/40 px-3 py-3">
            <span>
              <span className="block text-sm font-medium text-zinc-100">
                Remove Titles
              </span>
              <span className="mt-1 block text-sm text-zinc-400">
                Replace AniList titles for unwatched episodes with the episode fallback.
              </span>
            </span>
            <input
              type="checkbox"
              checked={spoilerSettings.removeUnwatchedEpisodeTitles}
              disabled={spoilerSaving}
              onChange={(event) =>
                updateSpoilerSetting(
                  "removeUnwatchedEpisodeTitles",
                  event.target.checked
                )
              }
              className="mt-1 size-4 accent-violet-500"
            />
          </label>

          {spoilerError ? (
            <p className="text-sm text-red-300">{spoilerError}</p>
          ) : null}
          {spoilerMessage ? (
            <p className="text-sm text-emerald-300">{spoilerMessage}</p>
          ) : null}
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
