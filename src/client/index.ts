/**
 * dsh-global-task-list client half — persistent interactive task panel
 * (`conversation.input.dock`). The plugin owns the panel store and every Host
 * HTTP round-trip: an apply-world EventSource subscription on /task-ui/events
 * refreshes GET /task-ui/tasks results through the store's bound actions
 * (SSE push replaces polling), and the injected operations face performs
 * the POST mutations. The panel component only reads the store (useStore),
 * renders localized copy (t), and triggers those operations.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-conversation's SlotMap merge (the 'conversation.input.dock' entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TaskUiPanelInjected } from './contract/slots.ts'
import { TaskUiPanel } from './TaskUiPanel.tsx'
import { createTaskUiStore, type TaskItem } from './store.ts'
import { en, zh, type TaskUiKey } from './locales.ts'

export type { TaskUiPanelComponentProps, TaskUiPanelInjected } from './contract/slots.ts'
export type { TaskUiKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The task panel's copy. */
    'task-ui': TaskUiKey
  }
}

/** Dictionary namespace owned by this plugin (panel copy). */
const NS = 'task-ui'

/** Services required by the client plugin. */
export const inject = ['slots', 'locale']

/** Fetch the task list from the Host API. */
async function fetchTasks(): Promise<TaskItem[]> {
  const res = await fetch('/task-ui/tasks')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data: unknown = await res.json()
  const tasks = (data as { tasks?: unknown }).tasks
  // Minimal wire guard: a missing/odd payload must not crash the refresh path.
  return Array.isArray(tasks) ? (tasks as TaskItem[]) : []
}

/** POST a JSON body to the Host API; rejects with the Host error text. */
async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.ok) return
  let detail = `HTTP ${res.status}`
  try {
    const data: unknown = await res.json()
    const error = (data as { error?: unknown }).error
    if (typeof error === 'string') detail = error
  } catch {
    // Non-JSON error body — keep the HTTP status detail.
  }
  throw new Error(detail)
}

/** Prompt handed to the master agent when the user asks to split a task. */
function splitPrompt(title: string): string {
  return `用户通过任务面板触发了生成式回路：请将任务「${title}」拆分为可并行推进的子任务（用 task_add 创建并用 parentId 关联），然后给出推进建议。`
}

/**
 * Client plugin body: register the panel dictionaries, own the panel store,
 * subscribe to the Host's /task-ui/events SSE channel (refreshing the store
 * on each tasks-changed frame), and contribute the panel into the
 * conversation-owned `conversation.input.dock` slot (additive list entry,
 * id `task-ui`, order 30).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'task-ui: dictionaries')

  const store = createTaskUiStore()
  // The `conversation.input.dock` slot is session-scoped, so the framework
  // instantiates one store per session; the bound actions that arrive on each
  // materialization are therefore per-session too. Keep them in a map so every
  // live session's store is refreshed on each SSE frame. Stale entries (a
  // session whose panel unmounted) are harmless: the framework does not render
  // unmounted session stores, and the per-registration disposer does not expose
  // a per-session unmount hook.
  const actionsBySession = new Map<string, BoundActions<typeof store>>()

  /** Fetch the task list and write it; a failure becomes an error banner. */
  const refreshWithError = (actions: BoundActions<typeof store>, code: 'refresh' | 'operation'): void => {
    void fetchTasks()
      .then(tasks => { actions.refresh(tasks); actions.clearError() })
      .catch((error: unknown) => { actions.setError({ code, detail: String(error) }) })
  }

  // SSE push replaces polling: the Host broadcasts a `tasks-changed` frame on
  // every durable write to the task_ui domain, so the panel refreshes on
  // change instead of on a fixed cadence. onerror also triggers one refresh:
  // EventSource auto-reconnects by default, and re-fetching on error keeps the
  // panel converged even when a frame is lost during the drop.
  ctx.effect(() => {
    const source = new EventSource('/task-ui/events')
    source.onmessage = () => { for (const actions of actionsBySession.values()) refreshWithError(actions, 'refresh') }
    source.onerror = () => { for (const actions of actionsBySession.values()) refreshWithError(actions, 'refresh') }
    return () => { source.close() }
  }, 'task-ui: task list SSE subscription')

  // Session-scope inject signature: runInject passes (sessionId, actions) —
  // sessionId first because this slot is session-scoped, then the bound store
  // actions because the entry declares a store. Register the bound actions
  // under this session's id so the SSE fan-out reaches EVERY live session.
  const injected = (sessionId: string, actions: BoundActions<typeof store>): TaskUiPanelInjected => {
    actionsBySession.set(sessionId, actions)
    // First paint should not wait for the next SSE frame.
    refreshWithError(actions, 'refresh')
    return {
      setStatus: (id, status) => {
        void postJson('/task-ui/status', { id, status })
          .then(() => refreshWithError(actions, 'operation'))
          .catch((error: unknown) => { actions.setError({ code: 'operation', detail: String(error) }) })
      },
      requestDelete: (id, confirmed) => {
        if (!confirmed) {
          actions.setConfirming(id)
          return
        }
        actions.setConfirming(null)
        void postJson('/task-ui/delete', { id })
          .then(() => refreshWithError(actions, 'operation'))
          .catch((error: unknown) => { actions.setError({ code: 'operation', detail: String(error) }) })
      },
      askAgent: (task) => {
        actions.clearError()
        void postJson('/task-ui/ask', { message: splitPrompt(task.title) })
          .catch((error: unknown) => { actions.setError({ code: 'operation', detail: String(error) }) })
      },
    }
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'task-ui',
    order: 30,
    store,
    locale: NS,
    inject: injected,
  }, TaskUiPanel))
}
