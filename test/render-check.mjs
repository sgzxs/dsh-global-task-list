// Render-path test: execute the built panel component through a minimal hook
// runtime and drive it across the states the panel actually sees.
//
//   node test/render-check.mjs [path/to/lib/client.js]
//
// Why this exists: a render-time throw is what DSH's per-entry isolation
// swallows — it reports the failure through its supervision seam and paints
// nothing, so the panel simply disappears while the rest of the UI stays
// healthy. Neither a build nor a load-time smoke test reaches this code path,
// and a dependency array is evaluated on EVERY render, so a stray identifier
// there takes the panel down deterministically without any interaction.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = process.argv[2] ?? join(ROOT, 'lib', 'client.js')

// ---- minimal hook runtime: enough to run a render, no reconciliation ----
let hooks = []
let cursor = 0

const react = {
  // Same shape as jsx-runtime below: the bundle mixes both, and a walker that
  // only understands one of them silently misses half the tree.
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: (init) => {
    const i = cursor++
    if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init
    const set = (value) => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value }
    return [hooks[i], set]
  },
  useRef: (init) => {
    const i = cursor++
    if (!(i in hooks)) hooks[i] = { current: init }
    return hooks[i]
  },
  useMemo: (compute) => { cursor++; return compute() },
  useEffect: () => { cursor++ },
  useLayoutEffect: () => { cursor++ },
  useCallback: (fn) => { cursor++; return fn },
}

const jsxRuntime = {
  jsx: (type, props) => ({ type, props: props ?? {} }),
  jsxs: (type, props) => ({ type, props: props ?? {} }),
  Fragment: 'Fragment',
}
const modules = {
  'react': react,
  'react/jsx-runtime': jsxRuntime,
  '@deepseek-ai/dsh-client-store': { defineStore: (decl) => ({ __store: decl, actions: {} }) },
}

// ---- browser globals ----
const storage = new Map()
globalThis.window = {
  matchMedia: () => ({ matches: false }),
  innerWidth: 1600,
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
  },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  __ModuleLoader__: { load: (registration) => { captured = registration } },
}
globalThis.document = {
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: () => {} },
  documentElement: {},
}
globalThis.EventSource = class { constructor() {} close() {} }
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })

let captured
new Function('window', 'document', 'EventSource', 'MutationObserver', 'getComputedStyle',
  readFileSync(bundlePath, 'utf8'))(
  globalThis.window, globalThis.document, globalThis.EventSource, globalThis.MutationObserver, globalThis.getComputedStyle,
)

const bundle = captured.factory((spec) => {
  if (!(spec in modules)) throw new Error(`unstubbed require(${spec})`)
  return modules[spec]
})

// ---- capture the panel component through a stub slot registry ----
let component
bundle.apply({
  effect: (callback) => callback(),
  locale: { register: () => ({}) },
  slots: {
    inject: (_slot, callback) => callback(),
    register: (_meta, registered) => { component = registered; return { dispose() {} } },
  },
})

/** Every props object in a rendered tree, depth-first. */
function nodes(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) out.push(...nodes(child)); return out }
  if (node.props) out.push(node)
  nodes(node.props?.children, out)
  return out
}

/**
 * Render child components too, not just the root. Each invocation gets its own
 * hook scope, which is what lets a card and the surface renderer be executed for
 * real instead of staying inert elements in the tree — their render paths are
 * exactly as capable of throwing as the panel's.
 */
function renderDeep(element) {
  if (element === null || element === undefined || typeof element !== 'object') return element
  if (Array.isArray(element)) return element.map(renderDeep)
  const children = renderDeep(element.props?.children)
  const props = { ...element.props, children }
  if (typeof element.type === 'function') {
    const outerHooks = hooks
    const outerCursor = cursor
    hooks = []
    cursor = 0
    try {
      return renderDeep(element.type(props))
    } finally {
      hooks = outerHooks
      cursor = outerCursor
    }
  }
  return { type: element.type, props }
}

const task = (id, over = {}) => ({
  id,
  title: `task ${id}`,
  status: 'running',
  description: 'a description',
  nextStep: 'do the next thing',
  steps: [],
  parentId: null,
  dependsOn: [],
  surface: null,
  progress: { text: 'halfway', percent: 50 },
  jobId: null,
  createdAt: 1,
  updatedAt: 2,
  ...over,
})

/** A record as an older Host wrote it: no nextStep, no steps. */
const legacy = {
  id: 'legacy',
  title: 'legacy',
  status: 'pending',
  description: '',
  parentId: null,
  dependsOn: [],
  surface: null,
  progress: null,
  jobId: null,
  createdAt: 0,
  updatedAt: 0,
}

// [name, state, expected flow nodes, expected "flow was derived" hint]
const cases = [
  ['empty list', { tasks: [] }, 0, false],
  ['one task', { tasks: [task('a')] }, 2, true],
  ['no progress', { tasks: [task('b', { progress: null })] }, 1, true],
  ['no nextStep (older Host)', { tasks: [{ ...task('c'), nextStep: undefined }] }, 1, true],
  ['empty description', { tasks: [task('d', { description: '' })] }, 2, true],
  ['legacy record shape', { tasks: [legacy] }, 0, false],
  ['deps + parent + job', { tasks: [task('e', { dependsOn: ['x1', 'y2'], parentId: 'p9', jobId: 'job-1234567890' })] }, 2, true],
  ['every status', { tasks: ['pending', 'running', 'done', 'blocked', 'failed'].map((s, i) => task(`s${i}`, { status: s })) }, 10, true],
  ['with error banner', { tasks: [task('f')], error: { code: 'refresh', detail: 'boom' } }, 2, true],
  ['confirming delete', { tasks: [task('g')], confirming: 'g' }, 2, true],
  ['surface document', { tasks: [task('h', { surface: { kind: 'metric', label: 'x', value: 1 } })] }, 2, true],
  ['collapsed pill', { tasks: [task('i')], collapsed: true }, 0, false],
  ['flow supplied', {
    tasks: [task('j', { steps: [
      { text: 'step one', state: 'done' },
      { text: 'step two', state: 'current' },
      { text: 'step three', state: 'next' },
    ] })],
  }, 3, false],
  ['flow without a next node', { tasks: [task('k', { steps: [{ text: 'only done', state: 'done' }] })] }, 2, false],
  ['flow overrides the derived node', { tasks: [task('l', { nextStep: '', steps: [{ text: 'x', state: 'todo' }] })] }, 1, false],
]

let failures = 0
const check = (label, condition) => {
  if (condition) return
  failures += 1
  console.log(`  ASSERT FAILED: ${label}`)
}

for (const [name, state, expectedFlow, expectedDerivedNote] of cases) {
  const full = { tasks: [], error: null, confirming: null, collapsed: false, ...state }
  cursor = 0
  hooks = []
  let tree
  try {
    tree = renderDeep(component({
      t: (key) => key,
      useStore: (selector) => selector(full),
      actions: { setConfirming: () => {}, setCollapsed: () => {} },
      setStatus: () => {},
      requestDelete: () => {},
      askAgent: () => {},
    }))
  } catch (error) {
    failures += 1
    console.log(`THROW ${name}`)
    console.log(`      ${error?.stack ? error.stack.split('\n').slice(0, 6).join('\n      ') : String(error)}`)
    continue
  }

  const all = nodes(tree)
  // The card `<li>` always carries these three data attributes (possibly
  // undefined), so the prop key itself is a stable per-card marker that does
  // not depend on hashed class names or on the exact stub tree shape.
  const cards = all.filter(n => n.props && 'data-expanded' in n.props && 'data-exit' in n.props)
  // Flow steps are the only nodes carrying `data-state` (status buttons use
  // `data-status`, which is a different key).
  const flowNodes = all.filter(n => n.props && 'data-state' in n.props)
  if (state.collapsed === true) {
    check(`${name}: collapsed renders the mini pill`, tree?.type === 'button')
  } else {
    check(`${name}: panel has exactly one resizer`, all.filter(n => n.props.role === 'separator').length === 1)
    check(`${name}: one card per task (${cards.length} vs ${full.tasks.length})`, cards.length === full.tasks.length)
    check(`${name}: panel root is a div`, tree?.type === 'div')
  }
  check(`${name}: flow nodes (${flowNodes.length} vs ${expectedFlow})`, flowNodes.length === expectedFlow)
  // `t()` echoes its key here, so the hint's own key is a stable marker for it.
  const hasDerivedNote = all.some(n => JSON.stringify(n.props?.children ?? '').includes('detail.flowDerived'))
  check(`${name}: derived-flow hint (${hasDerivedNote} vs ${expectedDerivedNote})`, hasDerivedNote === expectedDerivedNote)
  console.log(`ok    ${name.padEnd(30)} nodes=${all.length} cards=${cards.length} flow=${flowNodes.length} hint=${hasDerivedNote}`)
}

// The stale-job flag is Host-derived, so the panel must render the warning only
// when the payload carries it — and must not invent one for a live job.
for (const [label, jobStale, expected] of [['stale job link', true, true], ['live job link', false, false], ['host without the field', undefined, false]]) {
  cursor = 0
  hooks = []
  const linked = task('job', { jobId: 'job-abcdef12', jobStale })
  if (jobStale === undefined) delete linked.jobStale
  const rendered = renderDeep(component({
    t: (key) => key,
    useStore: (selector) => selector({ tasks: [linked], error: null, confirming: null, collapsed: false }),
    actions: { setConfirming: () => {}, setCollapsed: () => {} },
    setStatus: () => {},
    requestDelete: () => {},
    askAgent: () => {},
  }))
  const warns = nodes(rendered).some(n => JSON.stringify(n.props?.children ?? '').includes('panel.jobExpired'))
  check(`${label}: warning shown (${warns} vs ${expected})`, warns === expected)
  console.log(`ok    ${label.padEnd(30)} jobWarning=${warns}`)
}

console.log(failures === 0 ? '\nRENDER: PASS' : `\nRENDER: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
