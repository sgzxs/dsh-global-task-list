/**
 * Task panel store: the panel's shared viewing state (task list, last error,
 * delete-confirmation id). The plugin's apply world is the only writer —
 * polling and mutation results arrive through the bound actions; the panel
 * component reads via props.useStore. Task data itself stays on the Host
 * (the panel polls the HTTP API); the store never owns business truth.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** The five task lifecycle statuses (Host schema). */
export type TaskStatus = 'pending' | 'running' | 'done' | 'blocked' | 'failed'

/** Status badge tone accepted by the surface renderer. */
export type TaskSurfaceTone = 'neutral' | 'success' | 'warn' | 'error' | 'brand'

/** A task-surface section header row. */
export interface TaskSurfaceSection {
  kind: 'section'
  title?: string
  children?: TaskSurfaceNode[]
}

/** A labeled value with optional unit and trend. */
export interface TaskSurfaceMetric {
  kind: 'metric'
  label: string
  value: string | number
  unit?: string
  trend?: string
}

/** A pill carrying a semantic tone. */
export interface TaskSurfaceStatusBadge {
  kind: 'statusBadge'
  label: string
  tone?: TaskSurfaceTone
}

/** A labeled progress bar (percent clamped to 0..100 at render time). */
export interface TaskSurfaceProgress {
  kind: 'progress'
  label?: string
  percent: number
}

/** A plain column/row table. */
export interface TaskSurfaceTable {
  kind: 'table'
  columns: string[]
  rows: (string | number)[][]
}

/** A flat list of scalar items. */
export interface TaskSurfaceList {
  kind: 'list'
  items: (string | number)[]
}

/** A time-ordered event stream. */
export interface TaskSurfaceTimeline {
  kind: 'timeline'
  events: { time: string; title: string; detail?: string }[]
}

/** A node/edge graph; node status reuses the task-status hues when known. */
export interface TaskSurfaceDag {
  kind: 'dag'
  nodes: { id: string; label: string; status?: string }[]
  edges?: { from: string; to: string }[]
}

/** A collapsible section (native <details>/<summary>). */
export interface TaskSurfaceDisclosure {
  kind: 'disclosure'
  title: string
  children?: TaskSurfaceNode[]
}

/**
 * One surface document node. Crosses the Host HTTP wire as untyped JSON, so
 * the renderer treats it as a typed same-process boundary and only hardens
 * optional fields (`?? []`); unknown kinds are safely ignored.
 */
export type TaskSurfaceNode =
  | TaskSurfaceSection
  | TaskSurfaceMetric
  | TaskSurfaceStatusBadge
  | TaskSurfaceProgress
  | TaskSurfaceTable
  | TaskSurfaceList
  | TaskSurfaceTimeline
  | TaskSurfaceDag
  | TaskSurfaceDisclosure

/** One task row as served by GET /task-ui/tasks (Host schema). */
export interface TaskItem {
  id: string
  title: string
  status: TaskStatus
  description: string
  parentId: string | null
  dependsOn: string[]
  /** Optional generative-UI document rendered under the task card. */
  surface: TaskSurfaceNode | null
  /** Optional coarse progress: a label plus an optional 0..100 percent. */
  progress: TaskProgress | null
  jobId: string | null
  createdAt: number
  updatedAt: number
}

/** Coarse task progress written by the owning agent/subagent. */
export interface TaskProgress {
  /** Human-readable "what is done now" text. */
  text: string
  /** Optional completion percentage, 0..100. */
  percent?: number
}

/** A panel error: a localized key code plus the raw technical detail. */
export interface TaskUiError {
  /** Which operation failed (drives the localized prefix). */
  code: 'refresh' | 'operation'
  /** Raw failure detail (HTTP status, Host error message). */
  detail: string
}

/** Panel store state. */
export interface TaskUiState {
  /** Latest polled task list (empty until the first successful poll). */
  tasks: readonly TaskItem[]
  /** Last failure; null while healthy. */
  error: TaskUiError | null
  /** Task id awaiting delete confirmation; null when none. */
  confirming: string | null
  /** Whether the user collapsed the panel to the floating mini pill. */
  collapsed: boolean
}

/** Declared write surface: pure draft mutators, the complete store API. */
type TaskUiActions = {
  /** Replace the task list with a freshly fetched result. */
  refresh: (draft: TaskUiState, tasks: readonly TaskItem[]) => void
  /** Replace the error banner. */
  setError: (draft: TaskUiState, error: TaskUiError | null) => void
  /** Set the task id awaiting delete confirmation (null clears). */
  setConfirming: (draft: TaskUiState, id: string | null) => void
  /** Clear the error banner. */
  clearError: (draft: TaskUiState) => void
  /** Set whether the panel is collapsed to the mini pill. */
  setCollapsed: (draft: TaskUiState, collapsed: boolean) => void
}

/**
 * Create the task panel store handle. Called once in apply and passed to the
 * `shell.overlay` registration; the framework instantiates the root-scoped
 * instance and delivers `useStore`/`actions` (and the inject factory's bound
 * actions) at materialization.
 * @returns the store handle.
 */
export function createTaskUiStore(): EngineStoreHandle<TaskUiState, TaskUiActions> {
  return defineStore({
    init: (): TaskUiState => ({ tasks: [], error: null, confirming: null, collapsed: false }),
    actions: {
      refresh: (draft, tasks) => { draft.tasks = tasks },
      setError: (draft, error) => { draft.error = error },
      setConfirming: (draft, id) => { draft.confirming = id },
      clearError: (draft) => { draft.error = null },
      setCollapsed: (draft, collapsed) => { draft.collapsed = collapsed },
    },
  })
}
