/**
 * Result flow-back: the three states of a child session's settle notice.
 *
 * The runtime writes its own account into the parent's log when a continuable
 * child settles — a `user/message` whose durable `source.kind` is
 * `subagent-settled` (with `summary` and `senderSessionId`), *not* an Agent
 * message: the runtime is stating what became of the child, and nothing in it
 * was written by the child (`@deepseek-ai/dsh-subagent/continuation-messages`).
 *
 * What this module is for (`docs/06` §3.3, `docs/10` M5-18/M5-19):
 *
 * · **Visibility only.** We never summarize a child's work, never mark anything
 *   in a session, and never touch the child's own state. The panel shows that a
 *   notice exists and what state it is in; reading the child is a jump away
 *   (`docs/01` F55: navigation belongs to the official surface).
 * · **Three states, ordered by evidence strength.** A `turn/start` *after* the
 *   notice is the strongest evidence that somebody already carried on
 *   (`continued`); a local "seen" mark is next (`seen`); otherwise the notice is
 *   still `unseen` and the panel must be able to show that at a glance.
 * · **Every notice is its own row.** A child that settled twice produced two
 *   notices and two rows; merging them would hide the second one.
 * · **Seq is the only clock.** Both notices and turn starts live in the same
 *   session log, and log seq is the one ordering that survives replay.
 *
 * ⚠️ "After" is deliberately strict (`seq >`): a notice and a turn start can
 * never share a seq in one log, and the contract is pinned by a test so the
 * judgement cannot quietly drift to `>=`.
 *
 * ⚠️ The local "seen" mark lives in **our own store**, never in the session
 * (`docs/06` §3.3: "已处理记在我们自己的 sqlite … 不写会话"). Until that store
 * is wired, callers pass an empty list and every notice reads `unseen`.
 */

import type { PendingRow, SettleNotice } from '../shared/types'

export type { PendingRow, PendingState, SettleNotice } from '../shared/types'

/**
 * A recorded request in the parent's log - the "somebody carried on" evidence.
 *
 * ⚠️ The fold records requests, not literal `turn/start` events, so a later
 * request seq IS the evidence we use: a request can only exist inside a turn
 * that started before it, so "a request after the notice" proves the parent ran
 * again. Equivalent in meaning and strictly more conservative (a turn that
 * started and produced nothing is not evidence that anyone acted).
 */
export interface TurnStart {
  readonly seq: number
  readonly at: number
}

/**
 * The seq of a turn/start-ish record, or null when the shape is unusable.
 * Takes `unknown` on purpose: this is host data, so the guard must not pretend
 * the declared type makes a runtime check redundant.
 */
function seqOfTurn(value: unknown): number | null {
  if (value === null || typeof value !== 'object') return null
  const seq = (value as { seq?: unknown }).seq
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : null
}

function isNotice(value: unknown): value is SettleNotice {
  if (value === null || typeof value !== 'object') return false
  const row = value as { seq?: unknown; childId?: unknown; summary?: unknown; at?: unknown }
  return typeof row.seq === 'number' && Number.isFinite(row.seq) && typeof row.childId === 'string' && row.childId !== ''
}

/**
 * Decide each notice's state.
 *
 * @param notices - settle notices found in the parent's log (any order).
 * @param seenSeqs - notice seqs marked seen in our own store (missing = none seen).
 * @param turnStarts - `turn/start` events of the same session.
 * @returns one row per valid notice, oldest first.
 */
export function pendingRowsOf(
  notices: readonly SettleNotice[],
  seenSeqs: readonly number[],
  turnStarts: readonly TurnStart[],
): PendingRow[] {
  const starts = turnStarts
    .map(seqOfTurn)
    .filter((seq): seq is number => seq !== null)
  const seen = new Set(seenSeqs.filter(seq => typeof seq === 'number' && Number.isFinite(seq)))
  return notices
    .filter(isNotice)
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map(notice => ({
      notice,
      state: starts.some(seq => seq > notice.seq) ? 'continued' : (seen.has(notice.seq) ? 'seen' : 'unseen'),
    }))
}

/** How many notices still want attention — the card's badge count. */
export function unseenCountOf(rows: readonly PendingRow[]): number {
  return rows.filter(row => row.state === 'unseen').length
}
