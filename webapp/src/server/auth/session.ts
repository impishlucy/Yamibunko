import { createHash, randomBytes } from "node:crypto"

import { cookies } from "next/headers"

import {
  deleteSessionByTokenHash,
  getSessionByTokenHash,
  replaceUserSession,
  touchSession,
} from "@/server/db/sessions"
import { getUser } from "@/server/db/users"
import { getRequestOrigin } from "@/server/http/request"

export const sessionCookieName = "yamibunko_session"

const sessionMaxAgeSeconds = 60 * 60 * 24 * 30

export type CurrentUser = {
  username: string
  name: string
  isAdmin: boolean
  hasPassword: boolean
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("base64url")
}

async function shouldUseSecureCookies() {
  return new URL(await getRequestOrigin()).protocol === "https:"
}

export async function createSession(
  username: string,
  userAgent: string | null
) {
  const token = randomBytes(32).toString("base64url")
  const expires = new Date(Date.now() + sessionMaxAgeSeconds * 1000)

  replaceUserSession({
    username,
    tokenHash: hashToken(token),
    userAgent,
    expiresAt: expires.toISOString(),
  })

  return { token, expires }
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(sessionCookieName)?.value

  if (!token) {
    return null
  }

  const tokenHash = hashToken(token)
  const session = getSessionByTokenHash(tokenHash)

  if (!session) {
    return null
  }

  if (Date.parse(session.expiresAt) <= Date.now()) {
    deleteSessionByTokenHash(tokenHash)
    return null
  }

  const user = getUser(session.username)

  if (!user) {
    deleteSessionByTokenHash(tokenHash)
    return null
  }

  touchSession(tokenHash)

  return {
    username: user.username,
    name: user.username,
    isAdmin: user.isAdmin,
    hasPassword: Boolean(user.passwordHash),
  }
}

export async function setSessionCookie(token: string, expires: Date) {
  const cookieStore = await cookies()
  const secure = await shouldUseSecureCookies()

  cookieStore.set(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires,
  })
}

export async function clearSessionCookie() {
  const cookieStore = await cookies()
  const secure = await shouldUseSecureCookies()
  const token = cookieStore.get(sessionCookieName)?.value

  if (token) {
    deleteSessionByTokenHash(hashToken(token))
  }

  cookieStore.set(sessionCookieName, "", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  })
}

export async function requireCurrentUser() {
  const user = await getCurrentUser()

  if (!user) {
    return null
  }

  return user
}
