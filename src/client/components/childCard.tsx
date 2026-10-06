/**
 * The child-session card: the always-here 「开子会话」 entry, the read-only index of
 * children, and the small confirm box the entry opens.
 *
 * The contract (all of it from `docs/03` R5.1 / R5.1.1 / R5.1.3 and `docs/11` D15):
 *
 * · **Two blocks only** — 开子会话 + 子会话索引. No freeze record, no dispatch, no official
 *   task board, no compaction, no interrupt: those are later stages (`docs/11` D10).
 * · **The index never draws a conversation** and offers no jump; it states identity + state and
 *   says in words what the state means for editing. The official surface owns the tree and the
 *   full view.
 * · **The button is gated exactly like `保存`**: a parent whose turn has not closed, or that is
 *   not live in this process, would be refused by the host (`redline/turn-open` /
 *   `redline/not-live`) — so it is disabled here first and says why, rather than letting the
 *   click fail.
 * · **The confirm box is the host's own five items** (`child.plan`), and the first message is
 *   written by the human only: the plugin never invents a word (`docs/11` D15, hard constraint).
 *   An empty task makes the plan itself refuse, and that refusal is shown instead of a dead button.
 */

import { createElement as h, useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react'
import type { ViewKit } from '../viewkit'
import type { ChildRow } from '../childSessions'
import type { ChildPlan, ChildStarted, RedlineResult } from '../redlineChannel'
import type { PendingRow } from '../../shared/types'

export interface ChildCardProps {
  /** The parent session the panel is showing. */
  readonly sessionId?: string
  /** The index, already probed (`childSessions.ts`). */
  readonly rows: readonly ChildRow[]
  /** The parent is live in this process (`turnState.known`). */
  readonly live: boolean
  /** The parent's turn has not closed yet. */
  readonly turnOpen: boolean
  /** How many local edits the confirm box will carry (0 → the sentence says "no edits"). */
  readonly carriedCount: number
  /**
   * Result flow-back rows from the parent's log (`docs/06` §3.3): one per
   * `subagent-settled` notice, judged by the host. Absent = this log has no
   * notices (or an older host half), which simply means no badge.
   */
  readonly pending?: readonly PendingRow[]
  /** Mark (or unmark) one notice as seen — our own store only. */
  readonly onMarkSeen?: (seq: number, seen: boolean) => void
  /** A failed marks read/write, shown as `redline.err.<code>`. */
  readonly marksError?: string | null
  /** `child.plan` — read-only, builds the five items for this exact task text. */
  readonly plan: (humanTask: string) => Promise<RedlineResult<ChildPlan>>
  /** `child.start` — the ONLY session write the panel can perform. */
  readonly start: (humanTask: string) => Promise<RedlineResult<ChildStarted>>
}

/** The state dot + word a row shows, from the probed `turnState`. */
function stateOf(row: ChildRow): { tone: string; key: string; hint: string } {
  if (row.live === null) return { tone: 'unknown', key: 'child.state.unknown', hint: 'child.hint.unknown' }
  if (!row.live) return { tone: 'gone', key: 'child.state.gone', hint: 'child.hint.gone' }
  return row.open === true
    ? { tone: 'run', key: 'child.state.running', hint: 'child.hint.running' }
    : { tone: 'idle', key: 'child.state.idle', hint: 'child.hint.idle' }
}

/** `HH:MM` for a `createdAt` timestamp; an unreadable stamp shows nothing. */
function clockOf(createdAt: number): string | null {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null
  const date = new Date(createdAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function makeChildCard(kit: ViewKit): (props: ChildCardProps) => ReactElement {
  const { t } = kit

  return function ChildCard(props): ReactElement {
    const [open, setOpen] = useState(false)
    const [task, setTask] = useState('')
    const [plan, setPlan] = useState<ChildPlan | null>(null)
    const [busy, setBusy] = useState(false)
    const [errorCode, setErrorCode] = useState<string | null>(null)
    const [started, setStarted] = useState<ChildStarted | null>(null)
    // A late plan answer for an older task must not overwrite the newer one.
    const generation = useRef(0)

    const blockedKey = !props.live
      ? 'redline.blocked.notLive'
      : props.turnOpen ? 'redline.blocked.turnOpen' : null

    const close = useCallback(() => {
      setOpen(false)
      setPlan(null)
      setErrorCode(null)
      setStarted(null)
    }, [])

    // The confirm box's five items come from the host and depend on the task text
    // (item 3 IS that text, and the refusal fires on an empty one), so refetch on change —
    // debounced, because every keystroke would otherwise be a round trip.
    useEffect(() => {
      if (!open) return
      generation.current += 1
      const mine = generation.current
      const timer = setTimeout(() => {
        void (async () => {
          const answer = await props.plan(task)
          if (generation.current !== mine) return
          if (!answer.ok) { setErrorCode(answer.code); setPlan(null); return }
          setErrorCode(null)
          setPlan(answer.value)
        })()
      }, 220)
      return () => { clearTimeout(timer) }
    }, [open, task, props.plan])

    const refused = plan !== null && plan.refusal !== null
    const confirm = useCallback(() => {
      if (busy || plan === null || refused) return
      setBusy(true)
      setErrorCode(null)
      void (async () => {
        const answer = await props.start(task)
        setBusy(false)
        if (!answer.ok) { setErrorCode(answer.code); return }
        setStarted(answer.value)
        setPlan(null)
      })()
    }, [busy, plan, refused, props.start, task])

    const active = props.rows.filter(row => row.live === true && row.open === true).length
    // Result flow-back: how many settle notices nobody has dealt with. The host
    // does the judging (`src/redline/pending.ts`); the card only counts.
    const unseen = (props.pending ?? []).filter(item => item.state === 'unseen').length
    const errKey = errorCode === null ? null : `redline.err.${errorCode.replace('redline/', '')}`
    const marksKey = props.marksError == null ? null : `redline.err.${props.marksError.replace('redline/', '')}`

    return h('div', { className: 'redline-card' },
      h('div', { className: 'redline-card-title' },
        h('span', { className: 'redline-card-title-text' }, t('child.title')),
        h('span', { className: 'redline-card-scale' }, t('child.bmeta', { a: active, n: props.rows.length })),
        unseen > 0
          ? h('span', { className: 'redline-settled redline-settled-unseen', 'data-redline-unseen': String(unseen), title: t('child.settled.tip') },
            h('i', { className: 'redline-settled-dot' }), t('child.settled.count', { n: unseen }))
          : null,
      ),

      h('section', { className: 'redline-orch-block', 'data-redline-block': 'spawn' },
        h('div', { className: 'redline-orch-head' }, t('child.spawn.head'),
          h('span', { className: 'redline-orch-hint' }, t('child.spawn.hint'))),
        h('div', { className: 'redline-orch-toolbar' },
          h('button', {
            type: 'button',
            className: 'redline-btn',
            'data-redline-spawn': '1',
            disabled: blockedKey !== null,
            onClick: () => { setTask(''); setStarted(null); setOpen(true) },
          }, t('child.spawn.button')),
          h('span', { className: 'redline-cap' }, t('child.spawn.note')),
        ),
        blockedKey !== null ? h('div', { className: 'redline-cap' }, t(blockedKey)) : null,
        marksKey === null ? null : h('div', { className: 'redline-editor-err', role: 'alert' }, t(marksKey)),
      ),

      h('section', { className: 'redline-orch-block', 'data-redline-block': 'children' },
        h('div', { className: 'redline-orch-head' }, t('child.list.head'),
          h('span', { className: 'redline-orch-hint' }, t('child.list.hint'))),
        props.rows.length === 0
          ? h('div', { className: 'redline-cap' }, t('child.empty'))
          : props.rows.map((row) => {
            const state = stateOf(row)
            const settled = props.pending?.find(item => item.notice.childId === row.id)
            const clock = clockOf(row.createdAt)
            return h('div', { className: 'redline-orch-row', key: row.id, 'data-redline-child': row.id },
              h('div', { className: 'redline-orch-id' },
                h('span', { className: 'redline-snapid' }, row.short),
                h('span', { className: 'redline-chip-soft' }, t('child.mode.' + row.mode)),
                h('span', { className: 'redline-badge-state' },
                  h('i', { className: 'redline-mstat redline-mstat-' + state.tone }),
                  t(state.key)),
                settled === undefined
                  ? null
                  : h('span', {
                    className: 'redline-settled redline-settled-' + settled.state,
                    'data-redline-settled': settled.state,
                    title: t('child.settled.tip') + '\n' + settled.notice.summary,
                  }, h('i', { className: 'redline-settled-dot' }), t('child.settled'), ' · ', t('child.settled.' + settled.state)),
                // No mark button on `continued`: the parent already carried on, and the
                // state stays `continued` either way — a control that cannot change what
                // the row shows is exactly the fake button this project refuses to ship.
                settled === undefined || settled.state === 'continued' || props.onMarkSeen === undefined
                  ? null
                  : h('button', {
                    type: 'button',
                    className: 'redline-settled-act',
                    'data-redline-seen': settled.notice.seq,
                    title: t('child.settled.tip'),
                    onClick: () => { props.onMarkSeen?.(settled.notice.seq, settled.state !== 'seen') },
                  }, t(settled.state === 'seen' ? 'child.seen.unmark' : 'child.seen.mark')),
                row.label === '' ? null : h('span', { className: 'redline-cap' }, row.label),
                clock === null ? null : h('span', { className: 'redline-cap' }, clock),
              ),
              h('div', { className: 'redline-orch-actions' },
                h('span', { className: 'redline-cap' }, t(state.hint))),
            )
          }),
      ),

      open
        ? h('div', {
          className: 'redline-modal-backdrop',
          onMouseDown: (event: { target: unknown; currentTarget: unknown }) => {
            if (event.target === event.currentTarget) close()
          },
        }, h('div', { className: 'redline-modal-card', role: 'dialog', 'aria-modal': 'true', 'data-redline-confirm': '1' },
          h('div', { className: 'redline-modal-head' },
            h('span', { className: 'redline-modal-title' }, t('child.confirm.title')),
            h('button', { type: 'button', className: 'redline-modal-close', onClick: close }, '×'),
          ),
          started !== null
            ? h('div', { className: 'redline-ok', 'data-redline-started': started.label },
              t('child.confirm.started', { label: started.label }))
            : plan === null
              ? h('div', { className: 'redline-cap' }, t('child.confirm.preparing'))
              : h('ul', { className: 'redline-confirm-list' },
                plan.items.map(item => h('li', { key: item.label },
                  h('b', null, item.label),
                  h('span', null, item.text)))),
          errKey !== null ? h('div', { className: 'redline-editor-err', role: 'alert' }, t(errKey)) : null,
          started === null
            ? h('label', { className: 'redline-confirm-field' },
              h('span', null, t('child.confirm.taskLabel')),
              h('textarea', {
                className: 'redline-editor-text',
                rows: 3,
                'data-redline-task': '1',
                placeholder: t('child.confirm.taskPlaceholder'),
                value: task,
                onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setTask(event.target.value) },
              }))
            : null,
          plan !== null && plan.refusal !== null
            ? h('div', { className: 'redline-editor-blocked', 'data-redline-refusal': plan.refusal.code }, plan.refusal.message)
            : null,
          plan !== null && plan.carriedSeqs.length > 0
            ? h('div', { className: 'redline-cap' }, '#' + plan.carriedSeqs.join(' · #'))
            : null,
          h('div', { className: 'redline-modal-foot' },
            h('button', {
              type: 'button',
              className: 'redline-btn',
              'data-redline-confirm-ok': '1',
              disabled: busy || plan === null || refused || started !== null,
              onClick: confirm,
            }, t('child.confirm.ok')),
            h('button', { type: 'button', className: 'redline-btn redline-btn-quiet', onClick: close }, t('child.confirm.cancel')),
            h('span', { className: 'redline-cap' }, t('child.confirm.note')),
          ),
        ))
        : null,
    )
  }
}
