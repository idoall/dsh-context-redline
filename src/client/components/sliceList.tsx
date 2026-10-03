/**
 * The stats cards' slice rows: the donut's legend with numbers, two tiers
 * per slice — the primary line pairs the color dot and the name with the
 * bold share closing a fixed right column, and the secondary line drops the
 * absolute quantity (plus a qualifier like the call count) under the name in
 * muted small print. Hovering a row lights it and its donut segment together
 * (the shared hover key), and vice versa. No tracks or bars — the donut IS
 * the proportion chart; the rows are its legend. Preformatted strings in,
 * dumb markup out.
 */

import { type ReactElement } from 'react'
import type { ViewKit } from '../viewkit'

export interface SliceRow {
  key: string
  color: string
  label: string
  /** Preformatted leading share ('84%', '<1%', '—'). */
  pct: string
  /** Preformatted secondary line ('204.9k', '4m 0s · 10 calls'); empty renders no line. */
  count: string
  /** A zero-figure slice dims whole — the ring already carries the share. */
  dim?: boolean
}

export function makeSliceList(kit: ViewKit): (props: {
  rows: SliceRow[]
  /** The hovered slice key — the legend row ↔ segment hover link. */
  hoverKey?: string | null
  /** Hover relay; absent renders the rows inert. */
  onHoverKey?: (key: string | null) => void
}) => ReactElement {
  void kit
  return function SliceList(props: {
    rows: SliceRow[]
    hoverKey?: string | null
    onHoverKey?: (key: string | null) => void
  }): ReactElement {
    return (
      <div className="redline-sl flex-auto @max-[240px]/redline-card:basis-full" onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}>
        {props.rows.map(r => (
          <div
            key={r.key}
            className={'redline-sl-row'
              + (r.dim ? ' redline-sl-row-dim' : '')
              + (props.hoverKey !== undefined && props.hoverKey === r.key ? ' redline-sl-row-on' : '')}
            onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(r.key) }}
          >
            <div className="redline-sl-main">
              <i className="redline-sl-dot" style={{ background: r.color }} />
              <span className="redline-sl-label" title={r.label}>{r.label}</span>
              <span className="redline-sl-pct">{r.pct}</span>
            </div>
            {r.count !== '' ? <div className="redline-sl-sub" title={r.count}>{r.count}</div> : null}
          </div>
        ))}
      </div>
    )
  }
}
