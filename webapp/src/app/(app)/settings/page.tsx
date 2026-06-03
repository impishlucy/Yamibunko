import { SettingsAbout } from "@/components/settings-about"
import { SettingsForm } from "@/components/settings-form"
import { UserManagement } from "@/components/user-management"
import { getSafeServerSettings } from "@/server/config"
import { requireCurrentUser } from "@/server/auth/session"

export default async function SettingsPage() {
  const user = await requireCurrentUser()
  const settings = getSafeServerSettings({
    userName: user?.username ?? "Unknown",
    isAdmin: user?.isAdmin ?? false,
  })

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-50">Settings</h1>
      </div>
      <SettingsForm settings={settings} />
      {user?.isAdmin ? <UserManagement /> : null}
      <SettingsAbout isAdmin={settings.account.isAdmin} />
    </div>
  )
}
