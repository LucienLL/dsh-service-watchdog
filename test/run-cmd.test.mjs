import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRunCmd, resolveWatchdogPort } from '../lib/index.js'

test('buildRunCmd points the Run key at launcher.js (for orphanization)', () => {
  assert.equal(
    buildRunCmd(
      'C:\\Program Files\\nodejs\\node.exe',
      'E:\\Deepseek\\Default\\dsh-service-control\\lib\\launcher.js',
      'C:\\Users\\atoml\\AppData\\Local\\DeepSeekHarnessApp\\watchdog.json',
    ),
    '"C:\\Program Files\\nodejs\\node.exe" "E:\\Deepseek\\Default\\dsh-service-control\\lib\\launcher.js" --config "C:\\Users\\atoml\\AppData\\Local\\DeepSeekHarnessApp\\watchdog.json"',
  )
})

test('resolveWatchdogPort falls back to the default port when config is missing', () => {
  assert.equal(resolveWatchdogPort(undefined), 3199)
  assert.equal(resolveWatchdogPort(null), 3199)
  assert.equal(resolveWatchdogPort(''), 3199)
  assert.equal(resolveWatchdogPort(0), 3199)
  assert.equal(resolveWatchdogPort(3201), 3201)
})
