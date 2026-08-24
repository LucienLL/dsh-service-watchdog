/**
 * dsh-service-control — standalone detached watchdog process.
 *
 * Runs OUTSIDE the DSH service process tree (spawned detached by the host
 * half), so it survives a service restart/stop and can relaunch the service
 * after a crash. Node built-ins only — no DSH imports.
 *
 * Responsibilities:
 *   - expose a loopback-only HTTP control surface (health / status / reload /
 *     restart / start / stop / shutdown) so the browser half can drive a
 *     restart even when the DSH service
 *     is dead (the WebView2 page stays alive; the watchdog is on a different
 *     port, so it stays reachable);
 *   - adopt or launch the service, track its PID, and auto-restart it on an
 *     unexpected death (crashRestart);
 *   - append a human-readable log for diagnosis.
 *
 * Usage: node watchdog.js --config <path/to/watchdog.json>
 */
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readFileSync, appendFileSync } from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import net from 'node:net'
import { parseListeningPid, isLoopbackOrigin, isLoopbackHost } from './proc.js'
import { DEFAULT_SERVICE_PORT, DEFAULT_WATCHDOG_PORT, resolvePositivePort } from './ports.js'

const execFileAsync = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined
}

const configPath = argValue('--config')
if (!configPath) {
  console.error('watchdog: missing --config <path>')
  process.exit(2)
}

const config = JSON.parse(readFileSync(configPath, 'utf8'))
const servicePort = resolvePositivePort(config.servicePort, DEFAULT_SERVICE_PORT)
const watchdogPort = resolvePositivePort(config.watchdogPort, DEFAULT_WATCHDOG_PORT)
const launch = config.launch
let autostart = config.autostart !== false
let crashRestart = config.crashRestart !== false
const logPath = config.logPath
// Spawned from inside a booting service: only adopt (never launch), so a
// service still opening its port is not raced by a duplicate launch. Login
// autostart (Run key) does NOT pass this flag and therefore may launch.
const adoptOnly = process.argv.includes('--adopt-only')

let servicePid = null
let lastUp = false
let userStop = false
let starting = false
const startedAt = Date.now()
const codeHash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url), 'utf8')).digest('hex').slice(0, 16)
let restartCount = 0
let lastRestart = null // { at, up }

function log(line) {
  try {
    appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* log is best-effort */
  }
}

/** Hot-apply settings that are safe to change without a watchdog restart. */
function reloadConfig() {
  try {
    const next = JSON.parse(readFileSync(configPath, 'utf8'))
    autostart = next.autostart !== false
    crashRestart = next.crashRestart !== false
    log('reload: config re-read')
  } catch (error) {
    log(`reload failed: ${error && error.message ? error.message : error}`)
  }
}

/** TCP-connect probe of the service port (readiness = port accepting). */
function probePort(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 800 })
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(v)
    }
    sock.on('connect', () => finish(true))
    sock.on('error', () => finish(false))
    sock.on('timeout', () => finish(false))
  })
}

/** Find the PID LISTENING on the service port via `netstat -ano -p tcp`. */
async function findServicePid() {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true })
    return parseListeningPid(stdout, servicePort)
  } catch {
    /* ignore */
  }
  return null
}

/** Guard: only kill PIDs whose image is a node.exe process. */
async function isNodeProcess(pid) {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
    return /node\.exe/i.test(stdout)
  } catch {
    return false
  }
}

function launchService() {
  const child = spawn(launch.cmd, launch.args || [], {
    cwd: launch.cwd,
    env: launch.env || {},
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  })
  servicePid = child.pid
  child.unref()
  log(`launched service pid=${servicePid}`)
  return servicePid
}

async function stopService() {
  let pid = servicePid
  if (!pid) pid = await findServicePid()
  if (!pid) {
    log('stop: no service pid found')
    servicePid = null
    return
  }
  const safe = await isNodeProcess(pid)
  if (!safe) {
    log(`stop: refusing to kill non-node pid=${pid}`)
    servicePid = null
    return
  }
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    log(`taskkill sent for pid=${pid} (tree)`)
  } catch (error) {
    log(`taskkill failed: ${error && error.message ? error.message : error}`)
  }
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && (await probePort(servicePort))) {
    await sleep(300)
  }
  servicePid = null
}

async function startService() {
  if (await probePort(servicePort)) {
    servicePid = await findServicePid()
    return { ok: true, already: true, up: true }
  }
  userStop = false
  const pid = launchService()
  return { ok: true, already: false, up: false, pid }
}

async function restartService() {
  if (starting) return { ok: false, error: 'already-restarting' }
  starting = true
  try {
    userStop = false
    await stopService()
    launchService()
    const deadline = Date.now() + 90000
    let up = false
    while (Date.now() < deadline) {
      if (await probePort(servicePort)) {
        up = true
        break
      }
      await sleep(300)
    }
    restartCount += 1
    lastRestart = { at: Date.now(), up }
    log(`restart complete up=${up}`)
    return { ok: true, up, pid: servicePid }
  } finally {
    starting = false
  }
}

async function stopFinal() {
  userStop = true
  await stopService()
  return { ok: true }
}

async function boot() {
  if (await probePort(servicePort)) {
    servicePid = await findServicePid()
    lastUp = true
    log(`adopted existing service pid=${servicePid}`)
  } else if (adoptOnly) {
    lastUp = false
    log('adopt-only: service not up yet, will adopt when its port opens')
  } else if (autostart) {
    launchService()
    lastUp = false
    log('autostart: service was down, launched')
  } else {
    lastUp = false
    log('service down, autostart off')
  }
}

async function poll() {
  if (starting) return
  const up = await probePort(servicePort)
  if (up && !lastUp && servicePid === null) {
    servicePid = await findServicePid()
  }
  if (lastUp && !up && !userStop && !starting && crashRestart) {
    log('service went down unexpectedly — auto-restarting')
    servicePid = null
    launchService()
  }
  lastUp = up
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin
  const cors = {}
  if (origin && isLoopbackOrigin(origin)) {
    cors['Access-Control-Allow-Origin'] = origin
    cors['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    cors['Access-Control-Allow-Headers'] = 'content-type'
    cors['Vary'] = 'Origin'
  }
  const send = (code, body) => {
    res.writeHead(code, { ...cors, 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  // Anti-CSRF / DNS-rebinding: only loopback Host headers are served, and any
  // cross-site Origin is rejected BEFORE a state-changing handler can run, so
  // a remote page cannot trigger /restart /start /stop /reload as a side effect.
  if (!isLoopbackHost(req.headers.host)) return send(403, { error: 'forbidden' })
  if (origin && !isLoopbackOrigin(origin)) return send(403, { error: 'forbidden' })
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }
  let pathname
  try {
    pathname = new URL(req.url, 'http://127.0.0.1').pathname
  } catch {
    return send(400, { error: 'bad request' })
  }
  try {
    if (pathname === '/health') {
      return send(200, { ok: true, pid: process.pid, codeHash, uptimeMs: Date.now() - startedAt })
    }
    if (pathname === '/status') {
      const up = await probePort(servicePort)
      return send(200, {
        service: starting ? 'starting' : up ? 'up' : 'down',
        pid: servicePid,
        port: servicePort,
        userStop,
        uptimeMs: Date.now() - startedAt,
        restarts: restartCount,
        lastRestart,
      })
    }
    if (pathname === '/reload' && req.method === 'POST') {
      reloadConfig()
      return send(200, { ok: true, autostart, crashRestart })
    }
    if (pathname === '/restart' && req.method === 'POST') return send(200, await restartService())
    if (pathname === '/start' && req.method === 'POST') return send(200, await startService())
    if (pathname === '/stop' && req.method === 'POST') return send(200, await stopFinal())
    // Shut down the watchdog process itself, leaving the detached service
    // running, so the host can restart it to pick up code/config changes.
    if (pathname === '/shutdown' && req.method === 'POST') {
      send(200, { ok: true })
      setTimeout(() => process.exit(0), 50)
      return
    }
    return send(404, { error: 'not found' })
  } catch (error) {
    return send(500, { error: String(error && error.message ? error.message : error) })
  }
})

server.on('error', (error) => {
  log(`watchdog server error: ${error && error.message ? error.message : error}`)
  // A duplicate watchdog already owns the port — nothing more to do.
  process.exit(1)
})

server.listen(watchdogPort, '127.0.0.1', () => {
  log(`watchdog listening on 127.0.0.1:${watchdogPort}, service port ${servicePort}`)
})

void boot().then(() => {
  setInterval(poll, 2000)
})
