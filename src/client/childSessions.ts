/**
 * The child-session half of the panel: the parent's **index of children**
 * (`subagentCatalog`) plus the two calls that open a new one (`child.plan` →
 * `child.start`).
 *
 * Three things this module deliberately does NOT do, all from `docs/03` R5.1.1:
 *
 * 1. **It does not draw a conversation.** The index lists identity + state and
 *    nothing else; the full view is the official UI's job (the runtime's own
 *    subagent package owns the tree picker in the parent header). R5.1.1 spells
 *    out why: copying a tree/dialog view would fight the official surface and
 *    drag a consistency problem we do not need.
 * 2. **It does not offer a jump.** The current demo only states the child's
 *    state ("open it = the panel switches to its context"); the actual jump is
 *    a later stage (`docs/10` M5-06 / M7-02).
 * 3. **It never guesses a state.** A child's "running / idle / not in this
 *    process" is read from the SAME `turnState` op the editor uses — one
 *    read-only call per child — so the row's sentence matches what pressing
 *    `编辑` there would actually do. Unknown stays unknown (`null`), and the
 *    row says so instead of claiming 空闲.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listSeen, markSeen, planChild, readTurnState, startChild, type ChildPlan, type ChildStarted, type RedlineResult } from './redlineChannel'
import { pendingRowsOf, type PendingRow } from '../shared/redline-pending'
import type { SettleNotice } from '../shared/types'

/** One row of the index. */
export interface ChildRow {
  readonly id: string
  /** The tail of the id, the way the official surface shows it. */
  readonly short: string
  readonly label: string
  /** `one-shot` / `continuable` / `unknown` — straight from the catalog entry. */
  readonly mode: 'one-shot' | 'continuable' | 'unknown'
  readonly createdAt: number
  /** `true` = this process hosts a live agent for it; `null` = not read yet. */
  readonly live: boolean | null
  /** `true` = its turn has not closed yet (writes are refused there too). */
  readonly open: boolean | null
}

interface CatalogEntryLike {
  readonly id?: unknown
  readonly label?: unknown
  readonly mode?: unknown
  readonly createdAt?: unknown
}

/**
 * Parse the `subagentCatalog` projection into rows.
 *
 * Pure and total on purpose: the projection is host data, so a malformed entry
 * must degrade to a row that says `unknown`, never throw inside render.
 *
 * @param raw - the projection value as it arrived (any shape).
 * @returns one row per usable entry, newest first (the fold appends).
 */
export function childRowsOf(raw: unknown): ChildRow[] {
  if (!Array.isArray(raw)) return []
  const rows: ChildRow[] = []
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as CatalogEntryLike
    const id = typeof entry.id === 'string' ? entry.id : null
    if (id === null) continue
    const mode = entry.mode === 'one-shot' || entry.mode === 'continuable' || entry.mode === 'unknown' ? entry.mode : 'unknown'
    rows.push({
      id,
      short: id.length > 8 && id.includes('-') ? id.slice(-8) : id,
      label: typeof entry.label === 'string' ? entry.label : '',
      mode,
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
      live: null,
      open: null,
    })
  }
  return rows.reverse()
}

export interface ChildController {
  /**
   * The settle notices' three-state judgement (`docs/06` §3.3): the host reports
   * the notices, WE merge them with our own "seen" marks. The judgement itself
   * lives in `src/shared/redline-pending.ts` — one place, both halves.
   */
  readonly pending: readonly PendingRow[]
  /** The index rows; `live`/`open` fill in as the per-child probes answer. */
  readonly rows: readonly ChildRow[]
  /** Open the confirm box: the five items the host builds for this exact task. */
  readonly plan: (humanTask: string) => Promise<RedlineResult<ChildPlan>>
  /** The only call in this whole panel that writes a session (`docs/11` D15). */
  readonly start: (humanTask: string) => Promise<RedlineResult<ChildStarted>>
  /**
   * Mark (or unmark) one notice as seen — a write to OUR own store only (never a
   * session, never the child's state). Resolves true when the host accepted it.
   */
  readonly markSeen: (seq: number, seen: boolean) => Promise<boolean>
  /** A failed marks read/write, for the card to show (`redline.err.<code>`). */
  readonly marksError: string | null
}

/**
 * Probe one row's state through the same read-only op the editor's gate uses.
 *
 * @param sessionId - the child's own session id.
 * @returns `live`/`open`, or `null`s when the read failed (never a guess).
 */
async function probeChild(sessionId: string): Promise<{ live: boolean; open: boolean } | null> {
  const state = await readTurnState(sessionId)
  if (!state.ok) return null
  return { live: state.value.known, open: state.value.open }
}

/**
 * Wire the index + the two child calls for one session.
 *
 * @param sessionId - the session the panel is showing (the would-be parent).
 * @param catalog - the raw `subagentCatalog` projection value.
 */
export function useChildSessions(
  sessionId: string | undefined,
  catalog: unknown,
  notices: readonly SettleNotice[] | undefined,
  lastRequestSeq: number | undefined,
): ChildController {
  const base = useMemo(() => childRowsOf(catalog), [catalog])
  const [states, setStates] = useState<Record<string, { live: boolean; open: boolean }>>({})
  const [seenSeqs, setSeenSeqs] = useState<number[]>([])
  const [marksError, setMarksError] = useState<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    generation.current += 1
    const mine = generation.current
    setStates({})
    if (base.length === 0) return
    // A handful of read-only calls; a child that answers after the panel moved on
    // must not write into the new session's index (same guard as the draft hook).
    void (async () => {
      const entries = await Promise.all(base.map(async row => [row.id, await probeChild(row.id)] as const))
      if (generation.current !== mine) return
      const next: Record<string, { live: boolean; open: boolean }> = {}
      for (const [id, state] of entries) if (state !== null) next[id] = state
      setStates(next)
    })()
  }, [base])

  // The marks are our own state, so they load once per session — independent of
  // the catalog (a session with no children yet can still have marks).
  const markGeneration = useRef(0)
  useEffect(() => {
    markGeneration.current += 1
    const mine = markGeneration.current
    setSeenSeqs([])
    setMarksError(null)
    if (sessionId === undefined || sessionId === '') return
    void (async () => {
      const answer = await listSeen(sessionId)
      if (markGeneration.current !== mine) return
      if (!answer.ok) { setMarksError(answer.code); return }
      // Re-prove the shape before adopting it: a stale/garbled answer must not
      // become the marks (and must never reach the judgement as a non-array).
      if (!Array.isArray(answer.value)) { setMarksError('redline/seen-corrupt'); return }
      setSeenSeqs(answer.value)
    })()
  }, [sessionId])

  const mark = useCallback(async (seq: number, seen: boolean): Promise<boolean> => {
    if (sessionId === undefined || sessionId === '') return false
    setMarksError(null)
    const answer = await markSeen(sessionId, seq, seen)
    if (!answer.ok) { setMarksError(answer.code); return false }
    setSeenSeqs(answer.value)
    return true
  }, [sessionId])

  const rows = useMemo(
    () => base.map(row => ({ ...row, ...(states[row.id] ?? { live: null, open: null }) })),
    [base, states],
  )

  const plan = useCallback(async (humanTask: string): Promise<RedlineResult<ChildPlan>> => {
    if (sessionId === undefined || sessionId === '') {
      return { ok: false, code: 'redline/not-live', message: 'no session' }
    }
    return await planChild(sessionId, humanTask)
  }, [sessionId])

  const start = useCallback(async (humanTask: string): Promise<RedlineResult<ChildStarted>> => {
    if (sessionId === undefined || sessionId === '') {
      return { ok: false, code: 'redline/not-live', message: 'no session' }
    }
    return await startChild(sessionId, humanTask)
  }, [sessionId])

  // The judgement runs here, not in the fold: one of its three inputs (our
  // "seen" marks) lives in our own store and must never ride a projection. The
  // other two are the host's notices and the newest request seq on the head.
  const pending = useMemo(
    () => pendingRowsOf(notices ?? [], seenSeqs, typeof lastRequestSeq === 'number' ? [{ seq: lastRequestSeq, at: 0 }] : []),
    [notices, seenSeqs, lastRequestSeq],
  )

  return useMemo(
    () => ({ rows, pending, markSeen: mark, marksError, plan, start }),
    [rows, pending, mark, marksError, plan, start],
  )
}
