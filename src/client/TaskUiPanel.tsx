/**
 * Task panel (shell.overlay occupant): a floating, poll-driven list of the
 * global task library. Pure props component — reads the store via
 * `useStore`, renders localized copy via `t`, and triggers Host operations
 * through the injected callbacks (the apply world owns every fetch). Tasks
 * carrying a `surface` document render it below the card via SurfaceView.
 */
import { useEffect, useMemo, useState } from 'react'
import type { TaskItem, TaskStatus } from './store.ts'
import type { TaskUiKey } from './locales.ts'
import type { TaskUiPanelComponentProps } from './contract/slots.ts'
import { SurfaceView, statusDotClass } from './surface.tsx'
import css from './TaskUiPanel.module.css'

/** How long a delete confirmation stays armed before it lapses. */
const CONFIRM_TIMEOUT_MS = 3000

/** Statuses offered as quick-set controls (legacy panel parity: no `failed` control). */
const STATUS_CONTROLS: readonly TaskStatus[] = ['running', 'done', 'blocked', 'pending']

/** Locale key per task status. */
const STATUS_LABEL_KEY: Record<TaskStatus, TaskUiKey> = {
  pending: 'status.pending',
  running: 'status.running',
  done: 'status.done',
  blocked: 'status.blocked',
  failed: 'status.failed',
}

/** Derive the narrow locale seat type from the composed props. */
type PanelT = TaskUiPanelComponentProps['t']

/**
 * Derive whether the active conversation view is the built-in Chat view by
 * observing the session header's accessible tab ring. The chat entry is the
 * first tab (order 0, DEFAULT_VIEW_ID 'chat'); the trajectory entry is a
 * later order, so a selected index other than 0 means "not chat". With one
 * view there is no tab ring and chat is active by definition. This is the
 * only stable signal a third-party dock occupant can read: the active view id
 * lives in ui-conversation's private per-session store, not a service.
 */
function useActiveViewIsChat(): boolean {
  const [isChat, setIsChat] = useState<boolean>(true)

  useEffect(() => {
    const read = (): boolean => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]'))
      if (tabs.length === 0) return true
      const selected = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true')
      // No selection is a transient mount state: keep the panel visible.
      return selected <= 0
    }

    let latest = read()
    setIsChat(latest)

    // Attribute-filtered over the whole document: only view switches mutate
    // aria-selected, so this stays cheap even while the chat view streams.
    const observer = new MutationObserver(() => {
      const next = read()
      if (next !== latest) {
        latest = next
        setIsChat(next)
      }
    })
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-selected'] })
    return () => { observer.disconnect() }
  }, [])

  return isChat
}

/**
 * Render the task panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the panel element tree.
 */
export function TaskUiPanel({ t, useStore, actions, setStatus, requestDelete, askAgent }: TaskUiPanelComponentProps) {
  const tasks = useStore(s => s.tasks)
  const error = useStore(s => s.error)
  const confirming = useStore(s => s.confirming)
  const collapsed = useStore(s => s.collapsed)
  const viewIsChat = useActiveViewIsChat()

  // An armed delete confirmation lapses on its own (legacy panel parity);
  // the store is the only confirmation holder.
  useEffect(() => {
    if (confirming === null) return
    const timer = window.setTimeout(() => { actions.setConfirming(null) }, CONFIRM_TIMEOUT_MS)
    return () => { window.clearTimeout(timer) }
  }, [confirming, actions])

  // Header summary counts, derived purely from the store's task list.
  const counts = useMemo(() => {
    const result = { running: 0, done: 0, blocked: 0 }
    for (const task of tasks) {
      if (task.status === 'running') result.running += 1
      else if (task.status === 'done') result.done += 1
      else if (task.status === 'blocked') result.blocked += 1
    }
    return result
  }, [tasks])

  // Auto-hide off the Chat view (trajectory/waterfall): the composer dock the
  // panel rides is resident chrome, so it stays mounted across view switches.
  if (!viewIsChat) return null

  // Manual collapse: a compact floating pill keeps one-tap re-expand.
  if (collapsed) {
    return (
      <button
        type="button"
        className={css.mini}
        aria-label={t('panel.title')}
        onClick={() => { actions.setCollapsed(false) }}
      >
        <span className={css.miniDot} aria-hidden="true" />
        {t('panel.title')}{tasks.length > 0 ? ` · ${tasks.length}` : ''}
      </button>
    )
  }

  return (
    <div className={css.root}>
      <header className={css.header}>
        <div className={css.title}>{t('panel.title')}</div>
        <div className={css.summary}>{t('panel.summary', counts)}</div>
        <button
          type="button"
          className={css.collapseButton}
          onClick={() => { actions.setCollapsed(true) }}
        >
          {t('action.collapse')}
        </button>
      </header>
      {error !== null && (
        <div className={css.errorBanner} role="alert">
          {t(error.code === 'refresh' ? 'error.refresh' : 'error.operation', { detail: error.detail })}
        </div>
      )}
      {tasks.length === 0
        ? <div className={css.empty}>{t('panel.empty')}</div>
        : (
          <ul className={css.list}>
            {tasks.map(task => (
              <TaskRow
                key={task.id}
                task={task}
                confirming={confirming === task.id}
                t={t}
                setStatus={setStatus}
                requestDelete={requestDelete}
                askAgent={askAgent}
              />
            ))}
          </ul>
        )}
    </div>
  )
}

/** Props of one task card row. */
interface TaskRowProps {
  task: TaskItem
  /** Whether this row's delete confirmation is armed. */
  confirming: boolean
  t: PanelT
  setStatus: (id: string, status: TaskStatus) => void
  requestDelete: (id: string, confirmed: boolean) => void
  askAgent: (task: TaskItem) => void
}

/**
 * Render one task card: status dot + title + delete, the quick status
 * controls, the split action, the linked job line, and — when the task
 * carries a surface document — the recursive surface view.
 * @param props - row props.
 * @returns the card element tree.
 */
function TaskRow({ task, confirming, t, setStatus, requestDelete, askAgent }: TaskRowProps) {
  const onDelete = (): void => { requestDelete(task.id, confirming) }
  return (
    <li className={css.card}>
      <div className={css.cardHeader}>
        <span className={`${css.dot} ${statusDotClass[task.status]}`} aria-hidden="true" />
        <span className={css.taskTitle}>{task.title}</span>
        <button
          type="button"
          className={css.deleteButton}
          data-confirming={confirming || undefined}
          onClick={onDelete}
        >
          {t(confirming ? 'action.confirmDelete' : 'action.delete')}
        </button>
      </div>
      <div className={css.controls}>
        {STATUS_CONTROLS.map(status => {
          const active = task.status === status
          return (
            <button
              key={status}
              type="button"
              className={css.statusButton}
              data-status={status}
              data-active={active || undefined}
              disabled={active}
              onClick={() => { if (!active) setStatus(task.id, status) }}
            >
              {t(STATUS_LABEL_KEY[status])}
            </button>
          )
        })}
        <button
          type="button"
          className={css.splitButton}
          onClick={() => { askAgent(task) }}
        >
          {t('action.split')}
        </button>
      </div>
      {task.jobId !== null && (
        <div className={css.jobLine}>{t('panel.job', { id: task.jobId.slice(0, 8) })}</div>
      )}
      {task.progress !== null && (
        <div className={css.progressRow}>
          {task.progress.percent !== undefined && (
            <div className={css.progressTrack}>
              <div
                className={css.progressFill}
                style={{ width: `${Math.min(100, Math.max(0, task.progress.percent))}%` }}
              />
            </div>
          )}
          <div className={css.progressLabel}>{task.progress.text}</div>
        </div>
      )}
      {task.surface !== null && (
        <div className={css.surface}>
          <SurfaceView surface={task.surface} />
        </div>
      )}
    </li>
  )
}
