const localhostNames = new Set(["localhost", "127.0.0.1"])

export function normalizeBaseUrl(
  value: string,
  port = process.env.PORT ?? "3000"
) {
  const url = new URL(value.trim().replace(/^['"]|['"]$/g, ""))

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("BASE_URL must use http or https")
  }

  if (localhostNames.has(url.hostname) && !url.port) {
    url.port = port
  }

  url.hash = ""
  url.search = ""

  return url.toString().replace(/\/+$/, "")
}

export function joinBaseUrl(baseUrl: string, pathname: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`
}
