import { randomBytes } from "node:crypto"

type CastStreamToken = {
  username: string
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

  return {
    username: value.username,
  }
}
