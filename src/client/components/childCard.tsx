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
 *   An empty task makes the plan itself refuse; the confirm button is then disabled. The refusal stays
 *   observable (`data-redline-refusal` on the task block), but its sentence is NOT printed any more —
 *   the user asked to drop it (2026-10-08).
 */

import { createElement as h, useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { ViewKit } from '../viewkit'
import type { ChildIndexRow, ChildRow } from '../childSessions'
import type { ChildCapacity } from '../../shared/redline-capacity'
import type { CarrierModelOption, ChildPlan, ChildStarted, RedlineResult } from '../redlineChannel'

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
  /** Live model catalog; choosing one only configures the new carrier. */
  readonly models?: readonly CarrierModelOption[]
  /** The parent is live in this process (`turnState.known`). */
  readonly live: boolean
  /** The parent's turn has not closed yet. */
  readonly turnOpen: boolean
  /** How many local edits the confirm box will carry (0 → the sentence says "no edits"). */
  readonly carriedCount: number
  /** `child.plan` — read-only, builds the five items for this exact task text. */
  readonly plan: (humanTask: string) => Promise<RedlineResult<ChildPlan>>
  /** `child.start` — the ONLY session write the panel can perform. */
  readonly start: (
    humanTask: string,
    confirmationToken: string,
    finalText?: string,
    config?: { provider: string; model: string; reasoningEffort?: string },
  ) => Promise<RedlineResult<ChildStarted>>
}

interface CarrierSelectionBarProps {
  readonly models: readonly CarrierModelOption[]
  readonly selectedRoute: string
  readonly selectedEffort: string
  readonly onRoute: (route: string) => void
  readonly onEffort: (effort: string) => void
  readonly t: ViewKit['t']
}

function CarrierSelectionBar(props: CarrierSelectionBarProps): ReactElement {
  const [open, setOpen] = useState<'model' | 'effort' | null>(null)
  const modelRef = useRef<HTMLButtonElement | null>(null)
  const effortRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  const selected = props.models.find(model => JSON.stringify([model.provider, model.model]) === props.selectedRoute)
  const effortLabel = props.selectedEffort === ''
    ? props.t('child.confirm.effortDefault')
    : selected?.efforts.find(level => level.id === props.selectedEffort)?.name ?? props.selectedEffort

  useLayoutEffect(() => {
    if (open === null) return
    const trigger = open === 'model' ? modelRef.current : effortRef.current
    if (trigger === null) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(Math.max(open === 'model' ? 300 : 220, rect.width), window.innerWidth - 32)
    const left = Math.min(Math.max(16, rect.left), window.innerWidth - width - 16)
    setMenuStyle({ left, width, bottom: window.innerHeight - rect.top + 6, maxHeight: Math.max(120, rect.top - 22) })
  }, [open])

  useEffect(() => {
    if (open === null) return
    const dismiss = (event: MouseEvent): void => {
      const node = event.target
      if (!(node instanceof Node) || menuRef.current?.contains(node) === true
        || modelRef.current?.contains(node) === true || effortRef.current?.contains(node) === true) return
      setOpen(null)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(null) }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const toggle = (pane: 'model' | 'effort'): void => { setOpen(current => current === pane ? null : pane) }
  const groups = new Map<string, { name: string; models: CarrierModelOption[] }>()
  for (const model of props.models) {
    const group = groups.get(model.provider) ?? { name: model.providerName, models: [] }
    group.models.push(model)
    groups.set(model.provider, group)
  }
  const menu = open === null ? null : createPortal(h('div', {
    ref: menuRef,
    className: 'redline-picker-menu scrollable',
    style: menuStyle,
    role: 'menu',
    'data-redline-picker-menu': open,
  }, open === 'model'
    ? [...groups.entries()].map(([provider, group]) => h('section', { key: provider, className: 'redline-picker-group' },
      h('div', { className: 'redline-picker-group-label' }, group.name),
      group.models.map((model) => {
        const route = JSON.stringify([model.provider, model.model])
        const active = route === props.selectedRoute
        return h('button', {
          type: 'button', role: 'menuitemradio', 'aria-checked': active,
          className: 'redline-picker-option' + (active ? ' is-selected' : ''),
          key: route,
          onClick: () => { props.onRoute(route); setOpen(null) },
        }, h('span', null, model.modelName), h('span', { className: 'redline-picker-check' }, active ? '✓' : ''))
      })))
    : h('div', null,
      [{ id: '', name: props.t('child.confirm.effortDefault') }, ...(selected?.efforts ?? [])].map((level) => {
        const active = level.id === props.selectedEffort
        return h('button', {
          type: 'button', role: 'menuitemradio', 'aria-checked': active,
          className: 'redline-picker-option' + (active ? ' is-selected' : ''),
          key: level.id || 'default',
          onClick: () => { props.onEffort(level.id); setOpen(null) },
        }, h('span', null, level.name), h('span', { className: 'redline-picker-check' }, active ? '✓' : ''))
      }))), document.body)

  return h('div', { className: 'redline-picker-bar', 'data-redline-picker': '1' },
    h('button', {
      ref: modelRef, type: 'button', className: 'redline-picker-trigger',
      'data-redline-model': '1', 'aria-haspopup': 'menu', 'aria-expanded': open === 'model',
      onClick: () => { toggle('model') },
    }, h('span', { className: 'redline-picker-value' }, selected?.modelName ?? props.t('child.confirm.modelLabel')),
    h('span', { className: 'redline-picker-chevron' + (open === 'model' ? ' redline-picker-chevron-open' : '') }, '⌄')),
    h('span', { className: 'redline-picker-divider' }),
    h('button', {
      ref: effortRef, type: 'button', className: 'redline-picker-trigger',
      'data-redline-effort': '1', 'aria-haspopup': 'menu', 'aria-expanded': open === 'effort',
      disabled: selected === undefined,
      onClick: () => { toggle('effort') },
    }, h('span', { className: 'redline-picker-value redline-picker-effort-value' }, effortLabel),
    h('span', { className: 'redline-picker-chevron' + (open === 'effort' ? ' redline-picker-chevron-open' : '') }, '⌄')),
    menu,
  )
}

/** The state dot + word a row shows, from the probed `turnState`. */
function stateOf(row: ChildRow): { tone: string; key: string; hint: string } {
  if (row.live === null) return { tone: 'unknown', key: 'child.state.unknown', hint: 'child.hint.unknown' }
  if (!row.live) return row.via === 'ordinary-session'
    ? { tone: 'gone', key: 'child.state.unloaded', hint: 'child.hint.unloaded' }
    : { tone: 'gone', key: 'child.state.gone', hint: 'child.hint.gone' }
  if (row.open === true) return { tone: 'run', key: 'child.state.running', hint: 'child.hint.running' }
  return row.via === 'ordinary-session'
    ? { tone: 'idle', key: 'child.state.idle', hint: 'child.hint.carrierIdle' }
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
    const [finalText, setFinalText] = useState('')
    const [selectedRoute, setSelectedRoute] = useState('')
    const [selectedEffort, setSelectedEffort] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<{ code: string; message: string } | null>(null)
    // Late plan/start answers for an older task or selected session must not overwrite the new view.
    const generation = useRef(0)
    const startGeneration = useRef(0)

    const blockedKey = !props.live
      ? 'redline.blocked.notLive'
      : props.turnOpen ? 'redline.blocked.turnOpen' : null

    const close = useCallback(() => {
      setOpen(false)
      setPlan(null)
      setError(null)
    }, [])

    useEffect(() => {
      generation.current += 1
      startGeneration.current += 1
      setOpen(false)
      setTask('')
      setPlan(null)
      setFinalText('')
      setSelectedRoute('')
      setSelectedEffort('')
      setBusy(false)
      setError(null)
    }, [props.sessionId])

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
          if (!answer.ok) { setError({ code: answer.code, message: answer.message }); setPlan(null); return }
          setError(null)
          setPlan(answer.value)
          setFinalText(answer.value.prompt ?? '')
          const config = answer.value.config
          setSelectedRoute(config === undefined ? '' : JSON.stringify([config.provider, config.model]))
          // Start from the selected model's own default; never carry an explicit source effort by accident.
          setSelectedEffort('')
        })()
      }, 220)
      return () => { clearTimeout(timer) }
    }, [open, task, props.plan])

    const catalog = props.models ?? []
    const currentConfig = plan?.config
    const hasCurrent = currentConfig !== undefined && catalog.some(model =>
      model.provider === currentConfig.provider && model.model === currentConfig.model)
    const availableModels = currentConfig !== undefined && !hasCurrent
      ? [{
        provider: currentConfig.provider, providerName: currentConfig.provider,
        model: currentConfig.model, modelName: currentConfig.model, efforts: [],
      }, ...catalog]
      : catalog
    const selectedModel = availableModels.find(model => JSON.stringify([model.provider, model.model]) === selectedRoute)
    const legacyPlan = plan !== null && plan.config === undefined
    const finalBytes = new TextEncoder().encode(finalText).byteLength
    const refused = plan !== null && (plan.refusal !== null || finalText.trim() === '' || (!legacyPlan && selectedModel === undefined))
    const confirm = useCallback(() => {
      if (busy || plan === null || refused) return
      setBusy(true)
      setError(null)
      startGeneration.current += 1
      const mine = startGeneration.current
      void (async () => {
        if (!legacyPlan && selectedModel === undefined) return
        const selectedConfig = selectedModel === undefined ? undefined : {
          provider: selectedModel.provider,
          model: selectedModel.model,
          ...(selectedEffort === '' ? {} : { reasoningEffort: selectedEffort }),
        }
        const answer = legacyPlan
          ? await props.start(task, plan.draftRevision)
          : await props.start(task, plan.draftRevision, finalText, selectedConfig)
        if (startGeneration.current !== mine) return
        setBusy(false)
        if (!answer.ok) { setError({ code: answer.code, message: answer.message }); return }
        // The child is visible in the card's live index; do not replace the
        // confirmation with a second success screen that hides that outcome.
        close()
      })()
    }, [busy, close, finalText, legacyPlan, plan, refused, selectedEffort, selectedModel, props.start, task])

    // ⚠️ 口径跟 demo（`renderOrch()` 的 `state === 'running' || state === 'idle'`）：
    // 「活跃」= **在场的子会话**（运行中 + 空闲），**不是**"只有正在跑的" ——
    // 2026-10-07 真机读数时发现我们原先少算了一半（只在 `open` 为真时计数）。
    const active = props.rows.filter(row => row.live === true).length
    // Ordinary carrier sessions are root sessions and do not consume Agent Team member capacity.
    const scale = t('child.bmeta', { a: active, n: props.rows.length })
    const errKey = error === null ? null : `redline.err.${error.code.replace('redline/', '')}`
    const errText = error === null ? null : error.code === 'redline/internal' && error.message !== ''
      ? `${t(errKey ?? 'redline.err.internal')}：${error.message}`
      : t(errKey ?? 'redline.err.internal')

    return h('div', { className: 'redline-card', 'data-redline-card': 'child' },
      h('div', { className: 'redline-card-title' },
        h('div', { className: 'redline-orch-titles' },
          h('div', { className: 'redline-orch-title-row' },
            h('span', { className: 'redline-card-title-text' }, t('child.title')),
          ),
        ),
        h('div', { className: 'redline-orch-metrics' },
          h('span', { className: 'redline-card-scale redline-orch-metric' }, scale),
        ),
      ),

      h('section', { className: 'redline-orch-launch', 'data-redline-block': 'spawn' },
        h('div', { className: 'redline-orch-copy' },
          h('div', { className: 'redline-orch-launch-row' },
            h('h3', { className: 'redline-orch-launch-title' }, t('child.spawn.head')),
            h('span', { className: 'redline-orch-launch-hint' }, t('child.spawn.hint')),
          ),
          h('p', { className: 'redline-orch-launch-note' }, t('child.spawn.note')),
          blockedKey !== null ? h('p', { className: 'redline-orch-launch-note' }, t(blockedKey)) : null,
        ),
        h('button', {
          type: 'button',
          className: 'redline-orch-open',
          'data-redline-spawn': '1',
          disabled: blockedKey !== null,
          onClick: () => { setTask(''); setOpen(true) },
        }, t('child.spawn.button')),
      ),

      h('section', { 'data-redline-block': 'children' },
        h('div', { className: 'redline-orch-listhead' },
          h('span', null, t('child.list.head')),
          h('span', null, t('child.list.hint'))),
        props.originsError === undefined || props.originsError === null
          ? null
          : h('div', { className: 'redline-cap', 'data-redline-origins-error': props.originsError },
            t('redline.err.' + props.originsError.replace('redline/', ''))),
        props.rows.length === 0
          ? h('div', { className: 'redline-orch-empty' }, t('child.empty'))
          : h('div', { className: 'redline-orch-list' }, props.rows.map((row) => {
            const state = stateOf(row)
            const clock = clockOf(row.createdAt)
            return h('div', { className: 'redline-orch-row', key: row.id, 'data-redline-child': row.id },
              h('div', { className: 'redline-orch-main' },
                // 方形图标位（v0 的 `.sessionCardAvatar`）：纯装饰，不承载文案。
                h('span', { className: 'redline-orch-avatar', 'aria-hidden': 'true' }, '↗'),
                h('div', { className: 'redline-orch-content' },
                  h('div', { className: 'redline-orch-id' },
                    h('span', { className: 'redline-snapid' }, row.short),
                    h('span', { className: 'redline-chip-soft' }, t('child.mode.' + row.mode)),
                    // 来源（M5-12）：三态各自一句 —— 台账里有说是哪条路；没有说"不是在这儿开的"；
                    // 台账读不出来说"来源未知"。**不猜**（官方目录里没有来源字段，docs/01 F59）。
                    (() => {
                      const known = row.via === 'ordinary-session' || props.originsKnown !== false
                      const tone = !known ? 'unknown' : row.via == null ? 'other' : 'own'
                      const key = !known
                        ? 'child.src.unknown'
                        : row.via === 'ordinary-session' ? 'child.src.own.carrier'
                          : row.via === 'official-member' ? 'child.src.own.official'
                            : row.via === 'bare-child' ? 'child.src.own.bare' : 'child.src.other'
                      return h('span', { className: 'redline-src redline-src-' + tone, 'data-redline-src': tone, title: t('child.src.tip') }, t(key))
                    })(),
                    clock === null ? null : h('span', { className: 'redline-orch-clock' }, clock),
                  ),
                  row.label === '' ? null : h('p', { className: 'redline-orch-note' }, row.label),
                  h('span', { className: 'redline-orch-subnote' }, t(state.hint)),
                ),
              ),
              // 状态胶囊靠右（v0 的 `.sessionStatus`）。
              h('span', { className: 'redline-badge-state' + (state.tone === 'run' ? ' redline-badge-state-run' : '') },
                h('i', { className: 'redline-mstat redline-mstat-' + state.tone }),
                t(state.key)),
            )
          })),
      ),

      open
        ? h('div', {
          className: 'redline-modal-backdrop',
          onMouseDown: (event: { target: unknown; currentTarget: unknown }) => {
            if (event.target === event.currentTarget) close()
          },
        }, h('div', { className: 'redline-modal-card', role: 'dialog', 'aria-modal': 'true', 'data-redline-confirm': '1' },
          // 结构照抄 v0 定稿：固定标题栏 → 只有中间可滚 → 固定底栏。
          h('div', { className: 'redline-modal-head' },
            h('h2', { className: 'redline-modal-title' }, t('child.confirm.title')),
            h('button', { type: 'button', className: 'redline-modal-close', onClick: close }, '×'),
          ),
          h('div', { className: 'redline-confirm-body' },
            h('p', { className: 'redline-confirm-intro' }, t('child.confirm.intro')),
            plan === null
              ? h('div', { className: 'redline-cap' }, t('child.confirm.preparing'))
              : h('div', { className: 'redline-confirm-summary' },
                plan.items.filter(item => item.label !== '新会话配置与回程').map(item => h('div', { key: item.label },
                  h('strong', null, item.label + '：'),
                  h('span', null, item.text))),
                plan.metrics === null || typeof plan.metrics.bytes !== 'number'
                  ? null
                  : h('div', { 'data-redline-first-task': String(finalBytes) },
                    t('child.confirm.metrics', { bytes: finalBytes, edits: plan.metrics.edits }))),
            // 空任务时宿主会拒绝（`redline/empty-task`）：按钮禁用即可，**不再把那句拒绝话术打在弹窗里**
            // （用户 2026-10-08：「子会话的第一句话必须由你自己写……可以去掉」）。
            // 拒绝这件事仍然可观测（`data-redline-refusal` 挂在任务块上），只是不再占版面。
            h('label', {
              className: 'redline-confirm-task',
              ...(plan !== null && plan.refusal !== null ? { 'data-redline-refusal': plan.refusal.code } : {}),
            },
            h('span', { className: 'redline-confirm-task-label' }, t('child.confirm.taskLabel')),
            h('span', { className: 'redline-confirm-task-hint' }, t('child.confirm.taskHint')),
            h('textarea', {
              rows: 3,
              'data-redline-task': '1',
              placeholder: t('child.confirm.taskPlaceholder'),
              value: task,
              onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
                generation.current += 1
                setTask(event.target.value)
                setPlan(null)
                setFinalText('')
                setSelectedRoute('')
                setSelectedEffort('')
                setError(null)
              },
            })),
            h(CarrierSelectionBar, {
              models: availableModels,
              selectedRoute,
              selectedEffort,
              t,
              onRoute: (route: string) => {
                setSelectedRoute(route)
                setSelectedEffort('')
              },
              onEffort: (effort: string) => { setSelectedEffort(effort) },
            }),
            h('label', { className: 'redline-confirm-task redline-confirm-final' },
              h('span', { className: 'redline-confirm-task-label' }, t('child.confirm.finalLabel')),
              h('span', { className: 'redline-confirm-task-hint' }, t('child.confirm.finalHint')),
              h('textarea', {
                rows: 6,
                'data-redline-final': '1',
                value: finalText,
                onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setFinalText(event.target.value) },
              })),
            errText !== null ? h('div', { className: 'redline-editor-err', role: 'alert' }, errText) : null,
          ),
          h('div', { className: 'redline-modal-foot' },
            h('button', { type: 'button', className: 'redline-confirm-btn redline-confirm-btn-cancel', onClick: close }, t('child.confirm.cancel')),
            h('button', {
              type: 'button',
              className: 'redline-confirm-btn redline-confirm-btn-ok',
              'data-redline-confirm-ok': '1',
              disabled: busy || plan === null || refused,
              onClick: confirm,
            }, t('child.confirm.ok')),
          ),
        ))
        : null,

    )
  }
}
