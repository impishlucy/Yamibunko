export type DeviceKind = "desktop" | "phone" | "tablet" | "tv" | "console"

export type DeviceDetection = {
  kind: DeviceKind
  isTv: boolean
  isGameConsole: boolean
  isTvLike: boolean
}

type DeviceOverride = "tv" | "console" | "desktop" | null

const tvUserAgentPatterns = [
  /YamibunkoTV/i,
  /Android[-_\s]*TV|AndroidTV|Leanback/i,
  /DeviceType\/(?:AndroidTV|TV)/i,
  /Google[-_\s]*TV|GoogleTV|Google TV Streamer/i,
  /Chromecast|CrKey\//i,
  /Smart[-_\s]?TV|SMART-TV|Linux\/SmartTV|SmartTvA/i,
  /HbbTV|VSTVB|Firebolt|ComcastAppPlatform/i,
  /Tizen/i,
  /Web0S|webOS|WebAppManager|NetCast/i,
  /Roku|Roku\/DVP/i,
  /AFT[A-Z0-9]+|FireTV|Fire TV|AmazonWebAppPlatform|cordova-amazon-fireos|Kepler\//i,
  /BRAVIA|SonyCEBrowser|SonyDTV/i,
  /SHIELD Android TV|NVIDIA SHIELD|MiTV|MIBOX/i,
  /Viera|Panasonic|AquosBrowser|Aquos|PhilipsTV|Philips TV|NETTV/i,
  /VIDAA|Hisense|TCL\s*TV|RokuTV|Xumo|TitanOS|WhaleTV/i,
  /Cobalt\/.*(?:Starboard|HbbTV|VIDAA)|Starboard\/.*(?:HbbTV|VIDAA)/i,
  /SamsungBrowser\/[^\s]+.*\bTV\b/i,
  /\bTV\s+Safari\//i,
]

const thirdPartyTvBrowserPatterns = [
  /TV\s*Bro\/|TVBro\/|com\.phlox\.tvwebbrowser/i,
  /Browse\s*Here|BrowseHere|TCLBrowser|com\.tcl\.browser/i,
  /Puffin\s*TV|PuffinTV|com\.cloudmosa\.puffinTV/i,
  /Puffin\/[\w.-]+.*(?:Android[-_\s]*TV|AndroidTV|Google[-_\s]*TV|Smart[-_\s]*TV|Chromecast|CrKey\/|AFT[A-Z0-9]+|MIBOX|SHIELD|BRAVIA|TCL\s*TV|DeviceType\/(?:AndroidTV|TV))/i,
  /Open\s*Browser|OpenBrowser|SRAF\/|Seraphic|com\.seraphic\.openinet/i,
  /Jio(?:Pages|Sphere)(?:\s*TV|TV)?|JioBrowser|com\.jio\.web\.androidtv/i,
  /HiBrowser|OdinBrowser|com\.hisense\.odinbrowser/i,
  /TVWebBrowser|TV\s*Web\s*Browser/i,
]

const consoleUserAgentPatterns = [
  /PlayStation|PLAYSTATION|PS[345]\b/i,
  /Xbox|XBLWP|X11;\s*Xbox/i,
  /Nintendo\s+(?:Switch|WiiU?|Wii\s*U)|NintendoBrowser/i,
]

function fromOverride(override: DeviceOverride): DeviceDetection | null {
  if (override === "tv") {
    return {
      kind: "tv",
      isTv: true,
      isGameConsole: false,
      isTvLike: true,
    }
  }

  if (override === "console") {
    return {
      kind: "console",
      isTv: false,
      isGameConsole: true,
      isTvLike: true,
    }
  }

  if (override === "desktop") {
    return {
      kind: "desktop",
      isTv: false,
      isGameConsole: false,
      isTvLike: false,
    }
  }

  return null
}

function isPersistentOverride(override: DeviceOverride): override is "tv" | "console" {
  return override === "tv" || override === "console"
}

export function normalizeDeviceOverride(value: string | null | undefined): DeviceOverride {
  const normalized = value?.trim().toLowerCase()

  if (!normalized) {
    return null
  }

  if (["tv", "television", "leanback", "android-tv", "androidtv"].includes(normalized)) {
    return "tv"
  }

  if (["console", "game-console", "gaming-console", "playstation", "xbox"].includes(normalized)) {
    return "console"
  }

  if (["desktop", "browser", "default", "off"].includes(normalized)) {
    return "desktop"
  }

  return null
}

export function detectDeviceFromUserAgent(userAgent: string | null | undefined): DeviceDetection {
  const source = userAgent ?? ""
  const isGameConsole = consoleUserAgentPatterns.some((pattern) => pattern.test(source))

  if (isGameConsole) {
    return {
      kind: "console",
      isTv: false,
      isGameConsole: true,
      isTvLike: true,
    }
  }

  const isTv =
    tvUserAgentPatterns.some((pattern) => pattern.test(source)) ||
    thirdPartyTvBrowserPatterns.some((pattern) => pattern.test(source))

  if (isTv) {
    return {
      kind: "tv",
      isTv: true,
      isGameConsole: false,
      isTvLike: true,
    }
  }

  if (/iPad|Tablet|Nexus 7|Nexus 10/i.test(source)) {
    return {
      kind: "tablet",
      isTv: false,
      isGameConsole: false,
      isTvLike: false,
    }
  }

  if (/Android|iPhone|iPod|Mobile/i.test(source)) {
    return {
      kind: "phone",
      isTv: false,
      isGameConsole: false,
      isTvLike: false,
    }
  }

  return {
    kind: "desktop",
    isTv: false,
    isGameConsole: false,
    isTvLike: false,
  }
}

export function detectDevice(input: {
  userAgent?: string | null
  override?: string | null
}): DeviceDetection {
  return fromOverride(normalizeDeviceOverride(input.override)) ?? detectDeviceFromUserAgent(input.userAgent)
}

export function detectClientDevice(fallback: DeviceDetection): DeviceDetection {
  if (typeof window === "undefined") {
    return fallback
  }

  const params = new URLSearchParams(window.location.search)
  const urlOverride =
    normalizeDeviceOverride(params.get("yamibunkoDevice")) ??
    normalizeDeviceOverride(params.get("device"))

  if (urlOverride) {
    try {
      if (isPersistentOverride(urlOverride)) {
        window.localStorage.setItem("yamibunko.deviceMode", urlOverride)
      } else {
        window.localStorage.removeItem("yamibunko.deviceMode")
      }
    } catch {}

    return fromOverride(urlOverride) ?? fallback
  }

  let storedOverride: DeviceOverride = null

  try {
    storedOverride = normalizeDeviceOverride(
      window.localStorage.getItem("yamibunko.deviceMode")
    )
  } catch {
    storedOverride = null
  }

  const storedDetection = isPersistentOverride(storedOverride)
    ? fromOverride(storedOverride)
    : null

  return (
    storedDetection ??
    detectDeviceFromUserAgent(window.navigator.userAgent)
  )
}
