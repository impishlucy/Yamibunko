"use client"

import { useEffect, useState } from "react"
import { Cpu, Folder, Palette, UserRound } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { apiGet } from "@/lib/api"
import type { SafeSettings } from "@/lib/types"

type SettingsResponse = SafeSettings | { ok: false; issues: string[] }

function isSettings(value: SettingsResponse): value is SafeSettings {
  return "paths" in value
}

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-zinc-400">{label}</Label>
      <Input
        value={String(value)}
        readOnly
        className="h-9 rounded-lg border-white/10 bg-zinc-950/70 text-zinc-100"
      />
    </div>
  )
}

export function SettingsForm() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null)

  useEffect(() => {
    apiGet<SettingsResponse>("/api/settings")
      .then(setSettings)
      .catch(() => {
        setSettings({
          ok: false,
          issues: ["Settings unavailable"],
        })
      })
  }, [])

  if (!settings) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-48 rounded-lg bg-zinc-900" />
        ))}
      </div>
    )
  }

  if (!isSettings(settings)) {
    return (
      <Card className="rounded-lg border-red-400/20 bg-red-950/20">
        <CardHeader>
          <CardTitle>Configuration unavailable</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-red-200">
          {settings.issues.map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="rounded-lg border-white/10 bg-zinc-900/75">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <UserRound className="size-4 text-violet-300" />
            Account
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Field label="Name" value={settings.account.userName} />
          <div className="mt-3">
            <Field
              label="Role"
              value={settings.account.isAdmin ? "Admin" : "User"}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-lg border-white/10 bg-zinc-900/75">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <Folder className="size-4 text-violet-300" />
            Library paths
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Input" value={settings.paths.inputDir} />
          <Field label="Media" value={settings.paths.mediaDir} />
        </CardContent>
      </Card>

      <Card className="rounded-lg border-white/10 bg-zinc-900/75">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <Cpu className="size-4 text-violet-300" />
            Transcoding
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field
            label="Acceleration"
            value={settings.transcoding.acceleration}
          />
          <Field label="Capacity" value="Dynamic" />
        </CardContent>
      </Card>

      <Card className="rounded-lg border-white/10 bg-zinc-900/75">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <Palette className="size-4 text-violet-300" />
            Appearance
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Theme" value={settings.appearance.theme} />
        </CardContent>
      </Card>
    </div>
  )
}
