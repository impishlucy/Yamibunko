export function isDebugLogEnabled() {
  return process.env.ENABLBE_DEBUG_LOG?.trim().toLowerCase() === "true"
}

export function debugLog(message: string) {
  if (isDebugLogEnabled()) {
    console.log(message)
  }
}
