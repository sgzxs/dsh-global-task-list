/**
 * Task panel (`conversation.input.dock` occupant): a floating, live list of the
 * global task library. Pure props component — reads the store via `useStore`,
 * renders localized copy via `t`, and triggers Host operations through the
 * injected callbacks (the apply world owns every fetch).
 *
 * Detail: clicking a card expands a secondary region under it (description,
 * progress, next action, dependencies, timestamps). The expansion is CSS-only
 * (`grid-template-rows: 0fr -> 1fr`), so the panel's bottom-anchored rise
 * follows it for free.
 *
 * Motion:
 *   - a task that arrives after the panel has painted plays the card rise and
 *     the panel slides up by the height it gained — which is what lifts the
 *     cards above it and carries the new one in from below the viewport;
 *   - a deleted task keeps its slot while it plays the exit animation, and the
 *     panel retracts afterwards.
 * Both are skipped under `prefers-reduced-motion`.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { TaskItem, TaskStatus, TaskStep, TaskStepState } from './store.ts'
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

/** Shared empty results, so a render without a change keeps a stable identity. */
const NO_ENTERING: ReadonlySet<string> = new Set<string>()
const NO_EXITING: readonly TaskItem[] = []

/** Distance from the list bottom that still counts as following the newest card. */
const PINNED_SLACK_PX = 40

/** Timings used only if the theme's motion tokens are unavailable. */
const FALLBACK_RISE_MS = 200
const FALLBACK_EXIT_MS = 100
const FALLBACK_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)'

/** Whether the platform asked for reduced motion. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** One theme motion value, in milliseconds, with a fallback. */
function tokenMs(raw: string, fallback: number): number {
  const seconds = Number.parseFloat(raw)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback
}

/**
 * Read the theme's own motion values, so the panel's animations are timed by
 * the same tokens as the card's CSS keyframes instead of a second copy of the
 * numbers.
 * @param el - the element to animate (the custom properties are inherited).
 * @returns Web Animations timing for a panel move.
 */
function panelTiming(el: HTMLElement): { duration: number; easing: string } {
  const style = getComputedStyle(el)
  const easing = style.getPropertyValue('--ds-ease-in-out').trim()
  return {
    duration: tokenMs(style.getPropertyValue('--ds-transition-duration'), FALLBACK_RISE_MS),
    easing: easing === '' ? FALLBACK_EASING : easing,
  }
}

/** The card-exit duration, so the removal timer matches its animation. */
function exitDurationMs(): number {
  if (typeof document === 'undefined') return FALLBACK_EXIT_MS
  return tokenMs(
    getComputedStyle(document.documentElement).getPropertyValue('--ds-transition-duration-fast'),
    FALLBACK_EXIT_MS,
  )
}

/** Local timestamp for the detail view (minute precision is enough there). */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

/** Locale key naming one flow state (the detail flow's accessible text). */
const FLOW_STATE_KEY: Record<TaskStepState, TaskUiKey> = {
  done: 'flow.done',
  current: 'flow.current',
  next: 'flow.next',
  todo: 'flow.todo',
}

/** Marker glyph per flow state; `todo` stays blank (its ring is the mark). */
const FLOW_STATE_GLYPH: Record<TaskStepState, string> = {
  done: '✓',
  current: '●',
  next: '→',
  todo: '',
}

/**
 * The flow the detail card draws.
 *
 * The owner's `steps` win when it wrote any. Otherwise one node is derived from
 * the coarse fields, so tasks created before the flow existed still render
 * something true rather than an empty box. A step list that names no `next`
 * inherits `nextStep` as its next node, so the field the bundled skill requires
 * is never lost behind a partial list.
 * @param task - the task row to describe.
 * @returns the ordered flow, possibly empty (the caller renders the placeholder).
 */
function flowOf(task: TaskItem): TaskStep[] {
  const steps = task.steps ?? []
  const nodes: TaskStep[] = steps.length > 0
    ? [...steps]
    : task.progress === null
      ? []
      : [{
          text: task.progress.text,
          // A finished task's sentence describes finished work; a not-yet-started
          // one is still ahead; anything else is the live step.
          state: task.status === 'done' ? 'done' : task.status === 'pending' ? 'todo' : 'current',
        }]
  // `nextStep` postdates the first deployed schema, and a Host that has not been
  // restarted serves records without it.
  const nextStep = task.nextStep ?? ''
  if (nextStep !== '' && !nodes.some(node => node.state === 'next')) {
    nodes.push({ text: nextStep, state: 'next' })
  }
  return nodes
}

/** Panel width bounds, in px. The stylesheet's 360px sits between them. */
const MIN_PANEL_WIDTH = 260
const MAX_PANEL_WIDTH = 760
/** Mirrors the stylesheet's default width, for the pre-drag ARIA value. */
const DEFAULT_PANEL_WIDTH = 360
/** Width change per arrow key on the resize handle. */
const RESIZE_KEY_STEP = 16
/** Where the remembered width lives. */
const WIDTH_STORAGE_KEY = 'dsh-global-task-list:panel-width'

/**
 * Clamp a candidate width to the panel's bounds, further capped by the viewport
 * so the panel can never grow past the edge it is anchored to.
 * @param candidate - desired width in px.
 * @returns the width to apply.
 */
function clampWidth(candidate: number): number {
  const viewportMax = typeof window === 'undefined' ? MAX_PANEL_WIDTH : window.innerWidth - 32
  return Math.round(Math.min(Math.max(candidate, MIN_PANEL_WIDTH), Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, viewportMax))))
}

/**
 * The remembered width, or null to keep the stylesheet default.
 * Storage is best-effort: a browser that denies it (or a scheme without web
 * storage) simply gets an unremembered width for the session.
 * @returns the stored width, clamped, or null.
 */
function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY)
    if (raw === null) return null
    const value = Number.parseInt(raw, 10)
    return Number.isFinite(value) ? clampWidth(value) : null
  } catch {
    return null
  }
}

/** Remember the width, best-effort. */
function storeWidth(width: number): void {
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width))
  } catch {
    // Not remembered: the width still holds for this session.
  }
}

/** What the resize handle needs from its owner. */
interface PanelResize {
  /** Applied width in px, or null to keep the stylesheet default. */
  width: number | null
  /** Whether a drag is in progress (drives the handle's styling). */
  resizing: boolean
  handle: {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
    onPointerCancel: () => void
    /** Capture is also lost on window blur or element removal; end there too. */
    onLostPointerCapture: () => void
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  }
}

/**
 * Pointer-drag width resizing for the right-anchored panel, following
 * ui-layout's own DragHandle: pointer capture for the whole gesture, one
 * throttled report per animation frame, and the drag origin captured at
 * pointer-down so the width is computed from the gesture rather than
 * accumulated per move (which would drift with rounding).
 *
 * The panel hangs off the viewport's right edge, so its movable edge is the
 * left one and a leftward drag is what widens it.
 * @param panelRef - the panel element, measured at drag start.
 * @returns the width to apply, the drag flag, and the handle's handlers.
 */
function usePanelResize(panelRef: { current: HTMLDivElement | null }): PanelResize {
  const [width, setWidth] = useState<number | null>(readStoredWidth)
  const [resizing, setResizing] = useState(false)
  /** The active gesture; null between drags. */
  const drag = useRef<{ id: number; originX: number; startWidth: number; latestX: number } | null>(null)
  /** Pending frame for the throttled width update. */
  const frame = useRef<number | null>(null)

  const cancelFrame = (): void => {
    if (frame.current === null) return
    window.cancelAnimationFrame(frame.current)
    frame.current = null
  }

  const end = (): void => {
    cancelFrame()
    drag.current = null
    setResizing(false)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // Primary button only, and never a second gesture on top of a live one.
    if (event.button !== 0 || drag.current !== null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      id: event.pointerId,
      originX: event.clientX,
      // Measure rather than trust state: the stylesheet default may be in play,
      // and a viewport clamp may be shrinking the panel below the applied width.
      startWidth: panelRef.current?.offsetWidth ?? MIN_PANEL_WIDTH,
      latestX: event.clientX,
    }
    setResizing(true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current
    if (active === null || active.id !== event.pointerId) return
    active.latestX = event.clientX
    // A pointer can outrun the compositor, and every report re-lays out the
    // panel: collapse the burst into one update per frame.
    if (frame.current !== null) return
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null
      const current = drag.current
      if (current === null) return
      setWidth(clampWidth(current.startWidth - (current.latestX - current.originX)))
    })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current
    if (active === null || active.id !== event.pointerId) return
    cancelFrame()
    // Land on the release position instead of the last sampled frame.
    const settled = clampWidth(active.startWidth - (event.clientX - active.originX))
    setWidth(settled)
    storeWidth(settled)
    end()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const current = width ?? panelRef.current?.offsetWidth ?? MIN_PANEL_WIDTH
    // Geometric, matching the drag: the handle IS the panel's left edge, so
    // stepping it left widens the panel.
    const next = clampWidth(current + (event.key === 'ArrowLeft' ? RESIZE_KEY_STEP : -RESIZE_KEY_STEP))
    setWidth(next)
    storeWidth(next)
  }

  // A gesture interrupted by unmount (the panel collapses or the view switches
  // mid-drag) must not strand the rAF loop or the resizing flag.
  useEffect(() => end, [])

  return {
    width,
    resizing,
    handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: end, onLostPointerCapture: end, onKeyDown },
  }
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

/** One rendered row: a live task, or one still playing its exit animation. */
interface PanelRow {
  task: TaskItem
  /** Whether the task is already gone from the library and only animating out. */
  exiting: boolean
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

  /** The floating panel that slides when the list grows or retracts. */
  const panelRef = useRef<HTMLDivElement>(null)
  /** The scrolling card list, for following the newest card. */
  const bodyRef = useRef<HTMLDivElement>(null)
  /** Measured panel height at the previous commit; null before the first. */
  const lastHeight = useRef<number | null>(null)
  /** Row-id signature at the previous commit, to tell a list change from a resize. */
  const lastSignature = useRef<string | null>(null)
  /** The task list committed by a previous render, for detecting removals. */
  const committedTasks = useRef<readonly TaskItem[]>([])
  /** Whether the reader was parked at the newest card before this render. */
  const followsNewest = useRef(true)
  /** Set by the removal pass when this commit dropped a task, so the motion
   *  pass can ignore the transient height drop that the ghost row undoes in
   *  the same frame. */
  const droppedThisCommit = useRef(false)

  /** Tasks removed from the library that are still playing their exit. */
  const [exiting, setExiting] = useState<readonly TaskItem[]>(NO_EXITING)
  /** Ids whose detail region is expanded. */
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  /** Drag-to-resize state for the panel's left edge. */
  const resize = usePanelResize(panelRef)

  // Cards added since the previous commit. Read from a ref rather than state so
  // the answer is already available during this render — that is what lets the
  // new card carry its entrance attribute on the very paint it first appears.
  // On the panel's first render the ref is still empty, so opening the panel
  // (or switching back to Chat) never animates the backlog.
  const entering = useMemo(() => {
    const known = committedTasks.current
    if (known.length === 0) return NO_ENTERING
    const knownIds = new Set(known.map(task => task.id))
    const added = new Set<string>()
    for (const task of tasks) if (!knownIds.has(task.id)) added.add(task.id)
    // The shared empty set keeps this dependency stable across the SSE refreshes
    // that replace the array without changing its contents, so the motion pass
    // only runs when something actually changed.
    return added.size === 0 ? NO_ENTERING : added
  }, [tasks])

  // Rows keep a deleted task in place until its exit animation ends, so the
  // list does not reflow under a card that is still on screen. Merging by
  // createdAt restores the original position, since a deletion can be anywhere
  // and appending the ghost would make it jump to the bottom first.
  const rows = useMemo<readonly PanelRow[]>(() => {
    if (exiting.length === 0) return tasks.map(task => ({ task, exiting: false }))
    return [
      ...tasks.map(task => ({ task, exiting: false })),
      ...exiting.map(task => ({ task, exiting: true })),
    ].sort((a, b) => a.task.createdAt - b.task.createdAt)
  }, [tasks, exiting])

  /** Row identity, the signature that separates a list change from a resize. */
  const rowsKey = useMemo(() => rows.map(row => row.task.id).join(','), [rows])
  /** Expansion identity, which resizes the panel without changing the list. */
  const expandedKey = useMemo(() => [...expandedIds].sort().join(','), [expandedIds])

  // Adopt deleted tasks as ghost rows. A LAYOUT effect on purpose: the state
  // update it makes must be flushed in the same frame as the removal, because
  // the row re-enters the tree in that update. With a passive effect the card
  // left the DOM for one painted frame and came back — the list visibly flashed
  // and the panel ran a shrink/grow/shrink cycle, which is the jitter this
  // replaced. The card keeps its slot for the exit animation, and the timer
  // releases it so the panel retracts only once the card is really gone.
  useLayoutEffect(() => {
    const liveIds = new Set(tasks.map(task => task.id))
    const gone = committedTasks.current.filter(task => !liveIds.has(task.id))
    committedTasks.current = tasks
    droppedThisCommit.current = gone.length > 0
    if (gone.length === 0) return
    setExiting(previous => {
      const known = new Set(previous.map(task => task.id))
      return [...previous, ...gone.filter(task => !known.has(task.id))]
    })
    const ids = new Set(gone.map(task => task.id))
    window.setTimeout(() => {
      setExiting(previous => previous.filter(task => !ids.has(task.id)))
      // Drop the expansion state with the row, so a long session does not
      // accumulate the ids of tasks that were deleted while expanded.
      setExpandedIds(previous => {
        if (![...ids].some(id => previous.has(id))) return previous
        const next = new Set(previous)
        for (const id of ids) next.delete(id)
        return next
      })
    }, exitDurationMs())
  }, [tasks])

  // Panel motion. A list change and a plain resize need opposite treatment:
  // only the former is a card arriving or leaving, so only it animates; an
  // expansion (or a first measurement) just re-baselines the recorded height.
  //
  // `collapsed`/`viewIsChat` are dependencies because they decide whether the
  // panel is mounted: without them, a panel that was hidden would keep a stale
  // measurement and animate against geometry that was never on screen.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (panel === null) {
      lastHeight.current = null
      lastSignature.current = null
      return
    }

    // A removal in this same commit is transient: the ghost pass above re-adopts
    // the row before the frame is painted, so the height measured here belongs
    // to a layout that never reaches the screen. Leaving the recorded height and
    // signature untouched also makes the next commit the true "before" state.
    if (droppedThisCommit.current) {
      droppedThisCommit.current = false
      return
    }

    const height = panel.offsetHeight
    const previous = lastHeight.current
    const listChanged = lastSignature.current !== null && lastSignature.current !== rowsKey
    lastHeight.current = height
    lastSignature.current = rowsKey

    const reduced = prefersReducedMotion()
    const body = bodyRef.current

    if (!listChanged || previous === null) {
      // A clamped panel (already at max-height) has no rise to reveal an
      // arrival, so a reader parked at the newest card follows it; one who
      // scrolled up to read an older task is left where they are.
      if (entering.size > 0 && previous !== null && body !== null && followsNewest.current) {
        body.scrollTo({ top: body.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
      }
      return
    }

    if (reduced) return

    if (height > previous) {
      // Growth: the panel is bottom-anchored, so every card above the new one
      // already moved up by `delta`. Starting the panel `delta` lower and
      // animating that away reproduces the shift; translating the final layout
      // (rather than animating height) keeps the list from overflowing
      // mid-flight, and the strip that slides in from below the viewport is
      // exactly the new card.
      panel.animate(
        [{ transform: `translateY(${height - previous}px)` }, { transform: 'translateY(0)' }],
        panelTiming(panel),
      )
      return
    }

    // Shrink: a deleted card left the flow, so give its height back smoothly.
    // The box stays taller than its content for the whole animation, so nothing
    // overflows and no scrollbar flashes.
    panel.animate(
      [{ height: `${previous}px` }, { height: `${height}px` }],
      panelTiming(panel),
    )
  }, [rowsKey, entering, expandedKey, collapsed, viewIsChat, resize.width, resize.resizing])

  // Remember the scroll posture after the frame, so the next commit's motion
  // pass reads it as it was BEFORE that commit's change.
  useEffect(() => {
    const body = bodyRef.current
    followsNewest.current = body === null
      || body.scrollHeight - body.scrollTop - body.clientHeight <= PINNED_SLACK_PX
  }, [tasks])

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

  const toggleExpanded = (id: string): void => {
    setExpandedIds(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
    <div
      className={css.root}
      ref={panelRef}
      data-resizing={resize.resizing ? 'true' : undefined}
      style={resize.width === null ? undefined : { width: `${resize.width}px` }}
    >
      {/* The panel's movable edge. It sits inside the panel's own padding, so it
          never overlaps a card, and `touch-action: none` keeps a touch drag from
          scrolling the list underneath it. */}
      <div
        className={css.resizer}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('action.resize')}
        aria-valuenow={resize.width ?? DEFAULT_PANEL_WIDTH}
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={MAX_PANEL_WIDTH}
        tabIndex={0}
        {...resize.handle}
      />
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
      <div className={css.body} ref={bodyRef}>
        {error !== null && (
          <div className={css.errorBanner} role="alert">
            {t(error.code === 'refresh' ? 'error.refresh' : 'error.operation', { detail: error.detail })}
          </div>
        )}
        {rows.length === 0
          ? <div className={css.empty}>{t('panel.empty')}</div>
          : (
            <ul className={css.list}>
              {rows.map(({ task, exiting: isExiting }) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  confirming={confirming === task.id}
                  entering={entering.has(task.id)}
                  exiting={isExiting}
                  expanded={expandedIds.has(task.id)}
                  onToggle={() => { toggleExpanded(task.id) }}
                  t={t}
                  setStatus={setStatus}
                  requestDelete={requestDelete}
                  askAgent={askAgent}
                />
              ))}
            </ul>
          )}
      </div>
    </div>
  )
}

/** Props of one task card row. */
interface TaskRowProps {
  task: TaskItem
  /** Whether this row's delete confirmation is armed. */
  confirming: boolean
  /** Whether the card arrived after the panel's first paint (plays the rise). */
  entering: boolean
  /** Whether the task was deleted and the card is playing its exit. */
  exiting: boolean
  /** Whether the detail region is expanded. */
  expanded: boolean
  onToggle: () => void
  t: PanelT
  setStatus: (id: string, status: TaskStatus) => void
  requestDelete: (id: string, confirmed: boolean) => void
  askAgent: (task: TaskItem) => void
}

/**
 * Render one task card: status dot + title + expand + delete, the quick status
 * controls, the split action, the linked job line, the inline progress row, the
 * surface document, and — when expanded — the detail region.
 * @param props - row props.
 * @returns the card element tree.
 */
function TaskRow({
  task, confirming, entering, exiting, expanded, onToggle, t, setStatus, requestDelete, askAgent,
}: TaskRowProps) {
  const onDelete = (): void => { requestDelete(task.id, confirming) }
  const detailId = `task-ui-detail-${task.id}`
  const flow = flowOf(task)
  // True when the flow is the fallback rather than the owner's own step list.
  // The panel cannot invent history, so it says so rather than drawing a
  // suspiciously short flow with no explanation.
  const flowDerived = (task.steps ?? []).length === 0
  // Derived by the Host per process: a job linked before this Host started
  // cannot still be running, so "running" is unverified rather than false.
  const jobStale = task.jobStale === true

  // The whole card toggles, except where a control owns the click — otherwise
  // every status tap would also collapse the card out from under the pointer,
  // and a `disclosure` inside the surface document would fight its own summary.
  const onCardClick = (event: ReactMouseEvent<HTMLLIElement>): void => {
    const target = event.target as HTMLElement
    if (target.closest('button, summary, a, input, select, textarea, details') !== null) return
    onToggle()
  }

  return (
    <li
      className={css.card}
      data-enter={entering ? 'true' : undefined}
      data-exit={exiting ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined}
      onClick={onCardClick}
    >
      <div className={css.cardHeader}>
        <span className={`${css.dot} ${statusDotClass[task.status]}`} aria-hidden="true" />
        <span className={css.taskTitle}>{task.title}</span>
        <button
          type="button"
          className={css.expandButton}
          aria-expanded={expanded}
          aria-controls={detailId}
          aria-label={t('action.toggleDetail')}
          onClick={onToggle}
        >
          <span className={css.chevron} aria-hidden="true" />
        </button>
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
        <div className={jobStale ? css.jobLineStale : css.jobLine} title={jobStale ? t('panel.jobExpired') : undefined}>
          {t('panel.job', { id: task.jobId.slice(0, 8) })}
          {jobStale ? ` · ${t('panel.jobExpired')}` : ''}
        </div>
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

      {/* Secondary card: expands downward from this card. The 0fr -> 1fr grid
          transition animates to the content's natural height without measuring
          it, and `visibility` keeps the collapsed copy out of the tab order. */}
      <div className={css.detailWrap} id={detailId}>
        <div className={css.detail}>
          <div className={css.detailBlock}>
            <div className={css.detailLabel}>{t('detail.description')}</div>
            {task.description === ''
              ? <div className={css.detailUnset}>{t('detail.unset')}</div>
              : <div className={css.detailText}>{task.description}</div>}
          </div>

          {/* The flow replaces the separate progress and next-step blocks: one
              picture of where the task is, what is running, and what follows. */}
          <div className={css.detailBlock}>
            <div className={css.flowHeader}>
              <span className={css.detailLabel}>{t('detail.flow')}</span>
              {task.progress?.percent !== undefined && (
                <span className={css.detailPercent}>{Math.round(task.progress.percent)}%</span>
              )}
            </div>
            {flow.length === 0
              ? <div className={css.detailUnset}>{t('detail.unset')}</div>
              : (
                <ol className={css.flow}>
                  {flow.map((node, index) => (
                    <li key={`${node.state}-${index}`} className={css.flowStep} data-state={node.state}>
                      <span className={css.flowMarker} aria-hidden="true">{FLOW_STATE_GLYPH[node.state]}</span>
                      <div className={css.flowBox}>
                        {/* The frame carries the state visually; this is what a
                            screen reader gets instead. */}
                        <span className={css.srOnly}>{t(FLOW_STATE_KEY[node.state])}</span>
                        {node.text}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            {flowDerived && flow.length > 0 && (
              <div className={css.detailNote}>{t('detail.flowDerived')}</div>
            )}
          </div>

          {task.dependsOn.length > 0 && (
            <div className={css.detailMeta}>
              {t('detail.blockedBy', { ids: task.dependsOn.map(id => id.slice(0, 8)).join(', ') })}
            </div>
          )}
          {task.parentId !== null && (
            <div className={css.detailMeta}>{t('detail.parent', { id: task.parentId.slice(0, 8) })}</div>
          )}
          <div className={css.detailMeta}>
            {t('detail.created', { time: formatTime(task.createdAt) })}
            {' · '}
            {t('detail.updated', { time: formatTime(task.updatedAt) })}
          </div>
        </div>
      </div>
    </li>
  )
}
