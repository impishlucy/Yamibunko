type LogDetails = Record<string, unknown>
type LogLevel = "Info" | "Warn" | "Error"

const sensitiveKeyPattern =
  /(authorization|cookie|password|secret|session|token)/i

function sanitizeValue(value: unknown, key = "", depth = 0): unknown {
  if (sensitiveKeyPattern.test(key)) {
    return value ? "[redacted]" : value
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  if (!value || typeof value !== "object") {
    return value
  }

  if (depth >= 4) {
    return "[truncated]"
  }

  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => sanitizeValue(item, key, depth + 1))
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 3)
      .map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(entryValue, entryKey, depth + 1),
      ])
  )
}

function formatDetails(details?: LogDetails) {
  if (!details || Object.keys(details).length === 0) {
    return ""
  }

  return JSON.stringify(sanitizeValue(details))
}

function writeLog(level: LogLevel, scope: string, message: string, details?: LogDetails) {
  const line = `[${level}] [${scope}] ${message}${formatDetails(details)}`

  if (level === "Error") {
    console.error(line)
    return
  }

  if (level === "Warn") {
    console.warn(line)
    return
  }

  console.info(line)
}

export const serverLog = {
  info(scope: string, message: string, details?: LogDetails) {
    writeLog("Info", scope, message, details)
  },
  warn(scope: string, message: string, details?: LogDetails) {
    writeLog("Warn", scope, message, details)
  },
  error(scope: string, message: string, details?: LogDetails) {
    writeLog("Error", scope, message, details)
  },
}
