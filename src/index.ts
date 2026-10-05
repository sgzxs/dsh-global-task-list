// dsh-global-task-list host half — task library CRUD + HTTP API + subagent job bridge.
// Loaded as a bundle patch row (see cordis.patch.yml). Runtime deps
// (@deepseek-ai/dsh-*) resolve from the profile node_modules chain.
// TS source of lib/index.js (built by tsdown.host.config.mjs); the type-only
// imports below also load each package's Context augmentation so ctx.jobs /
// ctx.agents / ctx.webServer / ctx.storageDomain type-check.
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
// Type-only: pulls the `ctx.jobs` Context augmentation without binding the
// service shape, which differs between DSH 0.1.x and 0.2.x (see JobFeed).
import type {} from '@deepseek-ai/dsh-jobs'
// Type-only: augments AssembleContext with `agent`, which the prompt section's
// text provider reads to tell a subagent from the session that spawned it.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import z from 'zod'

export const name = 'task-ui'

export const inject = ['tools', 'storageDomain', 'webServer', 'jobs', 'agents', 'systemPrompt']

const TASK_STATUSES = ['pending', 'running', 'done', 'blocked', 'failed'] as const
type TaskStatus = (typeof TASK_STATUSES)[number]

// Flow-node states for the panel's step flow: two plain frames (`done`, `todo`)
// and two highlighted ones (`current`, `next`).
const TASK_STEP_STATES = ['done', 'current', 'next', 'todo'] as const
type TaskStepState = (typeof TASK_STEP_STATES)[number]

// Global task library (ADR 0005): cross-session persistent.
const TASK_SCHEMA = z.object({
  title: z.string(),
  status: z.enum(TASK_STATUSES),
  description: z.string().default(''),
  // What the task will do next, and the ordered flow the detail card draws.
  // Optional and defaulted, so records written before these fields existed
  // still load: the domain re-validates every stored record on open, and a
  // defaulted member only ever relaxes that check. (The backend descriptor is
  // derived from the domain name, version, and table names — not the schemas —
  // so an added column needs no version bump.)
  nextStep: z.string().default(''),
  steps: z.array(z.object({
    text: z.string(),
    state: z.enum(TASK_STEP_STATES).default('todo'),
  })).default([]),
  parentId: z.string().nullable().default(null),
  dependsOn: z.array(z.string()).default([]),
  surface: z.record(z.string(), z.unknown()).nullable().default(null),
  progress: z.object({
    text: z.string(),
    percent: z.number().min(0).max(100).optional(),
  }).nullable().default(null),
  jobId: z.string().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
})
type TaskRecord = z.infer<typeof TASK_SCHEMA>
/** A stored record plus its KV key (the row shape the tools and API return). */
type TaskRow = TaskRecord & { id: string }

const domainSpec = defineDomain({
  name: 'task_ui',
  version: 1,
  tables: {
    tasks: domainTable(TASK_SCHEMA),
  },
})

// subagent job status -> task status. Configurable so a deployment can remap
// how background-job lifecycle states surface as task states.
interface JobStatusMap {
  running: string
  stopping: string
  completed: string
  killed: string
  failed: string
}
const DEFAULT_JOB_STATUS_MAP: JobStatusMap = {
  running: 'running',
  stopping: 'running',
  completed: 'done',
  killed: 'blocked',
  failed: 'failed',
}

/** The members this bridge reads from one background-job snapshot. */
interface JobStatusView {
  id: string
  status: string
}

/**
 * The background-job service members this bridge touches, stated structurally
 * because the service changed shape in DSH 0.2: 0.1.x exposes
 * `onJobsChanged(listener)` plus `list(ownerAgent)`, while 0.2.x replaces the
 * hook with an event hub (`events.subscribe`) and narrows `list` to take the
 * owner's session id. Reading members structurally keeps the plugin loading on
 * either runtime instead of failing at apply() on a removed method.
 */
interface JobFeed {
  /** Visible jobs for `caller` (0.1.x: the owner Agent; 0.2.x: its session id). */
  list: (caller: unknown) => JobStatusView[]
  /** 0.1.x change hook: fires with the owner Agent whose visible set changed. */
  onJobsChanged?: (listener: (owner: unknown) => void) => unknown
  /** 0.2.x event hub: every commit is delivered with the resulting job snapshot. */
  events?: { subscribe?: (filter: { owners: 'all' }, listener: (event: unknown) => void) => unknown }
}

/** Deployment-configurable plugin settings (schemastery schema). */
export interface Config {
  jobStatusMap: JobStatusMap
  /**
   * Whether to contribute the one-sentence task-library nudge to the system
   * prompt. On by default: the tool descriptions say when to use each tool, but
   * a model that never reaches for a tool never reads them, and this library is
   * user-visible state the model is expected to maintain.
   */
  promptSection: boolean
}
export const Config: Schema<Config> = Schema.object({
  jobStatusMap: Schema.object({
    running: Schema.string().default(DEFAULT_JOB_STATUS_MAP.running),
    stopping: Schema.string().default(DEFAULT_JOB_STATUS_MAP.stopping),
    completed: Schema.string().default(DEFAULT_JOB_STATUS_MAP.completed),
    killed: Schema.string().default(DEFAULT_JOB_STATUS_MAP.killed),
    failed: Schema.string().default(DEFAULT_JOB_STATUS_MAP.failed),
  }).default(DEFAULT_JOB_STATUS_MAP),
  promptSection: Schema.boolean().default(true),
})

/**
 * The system-prompt nudge. One sentence, in the register the harness's own
 * sections use: the obligation, the moment to act, and the boundary that keeps
 * it from becoming noise.
 *
 * It sits at the subagent tool's own order because this library's primary
 * workflow is "record the task, then delegate it" — reading the delegation
 * guidance first is the right order — and because resolving that named slot
 * keeps the placement right if the harness ever moves it.
 */
const PROMPT_SECTION = 'Record multi-step work in the global task library with `task_add` before starting it — always before delegating it to a subagent — keep it current with `task_update` as you work, and read it back with `task_get` before continuing what an earlier session started. Analyze/investigate/compare/implement/review requests, and anything the user calls a task, all count as multi-step; only a reply you can give without looking anything up is too small to record. Already started? Record it now.'

/**
 * The subagent variant. A subagent does not plan, delegate, or own the library:
 * it was handed one recorded task, so all it needs is the obligation to keep
 * that record true. Telling it when to create tasks would only invite it to
 * invent parallel ones its spawner cannot see.
 */
const PROMPT_SECTION_SUBAGENT = 'The task you were given is recorded in the global task library; keep that record current with `task_update` as you work — advance its `progress` and `steps` — and write the outcome into it when you finish, so the session that spawned you can follow along.'

/**
 * When this process loaded the plugin.
 *
 * The job registry is in-process, so a job linked to a task before this instant
 * cannot still be alive — which is the only available way to tell a task that is
 * genuinely running from one whose job died with a previous run. The `jobs`
 * service exposes no call that enumerates every owner's jobs (`list(caller)` is
 * filtered by owner), so a task's own timestamp is the signal.
 */
const BOOT_AT = Date.now()

/**
 * Whether a task claims to be running on a job that cannot exist any more. The
 * record does not otherwise say so, and a later session would read `running` as
 * "work is in flight" when nothing is.
 * @param task - the task row to inspect.
 * @returns true when the record's `running` status is unverified.
 */
function jobLinkStale(task: TaskRow): boolean {
  return task.jobId !== null && task.status === 'running' && task.updatedAt < BOOT_AT
}

/**
 * Render one task as the model reads it: what it is, where it stands, and how to
 * continue. This is the cross-session handoff path — the durable record carries
 * far more than `task_list` prints, and a later session has no other way to read
 * it — so it leads with the actionable state and ends with the background.
 * @param task - the task row to render.
 * @returns the task as multi-line text.
 */
function renderTask(task: TaskRow): string {
  const lines: string[] = [`[${task.status}] ${task.title}`, `id: ${task.id}`]
  // Qualify the status before the reader acts on it.
  if (jobLinkStale(task)) {
    lines.push(`warning: job ${String(task.jobId)} was linked in an earlier run and no longer exists, so "running" is unverified — check before continuing`)
  }

  if (task.progress !== null) {
    const percent = task.progress.percent === undefined ? '' : `${Math.round(task.progress.percent)}% — `
    lines.push(`progress: ${percent}${task.progress.text}`)
  }
  if (task.nextStep !== '') lines.push(`next: ${task.nextStep}`)

  if (task.steps.length > 0) {
    lines.push('steps:')
    for (const step of task.steps) lines.push(`  - [${step.state}] ${step.text}`)
  }
  if (task.dependsOn.length > 0) lines.push(`depends on: ${task.dependsOn.join(', ')}`)
  if (task.parentId !== null) lines.push(`parent: ${task.parentId}`)
  if (task.jobId !== null) lines.push(`job: ${task.jobId}`)
  if (task.description !== '') lines.push(`description: ${task.description}`)
  // `surface` is a document for the user's panel, not prose: say it exists
  // rather than dumping opaque JSON into the model's context.
  if (task.surface !== null) lines.push('surface: (generative-UI document; the user sees it in the panel)')
  lines.push(`created: ${new Date(task.createdAt).toISOString()}  updated: ${new Date(task.updatedAt).toISOString()}`)
  return lines.join('\n')
}

// Defensive on sync/async: storageDomain reads may be sync or async
// depending on backend; for-await and await both tolerate either.
async function listTasks(tasks: KvTable<string, TaskRecord>): Promise<TaskRow[]> {
  const rows: TaskRow[] = []
  for await (const [key, value] of tasks.entries()) {
    rows.push({ id: key, ...value })
  }
  rows.sort((a, b) => a.createdAt - b.createdAt)
  return rows
}

async function getTask(tasks: KvTable<string, TaskRecord>, id: string): Promise<TaskRow | undefined> {
  for await (const [key, value] of tasks.entries()) {
    if (key === id) return { id: key, ...value }
  }
  return undefined
}

/** Shared text output contract for the task_* tools. */
function textOutput(): {
  schema: {
    type: 'object'
    additionalProperties: false
    properties: { text: { type: 'string'; required: true } }
  }
  render: (_args: unknown, value: { text: string }) => ContentBlock[]
} {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', required: true } },
    },
    render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Marks a seeded skill file, so a later version can tell "we seeded this and
 * nobody has touched it" from "the user edited it".
 *
 * Shape: `<!-- dsh-global-task-list seed <version> sha256=<hex of the body> -->`
 * on the first line. The digest covers everything after the marker.
 */
const SEED_MARKER = /^<!-- dsh-global-task-list seed (\S+) sha256=([0-9a-f]{64}) -->\r?\n/

/** sha256 of a skill body, for the seed marker. */
function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Digest for seed comparisons, with line endings normalised.
 *
 * A copy written by this plugin has LF endings, but it may have passed through
 * an editor or a checkout since; normalising means a CRLF copy still matches the
 * digest we recorded for it.
 * @param text - the skill body.
 * @returns its sha256 over LF-normalised text.
 */
function seedDigest(text: string): string {
  return digestOf(text.replace(/\r\n/g, '\n'))
}

/**
 * Bodies this package shipped in `skills/task-ui/SKILL.md` and has since
 * replaced, newest first.
 *
 * These exist to recognise an **unstamped** copy as ours. Installations seeded
 * before the marker existed — every installation older than 0.2.8 — carry no
 * proof of provenance, and an old one's body does not match the current text
 * either, so without this list they would be indistinguishable from a
 * hand-edited file and would never be updated: exactly the users a fix should
 * reach. A digest here is proof the file is byte-for-byte what we shipped.
 *
 * Exported so the test can assert the real digests and exercise the branch; the
 * values are the sha256 of each released body, taken from this repository's own
 * history.
 */
export const SUPERSEDED_SEED_DIGESTS = new Set<string>([
  // 0.1.1 – 0.1.5: the original skill, 6,762 bytes. What most old installs have.
  'c13d545ff820efea1484373865b7a7aa3683bd2266a0ac7fe749d499ee979d47',
  // 0.2.0: nextStep documented, 10,904 bytes.
  '350871398ff35c522ecb8243edbd26d174b6247ee59654fefb472d0bd581606b',
  // 0.2.2: the completion form corrected, 11,325 bytes.
  '406653ee99d571b05ef308380c91e030bb93fa66a67eefa0a52daecd57876d04',
])

/** This package's own version, as installed — recorded in the marker so a user can see what seeded their copy. */
function packageVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    const version = (pkg as { version?: unknown }).version
    return typeof version === 'string' ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Keep the user-level `task-ui` skill in step with the copy this package ships.
 *
 * The file is seeded into `<dshHome>/skills/task-ui/SKILL.md` so every session
 * can load it. It used to be seeded **once** and never again, which meant an
 * upgraded plugin kept serving whatever skill text the version that first ran
 * had written — the model would load a months-old manual while the plugin
 * believed it had shipped a new one.
 *
 * So the file carries a marker recording what we wrote and a digest of it. On
 * each activation:
 *
 * - absent → seed it;
 * - marker matches its own digest → **nobody has edited it**, so replace it with
 *   this version's text;
 * - unstamped but a body this package shipped (`SUPERSEDED_SEED_DIGESTS`) or the
 *   current body → also ours, so adopt it or bring it forward;
 * - otherwise → leave it exactly as it is and drop this version's text beside it
 *   as `SKILL.md.new`, with a log line naming both paths. A hand-edited skill is
 *   the user's, and an install must never silently eat it.
 *
 * Fail-soft: any error only logs and never blocks plugin load.
 */
function installBundledSkill(): void {
  try {
    // `import.meta.url` is the built lib/index.js inside the installed package,
    // so ../skills/task-ui/SKILL.md is the packaged copy relative to lib/.
    const src = fileURLToPath(new URL('../skills/task-ui/SKILL.md', import.meta.url))
    if (!existsSync(src)) return
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const dir = join(dshHome, 'skills', 'task-ui')
    const dest = join(dir, 'SKILL.md')
    const body = readFileSync(src, 'utf8')
    const stamped = `<!-- dsh-global-task-list seed ${packageVersion()} sha256=${seedDigest(body)} -->\n${body}`

    if (!existsSync(dest)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(dest, stamped)
      console.log('[task-ui] seeded bundled skill ->', dest)
      return
    }

    const current = readFileSync(dest, 'utf8')
    if (current === stamped) return

    const marker = SEED_MARKER.exec(current)
    if (marker !== null && seedDigest(current.slice(marker[0].length)) === marker[2]) {
      writeFileSync(dest, stamped)
      console.log(`[task-ui] updated seeded skill ${marker[1]} -> ${packageVersion()}`)
      return
    }

    // Unstamped but already carrying exactly this package's text: every install
    // that predates the marker looks like this. Adopt it — the marker is the only
    // thing written, so no instruction text changes and no edit can be lost —
    // which is what lets it update itself from here on.
    if (marker === null && seedDigest(current) === seedDigest(body)) {
      writeFileSync(dest, stamped)
      console.log('[task-ui] adopted the existing skill copy (body already current); it updates in place from now on')
      return
    }

    // Unstamped and carrying a body this package shipped in an earlier release:
    // provably ours and unmodified, so bring it forward. Without this, everyone
    // who installed before 0.2.8 — the users a fix most needs to reach — would be
    // mistaken for someone who edited the file by hand.
    if (marker === null && SUPERSEDED_SEED_DIGESTS.has(seedDigest(current))) {
      writeFileSync(dest, stamped)
      console.log(`[task-ui] migrated a pre-marker seeded skill (${seedDigest(current).slice(0, 10)}) -> ${packageVersion()}`)
      return
    }

    // Unstamped and unrecognised, or stamped with a body that no longer matches
    // its own digest: treat it as the user's and never clobber. Offer the new
    // text alongside and say so.
    const sidecar = `${dest}.new`
    if (!existsSync(sidecar) || readFileSync(sidecar, 'utf8') !== stamped) writeFileSync(sidecar, stamped)
    console.log('[task-ui] left the existing skill in place (edited, or not a copy this package seeded); newer copy at', sidecar)
  } catch (error) {
    console.log('[task-ui] skill install error:', String(error))
  }
}

/** The stable `DomainError` code a storage-domain failure carries, when it has one. */
function domainErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Whether a failure means another instance of this plugin still holds a shared
 * resource, rather than a genuine misconfiguration.
 *
 * Two shapes, one cause: the storage facility's `already-open` ("the name is
 * open **or still closing**") and the web server's `duplicate <kind> route
 * "<path>"`. Both mean the previous instance's teardown has not finished yet.
 * @param error - the caught failure.
 * @returns true when the resource may free itself shortly.
 */
function isResourceContention(error: unknown): boolean {
  if (domainErrorCode(error) === 'already-open') return true
  const message = error instanceof Error ? error.message : ''
  return message.includes('duplicate') && message.includes('route')
}

/**
 * Take a process-global resource, tolerating the window in which a previous
 * instance of this plugin still holds it.
 *
 * A host reloads plugins without awaiting the old instance's disposal, so a
 * toggle re-runs `apply()` while the old routes and domain are still held. Both
 * `WebServer.register` and `DomainFacility.open` reject a collision by
 * **throwing**, and the crash log is unambiguous about the consequence: a
 * synchronous throw out of `apply()` is `dsh: fatal load failure`, which takes
 * the whole application down. So this retries that one class of failure and, if
 * the resource never frees, reports it and carries on with the plugin loaded but
 * degraded — a panel without its HTTP API is a far better outcome than an app
 * that will not start.
 *
 * The disposer is owned by our own `ctx.effect`: that is what actually releases
 * the resource, and leaving it to the host's asynchronous teardown is precisely
 * what makes the next instance collide in the first place.
 * @param ctx - plugin context that owns the resource's lifetime.
 * @param label - resource name, used for the disposer label and the give-up log.
 * @param acquire - performs the registration and returns its disposer.
 * @param attempts - how many times to retry a contended acquisition.
 */
function acquireTolerantly(ctx: Context, label: string, acquire: () => () => void, attempts = 8): void {
  let release: (() => void) | undefined
  let cancelled = false
  ctx.effect(() => () => {
    cancelled = true
    release?.()
  }, `task-ui: release ${label}`)

  const attempt = (remaining: number): void => {
    try {
      const disposer = acquire()
      // Disposed while this acquisition was retrying: release immediately rather
      // than leave the resource held by a plugin that is already gone.
      if (cancelled) disposer()
      else release = disposer
    } catch (error) {
      if (remaining > 0 && isResourceContention(error)) {
        setTimeout(() => { attempt(remaining - 1) }, 50)
        return
      }
      console.log(`[task-ui] ${label} unavailable:`, String(error))
    }
  }
  attempt(attempts)
}

/**
 * Open the task domain, tolerating the one transient failure its lifecycle
 * defines.
 *
 * `already-open` means the name is open **or still closing**. A host reloads
 * plugins without awaiting the previous instance's disposal, so a toggle lands
 * here legitimately: the name frees only once teardown completes. That makes a
 * short bounded retry the correct handling and a hard failure a bug — letting
 * it escape took the whole application down.
 * @param ctx - plugin context carrying the storage facility.
 * @param spec - the domain spec to open.
 * @returns the opened domain handle.
 */
async function openTaskDomain(ctx: Context, spec: typeof domainSpec) {
  const attempts = 8
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await ctx.storageDomain.open(spec)
    } catch (error) {
      if (attempt >= attempts || !isResourceContention(error)) throw error
      // Teardown is short; back off just enough for it to finish.
      await new Promise((resolve) => { setTimeout(resolve, 25 * attempt) })
    }
  }
}

/**
 * Just-in-time note for a task that was just created, derived from the record
 * rather than restated from the guidance.
 *
 * The fields are optional in the schema, so a model can create a title-only
 * entry; the panel then has nothing to draw beyond a fallback node. Saying so in
 * the tool result costs nothing until it happens, and names exactly what THIS
 * record is missing.
 * @param task - the task as written.
 * @returns the note block, or '' when the record carries everything it should.
 */
function creationNotes(task: TaskRecord): string {
  const missing: string[] = []
  if (task.description === '') missing.push('`description`')
  if (task.progress === null) missing.push('`progress`')
  if (task.steps.length === 0) missing.push('`steps`')
  if (missing.length === 0) return ''
  return `\nnote: created without ${missing.join(', ')}. The panel can only draw what the record carries — fill these in with \`task_update\` now.`
}

/**
 * Just-in-time note for a task that was just marked done, derived from the
 * resulting record.
 *
 * Finishing rules live in this tool's description and in the bundled skill, but
 * a model that never loads the skill is exactly the one that leaves the record
 * half-finished — so report the specific inconsistency at the moment it is
 * created, instead of repeating the rule every time.
 * @param task - the task as it now stands.
 * @returns the note block, or '' when the finished record is consistent.
 */
function completionNotes(task: TaskRecord): string {
  if (task.status !== 'done') return ''
  const problems: string[] = []
  if (task.nextStep !== '') {
    problems.push(`\`nextStep\` is still ${JSON.stringify(task.nextStep)} — a finished task that still advertises a next action misleads whoever picks it up, so clear it`)
  }
  const outstanding = task.steps.filter((step) => step.state !== 'done')
  if (outstanding.length > 0) {
    problems.push(`${outstanding.length} step(s) are still not \`done\` (${outstanding.map((step) => JSON.stringify(step.text)).join(', ')}) and will read as outstanding — mark them done to keep the flow as the record of what was actually done`)
  }
  if (task.description === '') problems.push('`description` is empty — write the outcome there')
  if (problems.length === 0) return ''
  return `\nnote: marked done, but the record is incomplete — ${problems.join('; ')}.`
}

/** Sessions already handed the library's operator manual. */
const manualDelivered = new Set<string>()

/** The bundled skill body, read once. */
let manualBody: string | undefined

/**
 * The operator manual, read from this package's own bundled skill.
 *
 * Read from disk rather than through `ctx.skills` on purpose: this plugin runs
 * on the host plane while the skill providers are mounted per agent preset, so a
 * host lookup can miss the catalog a session actually sees. The bundled file is
 * the same content we ship and seed, and it is always next to `lib/`.
 * @returns the skill body without its front matter, or '' when unreadable.
 */
function operatorManual(): string {
  if (manualBody !== undefined) return manualBody
  try {
    const src = fileURLToPath(new URL('../skills/task-ui/SKILL.md', import.meta.url))
    const raw = existsSync(src) ? readFileSync(src, 'utf8') : ''
    // The `---` block is catalog metadata (name/description), not instruction.
    manualBody = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
  } catch {
    manualBody = ''
  }
  return manualBody
}

/**
 * Hand a session the operator manual the first time it uses the library.
 *
 * The skill is model-invoked, so a model that never calls the `skill` tool never
 * reads it — and the moment it decides to use the library is precisely when it
 * needs to know how. Attaching the body to the first tool result of a session
 * costs nothing until then, lands in the same turn (a system-prompt section
 * could only take effect on the next request), and appends to the conversation
 * instead of touching the cached prompt prefix. Once per session: after that the
 * text is already in history.
 * @param exec - the tool execution context, which carries the calling agent.
 * @param text - the result text to extend.
 * @returns the result text, with the manual appended the first time.
 */
function withManual(exec: unknown, text: string): string {
  const sessionId = (exec as { agent?: { session?: { id?: unknown } } } | undefined)?.agent?.session?.id
  if (typeof sessionId !== 'string' || manualDelivered.has(sessionId)) return text
  const manual = operatorManual()
  if (manual === '') return text
  manualDelivered.add(sessionId)
  return `${text}\n\n---\n\nYou have started using the global task library, so here is how to use it well. This is the bundled \`task-ui\` skill; read it once and follow it for the rest of this session.\n\n${manual}`
}

export function apply(ctx: Context, config: Config): void {
  // The patch row carries an explicit `config:` block, so the loader always
  // passes a validated config object here (schemastery fills schema defaults).
  const jobStatusMap = config.jobStatusMap
  // The version is logged because "which build am I actually running?" is not
  // otherwise answerable: a marketplace can show one version while a package
  // manager resolves another (an exact pin, a lockfile, or a registry that
  // answered from a lagging mirror), and nothing reconciles the two.
  console.log(`[task-ui] host plugin loaded v${packageVersion()}`)
  installBundledSkill()

  // `DomainFacility.open` documents that the CALLER owns the handle and closes
  // it via `Domain.close()`, typically from its own `ctx.effect` disposer.
  // Relying on the facility's fallback (it closes whatever is left open when it
  // unmounts) is what made disabling this plugin crash the app: that fallback is
  // asynchronous, the name stays reserved until it finishes, and the next
  // apply() ran inside that window and failed with `already-open`.
  let handle: { close: () => Promise<void> } | undefined
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    if (handle !== undefined) void handle.close()
  }, 'task-ui: close the task_ui domain')

  // Lazy-open: keep apply() sync (no official dsh-* plugin uses async apply; the
  // loader does not await it). Tools await the same promise on execute.
  const tasksPromise: Promise<KvTable<string, TaskRecord>> = openTaskDomain(ctx, domainSpec).then((domain) => {
    if (disposed) {
      // Disposed while the open was in flight: close it rather than reserve the
      // name for a plugin that is already gone.
      void domain.close()
      throw new Error('[task-ui] disposed while opening the task_ui domain')
    }
    handle = domain
    return domain.table('tasks')
  })
  // Without this the rejection surfaces as an unhandled promise rejection, which
  // the host treats as fatal. Tool and HTTP callers await the same promise and
  // still see the failure.
  void tasksPromise.catch(() => {})

  // ---- subagent job bridge: auto-sync job status -> task status ----
  // The jobs service changed shape in DSH 0.2, so this bridge feature-detects
  // the newer event hub and falls back to the older change hook. Both paths
  // funnel into the same write, so the library behaves identically either way:
  //
  //   0.2.x — `jobs.events.subscribe({ owners: 'all' }, listener)`; every
  //           commit (registered / progress / settled) carries the resulting
  //           job snapshot, so no follow-up lookup is needed. Its `settled`
  //           event is what advances a linked task to a terminal state. Note
  //           `jobs.list(caller)` also narrowed there: `caller` is the owner's
  //           session id, not the Agent handle 0.1.x expected.
  //   0.1.x — `jobs.onJobsChanged(listener)`; the listener receives the owner
  //           Agent whose visible set changed, and that handle is the
  //           authorization key for `ctx.jobs.list(owner)`.
  const jobFeed = ctx.jobs as unknown as JobFeed
  let syncing = false

  // Only tasks already linked to a job auto-advance. Tasks are created
  // explicitly by the master agent (task_add), never auto-registered from
  // arbitrary background jobs (npm/build commands would pollute the library
  // with command-noise titles).
  const applyJobStatus = async (jobId: string, jobStatus: string): Promise<void> => {
    // Read through the table's own entries rather than indexing by the raw
    // string: a job lifecycle state outside the configured set is a no-op, not
    // an error, and this keeps that intent type-safe.
    const mapped = Object.entries(jobStatusMap).find(([key]) => key === jobStatus)?.[1]
    if (mapped === undefined) return
    const tasks = await tasksPromise
    for await (const [key, value] of tasks.entries()) {
      if (value.jobId !== jobId) continue
      if (value.status !== mapped) {
        await tasks.put(key, { ...value, status: mapped as TaskStatus, updatedAt: Date.now() })
      }
    }
  }

  // Serialized: a burst of job events must not interleave two read-modify-write
  // passes over the same task table (the 0.1.x flag is kept for both paths).
  const runSync = async (work: () => Promise<void>): Promise<void> => {
    if (syncing) return
    syncing = true
    try {
      await work()
    } catch (error) {
      console.log('[task-ui] job sync error:', String(error))
    } finally {
      syncing = false
    }
  }

  /** 0.1.x path: re-read the owner's visible jobs, then sync each snapshot. */
  const syncFromJobs = (owner: unknown): Promise<void> => runSync(async () => {
    let snapshots: JobStatusView[]
    try {
      snapshots = jobFeed.list(owner)
    } catch {
      return // caller without a readable owner set — nothing to sync
    }
    for (const snap of snapshots) await applyJobStatus(snap.id, snap.status)
  })

  const jobEvents = jobFeed.events
  if (typeof jobEvents?.subscribe === 'function') {
    // 0.2.x: the event already names the changed job, so sync straight off it.
    jobEvents.subscribe({ owners: 'all' }, (event) => {
      const job = (event as { job?: { id?: unknown; status?: unknown } }).job
      if (typeof job?.id !== 'string' || typeof job.status !== 'string') return
      const { id, status } = job
      // fire-and-forget; serialized by runSync
      void runSync(() => applyJobStatus(id, status))
    })
  } else if (typeof jobFeed.onJobsChanged === 'function') {
    jobFeed.onJobsChanged((owner) => {
      if (owner === undefined) return
      // fire-and-forget; serialized by runSync
      void syncFromJobs(owner)
    })
  } else {
    // The task library is the plugin's core; a runtime with no job change feed
    // loses only the automatic status link, never the panel or the tools.
    console.log('[task-ui] jobs service exposes no change feed; job status sync disabled')
  }

  // ---- HTTP API for the client panel (same-origin fetch + poll) ----
  acquireTolerantly(ctx, 'the /task-ui HTTP API', () => ctx.webServer.register({
    kind: 'prefix',
    path: '/task-ui',
    handler: async (req, res) => {
      const url = req.url ?? ''
      try {
        const tasks = await tasksPromise
        if (req.method === 'GET' && url === '/task-ui/tasks') {
          const rows = await listTasks(tasks)
          // `jobStale` is derived per process, so it is computed here rather than
          // stored: it depends on when this process started.
          return sendJson(res, 200, { tasks: rows.map((row) => ({ ...row, jobStale: jobLinkStale(row) })) })
        }
        if (req.method === 'POST' && url === '/task-ui/status') {
          const body = await readJsonBody(req)
          if (body === undefined || typeof body.id !== 'string' || !TASK_STATUSES.includes(body.status)) {
            return sendJson(res, 400, { error: 'id and a valid status are required' })
          }
          const task = await getTask(tasks, body.id)
          if (task === undefined) return sendJson(res, 404, { error: 'task not found' })
          await tasks.put(body.id, { ...task, status: body.status, updatedAt: Date.now() })
          return sendJson(res, 200, { ok: true })
        }
        if (req.method === 'POST' && url === '/task-ui/delete') {
          const body = await readJsonBody(req)
          if (body === undefined || typeof body.id !== 'string') {
            return sendJson(res, 400, { error: 'id is required' })
          }
          const task = await getTask(tasks, body.id)
          if (task === undefined) return sendJson(res, 404, { error: 'task not found' })
          await tasks.delete(body.id)
          return sendJson(res, 200, { ok: true })
        }
        if (req.method === 'POST' && url === '/task-ui/ask') {
          // Generative loop: queue a user turn on the master agent.
          const body = await readJsonBody(req)
          if (body === undefined || typeof body.message !== 'string') {
            return sendJson(res, 400, { error: 'message is required' })
          }
          const agents = ctx.agents.list()
          // Master agents are those whose session header is not marked as a
          // subagent. `origin` lives directly on SessionHeader (the old
          // `header.meta?.origin` read was a dead field — `.meta` is always
          // undefined at runtime, which made every agent look like a master).
          const masters = agents.filter((a) => a.session.header.origin !== 'subagent')
          const pool = masters.length > 0 ? masters : agents
          const target = pool.find((a) => a.status === 'idle') ?? pool[0]
          if (target === undefined) return sendJson(res, 409, { error: 'no live agent to ask' })
          target.followup(createUserMessage({
            content: [{ type: 'text', text: body.message }],
            source: { kind: 'user' },
          }))
          return sendJson(res, 200, { ok: true })
        }
        return sendJson(res, 404, { error: 'unknown task-ui route' })
      } catch (error) {
        console.log('[task-ui] api error:', String(error))
        return sendJson(res, 500, { error: String(error) })
      }
    },
  }))

  // ---- SSE push for the client panel ----
  // /task-ui/events: Server-Sent Events channel. The panel subscribes here
  // and refreshes on task_ui domain changes instead of polling. Frames carry
  // no payload — the client re-fetches GET /task-ui/tasks on notification.
  const connections = new Set<ServerResponse>()

  const connect = (res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    })
    // Comment line on open so clients/proxies see a live channel even before
    // the first change; EventSource frame parsing skips it naturally.
    res.write(': connected\n\n')
    connections.add(res)
    res.on('close', () => { connections.delete(res) })
  }

  acquireTolerantly(ctx, 'the /task-ui/events SSE channel', () => ctx.webServer.register({
    kind: 'exact',
    path: '/task-ui/events',
    handler: (req, res) => {
      // Exact routes match ahead of the /task-ui prefix carrier; keep the
      // carrier's method-gate semantics for non-GET hits on this endpoint.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      connect(res)
    },
  }))

  // A disposed plugin that keeps an EventSource open leaves the panel waiting on
  // a channel nothing will ever write to, so end live streams with the plugin.
  ctx.effect(() => () => {
    for (const res of connections) {
      try { res.end() } catch { /* the socket may already be gone */ }
    }
    connections.clear()
  }, 'task-ui: close live SSE streams')

  ctx.on('domain/changed', (change) => {
    // Only the task_ui domain drives panel refreshes; every durable write
    // (task_add/update/delete, job-status sync) lands here after commit.
    if (change.domain !== 'task_ui') return
    const frame = 'data: ' + JSON.stringify({ type: 'tasks-changed' }) + '\n\n'
    // Guard per-connection writes: a dead channel must not throw out of the
    // listener and suppress later domain/changed observers (the facility
    // contains listener failures, but containment here is cheaper).
    for (const res of connections) {
      try {
        res.write(frame)
      } catch {
        connections.delete(res)
      }
    }
  })

  // ---- system-prompt nudge ----
  // The tool descriptions below carry the when-and-how, which is how the
  // harness's own `todo_write` drives itself. That only reaches a model that
  // reaches for a tool, though, and this library is user-visible state the model
  // is expected to maintain on its own — so it also gets one always-on sentence,
  // silenced wherever the tools are not actually callable in that scope.
  if (config.promptSection) {
    acquireTolerantly(ctx, 'the task-ui prompt section', () => ctx.systemPrompt.section({
      name: 'task-ui:library',
      order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
      text: (assembly) => {
        if (ctx.tools.get('task_add', assembly.scope) === undefined) return ''
        return assembly.agent?.session.header.origin === 'subagent' ? PROMPT_SECTION_SUBAGENT : PROMPT_SECTION
      },
    }))
  }

  // ---- model-facing tools ----
  //
  // Every registration from here on is tolerantly acquired for the same reason
  // the routes are: each one is a scope-global name, so a reload that lands
  // before the previous instance released it collides, and a synchronous throw
  // out of apply() is a fatal load failure. Retrying recovers the tool as soon
  // as the old fiber finishes; the alternative is a plugin that took the app
  // down to avoid a name clash.
  //
  // Each result also passes through `withManual`, which hands the session the
  // operator manual on its first library call. Wrapping the registration rather
  // than the six return statements keeps that in one place.
  const registerTool = (definition: Parameters<typeof ctx.tools.register>[0]): void => {
    const inner = definition.execute
    const delivered: typeof definition = {
      ...definition,
      execute: async (...callArgs: Parameters<typeof inner>) => {
        const result = await inner(...callArgs)
        if (typeof result !== 'object' || result === null || !('text' in result)) return result
        return { ...result, text: withManual(callArgs[1], String((result as { text: unknown }).text)) }
      },
    } as typeof definition
    acquireTolerantly(ctx, `the ${definition.name} tool`, () => ctx.tools.register(delivered))
  }

  registerTool(defineTool({
    name: 'taskui_probe',
    description: 'Report the task-library plugin\'s host status, its installed version, and the current task count.',
    parameters: {},
    output: textOutput(),
    async execute() {
      const rows = await listTasks(await tasksPromise)
      return { text: `[task-ui] v${packageVersion()} host alive, tasks=${rows.length}` }
    },
  }))

  registerTool(defineTool({
    name: 'task_list',
    description: 'List every task in the global task library as one triage line each: `- [status] title (id[, job=...]) — next: ...`. Read it before creating entries so you do not duplicate one, whenever the state may have moved (the user, another session, or a subagent can all change it), and when you pick up work recorded earlier. Then call `task_get` for the one task you are about to work on: the list is deliberately short, and the full record lives there.',
    parameters: {},
    output: textOutput(),
    async execute() {
      const rows = await listTasks(await tasksPromise)
      if (rows.length === 0) return { text: '(no tasks)' }
      return {
        text: rows.map((r) => {
          const next = r.nextStep === '' ? '' : ` — next: ${r.nextStep}`
          const job = r.jobId === null ? '' : `, job=${r.jobId}${jobLinkStale(r) ? ' [expired]' : ''}`
          return `- [${r.status}] ${r.title} (${r.id}${job})${next}`
        }).join('\n'),
      }
    },
  }))

  registerTool(defineTool({
    name: 'task_get',
    description: 'Read ONE task from the global task library in full: what it is, where it stands, and how to continue — description, progress, the whole step flow, next step, dependencies, linked job, and timestamps. Call it before continuing work another session or an earlier turn started, so you resume from what is actually recorded instead of re-deriving it.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id (from `task_list`).' },
    },
    output: textOutput(),
    async execute(args) {
      const task = await getTask(await tasksPromise, args.id)
      if (task === undefined) return { text: `task not found: ${args.id}` }
      return { text: renderTask(task) }
    },
  }))

  registerTool(defineTool({
    name: 'task_add',
    description: 'Record a task in the global task library — a persistent list shared across sessions and drawn in the user\'s panel — to plan multi-step work and show progress. Create the entry BEFORE you start the work, and always before delegating it to a subagent; if you have already started, create it now rather than not at all. Analyze, investigate, compare, implement, and review requests — and anything the user calls a task — count as multi-step; only skip a reply you can give without looking anything up. Fill `description`, `progress` and `steps` on creation: `progress` is where it stands now, `nextStep` what happens next, and `steps` is the ordered `[{ text, state }]` flow the panel draws (state `done` / `current` / `next` / `todo`). Never create a title-only entry.',
    parameters: {
      title: { type: 'string', required: true, description: 'Task title.' },
      description: { type: 'string', description: 'Optional description.' },
      nextStep: { type: 'string', description: 'Optional next action for this task, shown in the panel detail view.' },
      steps: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Optional ordered flow for the panel detail view: [{ text, state }], state one of done|current|next|todo. done/todo render in the plain frame; current and next each get a highlighted one.',
      },
      parentId: { type: 'string', description: 'Optional parent task id.' },
      dependsOn: { type: 'array', items: { type: 'string' }, description: 'Optional dependency task ids.' },
      surface: { type: 'object', additionalProperties: true, description: 'Optional task-surface document (structured JSON rendered by the panel).' },
      progress: { type: 'object', additionalProperties: true, description: 'Optional progress: { text, percent? }.' },
    },
    output: textOutput(),
    async execute(args) {
      const now = Date.now()
      const id = crypto.randomUUID()
      const tasks = await tasksPromise
      // `progress`, `surface` and `steps` arrive as unvalidated JSON from the
      // model; the durable zod boundary validates them on write, so the casts
      // document that trusted schema seam.
      await tasks.put(id, {
        title: args.title,
        status: 'pending',
        description: args.description ?? '',
        nextStep: args.nextStep ?? '',
        steps: (args.steps ?? []) as TaskRecord['steps'],
        parentId: args.parentId ?? null,
        dependsOn: args.dependsOn ?? [],
        surface: args.surface ?? null,
        progress: (args.progress ?? null) as TaskRecord['progress'],
        jobId: null,
        createdAt: now,
        updatedAt: now,
      })
      const created = await getTask(tasks, id)
      return { text: `task added: ${id} — ${args.title}${created === undefined ? '' : creationNotes(created)}` }
    },
  }))

  registerTool(defineTool({
    name: 'task_update',
    description: 'Advance one task in the global task library. While the task is in flight, keep its `progress` and `steps` current — mark finished steps `done`, the live one `current`, the next one `next` — and rewrite `nextStep`; an entry that never moves is worse than none. When you delegate the task to a subagent, link the spawned job with `jobId` and set status `running`, and its terminal status follows that job automatically. Mark it `done` as soon as it is finished, and finish it properly: clear `nextStep`, since a finished task that still advertises a next action misleads whoever picks it up next; leave `steps` in place with every step `done`, since that sequence is the record of what was actually done; and write the outcome into `description`.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      title: { type: 'string', description: 'New title.' },
      status: { type: 'string', enum: TASK_STATUSES, description: 'New status.' },
      description: { type: 'string', description: 'New description.' },
      nextStep: { type: 'string', description: 'New next action, shown in the panel detail view.' },
      steps: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'New ordered flow for the panel detail view: [{ text, state }], state one of done|current|next|todo. Keep finished steps as done, the live one as current, and the following one as next.',
      },
      parentId: { type: 'string', description: 'New parent task id.' },
      dependsOn: { type: 'array', items: { type: 'string' }, description: 'New dependency task ids.' },
      surface: { type: 'object', additionalProperties: true, description: 'Optional task-surface document (structured JSON rendered by the panel).' },
      progress: { type: 'object', additionalProperties: true, description: 'New progress: { text, percent? }.' },
      jobId: { type: 'string', description: 'Job id of the subagent working on this task.' },
    },
    output: textOutput(),
    async execute(args) {
      const tasks = await tasksPromise
      const task = await getTask(tasks, args.id)
      if (task === undefined) return { text: `task not found: ${args.id}` }
      // Rebuild the record field by field (instead of spreading the optional
      // patch) so every member keeps its exact TaskRecord type under strict
      // TS; the outcome matches the original `{ ...task, ...patch }` merge.
      const { id: _drop, ...patch } = args
      const next: TaskRecord = {
        title: patch.title ?? task.title,
        status: patch.status ?? task.status,
        description: patch.description ?? task.description,
        nextStep: patch.nextStep ?? task.nextStep,
        steps: (patch.steps ?? task.steps) as TaskRecord['steps'],
        parentId: patch.parentId ?? task.parentId,
        dependsOn: patch.dependsOn ?? task.dependsOn,
        surface: patch.surface ?? task.surface,
        progress: (patch.progress ?? task.progress) as TaskRecord['progress'],
        jobId: patch.jobId ?? task.jobId,
        createdAt: task.createdAt,
        updatedAt: Date.now(),
      }
      await tasks.put(args.id, next)
      return { text: `task updated: ${args.id}${completionNotes(next)}` }
    },
  }))

  registerTool(defineTool({
    name: 'task_delete',
    description: 'Delete one task from the global task library. Prefer marking a task `done` or `blocked` over deleting it: the library is the record of what was already done, and the user may still want that history.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
    },
    output: textOutput(),
    async execute(args) {
      const tasks = await tasksPromise
      const task = await getTask(tasks, args.id)
      if (task === undefined) return { text: `task not found: ${args.id}` }
      await tasks.delete(args.id)
      return { text: `task deleted: ${args.id}` }
    },
  }))
}
