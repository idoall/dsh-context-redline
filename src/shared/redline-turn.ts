/**
 * "May this row be edited at all, right now?" — the turn-boundary half of the
 * panel's decision (`docs/03` R4.3; the demo's own `blocked = turnOpen || !live`).
 *
 * Two reasons a session is not editable, and they are NOT the same thing:
 *
 * · **the turn is open** — the model may still be reading the context as it stands,
 *   so an edit prepared now is prepared against a surface that is about to move.
 *   `AGENTS.md` §1 forbids relaxing this (`docs/01` F8: the platform itself does not
 *   police turn boundaries — the plugin does).
 * · **the process cannot tell** (`known: false`) — the session is not hosted here or
 *   its log cannot be observed, so the panel must offer "view only" instead of
 *   pretending everything is fine.
 *
 * Purity: no `node:*`, no DOM, no React — the host derives it and the panel shows it.
 */

/** One event, as far as the rule is concerned. */
export interface TurnBoundaryEvent {
  readonly type?: unknown
}

/** `known: false` = this process cannot decide (view-only, never "closed"). */
export interface TurnState {
  readonly known: boolean
  readonly open: boolean
}

/**
 * Whether the log's LAST turn boundary is a start: a trailing `turn/start` with no
 * matching `turn/end`.
 *
 * An unmatched `turn/end` is deliberately NOT "owed" a start: a fork prefix can
 * begin mid-history, so counting absolute starts against ends would report a
 * perfectly idle child session as open.
 */
export function hasOpenTurn(events: readonly (TurnBoundaryEvent | null | undefined)[]): boolean {
  let open = false
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

/**
 * Combine liveness with the boundary.
 *
 * @param live - whether this process hosts (and can observe) the session.
 * @param events - its events, or null when the log could not be read. Elements are
 *   untrusted: the host passes whatever the query service answered.
 */
export function turnStateOf(live: boolean, events: readonly (TurnBoundaryEvent | null | undefined)[] | null): TurnState {
  if (!live || events === null) return { known: false, open: false }
  return { known: true, open: hasOpenTurn(events) }
}
