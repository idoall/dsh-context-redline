/**
 * One session card in the Context Dashboard's grid: the row's title (wrap-
 * clamped), last-activity and first-active times, and the directory over a
 * mini composition donut (the same seven-category ring the stats board
 * draws, at card scale) and the three figures a user scans for — turns and
 * steps, billed tokens, cost. A row whose host folded nothing yet degrades
 * to a metadata-only card (never an error). The whole card is one button:
 * clicking opens the session (the panel's `onOpen`).
 */

import type { ReactElement } from 'react'
import { billedOf, createdDayOf, projectOf, relativeTime, turnsOf, type OverviewRow } from '../overview'
import { partsOf } from '../categories'
import { fmt, fmtShare } from '../format'
import type { ViewKit } from '../viewkit'
import { makeDonut } from './donut'

export interface OverviewCardProps {
  row: OverviewRow
  /** The workspace title claiming this session, when one does (the breadcrumb's group). */
  group?: string
  /** The priced cost label ('—' until the price book lands or nothing billed). */
  costLabel: string
  /** Render instant for the relative-time label. */
  now: number
  onOpen(id: string): void
}

export function makeOverviewCard(kit: ViewKit): (props: OverviewCardProps) => ReactElement {
  const { t } = kit
  const Donut = makeDonut(kit)
  return function OverviewCard(props: OverviewCardProps): ReactElement {
    const { row } = props
    const timeline = row.timeline
    const billed = billedOf(timeline)
    const occupancy = timeline !== null && typeof timeline.contextWindow === 'number' && timeline.contextWindow > 0
      ? fmtShare(timeline.current.total, timeline.contextWindow)
      : null
    // The lead figure: turns and steps when the fold reported counts, the
    // bare turns estimate otherwise (a counts-less head falls back to the
    // request tally inside turnsOf).
    const turns = turnsOf(timeline)
    const steps = timeline?.counts?.steps
    const turnsLabel = steps === undefined ? String(turns) : t('ov.card.turns', { n: turns, s: steps })
    // The breadcrumb: group (workspace title) / project (cwd basename); a
    // session with neither drops the row, and the full path stays on the tip.
    // A workspace whose title IS the project (the common single-repo case)
    // shows the name ONCE — never "dsh-context-redline / dsh-context-redline".
    const project = projectOf(row.cwd)
    const group = props.group !== undefined && props.group !== project ? props.group : undefined
    const created = createdDayOf(row.activity)
    // The footer preview: the user's newest own message, one muted hairline-
    // separated line. Absent from rows folded before the fold carried it —
    // the row just stays off the card.
    const lastUser = timeline?.lastUser
    return (
      <button
        type="button"
        className={'redline-ov-session' + (row.current ? ' redline-ov-session-current' : '')}
        onClick={() => { props.onOpen(row.id) }}
      >
        <span className="redline-ov-session-head">
          {row.running && <span className="redline-ov-running" title={t('ov.running')} />}
          <span className="redline-ov-session-title" title={row.title}>{row.title}</span>
          {row.current && <span className="redline-ov-current">{t('ov.current')}</span>}
          <span className="redline-ov-session-times">
            <span className="redline-ov-session-time">{relativeTime(t, row.updatedAt, props.now)}</span>
            {created !== undefined && <span className="redline-ov-session-created">{created}</span>}
          </span>
        </span>
        {(group !== undefined || project !== undefined) && (
          <span className="redline-ov-session-crumb" title={row.cwd}>
            {group !== undefined && <span className="redline-ov-crumb-group">{group}</span>}
            {group !== undefined && project !== undefined && <span className="redline-ov-crumb-sep">/</span>}
            {project !== undefined && <span className="redline-ov-crumb-project">{project}</span>}
          </span>
        )}
        {timeline === null ? (
          <span className="redline-ov-session-empty">{t('ov.list.noData')}</span>
        ) : (
          <span className="redline-ov-session-body">
            <Donut
              size={64}
              segments={partsOf(timeline.current)}
              centerTop={fmt(timeline.current.total)}
              centerSub={occupancy ?? undefined}
            />
            <span className="redline-ov-mini-stats">
              <span className="redline-ov-mini-stat">
                <span className="redline-ov-mini-label">{t('stats.turns')}</span>
                <span className="redline-ov-mini-value">{turnsLabel}</span>
              </span>
              <span className="redline-ov-mini-stat">
                <span className="redline-ov-mini-label">{t('tokens.total')}</span>
                <span className="redline-ov-mini-value">{billed === null ? '—' : fmt(billed)}</span>
              </span>
              <span className="redline-ov-mini-stat">
                <span className="redline-ov-mini-label">{t('stats.cost')}</span>
                <span className="redline-ov-mini-value">{props.costLabel}</span>
              </span>
            </span>
          </span>
        )}
        {lastUser !== undefined && (
          <span className="redline-ov-session-preview" title={lastUser}>
            <span className="redline-ov-session-preview-label">{t('ov.card.lastUser')}</span>
            <span className="redline-ov-session-preview-text">{lastUser}</span>
          </span>
        )}
      </button>
    )
  }
}
