import path from "node:path"

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function fileName(filePath: string) {
  return path.basename(filePath)
}

export function parsePositiveInt(value: string | number | null | undefined) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : null
  }

  if (!value) {
    return null
  }

  const normalized = value.trim()

  if (!/^\d+$/.test(normalized)) {
    return null
  }

  const parsed = Number(normalized)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}
