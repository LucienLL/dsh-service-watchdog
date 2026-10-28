/**
 * dsh-service-watchdog — one-shot launcher.
 *
 * Spawns the watchdog DETACHED and exits immediately. This orphans the
 * watchdog: its parent (this launcher) is dead, so a later `taskkill /T /F`
 * on the DSH service tree cannot reach it (verified empirically on Windows —
 * a plain detached child is still inside the parent's tree and gets killed,
 * while a child of an already-exited launcher is not).
 *
 * Usage: node launcher.js --config <path>
 *
 * Single-owner guard: login autostart (HKCU Run) and the in-service plugin both
 * call this launcher, so a second instance can be started while one is already
 * healthy. Before spawning, probe the configured port: if a live watchdog
 * already answers /health with our own shape, exit quietly instead of racing it
 * for the port (which used to surface as `EADDRINUSE` noise and a stranded
 * instance). The probe fails open — any error, timeout, or unexpected answer
 * falls through to a normal spawn, so a broken probe can never block recovery.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_WATCHDOG_PORT, resolvePositivePort } from './ports.js'

const watchdogPath = fileURLToPath(new URL('./watchdog.js', import.meta.url))

function configuredPort (argv) {
  try {
    const index = argv.indexOf('--config')
    if (index === -1 || !argv[index + 1]) return DEFAULT_WATCHDOG_PORT
    const config = JSON.parse(readFileSync(argv[index + 1], 'utf8'))
    return resolvePositivePort(config.watchdogPort, DEFAULT_WATCHDOG_PORT)
  } catch {
    return DEFAULT_WATCHDOG_PORT
  }
}

async function healthyWatchdogRunning (port) {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return false
    const body = await response.json()
    return typeof body?.pid === 'number' && typeof body?.codeHash === 'string'
  } catch {
    return false
  }
}

const args = process.argv.slice(2)
if (await healthyWatchdogRunning(configuredPort(args))) {
  process.exit(0)
}

const child = spawn(process.execPath, [watchdogPath, ...args], {
  detached: true,
  windowsHide: true,
  stdio: 'ignore',
})
child.unref()
process.exit(0)
