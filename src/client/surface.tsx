/**
 * Task-surface renderer: a recursive, whitelisted generative-UI component
 * registry for the Host-provided `surface` document. Nine kinds are
 * supported (section, metric, statusBadge, progress, table, list, timeline,
 * dag, disclosure); any other kind is safely ignored. The node is treated as
 * a typed same-process boundary (no runtime validation), so only optional
 * fields are hardened with `?? []` and render-time clamps.
 */
import type { ReactNode } from 'react'
import type { TaskStatus, TaskSurfaceNode } from './store.ts'
import css from './TaskUiPanel.module.css'

/** Status-dot hue class per task status (shared with the panel's task dots). */
export const statusDotClass: Record<TaskStatus, string> = {
  pending: css.dotPending,
  running: css.dotRunning,
  done: css.dotDone,
  blocked: css.dotBlocked,
  failed: css.dotFailed,
}

/** Status-badge tone class per accepted tone (unknown tones fall back to neutral). */
const TONE_CLASS: Record<string, string> = {
  neutral: css.badgeNeutral,
  success: css.badgeSuccess,
  warn: css.badgeWarn,
  error: css.badgeError,
  brand: css.badgeBrand,
}

/**
 * Render one surface node, dispatching on `kind`. Unknown or malformed kinds
 * render nothing.
 * @param surface - the surface node to render.
 * @returns the node's element tree, or null when the kind is unsupported.
 */
export function SurfaceView({ surface }: { surface: TaskSurfaceNode }): ReactNode {
  switch (surface.kind) {
    case 'section':
      return (
        <div className={css.surfaceSection}>
          {surface.title !== undefined && <div className={css.sectionTitle}>{surface.title}</div>}
          {(surface.children ?? []).map((child, index) => (
            <SurfaceView key={index} surface={child} />
          ))}
        </div>
      )
    case 'metric':
      return (
        <div className={css.metricRow}>
          <span className={css.metricLabel}>{surface.label}</span>
          <span className={css.metricValue}>
            {String(surface.value)}
            {surface.unit !== undefined && <span className={css.metricUnit}>{surface.unit}</span>}
          </span>
          {surface.trend !== undefined && <span className={css.metricTrend}>{surface.trend}</span>}
        </div>
      )
    case 'statusBadge':
      return (
        <span className={`${css.badge} ${TONE_CLASS[surface.tone ?? 'neutral'] ?? css.badgeNeutral}`}>
          {surface.label}
        </span>
      )
    case 'progress':
      return (
        <div className={css.progressRow}>
          {surface.label !== undefined && <div className={css.progressLabel}>{surface.label}</div>}
          <div className={css.progressTrack}>
            <div
              className={css.progressFill}
              style={{ width: `${Math.min(100, Math.max(0, surface.percent))}%` }}
            />
          </div>
        </div>
      )
    case 'table':
      return (
        <table className={css.table}>
          <thead>
            <tr>{surface.columns.map(column => <th key={column} className={css.tableCell}>{column}</th>)}</tr>
          </thead>
          <tbody>
            {surface.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className={css.tableCell}>{String(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'list':
      return (
        <ul className={css.surfaceList}>
          {surface.items.map((item, index) => (
            <li key={index} className={css.listItem}>{String(item)}</li>
          ))}
        </ul>
      )
    case 'timeline':
      return (
        <ol className={css.timeline}>
          {surface.events.map((event, index) => (
            <li key={index} className={css.timelineEvent}>
              <span className={css.eventTime}>{event.time}</span>
              <span className={css.eventTitle}>{event.title}</span>
              {event.detail !== undefined && <span className={css.eventDetail}>{event.detail}</span>}
            </li>
          ))}
        </ol>
      )
    case 'dag':
      return (
        <div className={css.dag}>
          <div className={css.dagNodes}>
            {surface.nodes.map(node => (
              <span key={node.id} className={css.dagNode}>
                <span
                  className={`${css.dagNodeDot} ${statusDotClass[node.status as TaskStatus] ?? css.dotNeutral}`}
                  aria-hidden="true"
                />
                {node.label}
              </span>
            ))}
          </div>
          {surface.edges !== undefined && surface.edges.length > 0 && (
            <div className={css.dagEdges}>
              {surface.edges.map((edge, index) => (
                <div key={index} className={css.dagEdge}>{edge.from} → {edge.to}</div>
              ))}
            </div>
          )}
        </div>
      )
    case 'disclosure':
      return (
        <details className={css.disclosure}>
          <summary className={css.disclosureTitle}>{surface.title}</summary>
          {(surface.children ?? []).map((child, index) => (
            <SurfaceView key={index} surface={child} />
          ))}
        </details>
      )
    default:
      return null
  }
}
