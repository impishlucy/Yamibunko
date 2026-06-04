"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Gauge, Info, LogOut, RefreshCw, Settings, Snail, UserRound } from "lucide-react"
import { SiAnilist } from "@icons-pack/react-simple-icons"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { HoverHint } from "@/components/ui/hover-hint"
import { cn } from "@/lib/utils"
import type { CurrentUser } from "@/server/auth/session"

type AniListRefreshState = {
  configured: boolean
  connected: boolean
  visible: boolean
  canPress: boolean
  cooldownSeconds: number
  lastPressedAt: string | null
  actions: {
    user: boolean
    all: boolean
  }
}

type BandwidthSnapshot = {
  baseMaxUploadKbps: number | null
  maxUploadKbps: number | null
  usedUploadKbps: number
  reservedUploadKbps: number
  availableUploadKbps: number | null
  activeStreams: number
  temporaryUploadLimit: {
    active: boolean
    expiresAt: string | null
    factor: number
  }
}

function initials(username: string) {
  return username.slice(0, 2).toUpperCase()
}

function formatUploadMegabytes(kbps: number | null | undefined) {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps) || kbps < 0) {
    return "--"
  }

  return (kbps / 8 / 1000).toFixed(2)
}

function getBandwidthUsageClass(snapshot: BandwidthSnapshot | null) {
  if (!snapshot?.maxUploadKbps || snapshot.maxUploadKbps <= 0) {
    return "border-violet-300/25 bg-violet-500/15 text-violet-100"
  }

  const usage = snapshot.usedUploadKbps / snapshot.maxUploadKbps

  if (usage < 0.45) {
    return "border-emerald-300/35 bg-emerald-500/15 text-emerald-100"
  }

  if (usage <= 0.75) {
    return "border-yellow-300/40 bg-yellow-500/15 text-yellow-100"
  }

  return "border-red-300/40 bg-red-500/15 text-red-100"
}

function cooldownLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60

  if (minutes <= 0) {
    return `${remainingSeconds}s`
  }

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`
}

export function Topbar({ user }: { user: CurrentUser }) {
  const [open, setOpen] = useState(false)
  const [refreshDialogOpen, setRefreshDialogOpen] = useState(false)
  const [refreshState, setRefreshState] = useState<AniListRefreshState | null>(
    null
  )
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)
  const [bandwidthSnapshot, setBandwidthSnapshot] = useState<BandwidthSnapshot | null>(null)
  const [bandwidthDialogOpen, setBandwidthDialogOpen] = useState(false)
  const [bandwidthLimitUpdating, setBandwidthLimitUpdating] = useState(false)
  const refreshButtonRef = useRef<HTMLButtonElement | null>(null)
  const refreshDialogRef = useRef<HTMLDivElement | null>(null)
  const bandwidthButtonRef = useRef<HTMLButtonElement | null>(null)
  const bandwidthDialogRef = useRef<HTMLDivElement | null>(null)
  const profileButtonRef = useRef<HTMLButtonElement | null>(null)
  const profileMenuRef = useRef<HTMLDivElement | null>(null)

  const refreshUnavailable = Boolean(
    !refreshState?.canPress || !refreshState?.visible
  )
  const refreshDisabled = Boolean(refreshing || refreshUnavailable)
  const refreshTitle = useMemo(() => {
    if (!refreshState?.visible) {
      return "AniList refresh is unavailable"
    }

    if (refreshing) {
      return "AniList refresh is running"
    }

    if (!refreshState.canPress) {
      return `AniList refresh available in ${cooldownLabel(refreshState.cooldownSeconds)}`
    }

    return "Refresh AniList data"
  }, [refreshState, refreshing])

  const refreshButtonClassName = useMemo(() => {
    const base =
      "h-9 rounded-full border px-3 text-sm transition focus-visible:ring-2 focus-visible:ring-white/30"

    if (refreshing) {
      return `${base} border-emerald-300/35 bg-emerald-500/20 text-emerald-100 hover:border-emerald-300/45 hover:bg-emerald-500/25`
    }

    if (refreshUnavailable) {
      return `${base} cursor-not-allowed border-violet-400/10 bg-violet-500/5 text-violet-100/35 hover:border-violet-400/10 hover:bg-violet-500/5`
    }

    return `${base} border-violet-300/35 bg-violet-500/20 text-violet-100 hover:border-violet-300/50 hover:bg-violet-500/25`
  }, [refreshUnavailable, refreshing])

  const refreshIconClassName = `size-4 ${refreshing ? "animate-spin" : ""}`
  const bandwidthUsageClassName = useMemo(
    () => getBandwidthUsageClass(bandwidthSnapshot),
    [bandwidthSnapshot]
  )
  const bandwidthLabel = useMemo(() => {
    const current = formatUploadMegabytes(bandwidthSnapshot?.usedUploadKbps)
    const max = formatUploadMegabytes(bandwidthSnapshot?.maxUploadKbps)

    return `${current} / ${max} MB/s`
  }, [bandwidthSnapshot])
  const temporaryUploadLimitActive = Boolean(
    bandwidthSnapshot?.temporaryUploadLimit.active
  )
  const BandwidthIcon = temporaryUploadLimitActive ? Snail : Gauge
  const bandwidthLimitButtonLabel = temporaryUploadLimitActive
    ? "Click to remove limit"
    : "Click to apply temporary limit"

  const loadRefreshState = useCallback(async () => {
    const response = await fetch("/api/anilist/refresh", {
      cache: "no-store",
    }).catch(() => null)

    if (!response?.ok) {
      return
    }

    const state = (await response.json()) as AniListRefreshState
    setRefreshState(state)
  }, [])

  const loadBandwidthState = useCallback(async () => {
    if (!user.isAdmin) {
      return
    }

    const response = await fetch("/api/stream/bandwidth", {
      cache: "no-store",
    }).catch(() => null)

    if (!response?.ok) {
      return
    }

    const payload = (await response.json().catch(() => null)) as {
      bandwidth?: BandwidthSnapshot
    } | null

    if (payload?.bandwidth) {
      setBandwidthSnapshot(payload.bandwidth)
    }
  }, [user.isAdmin])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadRefreshState()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadRefreshState])

  useEffect(() => {
    if (!user.isAdmin) {
      return
    }

    let timer: number | null = null
    let cancelled = false

    const poll = async () => {
      await loadBandwidthState()

      if (cancelled) {
        return
      }

      timer = window.setTimeout(poll, 15000)
    }

    timer = window.setTimeout(poll, 0)

    return () => {
      cancelled = true

      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [loadBandwidthState, user.isAdmin])

  useEffect(() => {
    if (!refreshState || refreshState.cooldownSeconds <= 0) {
      return
    }

    const timer = window.setInterval(() => {
      setRefreshState((current) => {
        if (!current || current.cooldownSeconds <= 1) {
          return current
            ? { ...current, cooldownSeconds: 0, canPress: true }
            : current
        }

        return {
          ...current,
          cooldownSeconds: current.cooldownSeconds - 1,
        }
      })
    }, 1000)

    return () => window.clearInterval(timer)
  }, [refreshState])

  useEffect(() => {
    if (!refreshDialogOpen) {
      return
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target

      if (!(target instanceof Node)) {
        return
      }

      if (refreshDialogRef.current?.contains(target)) {
        return
      }

      if (refreshButtonRef.current?.contains(target)) {
        return
      }

      setRefreshDialogOpen(false)
    }

    document.addEventListener("pointerdown", onPointerDown)

    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [refreshDialogOpen])

  useEffect(() => {
    if (!bandwidthDialogOpen) {
      return
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target

      if (!(target instanceof Node)) {
        return
      }

      if (bandwidthDialogRef.current?.contains(target)) {
        return
      }

      if (bandwidthButtonRef.current?.contains(target)) {
        return
      }

      setBandwidthDialogOpen(false)
    }

    document.addEventListener("pointerdown", onPointerDown)

    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [bandwidthDialogOpen])

  useEffect(() => {
    if (!open) {
      return
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target

      if (!(target instanceof Node)) {
        return
      }

      if (profileMenuRef.current?.contains(target)) {
        return
      }

      if (profileButtonRef.current?.contains(target)) {
        return
      }

      setOpen(false)
    }

    document.addEventListener("pointerdown", onPointerDown)

    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open])

  async function logout() {
    await fetch("/api/auth/logout", {
      method: "POST",
    }).catch(() => undefined)

    window.location.assign("/login")
  }

  async function runRefresh(action: "user" | "all") {
    setRefreshing(true)
    setRefreshMessage(null)

    try {
      const response = await fetch("/api/anilist/refresh", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ action }),
      })
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        error?: string
        state?: AniListRefreshState
      } | null

      if (payload?.state) {
        setRefreshState(payload.state)
      } else {
        await loadRefreshState()
      }

      if (!response.ok || !payload?.ok) {
        setRefreshMessage(
          payload?.error === "REFRESH_COOLDOWN_ACTIVE"
            ? "Refresh is still on cooldown."
            : "AniList refresh failed."
        )
        return
      }

      setRefreshMessage("AniList refresh completed.")
      setRefreshDialogOpen(false)
    } finally {
      setRefreshing(false)
    }
  }

  async function toggleBandwidthLimit() {
    if (bandwidthLimitUpdating) {
      return
    }

    setBandwidthLimitUpdating(true)

    try {
      const response = await fetch("/api/stream/bandwidth", {
        method: "POST",
      })

      const payload = (await response.json().catch(() => null)) as {
        bandwidth?: BandwidthSnapshot
      } | null

      if (response.ok && payload?.bandwidth) {
        setBandwidthSnapshot(payload.bandwidth)
      }
    } finally {
      setBandwidthLimitUpdating(false)
    }
  }

  function onRefreshClick() {
    setOpen(false)
    setRefreshMessage(null)

    if (!refreshState?.visible || refreshDisabled) {
      return
    }

    setRefreshDialogOpen(true)
  }

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-[#0d0d12]/85 px-4 py-3 backdrop-blur sm:px-6 lg:px-8">
      <div className="relative flex items-center justify-between gap-3">
        <Link
          href="/library"
          prefetch={false}
          className="text-sm font-semibold tracking-normal text-zinc-100 transition hover:text-violet-200"
        >
          Yamibunko
        </Link>

        <div className="relative flex items-center gap-2">
          {user.isAdmin ? (
            <div className="relative">
              <button
                ref={bandwidthButtonRef}
                type="button"
                aria-label={`Current / Max Upload: ${bandwidthLabel}`}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium tabular-nums shadow-sm transition hover:border-white/25 focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none",
                  bandwidthUsageClassName
                )}
                onClick={() => setBandwidthDialogOpen((value) => !value)}
              >
                <BandwidthIcon className="size-4" aria-hidden="true" />
                <span>{bandwidthLabel}</span>
              </button>

              {bandwidthDialogOpen ? (
                <div
                  ref={bandwidthDialogRef}
                  className="fixed top-16 right-3 left-3 z-50 rounded-xl border border-white/10 bg-zinc-950 p-3 shadow-2xl shadow-black/50 sm:absolute sm:top-full sm:right-0 sm:left-auto sm:mt-2 sm:w-[min(20rem,calc(100vw-2rem))]"
                >
                  <h2 className="text-sm font-semibold text-zinc-100">
                    Current / Max Upload
                  </h2>
                  <p className="mt-1.5 text-sm font-medium tabular-nums text-zinc-200">
                    {bandwidthLabel}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    className="mt-3 h-9 w-full text-sm"
                    disabled={bandwidthLimitUpdating}
                    onClick={() => void toggleBandwidthLimit()}
                  >
                    {bandwidthLimitButtonLabel}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {refreshState?.visible ? (
            <HoverHint label={refreshTitle} align="end">
              <Button
                ref={refreshButtonRef}
                type="button"
                variant="ghost"
                aria-label={refreshTitle}
                aria-disabled={refreshDisabled}
                onClick={onRefreshClick}
                className={refreshButtonClassName}
              >
                <span className="flex items-center gap-1.5">
                  <SiAnilist className="size-4" />
                  <RefreshCw className={refreshIconClassName} />
                </span>
              </Button>
            </HoverHint>
          ) : null}

          <Button
            ref={profileButtonRef}
            type="button"
            variant="ghost"
            className="h-9 gap-2 rounded-lg px-2"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <Avatar className="size-7 border border-violet-400/25">
              <AvatarFallback className="bg-violet-500/15 text-xs text-violet-100">
                {initials(user.username)}
              </AvatarFallback>
            </Avatar>
            <span className="hidden text-sm text-zinc-300 sm:inline">
              {user.username}
            </span>
          </Button>

          {open ? (
            <div ref={profileMenuRef} className="absolute top-full right-0 z-50 mt-2 w-56 overflow-hidden rounded-lg border border-white/10 bg-zinc-950 shadow-2xl shadow-black/40">
              <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-sm text-zinc-200">
                <UserRound className="size-4 text-zinc-500" />
                <span className="min-w-0 truncate">{user.username}</span>
              </div>
              <Link
                href="/settings"
                prefetch={false}
                className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 transition hover:bg-white/5 hover:text-zinc-50"
                onClick={() => setOpen(false)}
              >
                <Settings className="size-4 text-zinc-500" />
                Settings
              </Link>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 transition hover:bg-white/5 hover:text-zinc-50"
                onClick={logout}
              >
                <LogOut className="size-4 text-zinc-500" />
                Log out
              </button>
            </div>
          ) : null}

          {refreshDialogOpen && refreshState ? (
            <div
              ref={refreshDialogRef}
              className="fixed top-16 right-3 left-3 z-50 rounded-xl border border-white/10 bg-zinc-950 p-3 shadow-2xl shadow-black/50 sm:absolute sm:top-full sm:right-0 sm:left-auto sm:mt-2 sm:w-[min(20rem,calc(100vw-2rem))]"
            >
              <h2 className="text-sm font-semibold text-zinc-100">
                Refresh AniList data?
              </h2>
              {user.isAdmin && !refreshState.connected ? null : (
                <p className="mt-1.5 text-xs leading-5 text-zinc-400">
                  {user.isAdmin
                    ? "Choose which AniList data should be refreshed."
                    : "Refresh AniList data."}
                </p>
              )}
              <HoverHint
                label="Limit so we do not anger the anilist api with too many requests."
                className="mt-2"
                align="end"
                contentClassName="whitespace-normal"
              >
                <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                  <Info className="size-3.5" />
                  <span>This is only allowed every 5 minutes.</span>
                </div>
              </HoverHint>

              {refreshMessage ? (
                <p className="mt-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-300">
                  {refreshMessage}
                </p>
              ) : null}

              <div className="mt-3 flex flex-col gap-2">
                {refreshState.actions.user ? (
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-9 text-sm"
                    disabled={refreshing}
                    onClick={() => void runRefresh("user")}
                  >
                    {user.isAdmin ? "Update my tracking data" : "Update"}
                  </Button>
                ) : null}
                {refreshState.actions.all ? (
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-9 text-sm"
                    disabled={refreshing}
                    onClick={() => void runRefresh("all")}
                  >
                    Update all AniList data
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  )
}
