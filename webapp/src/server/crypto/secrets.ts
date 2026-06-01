import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"

import { getServerConfig } from "@/server/config"

function getEncryptionKey() {
  const secret = getServerConfig().anilistClientSecret

  if (!secret) {
    throw new Error("AniList client secret is required to protect tokens")
  }

  // Keeps AniList tokens unreadable in SQLite without introducing another mandatory secret.
  return createHash("sha256")
    .update("yamibunko:anilist-token:")
    .update(secret)
    .digest()
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv)
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`
}

export function decryptSecret(value: string) {
  const [version, iv, tag, ciphertext] = value.split(".")

  if (version !== "v1" || !iv || !tag || !ciphertext) {
    throw new Error("Unsupported encrypted secret format")
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(iv, "base64url")
  )
  decipher.setAuthTag(Buffer.from(tag, "base64url"))

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8")
}
