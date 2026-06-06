import packageJson from "../../../package.json"

import {
  yamibunkoReleasesUrl,
  type AppUpdateStatus,
} from "@/lib/app-update"
import { errorMessage } from "@/server/utils/format"

const githubLatestReleaseApiUrl =
  "https://api.github.com/repos/impishlucy/Yamibunko/releases/latest"

const currentVersion = normalizeAppVersion(packageJson.version)

type UpdateCheckGlobalState = typeof globalThis & {
  __yamibunkoUpdateStatus?: AppUpdateStatus
  __yamibunkoUpdateCheckPromise?: Promise<AppUpdateStatus>
}

type GithubLatestRelease = {
  tag_name?: unknown
}

const updateCheckGlobal = globalThis as UpdateCheckGlobalState

export function normalizeAppVersion(version: string) {
  return version.trim().replace(/^v/i, "")
}

function parseVersionParts(version: string) {
  const normalized = normalizeAppVersion(version)
  const core = normalized.split(/[+-]/, 1)[0]

  if (!core) {
    return null
  }

  const parts = core.split(".").map((part) => {
    if (!/^\d+$/.test(part)) {
      return Number.NaN
    }

    return Number.parseInt(part, 10)
  })

  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) {
    return null
  }

  return parts
}

export function compareAppVersions(left: string, right: string) {
  const leftParts = parseVersionParts(left)
  const rightParts = parseVersionParts(right)

  if (!leftParts || !rightParts) {
    return 0
  }

  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0

    if (leftPart > rightPart) {
      return 1
    }

    if (leftPart < rightPart) {
      return -1
    }
  }

  return 0
}

function getUnknownStatus(): AppUpdateStatus {
  return {
    currentVersion,
    latestVersion: null,
    latestTag: null,
    updateAvailable: false,
    checkedAt: null,
    releaseUrl: yamibunkoReleasesUrl,
  }
}

function getCurrentStatus() {
  return updateCheckGlobal.__yamibunkoUpdateStatus ?? getUnknownStatus()
}

export function getCurrentAppVersion() {
  return currentVersion
}

export function getAppUpdateStatus() {
  return getCurrentStatus()
}

export async function checkForYamibunkoUpdate(reason: string) {
  if (updateCheckGlobal.__yamibunkoUpdateCheckPromise) {
    return updateCheckGlobal.__yamibunkoUpdateCheckPromise
  }

  const promise = (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    try {
      const response = await fetch(githubLatestReleaseApiUrl, {
        cache: "no-store",
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": `Yamibunko/${currentVersion}`,
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`GitHub latest release request failed with ${response.status}`)
      }

      const payload = (await response.json()) as GithubLatestRelease
      const latestTag =
        typeof payload.tag_name === "string" ? payload.tag_name.trim() : ""

      if (!latestTag) {
        throw new Error("GitHub latest release did not include a tag name")
      }

      const latestVersion = normalizeAppVersion(latestTag)
      const updateAvailable = compareAppVersions(latestVersion, currentVersion) > 0
      const status: AppUpdateStatus = {
        currentVersion,
        latestVersion,
        latestTag,
        updateAvailable,
        checkedAt: new Date().toISOString(),
        releaseUrl: yamibunkoReleasesUrl,
      }

      updateCheckGlobal.__yamibunkoUpdateStatus = status

      console.log(
        updateAvailable
          ? `[Info] [Update] Yamibunko update available - Current ${currentVersion}, Latest ${latestVersion} - ${reason}`
          : `[Info] [Update] Yamibunko is up to date - Current ${currentVersion}, Latest ${latestVersion} - ${reason}`
      )

      return status
    } catch (error) {
      const previous = getCurrentStatus()
      const status: AppUpdateStatus = {
        ...previous,
        checkedAt: new Date().toISOString(),
        error: errorMessage(error),
      }

      updateCheckGlobal.__yamibunkoUpdateStatus = status
      console.warn(
        `[Warn] [Update] Yamibunko update check failed - ${reason} - ${errorMessage(error)}`
      )

      return status
    } finally {
      clearTimeout(timeout)
      updateCheckGlobal.__yamibunkoUpdateCheckPromise = undefined
    }
  })()

  updateCheckGlobal.__yamibunkoUpdateCheckPromise = promise
  return promise
}
