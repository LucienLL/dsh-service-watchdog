export const DEFAULT_SERVICE_PORT = 3180
export const DEFAULT_WATCHDOG_PORT = 3199

export function resolvePositivePort(value, fallback) {
  const port = Number(value)
  return Number.isFinite(port) && port > 0 ? port : fallback
}
