export const DEFAULT_SERVICE_PORT = 3180
export const DEFAULT_WATCHDOG_PORT = 43180
// Ports a previous release listened on. A watchdog that boots anywhere else
// retires any instance still held there, so a port move can never leave two
// watchdogs fighting the same service.
export const LEGACY_WATCHDOG_PORTS = [3199]

export function resolvePositivePort(value, fallback) {
  const port = Number(value)
  return Number.isFinite(port) && port > 0 ? port : fallback
}
