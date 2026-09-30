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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// `apply()` seeds the bundled skill into $DSH_HOME, so point that at a throwaway
// root: a test must never touch the developer's real ~/.dsh/skills.
const previousDshHome = process.env.DSH_HOME
const seedHome = mkdtempSync(join(tmpdir(), 'task-ui-seed-'))
process.env.DSH_HOME = seedHome
const skillPath = join(seedHome, 'skills', 'task-ui', 'SKILL.md')
const sidecarPath = `${skillPath}.new`
const digestOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

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
const disposers = []
let subscribed = null

// Storage-domain double. `openFailures` injects the transient `already-open`
// rejection a plugin toggle produces while the previous instance is still
// tearing down; `closed` records that the caller honoured the documented
// lifecycle by closing the handle it owns.
let openFailures = 0
let openCalls = 0
let closed = 0
const domain = {
  table: () => table,
  close: async () => { closed += 1 },
}

const ctx = {
  // cordis calls the callback for its disposer and keeps it; the test does the
  // same so disposal (what a plugin toggle performs) can be simulated.
  effect: (callback, label) => {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push({ label: label ?? '(unlabelled)', dispose })
    return dispose
  },
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
  storageDomain: {
    open: async () => {
      openCalls += 1
      if (openFailures > 0) {
        openFailures -= 1
        const error = new Error('storage domain "task_ui" is already open or still closing')
        error.code = 'already-open'
        throw error
      }
      return domain
    },
  },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  jobs: { events: { subscribe: (filter, listener) => { subscribed = { filter, listener }; return () => {} } } },
  agents: { list: () => [] },
}

const host = await import(new URL('../lib/index.js', import.meta.url).href)
console.log(`module name          : ${host.name}`)
console.log(`inject               : ${JSON.stringify(host.inject)}`)

// The first three opens fail the way a plugin toggle does -- the previous
// instance's teardown has not released the name yet -- so everything below also
// proves apply() survives it.
openFailures = 3
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
// The boundary must be decidable. "one-shot answers" let a model file a repo
// analysis under "one exchange, so skip it"; the SHAPE of the request is what it
// has to key on instead.
check('section states a decidable skip boundary', sectionText('scope').includes('without looking anything up'))
check('section names analysis as multi-step', sectionText('scope').includes('count as multi-step'))
check('section lets a late start still record', sectionText('scope').includes('Already started'))
check('section drops the one-shot escape hatch', !sectionText('scope').includes('one-shot'))
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

check('task_add description states the same skip boundary', byName.task_add.description.includes('without looking anything up'))
check('task_add description covers a late start', byName.task_add.description.includes('already started'))
check('task_add description drops the one-shot escape hatch', !byName.task_add.description.includes('one-shot'))
check('task_add description states the delegation moment', byName.task_add.description.includes('before delegating'))
check('task_add requires the flow fields', byName.task_add.description.includes('steps'))
check('task_update description covers job linking', byName.task_update.description.includes('jobId'))
check('task_update description warns against stale entries', byName.task_update.description.includes('never moves'))
// The completion form lives in the skill too, but it is a correctness rule for
// the record, not a workflow detail: it must be reachable without loading the
// skill, because a model that never loads it is exactly who gets this wrong.
check('task_update description clears nextStep on completion', byName.task_update.description.includes('clear `nextStep`'))
check('task_update description keeps the flow as the record', byName.task_update.description.includes('every step `done`'))
check('task_update description records the outcome', byName.task_update.description.includes('write the outcome into `description`'))
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

// ---- just-in-time notes ----
// These are derived from the resulting record, not restated from the guidance,
// so they must stay silent when the record is right and name the specific gap
// when it is not. That is what makes them worth their tokens.
const bare = await byName.task_add.execute({ title: 'bare task' })
const bareId = bare.text.split(': ')[1].split(' ')[0]
console.log(`title-only create    : ${bare.text.split('\n')[1] ?? bare.text}`)
check('a title-only create is called out', bare.text.includes('created without'))
check('the note names the missing fields',
  bare.text.includes('`description`') && bare.text.includes('`progress`') && bare.text.includes('`steps`'))
await byName.task_delete.execute({ id: bareId })

const whole = await byName.task_add.execute({
  title: 'whole task',
  description: 'what it is',
  nextStep: 'the next thing',
  progress: { text: 'where it stands', percent: 0 },
  steps: [{ text: 'a step', state: 'current' }],
})
const wholeId = whole.text.split(': ')[1].split(' ')[0]
check('a complete create carries no note', !whole.text.includes('note:'))

const sloppy = await byName.task_update.execute({ id: wholeId, status: 'done' })
console.log('--- finishing while still advertising work ---')
console.log(sloppy.text)
check('finishing with a live nextStep is called out', sloppy.text.includes('`nextStep` is still'))
check('the note quotes the offending nextStep', sloppy.text.includes('the next thing'))
check('unfinished steps are called out too', sloppy.text.includes('still not `done`'))

// The empty-description branch on its own: a tidy record with no outcome.
const noOutcome = await byName.task_add.execute({
  title: 'no outcome',
  progress: { text: 'done already', percent: 100 },
  steps: [{ text: 'the only step', state: 'done' }],
})
const noOutcomeId = noOutcome.text.split(': ')[1].split(' ')[0]
const doneBare = await byName.task_update.execute({ id: noOutcomeId, status: 'done' })
check('an empty description is called out', doneBare.text.includes('`description` is empty'))
await byName.task_delete.execute({ id: noOutcomeId })

const tidy = await byName.task_update.execute({
  id: wholeId,
  nextStep: '',
  steps: [{ text: 'a step', state: 'done' }],
  description: 'the outcome',
})
check('a tidy completion carries no note', !tidy.text.includes('note:'))
await byName.task_delete.execute({ id: wholeId })

// ---- the operator manual rides the first library call of a session ----
// The skill is model-invoked, so a session that never calls the `skill` tool
// would never read it — and the moment it decides to use the library is exactly
// when it needs to know how.
const sessionA = { agent: { session: { id: 'session-a' } } }
const firstCall = await byName.task_list.execute({}, sessionA)
check('the first library call carries the manual', firstCall.text.includes('You have started using the global task library'))
check('the manual carries the skill body', firstCall.text.includes('全局任务库与监督面板'))
check('the front matter is stripped', !firstCall.text.includes('description: "Task UI'))

const secondCall = await byName.task_list.execute({}, sessionA)
check('the manual is delivered once per session', !secondCall.text.includes('You have started using the global task library'))

const otherSession = await byName.task_get.execute({ id: 'missing' }, { agent: { session: { id: 'session-b' } } })
check('another session is handed it too', otherSession.text.includes('You have started using the global task library'))

const noSession = await byName.task_list.execute({})
check('no session id means no manual', !noSession.text.includes('You have started using the global task library'))
console.log(`manual size          : ${(await byName.task_list.execute({}, { agent: { session: { id: 'session-c' } } })).text.length} chars, once per session`)

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

// ---- the toggle lifecycle ----
// `already-open` is transient ("open or still closing"), so apply() must retry it
// rather than let it escape: an unhandled rejection here crashed the whole app.
console.log(`storage opens        : ${openCalls} (3 injected already-open + 1 success)`)
check('apply() retried the transient already-open', openCalls === 4)
check('a retried open still yields a working table', rows.size >= 0)

// The documented lifecycle puts the handle on the caller, and closing it from
// our own effect is what stops the next apply() from racing the teardown.
const closeEffect = disposers.find((entry) => entry.label.includes('close the task_ui domain'))
check('a close-on-dispose effect is registered', closeEffect !== undefined)
closeEffect?.dispose()
await Promise.resolve()
console.log(`domains closed on dispose: ${closed}`)
check('disposing closes the owned domain handle', closed === 1)

// The same row, refreshed after boot, is no longer flagged: a live write means
// something is actually driving it.
rows.set('stale-1', { ...rows.get('stale-1'), updatedAt: Date.now() + 1000 })
const refreshed = await byName.task_get.execute({ id: 'stale-1' })
check('a post-boot write clears the warning', !refreshed.text.includes('warning:'))
rows.delete('stale-1')

// ---- route contention: the "enable" failure ----
// A host reloads plugins without awaiting the previous instance's disposal, and
// the web server rejects a duplicate (kind, path) by THROWING. A synchronous
// throw out of apply() is `dsh: fatal load failure` and takes the app down, so
// the routes are acquired tolerantly: retried past the collision, with the
// disposer owned by our own effect.
{
  const held = new Set()
  const acquired = []
  const disposers2 = []
  let pendingFailures = 2

  const contendedCtx = {
    effect: (callback, label) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers2.push({ label: label ?? '(unlabelled)', dispose })
      return dispose
    },
    on: () => {},
    tools: { register: () => () => {}, get: () => undefined },
    systemPrompt: { getSectionOrder: () => 2800, section: () => () => {} },
    storageDomain: { open: async () => ({ table: () => table, close: async () => {} }) },
    webServer: {
      register: (route) => {
        const key = `${route.kind} ${route.path}`
        // The previous instance still owns the path: exactly what the crash
        // report showed as `duplicate prefix route "/task-ui"`.
        if (pendingFailures > 0) {
          pendingFailures -= 1
          throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        }
        if (held.has(key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        held.add(key)
        acquired.push(key)
        return () => { held.delete(key) }
      },
    },
    jobs: { events: { subscribe: () => () => {} } },
    agents: { list: () => [] },
  }

  // Reaching the next line at all is the first assertion: apply() must not
  // propagate the throw, because the host treats that as fatal.
  host.apply(contendedCtx, {
    promptSection: true,
    jobStatusMap: { running: 'running', stopping: 'running', completed: 'done', killed: 'blocked', failed: 'failed' },
  })
  check('a contended route does not throw out of apply()', true)

  await new Promise((resolve) => { setTimeout(resolve, 600) })
  console.log(`routes after contention : ${JSON.stringify(acquired)}`)
  check('both routes were acquired after retrying', acquired.length === 2)

  const releaseApi = disposers2.find((entry) => entry.label.includes('/task-ui HTTP API'))
  check('the route disposer is owned by our own effect', releaseApi !== undefined)
  releaseApi?.dispose()
  check('disposing frees the prefix route', !held.has('prefix /task-ui'))
  check('live SSE streams are closed on dispose', disposers2.some((entry) => entry.label.includes('close live SSE streams')))
}

// ---- skill seeding ----
// Seeding used to be write-once, which left an upgraded plugin serving whatever
// manual the version that first ran had written. It now stamps what it wrote, so
// it can refresh a copy nobody touched and still never eat a hand-edited one.
{
  // A fresh stub context per apply: registering the same tool names twice into
  // one context would (correctly) collide.
  const stubCtx = () => ({
    effect: (callback) => callback(),
    on: () => {},
    tools: { register: () => () => {}, get: () => undefined },
    systemPrompt: { getSectionOrder: () => 2800, section: () => () => {} },
    storageDomain: { open: async () => ({ table: () => table, close: async () => {} }) },
    webServer: { register: () => () => {} },
    jobs: { events: { subscribe: () => () => {} } },
    agents: { list: () => [] },
  })
  const applyAgain = () => host.apply(stubCtx(), {
    promptSection: true,
    jobStatusMap: { running: 'running', stopping: 'running', completed: 'done', killed: 'blocked', failed: 'failed' },
  })

  check('seeds the skill when absent', existsSync(skillPath))
  const seeded = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : ''
  check('the seed carries a marker', seeded.startsWith('<!-- dsh-global-task-list seed'))
  check('the seed carries the body', seeded.includes('全局任务库与监督面板'))

  // Some earlier version's seed: valid marker, different body. Ours to update.
  const oldBody = '# an older manual\n'
  writeFileSync(skillPath, `<!-- dsh-global-task-list seed 0.0.1 sha256=${digestOf(oldBody)} -->\n${oldBody}`)
  applyAgain()
  check('refreshes a copy nobody edited', readFileSync(skillPath, 'utf8') === seeded)
  check('no sidecar when the file was ours', !existsSync(sidecarPath))

  // An install that predates the marker: identical body, no marker. Adopt it by
  // writing the marker alone, so it updates itself from here on.
  writeFileSync(skillPath, seeded.slice(seeded.indexOf('\n') + 1))
  applyAgain()
  check('adopts an unstamped copy that is already current', readFileSync(skillPath, 'utf8') === seeded)
  check('adoption writes no sidecar', !existsSync(sidecarPath))

  // A hand-edited file has no valid marker. Leave it, offer the new text beside.
  writeFileSync(skillPath, '# my own manual\n')
  applyAgain()
  check('never overwrites a hand-edited skill', readFileSync(skillPath, 'utf8') === '# my own manual\n')
  check('offers the newer text alongside', existsSync(sidecarPath) && readFileSync(sidecarPath, 'utf8').includes('全局任务库与监督面板'))
  console.log(`seed marker          : ${seeded.slice(0, 60)}…`)
}

console.log(failures === 0 ? '\nHOST: PASS' : `\nHOST: FAIL (${failures})`)
if (previousDshHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = previousDshHome
rmSync(seedHome, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
