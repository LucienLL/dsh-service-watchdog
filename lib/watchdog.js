/**
 * dsh-service-watchdog — standalone detached watchdog process.
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
 *   - hold the entry plane: the service reports its authenticated URL through
 *     POST /handoff, and GET /go redirects a bookmarked browser to it (or shows
 *     a launch page that starts the service when it is down). The fixed entry
 *     therefore outlives every service restart while never storing a token in
 *     the bookmark;
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
import { DEFAULT_SERVICE_PORT, DEFAULT_WATCHDOG_PORT, LEGACY_WATCHDOG_PORTS, resolvePositivePort } from './ports.js'

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
// Ports a previous release listened on. A watchdog that boots elsewhere retires
// whatever still answers there, so a port move cannot leave two watchdogs
// fighting over the same service. Never includes our own port.
const legacyWatchdogPorts = (Array.isArray(config.legacyWatchdogPorts) ? config.legacyWatchdogPorts : LEGACY_WATCHDOG_PORTS)
  .map((port) => Number(port))
  .filter((port) => Number.isInteger(port) && port > 0 && port !== watchdogPort)
// Spawned from inside a booting service: only adopt (never launch), so a
// service still opening its port is not raced by a duplicate launch. Login
// autostart (Run key) does NOT pass this flag and therefore may launch.
const adoptOnly = process.argv.includes('--adopt-only')

let servicePid = null
let lastUp = false
let userStop = false
let starting = false
// The service's current authenticated URL, overserved by a POST /handoff from
// the in-service plugin. Never returned in any response body: only /go
// redirects to it, exactly like the desktop host's own navigation.
let handoffUrl = null
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

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
// The service mints a 32-byte base64url launch token (43 characters).
const LAUNCH_TOKEN = /^[A-Za-z0-9_-]{43}$/
const HANDOFF_BODY_LIMIT = 4096

/** Small JSON fetch helper for talking to another watchdog instance. */
async function fetchJson(port, path, method = 'GET') {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
      method,
      signal: AbortSignal.timeout(2000),
    })
    return response.ok ? await response.json() : undefined
  } catch {
    return undefined
  }
}

/**
 * Retire a watchdog inherited from a legacy port. Identification is required:
 * only a listener answering /health with our shape AND /status with a service
 * field is shut down, so an unrelated program on that port is left alone.
 */
async function retireLegacyWatchdogs() {
  for (const port of legacyWatchdogPorts) {
    if (!(await probePort(port))) continue
    const health = await fetchJson(port, '/health')
    if (!health || typeof health.pid !== 'number' || typeof health.codeHash !== 'string') continue
    const status = await fetchJson(port, '/status')
    if (!status || typeof status.service !== 'string') continue
    await fetchJson(port, '/shutdown', 'POST')
    log(`retired legacy watchdog on 127.0.0.1:${String(port)}`)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && (await probePort(port))) await sleep(200)
  }
}

/** Read a small request body with a hard cap; rejects oversize input. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Validate the authenticated URL a service hands over. Anything that is not a
 * bare loopback origin on the service port carrying exactly one launch token is
 * rejected, so a compromised or confused caller cannot point /go elsewhere.
 * @param raw - request body text.
 * @returns the absolute URL, or undefined when the payload is not acceptable.
 */
function acceptHandoff(raw) {
  let url
  try {
    url = new URL(String(raw).trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:') return undefined
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return undefined
  if (url.port !== String(servicePort)) return undefined
  if (url.pathname !== '/' || url.hash !== '' || url.username !== '' || url.password !== '') return undefined
  const keys = [...url.searchParams.keys()]
  if (keys.length !== 1 || keys[0] !== 'token') return undefined
  const token = url.searchParams.get('token') ?? ''
  if (!LAUNCH_TOKEN.test(token)) return undefined
  return url.href
}

/** The self-starting page served by /go while the service is down or unauthenticated. */
function launchPageHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DeepSeek Harness</title>
<style>
body{margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#101418;color:#e6edf3;font:14px/1.7 "Segoe UI",-apple-system,sans-serif}
div{text-align:center;padding:24px}p{margin:.4em 0}#state{opacity:.6;font-size:12px}
</style></head>
<body><div><p id="message">正在启动 DeepSeek Harness 服务…</p><p id="state"></p></div>
<script>
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let startRequested = false
async function tick() {
  for (let i = 0; i < 90; i += 1) {
    const status = await fetch('/status', { cache: 'no-store' })
      .then((response) => response.json())
      .catch(() => null)
    if (status && status.service === 'up') {
      location.replace('/go')
      return
    }
    if (!startRequested && status && status.service !== 'up') {
      startRequested = true
      fetch('/start', { method: 'POST' }).catch(() => {})
    }
    document.getElementById('state').textContent = status ? '服务状态：' + status.service : '看门狗不可达'
    await wait(1000)
  }
  document.getElementById('message').textContent = '启动超时，请检查 %LOCALAPPDATA%\\\\DeepSeekHarnessApp\\\\watchdog.log'
}
tick()
</script></body></html>`
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
        watchdogPort,
        // Whether a usable entry target exists; the URL itself never leaves the
        // process except as a /go redirect Location.
        handoffReady: up && handoffUrl !== null,
        userStop,
        uptimeMs: Date.now() - startedAt,
        restarts: restartCount,
        lastRestart,
      })
    }
    if (pathname === '/handoff') {
      if (req.method !== 'POST') return send(405, { error: 'method not allowed' })
      let accepted
      try {
        accepted = acceptHandoff(await readBody(req, HANDOFF_BODY_LIMIT))
      } catch {
        return send(413, { error: 'body too large' })
      }
      if (accepted === undefined) return send(400, { error: 'invalid handoff' })
      handoffUrl = accepted
      log('handoff accepted (token hidden)')
      return send(200, { ok: true })
    }
    // The fixed browser entry: a bookmarkable address carrying no credential.
    // It outlives every service restart and shows a launch page while the
    // service is down instead of a bare connection refusal.
    if (pathname === '/go') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'method not allowed' })
      if (await probePort(servicePort)) {
        // Prefer the URL the service reported through /handoff. Until a service
        // has reported one (an older plugin build, or a handoff that has not
        // landed yet) fall back to the service's own /go, which mints the
        // redirect with its live token — same result, one extra hop.
        const location = handoffUrl ?? `http://127.0.0.1:${String(servicePort)}/go`
        res.writeHead(302, {
          location,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        res.end()
        return
      }
      res.writeHead(200, {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-type': 'text/html; charset=utf-8',
      })
      res.end(req.method === 'HEAD' ? undefined : launchPageHtml())
      return
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
  void retireLegacyWatchdogs()
})

void boot().then(() => {
  setInterval(poll, 2000)
})
