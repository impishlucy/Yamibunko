import { SettingsForm } from "@/components/settings-form"
import { UserManagement } from "@/components/user-management"

export default function SettingsPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-50">Settings</h1>
        <p className="text-sm text-zinc-500">
          Launcher and library configuration
        </p>
      </div>
      <SettingsForm />
      <UserManagement />
    </div>
  )
}
