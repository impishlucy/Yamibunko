export const appUpdateStatusPath = "/api/app/update"
export const yamibunkoReleasesUrl = "https://github.com/impishlucy/Yamibunko/releases"
export const appUpdatePreferenceChangedEvent = "yamibunko:app-update-preference-changed"

export type AppUpdateStatus = {
  currentVersion: string
  latestVersion: string | null
  latestTag: string | null
  updateAvailable: boolean
  ignoredVersion?: string | null
  updateBadgesDisabled?: boolean
  checkedAt: string | null
  releaseUrl: string
  error?: string
}
