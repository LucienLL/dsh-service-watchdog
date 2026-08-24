import assert from 'node:assert/strict'
import test from 'node:test'
import { parseListeningPid, isLoopbackOrigin, isLoopbackHost } from '../lib/proc.js'

test('parseListeningPid finds the LISTENING pid on the port', () => {
  const netstat = [
    '  TCP    127.0.0.1:3180     0.0.0.0:0      LISTENING       29660',
    '  TCP    127.0.0.1:3080     0.0.0.0:0      LISTENING       11111',
    '  TCP    [::1]:3180          [::]:0          LISTENING       29660',
  ].join('\r\n')
  assert.equal(parseListeningPid(netstat, 3180), 29660)
  assert.equal(parseListeningPid(netstat, 3080), 11111)
  assert.equal(parseListeningPid(netstat, 9999), null)
})

test('parseListeningPid ignores non-listening lines and junk', () => {
  const netstat = [
    '  TCP    192.168.1.5:53180  1.2.3.4:443   ESTABLISHED    1234',
    '',
  ].join('\n')
  assert.equal(parseListeningPid(netstat, 443), null)
})

test('isLoopbackOrigin allows loopback hosts only', () => {
  assert.equal(isLoopbackOrigin('http://127.0.0.1:3180'), true)
  assert.equal(isLoopbackOrigin('http://localhost:3180'), true)
  assert.equal(isLoopbackOrigin('http://[::1]:3180'), true)
  assert.equal(isLoopbackOrigin('http://evil.example.com'), false)
  assert.equal(isLoopbackOrigin(undefined), false)
  assert.equal(isLoopbackOrigin('not a url'), false)
})

test('isLoopbackHost allows loopback host headers only', () => {
  assert.equal(isLoopbackHost('127.0.0.1:3199'), true)
  assert.equal(isLoopbackHost('localhost:3199'), true)
  assert.equal(isLoopbackHost('[::1]:3199'), true)
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('evil.example.com'), false)
  assert.equal(isLoopbackHost('127.0.0.1.evil.com:3199'), false)
  assert.equal(isLoopbackHost(undefined), false)
})
