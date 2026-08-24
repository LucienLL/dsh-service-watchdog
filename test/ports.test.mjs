import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SERVICE_PORT, DEFAULT_WATCHDOG_PORT, resolvePositivePort } from '../lib/ports.js'

test('resolvePositivePort falls back to the supplied default', () => {
  assert.equal(resolvePositivePort(undefined, DEFAULT_WATCHDOG_PORT), DEFAULT_WATCHDOG_PORT)
  assert.equal(resolvePositivePort(null, DEFAULT_SERVICE_PORT), DEFAULT_SERVICE_PORT)
  assert.equal(resolvePositivePort('', DEFAULT_WATCHDOG_PORT), DEFAULT_WATCHDOG_PORT)
  assert.equal(resolvePositivePort(0, DEFAULT_SERVICE_PORT), DEFAULT_SERVICE_PORT)
  assert.equal(resolvePositivePort(3199, DEFAULT_WATCHDOG_PORT), 3199)
})
