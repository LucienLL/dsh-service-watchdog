/**
 * dsh-service-watchdog — server half (Cordis plugin).
 *
 * Manages a detached watchdog process that can restart the DSH web service
 * even after the service itself has stopped (the watchdog lives on its own
 * loopback control port and outlives the service process tree).
 *
 * - Persists the exact launch command (node path, argv, cwd, full env) to a
 *   watchdog config file at setup, so the watchdog can relaunch the service
 *   after a machine reboot without any running process to read it from.
 * - Registers a HKCU Run key (autostart) that starts the watchdog at login via
 *   launcher.js (which exits immediately and orphans the watchdog, so it
 *   survives process-tree cleanup); the watchdog then brings the service up.
 * - Serves GET /service-control/work with a live "is there active work"
 *   snapshot (running agents, queued inbox messages, running background jobs)
 *   so the browser half can ask for a second confirmation before killing.
 *
 * @module dsh-service-watchdog
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import net from 'node:net'
import http from 'node:http'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace, liveConfig, plainConfig } from './settings-compat.js'
import { DEFAULT_SERVICE_PORT, DEFAULT_WATCHDOG_PORT, resolvePositivePort } from './ports.js'

const execFileAsync = promisify(execFile)

const name = 'service-control'
const inject = ['settings']

const SC_NS = settingsNamespace('service-control')
// The watchdog is spawned through launcher.js (which exits immediately) so it
// is orphaned and survives a taskkill /T of the service tree.
const LAUNCHER_PATH = fileURLToPath(new URL('./launcher.js', import.meta.url))
const WATCHDOG_PATH = fileURLToPath(new URL('./watchdog.js', import.meta.url))
const RUN_VALUE_NAME = 'DshServiceControlWatchdog'

const Config = liveConfig(z.object({
  watchdogPort: z.number().default(3199),
  autostart: z.boolean().default(true),
  crashRestart: z.boolean().default(true),
}))

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Shared state dir with the C# launcher (server.log / server.pid live here). */
function stateDir() {
  return process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'DeepSeekHarnessApp')
    : join(dshHome(), 'run')
}

function servicePortFromArgv() {
  const argv = process.argv
  const i = argv.indexOf('--port')
  if (i >= 0 && argv[i + 1]) {
    const p = Number(argv[i + 1])
    if (Number.isFinite(p) && p > 0) return p
  }
  return DEFAULT_SERVICE_PORT
}

/** Reconstruct the exact command that started THIS service. */
function buildLaunch() {
  const args = process.argv.slice(1)
  if (args.length > 0 && !isAbsolute(args[0])) args[0] = join(process.cwd(), args[0])
  return {
    cmd: process.execPath,
    args,
    cwd: process.cwd(),
    env: sanitizeEnv(process.env),
  }
}

function buildRunCmd(execPath, launcherPath, cfgPath) {
  return `"${execPath}" "${launcherPath}" --config "${cfgPath}"`
}

function resolveWatchdogPort(value) {
  return resolvePositivePort(value, DEFAULT_WATCHDOG_PORT)
}

// Strip secrets before persisting the relaunch env to watchdog.json. The C#
// launcher only ever sets DSH_HOME / PATH / NODE_OPTIONS plus the clean
// desktop env; anything token/key/secret-shaped (or Codex-injected) must not
// be written to disk. API keys resolve again from .credentials.yaml on relaunch.
const SECRET_ENV_PATTERN = /(token|api[_-]?key|secret|password|passwd|private|credential|^codex_)/i
function sanitizeEnv(env) {
  const out = {}
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_PATTERN.test(key)) continue
    out[key] = value
  }
  return out
}

/** POST an action to a running watchdog (best-effort, never throws). */
function postWatchdog(port, path) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', timeout: 2000 },
      (res) => {
        res.resume()
        resolve()
      },
    )
    req.on('error', () => resolve())
    req.on('timeout', () => {
      req.destroy()
      resolve()
    })
    req.end()
  })
}

/** GET /health from a running watchdog; resolves null when unreachable. */
function fetchWatchdogHealth(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 2000 }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.end()
  })
}

/** Fingerprint of the on-disk watchdog code, used to detect a stale watchdog. */
function watchdogCodeHash() {
  try {
    return createHash('sha256').update(readFileSync(WATCHDOG_PATH, 'utf8')).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

function portUp(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 500 })
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

/** Live "is there active work" snapshot (running agents / queued / jobs). */
function activeWork(ctx) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.list !== 'function') {
    return { busy: false, runningAgents: 0, queuedMessages: 0, activeJobs: 0 }
  }
  const list = agents.list()
  let runningAgents = 0
  let queuedMessages = 0
  for (const a of list) {
    if (a.status === 'running') runningAgents += 1
    const inbox = a.inbox
    if (inbox) {
      queuedMessages += (inbox.nextTurn ? inbox.nextTurn.length : 0) + (inbox.nextStep ? inbox.nextStep.length : 0)
    }
  }
  // `jobs.list(owner)` returns that owner's jobs PLUS the shared (owner-less)
  // open jobs, so a plain sum double-counts every global job once per agent.
  // Dedupe by job id to get an accurate active count.
  const jobs = ctx.get('jobs')
  let activeJobs = 0
  if (jobs && typeof jobs.list === 'function') {
    const seen = new Set()
    for (const a of list) {
      try {
        for (const s of jobs.list(a)) {
          if ((s.status === 'running' || s.status === 'stopping') && !seen.has(s.id)) {
            seen.add(s.id)
            activeJobs += 1
          }
        }
      } catch {
        /* ignore a job owner that is mid-teardown */
      }
    }
  }
  return {
    // Queued (parked) messages are also work that a restart would lose, so they
    // must trip the second-confirmation the same way running agents/jobs do.
    busy: runningAgents > 0 || queuedMessages > 0 || activeJobs > 0,
    runningAgents,
    queuedMessages,
    activeJobs,
    sessions: list.length,
  }
}

async function setRunKey(enabled, runCmd) {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
  try {
    if (enabled) {
      await execFileAsync('reg', ['add', key, '/v', RUN_VALUE_NAME, '/t', 'REG_SZ', '/d', runCmd, '/f'], { windowsHide: true })
    } else {
      await execFileAsync('reg', ['delete', key, '/v', RUN_VALUE_NAME, '/f'], { windowsHide: true })
    }
  } catch (error) {
    // Best-effort: missing reg.exe or non-Windows is not fatal.
    console.error(`[dsh-service-watchdog] Run key update failed: ${error && error.message ? error.message : error}`)
  }
}

function apply(ctx, config) {
  const entryConfig = config
  config = plainConfig(entryConfig)
  const servicePort = servicePortFromArgv()
  const launch = buildLaunch()
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  const cfgPath = join(dir, 'watchdog.json')
  const logPath = join(dir, 'watchdog.log')
  const getWatchdogPort = () => resolveWatchdogPort(config.watchdogPort)
  let ensureWatchdogPromise = null

  const writeConfig = () => {
    writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          servicePort,
          watchdogPort: getWatchdogPort(),
          launch,
          autostart: config.autostart !== false,
          crashRestart: config.crashRestart !== false,
          logPath,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
  }

  // Route the Run key through launcher.js so the login watchdog is orphaned the
  // same way the service-side spawn is (a direct child of the login shell can
  // be killed by session/process-tree cleanup, which left the button grayed).
  const runCmd = buildRunCmd(process.execPath, LAUNCHER_PATH, cfgPath)

  const ensureWatchdog = () => {
    if (ensureWatchdogPromise) return ensureWatchdogPromise
    ensureWatchdogPromise = (async () => {
      writeConfig()
      const watchdogPort = getWatchdogPort()
      if (await portUp(watchdogPort)) return
      try {
        const child = spawn(process.execPath, [LAUNCHER_PATH, '--config', cfgPath, '--adopt-only'], {
          detached: true,
          windowsHide: true,
          stdio: 'ignore',
        })
        child.unref()
        ctx.logger.info('service-control: watchdog spawn requested on 127.0.0.1:%d', watchdogPort)
        const deadline = Date.now() + 5000
        while (Date.now() < deadline && !(await portUp(watchdogPort))) {
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      } catch (error) {
        ctx.logger.warn('service-control: watchdog spawn failed: %s', String(error))
      }
    })().finally(() => {
      ensureWatchdogPromise = null
    })
    return ensureWatchdogPromise
  }

  // The port the currently-running watchdog is on. Changing watchdogPort in
  // settings must retire the old-port watchdog instead of leaving two alive.
  let activeWatchdogPort = getWatchdogPort()

  const waitPortDown = async (port) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && (await portUp(port))) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  // Reconcile the live watchdog with the desired state: spawn if gone, retire +
  // respawn on port change, and restart it when its code changed on disk.
  const syncWatchdog = async () => {
    const port = getWatchdogPort()

    if (port !== activeWatchdogPort) {
      ctx.logger.info('service-control: watchdog port changed %d -> %d', activeWatchdogPort, port)
      await postWatchdog(activeWatchdogPort, '/shutdown')
      await waitPortDown(activeWatchdogPort)
      activeWatchdogPort = port
      void ensureWatchdog()
      return
    }

    if (!(await portUp(port))) {
      void ensureWatchdog()
      return
    }

    const expected = watchdogCodeHash()
    if (expected) {
      const health = await fetchWatchdogHealth(port)
      if (health && health.codeHash && health.codeHash !== expected) {
        ctx.logger.info('service-control: watchdog code changed — restarting to load it')
        await postWatchdog(port, '/shutdown')
        await waitPortDown(port)
        void ensureWatchdog()
      }
    }
  }

  const applySettingsChange = () => {
    writeConfig()
    void setRunKey(config.autostart !== false, runCmd)
    void postWatchdog(getWatchdogPort(), '/reload')
    void syncWatchdog()
  }

  installSettingsSection(ctx, SC_NS, Config, entryConfig, {
    setSource: (current) => {
      // `current` is a source FUNCTION () => scope.get(), not the config object.
      config = current()
      applySettingsChange()
    },
    onChange: applySettingsChange,
  })

  void ensureWatchdog()
  void setRunKey(config.autostart !== false, runCmd)
  void syncWatchdog()

  // Self-heal: the watchdog can be killed externally while its detached service
  // child survives orphaned (e.g. after a reboot the Run-key watchdog dies and
  // nothing re-spawns it, leaving the restart button grayed out). Poll the
  // watchdog and re-spawn it whenever it has gone away; also restart it when
  // its code changed on disk, so watchdog edits load without a machine reboot.
  const watchdogWatchTimer = setInterval(() => {
    void syncWatchdog()
  }, 15000)

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      scope.effect(() => scope.webServer.register({
        name: 'service-control-work',
        kind: 'exact',
        path: '/service-control/work',
        handler: (req, res) => {
          try {
            const body = {
              ...activeWork(ctx),
              watchdogPort: getWatchdogPort(),
              servicePort,
              pid: process.pid,
              up: true,
              uptimeMs: Math.round(process.uptime() * 1000),
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(body))
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: String(error) }))
          }
        },
      }), 'service-control: /service-control/work route')
    })
  }

  ctx.effect(() => () => {
    clearInterval(watchdogWatchTimer)
  }, 'service-control: cleanup')
}

export { Config, apply, buildRunCmd, inject, name, resolveWatchdogPort }
