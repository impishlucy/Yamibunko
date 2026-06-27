import { requireAdminApiUser, requireSameOriginRequest } from "@/server/auth/api"
import {
  checkForYamibunkoUpdate,
  compareAppVersions,
  getAppUpdateStatus,
  getCurrentAppVersion,
} from "@/server/app/updateCheck"
import {
  getUser,
  getUserIgnoredAppUpdateVersion,
  setUserIgnoredAppUpdateVersion,
} from "@/server/db/users"
import type { AppUpdateStatus } from "@/lib/app-update"

import { getStartupBlockedResponse } from "@/server/startup/requestGuard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function applyAdminSettings(
  status: AppUpdateStatus,
  input: {
    ignoredVersion: string | null
    updateBadgesDisabled: boolean
  }
): AppUpdateStatus {
  const fallbackIgnoredVersion = input.ignoredVersion ?? getCurrentAppVersion()
  const updateAvailable = Boolean(
    !input.updateBadgesDisabled &&
      status.latestVersion &&
      compareAppVersions(status.latestVersion, status.currentVersion) > 0 &&
      compareAppVersions(status.latestVersion, fallbackIgnoredVersion) > 0
  )

  return {
    ...status,
    ignoredVersion: fallbackIgnoredVersion,
    updateBadgesDisabled: input.updateBadgesDisabled,
    updateAvailable,
  }
}

async function getAdminUpdateStatus(username: string) {
  const currentStatus = getAppUpdateStatus()
  const status = currentStatus.checkedAt
    ? currentStatus
    : await checkForYamibunkoUpdate("admin status request")

  const user = getUser(username)

  return applyAdminSettings(status, {
    ignoredVersion: getUserIgnoredAppUpdateVersion(username),
    updateBadgesDisabled: user?.disableUpdateBadges ?? false,
  })
}

export async function GET() {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

  const auth = await requireAdminApiUser()

  if (!auth.ok) {
    return auth.response
  }

  return Response.json(await getAdminUpdateStatus(auth.user.username))
}

export async function PATCH(request: Request) {
  const startupBlocked = getStartupBlockedResponse()

  if (startupBlocked) {
    return startupBlocked
  }

  const originError = await requireSameOriginRequest(request)

  if (originError) {
    return originError
  }

  const auth = await requireAdminApiUser(request)

  if (!auth.ok) {
    return auth.response
  }

  const currentStatus = getAppUpdateStatus()
  const status = currentStatus.checkedAt
    ? currentStatus
    : await checkForYamibunkoUpdate("admin dismiss request")
  const ignoredVersion = status.latestVersion ?? getCurrentAppVersion()

  setUserIgnoredAppUpdateVersion(auth.user.username, ignoredVersion)

  const user = getUser(auth.user.username)

  return Response.json(
    applyAdminSettings(status, {
      ignoredVersion,
      updateBadgesDisabled: user?.disableUpdateBadges ?? false,
    })
  )
}
