import { z } from "zod"

const usernamePattern = /^[a-z0-9._-]+$/i

export function normalizeUsername(value: string) {
  return value.normalize("NFKC").trim()
}

export function isValidUsername(value: string) {
  return (
    value.length >= 3 &&
    value.length <= 64 &&
    usernamePattern.test(value)
  )
}

export const usernameSchema = z
  .string()
  .transform((value) => normalizeUsername(value))
  .refine(isValidUsername)

export const optionalUsernameSchema = z
  .string()
  .transform((value) => normalizeUsername(value))
  .refine((value) => value.length === 0 || isValidUsername(value))

export function sanitizeLogText(value: string, maxLength = 4000) {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
}
