// Isolated integration test for the launcher's single-owner guard.
//
// Login autostart (HKCU Run) and the in-service plugin both call launcher.js.
// When one watchdog is already healthy, the second launcher must exit without
// spawning a competitor; when none is healthy it must spawn one (fail open).
//
//   node test/integration/launcher-single-owner.mjs
//
// Uses a throwaway port (43990) and never touches the live watchdog (43180).
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 43990
const SERVICE_PORT = 33990
const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib')
const dir = mkdtempSync(join(tmpdir(), 'wd-launcher-'))
const configPath = join(dir, 'watchdog.json')

writeFileSync(configPath, JSON.stringify({
  servicePort: SERVICE_PORT,
  watchdogPort: PORT,
  launch: { cmd: process.execPath, args: ['-e', ''], cwd: dir, env: {} },
  autostart: false,
  crashRestart: false,
  logPath: join(dir, 'watchdog.log'),
}))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const check = (label, ok, detail = '') => results.push({ label, ok, detail })

async function health () {
  return fetch(`http://127.0.0.1:${String(PORT)}/health`)
    .then((r) => (r.ok ? r.json() : undefined))
    .catch(() => undefined)
}

async function runLauncher () {
  const started = Date.now()
  const child = spawn(process.execPath, [join(LIB, 'launcher.js'), '--config', configPath], { stdio: 'ignore' })
  await new Promise((resolve) => child.on('exit', resolve))
  return Date.now() - started
}

try {
  check('no watchdog before the first launch', (await health()) === undefined)

  await runLauncher()
  let first
  for (let i = 0; i < 60 && !first; i += 1) {
    first = await health()
    if (!first) await sleep(200)
  }
  check('first launcher spawns a watchdog', typeof first?.pid === 'number', `pid=${first?.pid}`)
  check('watchdog reports a codeHash', typeof first?.codeHash === 'string')

  await runLauncher()
  await sleep(1200)
  const second = await health()
  check('second launcher leaves the same watchdog running', second?.pid === first?.pid, `${first?.pid} -> ${second?.pid}`)

  await fetch(`http://127.0.0.1:${String(PORT)}/shutdown`, { method: 'POST' }).catch(() => {})
  let down = false
  for (let i = 0; i < 30 && !down; i += 1) {
    down = (await health()) === undefined
    if (!down) await sleep(200)
  }
  check('shutdown frees the port', down)

  await runLauncher()
  let respawned
  for (let i = 0; i < 60 && !respawned; i += 1) {
    respawned = await health()
    if (!respawned) await sleep(200)
  }
  check('launcher respawns when nothing is healthy (fail open)', typeof respawned?.pid === 'number', `pid=${respawned?.pid}`)
  check('respawned watchdog is a new process', respawned?.pid !== first?.pid, `${first?.pid} -> ${respawned?.pid}`)

  await fetch(`http://127.0.0.1:${String(PORT)}/shutdown`, { method: 'POST' }).catch(() => {})
} catch (error) {
  check('test harness completed', false, String(error && error.message ? error.message : error))
}

let failed = 0
for (const result of results) {
  if (!result.ok) failed += 1
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.detail ? '  [' + result.detail + ']' : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
