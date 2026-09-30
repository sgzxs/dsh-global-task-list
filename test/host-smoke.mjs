// Host-half smoke test: import the built `lib/index.js` with the real DSH
// dependencies from node_modules, run `apply()` against a stub context, and
// assert what it contributes.
//
//   node test/host-smoke.mjs
//
// The host half is plain ESM that resolves its `@deepseek-ai/*` imports from the
// profile at runtime, so it can be imported for real here — no bundling, no
// stubs for the libraries themselves, only for the services it injects.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- in-memory storageDomain ----
const rows = new Map()
const table = {
  async *entries() { for (const [key, value] of rows) yield [key, value] },
  async put(key, value) { rows.set(key, value) },
  async delete(key) { rows.delete(key) },
}

// ---- captured contributions ----
const tools = []
const sections = []
const routes = []
const effects = []
let subscribed = null

const ctx = {
  effect: (callback, label) => { effects.push(label ?? '(unlabelled)'); return callback() },
  on: () => {},
  logger: { warn: () => {}, info: () => {}, error: () => {} },
  tools: {
    register: (definition) => { tools.push(definition); return () => {} },
    get: (name) => tools.find((tool) => tool.name === name),
  },
  systemPrompt: {
    // The real service returns a centrally allocated order; the test only needs
    // a stable number and to see which name was asked for.
    getSectionOrder: (name) => { sections.push({ orderName: name }); return 2800 },
    section: (spec) => { sections.push(spec); return () => {} },
  },
  storageDomain: { open: async () => ({ table: () => table }) },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  jobs: { events: { subscribe: (filter, listener) => { subscribed = { filter, listener }; return () => {} } } },
  agents: { list: () => [] },
}

const host = await import(new URL('../lib/index.js', import.meta.url).href)
console.log(`module name          : ${host.name}`)
console.log(`inject               : ${JSON.stringify(host.inject)}`)

host.apply(ctx, {
  promptSection: true,
  jobStatusMap: { running: 'running', stopping: 'running', completed: 'done', killed: 'blocked', failed: 'failed' },
})

const names = tools.map((tool) => tool.name).sort()
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
const section = sections.find((entry) => typeof entry === 'object' && 'text' in entry)

console.log(`tools registered     : ${JSON.stringify(names)}`)
console.log(`routes registered    : ${JSON.stringify(routes.map((route) => `${route.kind} ${route.path}`))}`)
console.log(`job feed subscribed  : ${subscribed !== null} (${JSON.stringify(subscribed?.filter)})`)
console.log(`section name         : ${section?.name}`)
console.log(`section order asked  : ${sections[0]?.orderName}`)

const sectionText = (scope, agent) => section.text({ scope, agent })

let failures = 0
const check = (label, condition) => {
  if (condition) return
  failures += 1
  console.log(`  ASSERT FAILED: ${label}`)
}

check('six tools registered', names.length === 6)
check('expected tool names', JSON.stringify(names) === JSON.stringify(['task_add', 'task_delete', 'task_get', 'task_list', 'task_update', 'taskui_probe']))
check('prompt section registered', section?.name === 'task-ui:library')
check('section placed at a named order', sections[0]?.orderName === 'TOOL_SUBAGENT')
check('section text is non-empty in a scope with the tools', typeof sectionText('scope') === 'string' && sectionText('scope').length > 40)
check('section text tells the model when to skip', sectionText('scope').includes('skip it'))
check('section is silent in a scope without the tools', (() => {
  const saved = tools.splice(0, tools.length)
  const silent = sectionText('scope', undefined)
  tools.push(...saved)
  return silent === ''
})())

// A subagent gets the short variant: keep the record true, do not plan or delegate.
const subagentAgent = { session: { header: { origin: 'subagent' } } }
const masterText = sectionText('scope', { session: { header: {} } })
const subagentText = sectionText('scope', subagentAgent)
console.log(`master section chars : ${masterText.length}`)
console.log(`subagent section     : ${subagentText}`)
check('subagent gets a different section', subagentText !== masterText)
check('subagent is not told to create tasks', !subagentText.includes('task_add'))
check('subagent is not told to delegate', !subagentText.includes('delegating'))
check('subagent is told to update progress', subagentText.includes('progress') && subagentText.includes('task_update'))

check('task_add description states the skip boundary', byName.task_add.description.includes('skip it for trivial'))
check('task_add description states the delegation moment', byName.task_add.description.includes('before delegating'))
check('task_add requires the flow fields', byName.task_add.description.includes('steps'))
check('task_update description covers job linking', byName.task_update.description.includes('jobId'))
check('task_update description warns against stale entries', byName.task_update.description.includes('never moves'))
check('task_get description frames the handoff', byName.task_get.description.includes('another session'))
// `defineTool` stores the CONVERTED JSON Schema, which is also what the model
// sees, so assert on that rather than on the raw parameter spec.
const addParams = byName.task_add.parameters
console.log(`task_add steps schema : ${JSON.stringify(addParams.properties?.steps)}`)
check('task_add declares the steps parameter', addParams.properties?.steps !== undefined)
check('steps converts to an array schema', addParams.properties?.steps?.type === 'array')
check('steps items stay open objects', addParams.properties?.steps?.items?.additionalProperties === true)
check('task_add declares nextStep', addParams.properties?.nextStep !== undefined)
check('prefix route for the API', routes.some((route) => route.kind === 'prefix' && route.path === '/task-ui'))
check('exact route for the SSE channel', routes.some((route) => route.kind === 'exact' && route.path === '/task-ui/events'))
check('job bridge subscribed to every owner', JSON.stringify(subscribed?.filter) === JSON.stringify({ owners: 'all' }))

// The tools must be callable end to end through the stub storage.
const added = await byName.task_add.execute({ title: 'host smoke', description: 'what it is', nextStep: 'what is next', progress: { text: 'where it stands', percent: 5 }, steps: [{ text: 'a step', state: 'current' }] })
const id = added.text.split(': ')[1].split(' ')[0]
check('task_add writes a record', rows.size === 1)
check('record keeps the supplied flow', rows.get(id)?.steps?.length === 1)

const listed = await byName.task_list.execute({})
console.log(`task_list line       : ${listed.text}`)
check('task_list sees the record', listed.text.includes('host smoke'))
check('task_list carries the next step for triage', listed.text.includes('next: what is next'))

const detail = await byName.task_get.execute({ id })
console.log('--- task_get output ---')
console.log(detail.text)
check('task_get leads with the status and title', detail.text.startsWith('[pending] host smoke'))
check('task_get carries the description', detail.text.includes('description: what it is'))
check('task_get carries progress with the percent', detail.text.includes('progress: 5% — where it stands'))
check('task_get carries the next step', detail.text.includes('next: what is next'))
check('task_get carries the step flow', detail.text.includes('- [current] a step'))
check('task_get reports a missing id softly', (await byName.task_get.execute({ id: 'nope' })).text.startsWith('task not found'))

await byName.task_delete.execute({ id })
check('task_delete removes it', rows.size === 0)

// A task whose job was linked before this process started cannot still be
// running: the job registry is in-process. The Host must say so in both read
// paths instead of letting "running" stand unqualified.
rows.set('stale-1', {
  title: 'left over from a previous run',
  status: 'running',
  description: '',
  nextStep: 'verify whether anything is actually running',
  steps: [],
  parentId: null,
  dependsOn: [],
  surface: null,
  progress: null,
  jobId: 'job-abcdef12',
  createdAt: 1,
  updatedAt: 1,
})
const staleList = await byName.task_list.execute({})
console.log(`stale list line      : ${staleList.text}`)
check('task_list marks the expired job link', staleList.text.includes('[expired]'))
check('task_list does not mark it as an error', !staleList.text.includes('undefined'))

const staleGet = await byName.task_get.execute({ id: 'stale-1' })
console.log('--- task_get output for the stale job ---')
console.log(staleGet.text)
check('task_get warns before the reader acts', staleGet.text.includes('warning: job job-abcdef12'))
check('task_get says the status is unverified', staleGet.text.includes('unverified'))
check('the warning precedes progress', staleGet.text.indexOf('warning:') < staleGet.text.indexOf('next:'))

// The same row, refreshed after boot, is no longer flagged: a live write means
// something is actually driving it.
rows.set('stale-1', { ...rows.get('stale-1'), updatedAt: Date.now() + 1000 })
const refreshed = await byName.task_get.execute({ id: 'stale-1' })
check('a post-boot write clears the warning', !refreshed.text.includes('warning:'))
rows.delete('stale-1')

console.log(failures === 0 ? '\nHOST: PASS' : `\nHOST: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
