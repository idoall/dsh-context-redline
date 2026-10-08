/**
 * The panel's local-edit state: one loaded `DraftTable` per session, plus the
 * save/discard calls the rows make.
 *
 * Three rules this hook exists to keep, all from the hard constraint of
 * `docs/11` D15 ("every save is temporary"):
 *
 * 1. **A save only ever writes our own store.** Nothing here touches the session
 *    log; the only call it makes is `draft.update` on our channel, and the host
 *    answers with the new table — which this hook then adopts as the truth. No
 *    optimistic merge of our own construction: a refusal (`redline/no-change`,
 *    `redline/empty-content`) must leave the stored table exactly as it was.
 * 2. **A refusal is shown, never swallowed** (`docs/03` R3.5): the failing row
 *    keeps the user's input and displays the reason, mapped from the STABLE code
 *    by the component (`redline.err.<code>`).
 * 3. **One request at a time per row**, so a double click cannot interleave two
 *    saves of the same row.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DraftTable } from '../shared/redline-drafts'
import { dropDraft, excludeDraft, listDrafts, readRow, readTurnState, saveDraft, type DraftEdit, type RedlineResult, type RedlineRow } from './redlineChannel'
import type { TurnState } from '../shared/redline-turn'

/** The per-row failure the editor shows, keyed by the row it belongs to. */
export interface RedlineRowError {
  readonly seq: number
  /** A stable code (`redline/*`), or `redline/transport`. */
  readonly code: string
}

export interface RedlineDraftController {
  /** The local edits in effect (the row markers and the prefill read this). */
  readonly table: DraftTable
  /**
   * Whether editing is allowed at all right now. `known:false` = view only;
   * `open:true` = the turn has not closed. The panel disables `保存` on both and
   * says why (`docs/03` R4.3) — before any round trip, like the demo does.
   */
  readonly turn: TurnState
  /** False until the first load settles — the panel shows nothing edited before that. */
  readonly ready: boolean
  /** The row currently saving/dropping, so its buttons can disable. */
  readonly busySeq: number | null
  /** The last refusal/failure for the editor to display. */
  readonly rowError: RedlineRowError | null
  /** One row's COMPLETE content — what the editor prefills from (`docs/01` F35). */
  loadRow(seq: number): Promise<RedlineResult<RedlineRow>>
  /** Resolves true only when the save was accepted (so the editor knows to close). */
  save(seq: number, edit: DraftEdit): Promise<boolean>
  /** Resolves true only when the discard was accepted. */
  drop(seq: number): Promise<boolean>
  /** 标为「不要」/ 取消标记（`docs/11` D65）。解析为 true 表示宿主接受了。 */
  exclude(seq: number, on: boolean): Promise<boolean>
  /** Forget a row's error (the next open starts clean). */
  clearError(): void
}

/**
 * Load and mutate one session's local edits.
 *
 * @param sessionId - the session whose rows are shown; `undefined` keeps it idle
 *   (a slot can mount before the framework hands a session over).
 */
export function useRedlineDrafts(sessionId: string | undefined): RedlineDraftController {
  const [table, setTable] = useState<DraftTable>({})
  const [ready, setReady] = useState(false)
  const [busySeq, setBusySeq] = useState<number | null>(null)
  const [rowError, setRowError] = useState<RedlineRowError | null>(null)
  const [turn, setTurn] = useState<TurnState>({ known: true, open: false })
  // A late answer from a previous session must not overwrite the current one.
  const generation = useRef(0)

  useEffect(() => {
    generation.current += 1
    const mine = generation.current
    setTable({})
    setReady(false)
    setRowError(null)
    setTurn({ known: true, open: false })
    if (sessionId === undefined || sessionId === '') return
    void (async () => {
      const [drafts, state] = await Promise.all([listDrafts(sessionId), readTurnState(sessionId)])
      if (generation.current !== mine) return
      if (drafts.ok) setTable(drafts.value)
      else setRowError({ seq: -1, code: drafts.code })
      // A failed state read must not silently look "editable": `known:false` is the
      // honest answer (view only), and the panel says so.
      setTurn(state.ok ? state.value : { known: false, open: false })
      setReady(true)
    })()
  }, [sessionId])

  const save = useCallback(async (seq: number, edit: DraftEdit): Promise<boolean> => {
    if (sessionId === undefined || sessionId === '') return false
    setBusySeq(seq)
    setRowError(null)
    const result = await saveDraft(sessionId, seq, edit)
    setBusySeq(current => (current === seq ? null : current))
    if (!result.ok) { setRowError({ seq, code: result.code }); return false }
    setTable(result.value)
    return true
  }, [sessionId])

  const exclude = useCallback(async (seq: number, on: boolean): Promise<boolean> => {
    if (sessionId === undefined || sessionId === '') return false
    setBusySeq(seq)
    setRowError(null)
    const result = await excludeDraft(sessionId, seq, on)
    setBusySeq(current => (current === seq ? null : current))
    if (!result.ok) { setRowError({ seq, code: result.code }); return false }
    setTable(result.value)
    return true
  }, [sessionId])

  const drop = useCallback(async (seq: number): Promise<boolean> => {
    if (sessionId === undefined || sessionId === '') return false
    setBusySeq(seq)
    setRowError(null)
    const result = await dropDraft(sessionId, seq)
    setBusySeq(current => (current === seq ? null : current))
    if (!result.ok) { setRowError({ seq, code: result.code }); return false }
    setTable(result.value)
    return true
  }, [sessionId])

  const loadRow = useCallback(async (seq: number): Promise<RedlineResult<RedlineRow>> => {
    if (sessionId === undefined || sessionId === '') {
      return { ok: false, code: 'redline/not-live', message: 'no session' }
    }
    return await readRow(sessionId, seq)
  }, [sessionId])

  const clearError = useCallback(() => { setRowError(null) }, [])

  return useMemo(
    () => ({ table, turn, ready, busySeq, rowError, loadRow, save, drop, exclude, clearError }),
    [table, turn, ready, busySeq, rowError, loadRow, save, drop, exclude, clearError],
  )
}
