import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('browser face injects Cordis service names rather than package names', () => {
  let registration
  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load(value) {
          registration = value
        },
      },
    },
  })

  vm.runInContext(clientSource, context)
  assert.equal(registration?.id, `${packageManifest.name}/client`)

  const client = registration.factory((specifier) => {
    if (specifier === 'react') {
      return {
        useSyncExternalStore: () => undefined,
        createElement: () => undefined,
        useState: () => [undefined, () => undefined],
        useEffect: () => undefined,
      }
    }
    throw new Error(`unexpected client external: ${specifier}`)
  })

  assert.deepEqual(Array.from(client.inject), ['slots'])
  for (const modern of [false, true]) {
    const registrations = []
    const scope = { getSnapshot() {}, subscribe() {}, set() {} }
    const ctx = {
      slots: { inject: (_, cb) => cb(), register: options => { registrations.push(options); return () => {} } },
      inject(names, cb) {
        if (names[0] === (modern ? 'configForms' : 'settingsScope')) cb(this)
      },
      configForms: { get: id => { assert.equal(id, 'service-control'); return scope } },
      settingsScope: { bind: spec => { assert.equal(spec.namespace, 'service-control'); return scope } },
    }
    client.apply(ctx)
    assert.ok(registrations.some(row => row.name === (modern ? 'settings.plugins.tab' : 'settings.plugin.item')))
    assert.ok(registrations.some(row => row.name === 'sidebar.footer.action'))
  }

})
