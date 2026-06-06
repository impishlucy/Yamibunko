import { randomBytes } from "node:crypto"

import { getSessionByTokenHash } from "@/server/db/sessions"
import { getUser } from "@/server/db/users"

type CastStreamToken = {
  username: string
  sessionTokenHash: string
  animeId: string
  seasonNumber: number
  episodeNumber: number
  expiresAt: number
}

const tokenTtlMs = 2 * 60 * 60 * 1000
const tokens = new Map<string, CastStreamToken>()

function cleanupExpiredTokens() {
  const now = Date.now()

  for (const [token, value] of tokens) {
    if (value.expiresAt <= now) {
      tokens.delete(token)
    }
  }
}

export function createCastStreamToken(input: {
  username: string
  sessionTokenHash: string
  animeId: string
  seasonNumber: number
  episodeNumber: number
}) {
  cleanupExpiredTokens()

  const token = randomBytes(32).toString("base64url")
  tokens.set(token, {
    ...input,
    expiresAt: Date.now() + tokenTtlMs,
  })

  return token
}

export function validateCastStreamToken(input: {
  token: string
  animeId: string
  seasonNumber: number
  episodeNumber: number
}) {
  cleanupExpiredTokens()

  const value = tokens.get(input.token)

  if (
    !value ||
    value.expiresAt <= Date.now() ||
    value.animeId !== input.animeId ||
    value.seasonNumber !== input.seasonNumber ||
    value.episodeNumber !== input.episodeNumber
  ) {
    return null
  }

  const session = getSessionByTokenHash(value.sessionTokenHash)

  if (!session || session.username !== value.username) {
    tokens.delete(input.token)
    return null
  }

  if (Date.parse(session.expiresAt) <= Date.now()) {
    tokens.delete(input.token)
    return null
  }

  const user = getUser(session.username)

  if (!user) {
    tokens.delete(input.token)
    return null
  }

  return {
    username: user.username,
  }
}

export function deleteCastStreamTokensForUser(username: string) {
  for (const [token, value] of tokens) {
    if (value.username === username) {
      tokens.delete(token)
    }
  }
}

export function deleteOtherCastStreamTokensForUser(
  username: string,
  currentSessionTokenHash: string
) {
  for (const [token, value] of tokens) {
    if (
      value.username === username &&
      value.sessionTokenHash !== currentSessionTokenHash
    ) {
      tokens.delete(token)
    }
  }
}
