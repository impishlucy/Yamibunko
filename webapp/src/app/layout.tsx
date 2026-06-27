import type { Metadata, Viewport } from "next"

import { headers } from "next/headers"

import { StartupScreen } from "@/components/startup-screen"
import { ThemeProvider } from "@/components/theme-provider"
import { TvModeProvider } from "@/components/tv-mode-provider"
import { detectDevice } from "@/lib/device"
import { getServerStartupStatus } from "@/server/startup/readiness"

import "./globals.css"

export const metadata: Metadata = {
  title: "Yamibunko",
  applicationName: "Yamibunko",
  description: "Local anime library and processing app",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
    apple: "/apple-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "Yamibunko",
    statusBarStyle: "black-translucent",
  },
}

export const dynamic = "force-dynamic"

export const viewport: Viewport = {
  themeColor: "#09090b",
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const requestHeaders = await headers()
  const startupStatus = getServerStartupStatus()
  const initialDevice = detectDevice({
    userAgent: requestHeaders.get("user-agent"),
    override: requestHeaders.get("x-yamibunko-device"),
  })

  return (
    <html
      lang="en"
      data-yami-console={initialDevice.isGameConsole ? "true" : "false"}
      data-yami-device={initialDevice.kind}
      data-yami-tv={initialDevice.isTvLike ? "true" : "false"}
      suppressHydrationWarning
    >
      <body className="antialiased">
        <TvModeProvider initialDevice={initialDevice}>
          <ThemeProvider defaultTheme="dark" enableSystem={false}>
            {startupStatus.ready ? (
              children
            ) : (
              <StartupScreen initialStatus={startupStatus} />
            )}
          </ThemeProvider>
        </TvModeProvider>
      </body>
    </html>
  )
}
