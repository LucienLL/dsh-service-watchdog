/**
 * dsh-service-control — one-shot launcher.
 *
 * Spawns the watchdog DETACHED and exits immediately. This orphans the
 * watchdog: its parent (this launcher) is dead, so a later `taskkill /T /F`
 * on the DSH service tree cannot reach it (verified empirically on Windows —
 * a plain detached child is still inside the parent's tree and gets killed,
 * while a child of an already-exited launcher is not).
 *
 * Usage: node launcher.js --config <path>
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const watchdogPath = fileURLToPath(new URL('./watchdog.js', import.meta.url))
const child = spawn(process.execPath, [watchdogPath, ...process.argv.slice(2)], {
  detached: true,
  windowsHide: true,
  stdio: 'ignore',
})
child.unref()
process.exit(0)
