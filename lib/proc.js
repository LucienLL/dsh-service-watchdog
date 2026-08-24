/**
 * dsh-service-watchdog — pure process/network helpers (no side effects),
 * shared by the watchdog and unit-tested in isolation.
 */

/**
 * Parse the PID LISTENING on a port from `netstat -ano -p tcp` output.
 * @param {string} stdout - netstat text.
 * @param {number} port - the port to look for.
 * @returns {number|null}
 */
export function parseListeningPid(stdout, port) {
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) continue
    const addr = parts[1] || ''
    if (!addr.endsWith(`:${port}`)) continue
    const pid = Number(parts[parts.length - 1])
    if (Number.isFinite(pid) && pid > 0) return pid
  }
  return null
}

/**
 * Whether an Origin header resolves to a loopback host. The watchdog control
 * surface must only be reachable from loopback origins.
 * @param {string|undefined} origin
 * @returns {boolean}
 */
export function isLoopbackOrigin(origin) {
  if (!origin) return false
  try {
    const host = new URL(origin).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * Whether a Host header points at a loopback listener. Rejecting non-loopback
 * hosts defends against DNS-rebinding and cross-site requests to the watchdog
 * control surface (which must only ever be driven from the local DSH page).
 * @param {string|undefined} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  if (!host) return false
  return /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/i.test(String(host))
}
