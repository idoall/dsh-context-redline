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
import type { ChildIndexRow, ChildRow } from '../childSessions'
import { UNKNOWN_CAPACITY, type ChildCapacity } from '../../shared/redline-capacity'
import type { ChildPlan, ChildStarted, RedlineResult } from '../redlineChannel'

export interface ChildCardProps {
  /** The parent session the panel is showing. */
  readonly sessionId?: string
  /** The index, already probed (`childSessions.ts`). */
  readonly rows: readonly ChildIndexRow[]
  /** 我们那本来源台账读得出来吗（缺省按"读得出来"处理，独立渲染时行为可预期）。 */
  readonly originsKnown?: boolean
  /** 读不出来时的**原因**（错误码）；界面要把它说成人话，不许只写"来源未知"。 */
  readonly originsError?: string | null
  /** 这台机器允许几个团队成员（M5-13 的分母）；缺省 = 不知道。 */
  readonly capacity?: ChildCapacity
  /** The parent is live in this process (`turnState.known`). */
  readonly live: boolean
  /** The parent's turn has not closed yet. */
  readonly turnOpen: boolean
  /** How many local edits the confirm box will carry (0 → the sentence says "no edits"). */
  readonly carriedCount: number
  /** `child.plan` — read-only, builds the five items for this exact task text. */
  readonly plan: (humanTask: string) => Promise<RedlineResult<ChildPlan>>
  /** `child.start` — the ONLY session write the panel can perform. */
  readonly start: (humanTask: string, draftRevision: string) => Promise<RedlineResult<ChildStarted>>
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
        const answer = await props.start(task, plan.draftRevision)
        setBusy(false)
        if (!answer.ok) { setErrorCode(answer.code); return }
        setStarted(answer.value)
        setPlan(null)
      })()
    }, [busy, plan, refused, props.start, task])

    // ⚠️ 口径跟 demo（`renderOrch()` 的 `state === 'running' || state === 'idle'`）：
    // 「活跃」= **在场的子会话**（运行中 + 空闲），**不是**"只有正在跑的" ——
    // 2026-10-07 真机读数时发现我们原先少算了一半（只在 `open` 为真时计数）。
    const active = props.rows.filter(row => row.live === true).length
    const capacity = props.capacity ?? UNKNOWN_CAPACITY
    // 分母只在**真读到**的时候写；读不到就只写 `活跃 N`（绝不编 8 / 16，`docs/01` F31）。
    const scale = capacity.known && capacity.max !== null
      ? t('child.bmeta.cap', { a: active, max: capacity.max, n: props.rows.length })
      : t('child.bmeta', { a: active, n: props.rows.length })
    const atCap = capacity.known && capacity.max !== null && active >= capacity.max
    const errKey = errorCode === null ? null : `redline.err.${errorCode.replace('redline/', '')}`

    return h('div', { className: 'redline-card' },
      h('div', { className: 'redline-card-title' },
        h('span', { className: 'redline-card-title-text' }, t('child.title')),
        h('span', { className: 'redline-card-scale' }, scale),
      ),

      h('section', { className: 'redline-orch-block', 'data-redline-block': 'spawn' },
        h('div', { className: 'redline-orch-head' }, t('child.spawn.head'),
          h('span', { className: 'redline-orch-hint' }, t('child.spawn.hint'))),
        h('div', { className: 'redline-orch-toolbar' },
          h('button', {
            type: 'button',
            className: 'redline-btn',
            'data-redline-spawn': '1',
            disabled: blockedKey !== null || atCap,
            onClick: () => { setTask(''); setStarted(null); setOpen(true) },
          }, t('child.spawn.button')),
          h('span', { className: 'redline-cap' }, t('child.spawn.note')),
        ),
        blockedKey !== null ? h('div', { className: 'redline-cap' }, t(blockedKey)) : null,
      ),

      h('section', { className: 'redline-orch-block', 'data-redline-block': 'children' },
        h('div', { className: 'redline-orch-head' }, t('child.list.head'),
          h('span', { className: 'redline-orch-hint' }, t('child.list.hint'))),
        atCap
          ? h('div', { className: 'redline-cap', 'data-redline-cap': '1' }, t('child.cap.reached', { max: capacity.max }))
          : null,
        props.originsError === undefined || props.originsError === null
          ? null
          : h('div', { className: 'redline-cap', 'data-redline-origins-error': props.originsError },
            t('redline.err.' + props.originsError.replace('redline/', ''))),
        props.rows.length === 0
          ? h('div', { className: 'redline-cap' }, t('child.empty'))
          : props.rows.map((row) => {
            const state = stateOf(row)
            const clock = clockOf(row.createdAt)
            return h('div', { className: 'redline-orch-row', key: row.id, 'data-redline-child': row.id },
              h('div', { className: 'redline-orch-id' },
                h('span', { className: 'redline-snapid' }, row.short),
                h('span', { className: 'redline-chip-soft' }, t('child.mode.' + row.mode)),
                // 来源（M5-12）：三态各自一句 —— 台账里有说是哪条路；没有说"不是在这儿开的"；
                // 台账读不出来说"来源未知"。**不猜**（官方目录里没有来源字段，docs/01 F59）。
                (() => {
                  const known = props.originsKnown !== false
                  const tone = !known ? 'unknown' : row.via == null ? 'other' : 'own'
                  const key = !known
                    ? 'child.src.unknown'
                    : row.via === 'official-member' ? 'child.src.own.official'
                      : row.via === 'bare-child' ? 'child.src.own.bare' : 'child.src.other'
                  return h('span', { className: 'redline-src redline-src-' + tone, 'data-redline-src': tone, title: t('child.src.tip') }, t(key))
                })(),
                h('span', { className: 'redline-badge-state' },
                  h('i', { className: 'redline-mstat redline-mstat-' + state.tone }),
                  t(state.key)),
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
              t('child.confirm.started', { label: started.label }),
              h('span', { className: 'redline-cap', 'data-redline-via': started.via ?? 'unknown' },
                started.via === 'official-member' ? t('child.via.official')
                  : started.via === 'bare-child' ? t('child.via.bare')
                    : t('child.via.unknown')))
            : plan === null
              ? h('div', { className: 'redline-cap' }, t('child.confirm.preparing'))
              : h('ul', { className: 'redline-confirm-list' },
                plan.metrics === null || typeof plan.metrics.bytes !== 'number'
                  ? null
                  : h('li', { key: 'metrics' },
                    h('span', { className: 'redline-confirm-label' }, t('child.confirm.metrics.label')),
                    h('span', { className: 'redline-confirm-text', 'data-redline-first-task': String(plan.metrics.bytes) },
                      t('child.confirm.metrics', { bytes: plan.metrics.bytes, edits: plan.metrics.edits }))),
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
