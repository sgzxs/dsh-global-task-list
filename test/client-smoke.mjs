// Client-half smoke test: load the built `__ModuleLoader__` bundle with stubbed
// platform modules, run `apply()`, and assert the panel registers into the slot
// with the expected metadata. Catches module-eval and apply()-time throws — the
// failures a browser reports as "Failed to load plugins".
//
//   node test/client-smoke.mjs [path/to/lib/client.js]
//
// Pure Node, no dependencies, no browser: safe to run anywhere.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = process.argv[2] ?? join(ROOT, 'lib', 'client.js')

// ---- stand-ins for the browser platform seed words ----
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
}
const jsxRuntime = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: 'Fragment',
}
const clientStore = {
  defineStore: (decl) => ({ __store: decl, actions: Object.keys(decl.actions ?? {}) }),
}

const modules = {
  'react': react,
  'react/jsx-runtime': jsxRuntime,
  '@deepseek-ai/dsh-client-store': clientStore,
}

// ---- browser globals the apply() world touches ----
let eventSourceCount = 0
globalThis.EventSource = class {
  constructor(url) { this.url = url; eventSourceCount += 1 }
  close() {}
}
const injectedStyles = []
globalThis.document = {
  querySelectorAll: () => [],
  // The bundle injects one <style data-plugin-css> per CSS module at factory
  // time; null here means "not injected yet", so it takes the create path.
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (tag) => { injectedStyles.push(tag) } },
}
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.window = {
  matchMedia: () => ({ matches: false }),
  __ModuleLoader__: { load: (registration) => { captured = registration } },
}
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })

let captured
const source = readFileSync(bundlePath, 'utf8')
// The bundle is a classic script: evaluate it with our `window` in scope.
new Function('window', 'document', 'EventSource', 'MutationObserver', 'getComputedStyle', source)(
  globalThis.window,
  globalThis.document,
  globalThis.EventSource,
  globalThis.MutationObserver,
  globalThis.getComputedStyle,
)

if (captured === undefined) throw new Error('bundle did not call window.__ModuleLoader__.load()')
console.log(`bundle               : ${bundlePath}`)
console.log(`registered id        : ${captured.id}`)

const exports = captured.factory((spec) => {
  if (!(spec in modules)) throw new Error(`unstubbed require(${spec})`)
  return modules[spec]
})
console.log(`exports.apply        : ${typeof exports.apply}`)
console.log(`exports.inject       : ${JSON.stringify(exports.inject)}`)

// ---- run apply() against a stub client context ----
let registration
const effectLabels = []
const ctx = {
  effect: (callback, label) => { effectLabels.push(label ?? '(unlabelled)'); return callback() },
  locale: { register: (ns, dicts) => ({ ns, locales: Object.keys(dicts) }) },
  slots: {
    inject: (slot, callback) => { console.log(`inject slot          : ${slot}`); callback() },
    register: (meta, component) => { registration = { meta, component }; return { dispose() {} } },
  },
}
exports.apply(ctx)

console.log(`effect labels        : ${JSON.stringify(effectLabels)}`)
console.log(`EventSource opened   : ${eventSourceCount}`)
console.log(`slot registration    : ${JSON.stringify({
  name: registration?.meta?.name,
  id: registration?.meta?.id,
  order: registration?.meta?.order,
  locale: registration?.meta?.locale,
  hasStore: registration?.meta?.store !== undefined,
  hasInject: typeof registration?.meta?.inject === 'function',
})}`)
console.log(`style tags injected  : ${injectedStyles.length}`)
const cssText = injectedStyles.map((tag) => tag.textContent).join('')
for (const marker of ['dsh-task-rise', '--dsw-elevation-prominent', '--dsw-alias-settings-card-fill', 'corner-shape:round']) {
  console.log(`  css contains ${marker.padEnd(32)}: ${cssText.includes(marker)}`)
}

// The inject factory must hand the component its operations face.
const ops = registration.meta.inject('session-probe', {
  refresh: () => {}, clearError: () => {}, setError: () => {}, setConfirming: () => {},
})
console.log(`injected operations  : ${JSON.stringify(Object.keys(ops).sort())}`)

const ok = captured.id === 'dsh-global-task-list'
  && typeof exports.apply === 'function'
  && registration?.meta?.id === 'task-ui'
  && registration?.meta?.name === 'conversation.input.dock'
  && typeof registration?.meta?.store === 'object'
  && registration?.meta?.store !== null
  && typeof registration?.component === 'function'
  && cssText.includes('--dsw-alias-settings-card-fill')
  && ops.setStatus !== undefined && ops.requestDelete !== undefined && ops.askAgent !== undefined
console.log(ok ? '\nSMOKE: PASS' : '\nSMOKE: FAIL')
process.exit(ok ? 0 : 1)
