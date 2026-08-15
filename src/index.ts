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
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import Schema from '@deepseek-ai/schemastery'
import z from 'zod'

export const name = 'task-ui'

export const inject = ['tools', 'storageDomain', 'webServer', 'jobs', 'agents']

const TASK_STATUSES = ['pending', 'running', 'done', 'blocked', 'failed'] as const
type TaskStatus = (typeof TASK_STATUSES)[number]

// Global task library (ADR 0005): cross-session persistent.
const TASK_SCHEMA = z.object({
  title: z.string(),
  status: z.enum(TASK_STATUSES),
  description: z.string().default(''),
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

/** Deployment-configurable plugin settings (schemastery schema). */
export interface Config {
  jobStatusMap: JobStatusMap
}
export const Config: Schema<Config> = Schema.object({
  jobStatusMap: Schema.object({
    running: Schema.string().default(DEFAULT_JOB_STATUS_MAP.running),
    stopping: Schema.string().default(DEFAULT_JOB_STATUS_MAP.stopping),
    completed: Schema.string().default(DEFAULT_JOB_STATUS_MAP.completed),
    killed: Schema.string().default(DEFAULT_JOB_STATUS_MAP.killed),
    failed: Schema.string().default(DEFAULT_JOB_STATUS_MAP.failed),
  }).default(DEFAULT_JOB_STATUS_MAP),
})

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

export function apply(ctx: Context, config: Config): void {
  // The patch row carries an explicit `config:` block, so the loader always
  // passes a validated config object here (schemastery fills schema defaults).
  const jobStatusMap = config.jobStatusMap
  console.log('[task-ui] host plugin loaded')
  // Lazy-open: keep apply() sync (no official dsh-* plugin uses async apply;
  // the loader does not await it). Tools await the same promise on execute.
  const domainPromise = ctx.storageDomain.open(domainSpec)
  const tasksPromise: Promise<KvTable<string, TaskRecord>> = domainPromise.then((domain) => domain.table('tasks'))

  // ---- subagent job bridge: auto-sync job status -> task status ----
  // onJobsChanged passes the owner Agent whose visible set changed; the
  // owner handle is the authorization key for ctx.jobs.list().
  let syncing = false
  const syncFromJobs = async (owner: Agent | undefined): Promise<void> => {
    if (syncing) return
    syncing = true
    try {
      const tasks = await tasksPromise
      let snapshots: JobSnapshot[]
      try {
        snapshots = ctx.jobs.list(owner)
      } catch {
        return // caller without a readable owner set — nothing to sync
      }
      for (const snap of snapshots) {
        const mapped = jobStatusMap[snap.status]
        if (mapped === undefined) continue
        // Only tasks already linked to a job auto-advance. Tasks are created
        // explicitly by the master agent (task_add), never auto-registered
        // from arbitrary background jobs (npm/build commands would pollute
        // the library with command-noise titles).
        for await (const [key, value] of tasks.entries()) {
          if (value.jobId !== snap.id) continue
          if (value.status !== mapped) {
            await tasks.put(key, { ...value, status: mapped as TaskStatus, updatedAt: Date.now() })
          }
        }
      }
    } catch (error) {
      console.log('[task-ui] job sync error:', String(error))
    } finally {
      syncing = false
    }
  }
  ctx.jobs.onJobsChanged((owner) => {
    if (owner === undefined) return
    // fire-and-forget; serialized by the syncing flag
    void syncFromJobs(owner)
  })

  // ---- HTTP API for the client panel (same-origin fetch + poll) ----
  ctx.webServer.register({
    kind: 'prefix',
    path: '/task-ui',
    handler: async (req, res) => {
      const url = req.url ?? ''
      try {
        const tasks = await tasksPromise
        if (req.method === 'GET' && url === '/task-ui/tasks') {
          const rows = await listTasks(tasks)
          return sendJson(res, 200, { tasks: rows })
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
  })

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

  ctx.webServer.register({
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
  })

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

  // ---- model-facing tools ----
  ctx.tools.register(defineTool({
    name: 'taskui_probe',
    description: 'Task UI spike probe: reports plugin status and current task count.',
    parameters: {},
    output: textOutput(),
    async execute() {
      const rows = await listTasks(await tasksPromise)
      return { text: `[task-ui] host alive, tasks=${rows.length}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'task_list',
    description: 'List all tasks in the global task library (id, status, title, jobId).',
    parameters: {},
    output: textOutput(),
    async execute() {
      const rows = await listTasks(await tasksPromise)
      if (rows.length === 0) return { text: '(no tasks)' }
      return { text: rows.map((r) => `- [${r.status}] ${r.title} (${r.id}${r.jobId ? ', job=' + r.jobId : ''})`).join('\n') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'task_add',
    description: 'Add a task to the global task library.',
    parameters: {
      title: { type: 'string', required: true, description: 'Task title.' },
      description: { type: 'string', description: 'Optional description.' },
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
      // `progress` arrives as an unvalidated JSON object from the model; the
      // durable zod boundary validates it on write, so the cast documents the
      // trusted schema seam (same for surface, which needs no cast).
      await tasks.put(id, {
        title: args.title,
        status: 'pending',
        description: args.description ?? '',
        parentId: args.parentId ?? null,
        dependsOn: args.dependsOn ?? [],
        surface: args.surface ?? null,
        progress: (args.progress ?? null) as TaskRecord['progress'],
        jobId: null,
        createdAt: now,
        updatedAt: now,
      })
      return { text: `task added: ${id} — ${args.title}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'task_update',
    description: 'Update a task. After spawning a subagent for a task, link it with its job id and set status running so the panel auto-syncs.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      title: { type: 'string', description: 'New title.' },
      status: { type: 'string', enum: TASK_STATUSES, description: 'New status.' },
      description: { type: 'string', description: 'New description.' },
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
        parentId: patch.parentId ?? task.parentId,
        dependsOn: patch.dependsOn ?? task.dependsOn,
        surface: patch.surface ?? task.surface,
        progress: (patch.progress ?? task.progress) as TaskRecord['progress'],
        jobId: patch.jobId ?? task.jobId,
        createdAt: task.createdAt,
        updatedAt: Date.now(),
      }
      await tasks.put(args.id, next)
      return { text: `task updated: ${args.id}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'task_delete',
    description: 'Delete a task from the global task library.',
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
