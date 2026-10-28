// Isolated integration test for the entry plane (/handoff + /go) and legacy-port
// retirement. Throwaway ports only: the live service (3180) and the live watchdog
// (43180) are never touched.
//
// Run directly (it spawns real child processes, so it is NOT part of
// `node --test test/*.mjs`):
//
//   node test/integration/entry-plane.mjs
//
// Exits 0 when every check passes, 1 otherwise.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const SERVICE_PORT = 33180
const WATCHDOG_PORT = 43380
const LEGACY_PORT = 43390
const TOKEN = 'a'.repeat(43)
const GOOD_URL = `http://127.0.0.1:${SERVICE_PORT}/?token=${TOKEN}`
// Resolve the watchdog relative to this file so the test works from any checkout.
const WATCHDOG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'watchdog.js')

const dir = mkdtempSync(join(tmpdir(), 'wd-test-'))

function writeConfig (name, overrides) {
  const path = join(dir, `${name}.json`)
  writeFileSync(path, JSON.stringify({
    servicePort: SERVICE_PORT,
    launch: { cmd: process.execPath, args: ['-e', ''], cwd: dir, env: {} },
    autostart: false,
    crashRestart: false,
    logPath: join(dir, `${name}.log`),
    ...overrides,
  }))
  return path
}

const results = []
const check = (label, ok, detail = '') => results.push({ label, ok, detail })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const spawnWatchdog = (configPath) => spawn(
  process.execPath,
  [WATCHDOG, '--config', configPath, '--adopt-only'],
  { stdio: 'ignore', windowsHide: true },
)

async function portOpen (port) {
  return fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)
}

async function waitPort (port, want, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await portOpen(port)) === want) return true
    await sleep(150)
  }
  return false
}

async function call (path, { method = 'GET', headers = {}, body, port = WATCHDOG_PORT } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body, redirect: 'manual' })
  return { status: response.status, headers: response.headers, text: await response.text() }
}

const processes = []
let dummy

try {
  // A watchdog left behind on the old port, which the new instance must retire.
  const legacyConfig = writeConfig('legacy', { watchdogPort: LEGACY_PORT, legacyWatchdogPorts: [] })
  processes.push(spawnWatchdog(legacyConfig))
  check('legacy watchdog is up before the new one boots', await waitPort(LEGACY_PORT, true))

  const mainConfig = writeConfig('main', { watchdogPort: WATCHDOG_PORT, legacyWatchdogPorts: [LEGACY_PORT] })
  processes.push(spawnWatchdog(mainConfig))
  check('watchdog booted on the new port', await waitPort(WATCHDOG_PORT, true))
  check('watchdog retired the legacy instance', await waitPort(LEGACY_PORT, false))

  // Service down: the entry must serve the launch page, not a connection error.
  const page = await call('/go')
  check('/go with the service down serves the launch page', page.status === 200 && page.text.includes('正在启动'), `status=${page.status}`)
  check('launch page carries no token', !page.text.includes(TOKEN))

  dummy = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('dummy service') })
  await new Promise((resolve) => dummy.listen(SERVICE_PORT, '127.0.0.1', resolve))

  // Service up but no handoff yet: fall back to the service's own entry.
  const fallback = await call('/go')
  check('/go without a handoff falls back to the service entry',
    fallback.status === 302 && fallback.headers.get('location') === `http://127.0.0.1:${SERVICE_PORT}/go`,
    `status=${fallback.status} location=${fallback.headers.get('location')}`)

  const bad = [
    ['foreign host', 'http://evil.example/?token=' + TOKEN],
    ['wrong port', `http://127.0.0.1:9999/?token=${TOKEN}`],
    ['missing token', `http://127.0.0.1:${SERVICE_PORT}/`],
    ['short token', `http://127.0.0.1:${SERVICE_PORT}/?token=abc`],
    ['extra query', `http://127.0.0.1:${SERVICE_PORT}/?token=${TOKEN}&x=1`],
    ['fragment', `http://127.0.0.1:${SERVICE_PORT}/?token=${TOKEN}#x`],
    ['path', `http://127.0.0.1:${SERVICE_PORT}/deep/?token=${TOKEN}`],
    ['not a url', 'hello'],
  ]
  for (const [label, payload] of bad) {
    const response = await call('/handoff', { method: 'POST', body: payload })
    check(`/handoff rejects ${label}`, response.status === 400, `status=${response.status}`)
  }

  const crossSite = await call('/handoff', { method: 'POST', body: GOOD_URL, headers: { origin: 'http://evil.example' } })
  check('/handoff rejects a cross-site Origin', crossSite.status === 403, `status=${crossSite.status}`)

  const accepted = await call('/handoff', { method: 'POST', body: GOOD_URL })
  check('/handoff accepts a valid URL', accepted.status === 200, `status=${accepted.status}`)

  const status = await call('/status')
  const statusJson = JSON.parse(status.text)
  check('/status reports handoffReady', statusJson.handoffReady === true, `handoffReady=${statusJson.handoffReady}`)
  check('/status reports the watchdog port', statusJson.watchdogPort === WATCHDOG_PORT, `got ${statusJson.watchdogPort}`)
  check('/status never leaks the token', !status.text.includes(TOKEN))

  const go = await call('/go')
  check('/go redirects to the reported URL', go.status === 302 && go.headers.get('location') === GOOD_URL, `status=${go.status}`)
  check('/go redirect is no-store + no-referrer',
    go.headers.get('cache-control') === 'no-store' && go.headers.get('referrer-policy') === 'no-referrer')

  // fetch() forbids overriding Host, so the fence is probed over a raw socket.
  const rawRequest = (requestText) => new Promise((resolve) => {
    const socket = net.connect(WATCHDOG_PORT, '127.0.0.1', () => socket.write(requestText))
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { data += chunk })
    socket.on('end', () => resolve(data))
    socket.on('error', () => resolve(data))
    socket.setTimeout(4000, () => socket.destroy())
  })

  const foreignHostRaw = await rawRequest(`GET /go HTTP/1.1\r\nHost: evil.example:${WATCHDOG_PORT}\r\nConnection: close\r\n\r\n`)
  check('/go rejects a foreign Host (raw socket)', /^HTTP\/1\.1 403/.test(foreignHostRaw), foreignHostRaw.split('\r\n')[0])

  const loopbackHostRaw = await rawRequest(`GET /go HTTP/1.1\r\nHost: 127.0.0.1:${WATCHDOG_PORT}\r\nConnection: close\r\n\r\n`)
  check('/go accepts a loopback Host (raw socket)', /^HTTP\/1\.1 302/.test(loopbackHostRaw), loopbackHostRaw.split('\r\n')[0])

  const foreignOrigin = await call('/go', { headers: { origin: 'http://evil.example' } })
  check('/go rejects a foreign Origin', foreignOrigin.status === 403, `status=${foreignOrigin.status}`)

  const post = await call('/go', { method: 'POST' })
  check('/go rejects POST', post.status === 405, `status=${post.status}`)
} catch (error) {
  check('test harness completed', false, String(error && error.message ? error.message : error))
} finally {
  for (const child of processes) child.kill()
  if (dummy) await new Promise((resolve) => dummy.close(resolve))
}

let failed = 0
for (const result of results) {
  if (!result.ok) failed += 1
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.detail ? '  [' + result.detail + ']' : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
