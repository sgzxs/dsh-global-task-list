/**
 * Task panel slot contract: the registrant-side props composition for the
 * layout-owned `shell.overlay` list slot. The panel owns no child slots; it
 * receives the runtime share, the declared store seat, the locale seat, and
 * this plugin's injected operations face (Host HTTP calls live in the apply
 * world — the component only triggers them).
 */
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'shell.overlay' entry) so
// PropsRuntime<'shell.overlay'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createTaskUiStore, TaskItem, TaskStatus } from '../store.ts'

/**
 * Registrant-private injected share (arrives via the register inject
 * factory, closed over the apply-world ctx and the bound store actions).
 * Operations perform their Host HTTP round-trips here; the panel never
 * fetches directly.
 */
export interface TaskUiPanelInjected {
  /**
   * Request a task status change through POST /task-ui/status.
   * @param id - task id.
   * @param status - target status.
   */
  setStatus: (id: string, status: TaskStatus) => void
  /**
   * Delete-request flow: the first call for an id arms the confirmation
   * (store `confirming`); a second call with `confirmed` true performs
   * POST /task-ui/delete and refreshes.
   * @param id - task id.
   * @param confirmed - whether the user already confirmed this id.
   */
  requestDelete: (id: string, confirmed: boolean) => void
  /**
   * Ask the master agent to split a task through POST /task-ui/ask.
   * @param task - the task to split.
   */
  askAgent: (task: TaskItem) => void
}

/**
 * Full component props: runtime share + store share + locale seat + injected
 * operations face.
 */
export type TaskUiPanelComponentProps =
  PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createTaskUiStore>>
  & PropsLocale<'task-ui'>
  & TaskUiPanelInjected
