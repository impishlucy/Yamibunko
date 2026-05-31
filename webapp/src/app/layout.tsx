import type { Metadata } from "next"

import "./globals.css"

export const metadata: Metadata = {
  title: "Anime Library",
  description: "Local anime library and processing app",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark antialiased">
      <body>{children}</body>
    </html>
  )
}
