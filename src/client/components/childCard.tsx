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
import { randomUuid } from '../ids'
import type { ChildIndexRow, ChildRow } from '../childSessions'
import type { ChildCapacity } from '../../shared/redline-capacity'
import { splitTaskRow } from '../../shared/redline-supervisor'
import type { AnchorInput, AnchorPlan, AnchorStarted, CarrierAnchorMode, CarrierModelOption, ChildPlan, ChildStarted, GuardPrepareInput, GuardPrepared, RedlineResult, RepoFacts } from '../redlineChannel'

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
  /** `child.plan` — read-only, builds the confirmation items for this task and optional anchor. */
  readonly plan: (humanTask: string, anchor?: string, anchorMode?: CarrierAnchorMode) => Promise<RedlineResult<ChildPlan>>
  /** `child.start` — the ONLY session write the panel can perform. */
  readonly start: (
    humanTask: string,
    confirmationToken: string,
    finalText?: string,
    config?: { provider: string; model: string; reasoningEffort?: string },
    anchor?: string,
    anchorMode?: CarrierAnchorMode,
  ) => Promise<RedlineResult<ChildStarted>>
  /** Read-only preview of one anchored conversation. */
  readonly planAnchor: (input: AnchorInput) => Promise<RedlineResult<AnchorPlan>>
  /**
   * Read-only repository facts for the dialog's defaults (git? branch? forge?).
   * Absent in a standalone/demo render: the dialog then keeps its old defaults.
   */
  readonly readRepo?: () => Promise<RedlineResult<RepoFacts>>
  /** Create the supervisor run directory (the dialog's step two). */
  readonly prepareGuard: (input: GuardPrepareInput) => Promise<RedlineResult<GuardPrepared>>
  /** The second (and only other) session write: one anchored root conversation. */
  readonly startAnchor: (
    operationId: string,
    input: AnchorInput,
    snapshotFingerprint: string,
    requestFingerprint: string,
    config?: { provider: string; model: string; reasoningEffort?: string },
  ) => Promise<RedlineResult<AnchorStarted>>
  /** Jump to the session the Host just created. */
  readonly openSession: (sessionId: string) => void
}

export interface CarrierSelectionBarProps {
  readonly models: readonly CarrierModelOption[]
  readonly selectedRoute: string
  readonly selectedEffort: string
  readonly onRoute: (route: string) => void
  readonly onEffort: (effort: string) => void
  readonly t: ViewKit['t']
  /** Optional "follow main session" top entry for the supervisor evaluator picker. */
  readonly followDefaultLabel?: string
  /** Efforts offered while no explicit route is selected (follow mode). */
  readonly followEfforts?: readonly { readonly id: string; readonly name: string }[]
  /** Remove top margin when embedded inside a structured setting row. */
  readonly compact?: boolean
  /** Override data attributes so multiple pickers in one dialog stay distinct. */
  readonly barDataAttr?: string
  readonly modelDataAttr?: string
  readonly effortDataAttr?: string
}

export function CarrierSelectionBar(props: CarrierSelectionBarProps): ReactElement {
  const [open, setOpen] = useState<'model' | 'effort' | null>(null)
  const modelRef = useRef<HTMLButtonElement | null>(null)
  const effortRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  const selected = props.models.find(model => JSON.stringify([model.provider, model.model]) === props.selectedRoute)
  const efforts = selected !== undefined ? selected.efforts : (props.followEfforts ?? [])
  const effortLabel = props.selectedEffort === ''
    ? props.t('child.confirm.effortDefault')
    : efforts.find(level => level.id === props.selectedEffort)?.name ?? props.selectedEffort
  const hasEfforts = efforts.length > 0
  const barAttr = props.barDataAttr ?? 'data-redline-picker'
  const modelAttr = props.modelDataAttr ?? 'data-redline-model'
  const effortAttr = props.effortDataAttr ?? 'data-redline-effort'
  const modelLabel = selected?.modelName ?? props.followDefaultLabel ?? props.t('child.confirm.modelLabel')

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
    ? [
      ...(props.followDefaultLabel === undefined ? [] : [
        h('section', { key: '__follow__', className: 'redline-picker-group' },
          h('button', {
            type: 'button', role: 'menuitemradio', 'aria-checked': props.selectedRoute === '',
            className: 'redline-picker-option' + (props.selectedRoute === '' ? ' is-selected' : ''),
            onClick: () => { props.onRoute(''); setOpen(null) },
          }, h('span', null, props.followDefaultLabel), h('span', { className: 'redline-picker-check' }, props.selectedRoute === '' ? '✓' : ''))),
      ]),
      ...[...groups.entries()].map(([provider, group]) => h('section', { key: provider, className: 'redline-picker-group' },
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
        }))),
    ]
    : h('div', null,
      [{ id: '', name: props.t('child.confirm.effortDefault') }, ...efforts].map((level) => {
        const active = level.id === props.selectedEffort
        return h('button', {
          type: 'button', role: 'menuitemradio', 'aria-checked': active,
          className: 'redline-picker-option' + (active ? ' is-selected' : ''),
          key: level.id || 'default',
          onClick: () => { props.onEffort(level.id); setOpen(null) },
        }, h('span', null, level.name), h('span', { className: 'redline-picker-check' }, active ? '✓' : ''))
      }))), document.body)

  return h('div', {
    className: 'redline-picker-bar' + (props.compact === true ? ' redline-picker-bar-compact' : ''),
    [barAttr]: '1',
  },
  h('button', {
    ref: modelRef, type: 'button', className: 'redline-picker-trigger',
    [modelAttr]: '1', 'aria-haspopup': 'menu', 'aria-expanded': open === 'model',
    onClick: () => { toggle('model') },
  }, h('span', { className: 'redline-picker-value' }, modelLabel),
  h('span', { className: 'redline-picker-chevron' + (open === 'model' ? ' redline-picker-chevron-open' : '') }, '⌄')),
  h('span', { className: 'redline-picker-divider' }),
  h('button', {
    ref: effortRef, type: 'button', className: 'redline-picker-trigger',
    [effortAttr]: '1', 'aria-haspopup': 'menu', 'aria-expanded': open === 'effort',
    disabled: !hasEfforts,
    onClick: () => { toggle('effort') },
  }, h('span', { className: 'redline-picker-value redline-picker-effort-value' }, effortLabel),
  h('span', { className: 'redline-picker-chevron' + (open === 'effort' ? ' redline-picker-chevron-open' : '') }, '⌄')),
  menu)
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

interface AnchorDialogProps {
  readonly open: boolean
  readonly models: readonly CarrierModelOption[]
  readonly t: ViewKit['t']
  readonly planAnchor: ChildCardProps['planAnchor']
  readonly readRepo: ChildCardProps['readRepo']
  readonly prepareGuard: ChildCardProps['prepareGuard']
  readonly startAnchor: ChildCardProps['startAnchor']
  readonly openSession: (sessionId: string) => void
  readonly onClose: () => void
}

// The supervisor master toggle: a real <label> so the whole line is the hit area.
const SUPERVISOR_TOGGLE_PROPS = {
  className: 'redline-confirm-task-label redline-anchor-toggle',
  'data-redline-anchor-supervisor-toggle': '1',
}

/** `"["provider","model"]"` (the picker's route key) → a request route. */
function routeRequest(route: string, effort: string): { provider: string; model: string; reasoningEffort?: string } | undefined {
  if (route === '') return undefined
  try {
    const parsed: unknown = JSON.parse(route)
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
    const [provider, model] = parsed as unknown[]
    if (typeof provider !== 'string' || typeof model !== 'string') return undefined
    return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
  } catch {
    return undefined
  }
}

/** Provider of a picker route key; `undefined` for "follow"/unset. */
function routeProvider(route: string): string | undefined {
  if (route === '') return undefined
  try {
    const parsed: unknown = JSON.parse(route)
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
    const provider = (parsed as unknown[])[0]
    return typeof provider === 'string' ? provider : undefined
  } catch {
    return undefined
  }
}

/**
 * True when any judge-side route is a CLI-bridge provider: the same shape that
 * returns empty text for a one-shot JSON request. The default judge follows the
 * executor, so an `antigravity` executor must warn even with no explicit
 * evaluator pick.
 */
function bridgeJudge(
  primary: { readonly provider?: string } | undefined,
  ...routes: readonly string[]
): boolean {
  return primary?.provider === 'antigravity' || routes.some(route => routeProvider(route) === 'antigravity')
}

const DEFAULT_DISCIPLINE = '先确认目标与验收标准，再开始执行。\n出现错误时，修正错误、重新验证，继续执行原目标；不得因为出错而修改目标。\n只有验收标准全部通过才算完成；完成前不提出新目标。\n修改必须有测试；有界面的改动必须有头 UAT，通过后再汇报。'

/**
 * One anchored root conversation: goal + acceptance + discipline become a
 * runtime snapshot; the task is the first user message. Nothing is migrated
 * from the current session and no result is returned to it.
 */
function AnchorDialog(props: AnchorDialogProps): ReactElement | null {
  const { t } = props
  const [task, setTask] = useState('')
  const [goal, setGoal] = useState('')
  const [goalDirty, setGoalDirty] = useState(false)
  const [acceptance, setAcceptance] = useState('')
  const [discipline, setDiscipline] = useState(DEFAULT_DISCIPLINE)
  const [supervisorEnabled, setSupervisorEnabled] = useState(false)
  const [supervisorTasks, setSupervisorTasks] = useState('')
  const [supervisorWorktree, setSupervisorWorktree] = useState(false)
  /** Repository facts read once per dialog open; `null` until they arrive. */
  const [repo, setRepo] = useState<RepoFacts | null>(null)
  /** True once the human touched the worktree row: never override their choice. */
  const worktreeTouched = useRef(false)
  const readRepoRef = useRef(props.readRepo)
  readRepoRef.current = props.readRepo
  const [supervisorEnforce, setSupervisorEnforce] = useState(false)
  const [supervisorEvalRoute, setSupervisorEvalRoute] = useState('')
  const [executorFallbackRoute, setExecutorFallbackRoute] = useState('')
  const [executorFallbackEffort, setExecutorFallbackEffort] = useState('')
  const [evaluatorFallbackRoute, setEvaluatorFallbackRoute] = useState('')
  const [evaluatorFallbackEffort, setEvaluatorFallbackEffort] = useState('')
  const [visualEnabled, setVisualEnabled] = useState(false)
  const [visualRoute, setVisualRoute] = useState('')
  const [visualEffort, setVisualEffort] = useState('')
  const [visualFallbackRoute, setVisualFallbackRoute] = useState('')
  const [visualFallbackEffort, setVisualFallbackEffort] = useState('')
  const [supervisorEvalEffort, setSupervisorEvalEffort] = useState('')
  const [supervisorProbes, setSupervisorProbes] = useState('')
  const [dangerFullAccess, setDangerFullAccess] = useState(false)
  const [stage, setStage] = useState<'idle' | 'preparing' | 'starting'>('idle')
  const [prepared, setPrepared] = useState<{ runId: string; count: number; worktreePath?: string } | null>(null)
  const [plan, setPlan] = useState<AnchorPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [route, setRoute] = useState('')
  const [effort, setEffort] = useState('')
  const modelTouched = useRef(false)
  const operationId = useRef<string>(randomUuid())
  // The prepared run id survives field edits so a retry rewrites the same run
  // directory instead of leaving an orphan behind. It resets with the dialog.
  const preparedRunId = useRef<string | null>(null)
  const generation = useRef(0)
  const supervisorRawLines = supervisorTasks.split(/\r?\n/)
  const supervisorLines = supervisorRawLines.map(line => line.trim()).filter(line => line !== '')
  // A task line must carry a non-empty id and title; an empty field is not a task.
  // The id rule and the duplicate check mirror the host parser, so a typo is
  // refused in the dialog with a clear line-numbered message instead of failing
  // silently or after the run directory exists.
  const supervisorTaskIds = new Set<string>()
  const supervisorPendingDeps: { lineNo: number; id: string; dep: string }[] = []
  let supervisorTasksErr: string | null = null
  if (supervisorEnabled && supervisorLines.length === 0) {
    supervisorTasksErr = t('anchor.supervisorTasksEmpty')
  }
  const splitCellList = (raw: string): string[] => raw
    .split(/[,，、]\s*/)
    .map(item => item.trim().replace(/^`+|`+$/g, '').trim())
    .filter(item => item !== '')
  const isBadScope = (raw: string): boolean => {
    const normalized = raw.trim().replace(/\\/g, '/')
    if (normalized === '' || normalized.length > 300) return true
    if (normalized.startsWith('/') || /^[A-Za-z]:(?:\/|$)/.test(normalized)) return true
    const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.')
    if (segments.length === 0 || segments.includes('..')) return true
    const head = segments[0] ?? ''
    if (head === '**' || /[*?]/.test(head)) return true
    return false
  }
  const noDepSentinel = /^(?:-+|—|–|none|n\/a|null|无|无依赖|\(无\)|（无）)$/i
  for (let index = 0; index < supervisorRawLines.length; index += 1) {
    const line = (supervisorRawLines[index] ?? '').trim()
    if (line === '') continue
    const lineNo = index + 1
    // Same quote-aware split as the host parser: `-run "A|B"` inside an
    // acceptance cell must not shift the scope into the dependency column.
    const parts = splitTaskRow(line)
    const id = parts[0] ?? ''
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
      if (supervisorEnabled && supervisorTasksErr === null) {
        supervisorTasksErr = t('anchor.supervisorTaskBadId', { line: lineNo, sample: line.slice(0, 48) })
      }
      continue
    }
    if ((parts[1] ?? '') === '') {
      if (supervisorEnabled && supervisorTasksErr === null) {
        supervisorTasksErr = t('anchor.supervisorTaskNoTitle', { line: lineNo })
      }
      continue
    }
    if (supervisorTaskIds.has(id)) {
      if (supervisorEnabled && supervisorTasksErr === null) {
        supervisorTasksErr = t('anchor.supervisorTaskDupId', { line: lineNo, id })
      }
      continue
    }
    supervisorTaskIds.add(id)
    if (parts.length > 3) {
      for (const entry of splitCellList(parts[3] ?? '')) {
        if (isBadScope(entry) && supervisorEnabled && supervisorTasksErr === null) {
          supervisorTasksErr = t('anchor.supervisorTaskBadScope', { line: lineNo, id, path: entry.slice(0, 64) })
        }
      }
    }
    if (parts.length > 4) {
      const deps = splitCellList(parts[4] ?? '')
      if (!(deps.length === 1 && noDepSentinel.test(deps[0] ?? ''))) {
        for (const dep of deps) {
          if (dep === id && supervisorEnabled && supervisorTasksErr === null) {
            supervisorTasksErr = t('anchor.supervisorTaskBadDep', { line: lineNo, id, dep })
          } else {
            supervisorPendingDeps.push({ lineNo, id, dep })
          }
        }
      }
    }
  }
  for (const item of supervisorPendingDeps) {
    if (!supervisorTaskIds.has(item.dep) && supervisorEnabled && supervisorTasksErr === null) {
      supervisorTasksErr = t('anchor.supervisorTaskBadDep', { line: item.lineNo, id: item.id, dep: item.dep })
    }
  }
  const supervisorTasksValid = supervisorLines.length > 0 && supervisorTasksErr === null
  // Probe lines: `TASK | command args`. A malformed line — or one that names a
  // task the table does not define — disables the button and reports the exact
  // offending line instead of being dropped silently.
  let supervisorProbesErr: string | null = null
  const supervisorProbeLines = supervisorProbes.split(/\r?\n/)
  const supervisorProbeParsed: { id: string; cmd: string; args: string[]; ok: boolean }[] = []
  for (let index = 0; index < supervisorProbeLines.length; index += 1) {
    const line = (supervisorProbeLines[index] ?? '').trim()
    if (line === '') continue
    const lineNo = index + 1
    const [taskId = '', ...command] = line.split('|')
    const argv = command.join('|').trim().split(/\s+/).filter(token => token !== '')
    const id = taskId.trim()
    if (id === '' || argv.length === 0) {
      if (supervisorEnabled && supervisorProbesErr === null) {
        supervisorProbesErr = t('anchor.supervisorProbeBadFormat', { line: lineNo, sample: line.slice(0, 48) })
      }
      supervisorProbeParsed.push({ id, cmd: '', args: [], ok: false })
      continue
    }
    if (!supervisorTaskIds.has(id)) {
      if (supervisorEnabled && supervisorProbesErr === null) {
        supervisorProbesErr = t('anchor.supervisorProbeUnknownTask', { line: lineNo, id })
      }
      supervisorProbeParsed.push({ id, cmd: argv[0] ?? '', args: argv.slice(1), ok: false })
      continue
    }
    supervisorProbeParsed.push({ id, cmd: argv[0] ?? '', args: argv.slice(1), ok: true })
  }
  const supervisorProbesValid = supervisorProbeParsed.every(probe => probe.ok)
  const supervisorValid = !supervisorEnabled || (supervisorTasksValid && supervisorProbesValid)
  const valid = [task, goal, acceptance, discipline].every(value => value.trim() !== '') && supervisorValid

  useEffect(() => {
    if (!props.open) return
    setTask('')
    setGoal('')
    setGoalDirty(false)
    setAcceptance('')
    setDiscipline(DEFAULT_DISCIPLINE)
    setSupervisorEnabled(false)
    setSupervisorTasks('')
    setSupervisorWorktree(false)
    setRepo(null)
    worktreeTouched.current = false
    setSupervisorEnforce(false)
    setSupervisorEvalRoute('')
    setSupervisorEvalEffort('')
    setExecutorFallbackRoute('')
    setExecutorFallbackEffort('')
    setEvaluatorFallbackRoute('')
    setEvaluatorFallbackEffort('')
    setVisualEnabled(false)
    setVisualRoute('')
    setVisualEffort('')
    setVisualFallbackRoute('')
    setVisualFallbackEffort('')
    setSupervisorProbes('')
    setDangerFullAccess(false)
    setStage('idle')
    setPrepared(null)
    setPlan(null)
    setBusy(false)
    setError(null)
    setRoute('')
    setEffort('')
    modelTouched.current = false
    preparedRunId.current = null
    operationId.current = randomUuid()
  }, [props.open])

  // Ask the host whether this workspace is a git repository. The answer decides
  // the safe default: a supervised run commits, and an in-place run commits on
  // the CURRENT branch — on `main` that is exactly what「独立 worktree」exists to
  // prevent. Detection is read-only and never creates a run.
  useEffect(() => {
    if (!props.open) return
    const probe = readRepoRef.current
    if (probe === undefined) return
    let alive = true
    void probe().then((answer) => {
      if (!alive || !answer.ok) return
      setRepo(answer.value)
      if (answer.value.isGit && !worktreeTouched.current) setSupervisorWorktree(true)
    }).catch(() => undefined)
    return () => { alive = false }
  }, [props.open])

  // Any supervisor input change invalidates the prepared directory: the ledger
  // must be rewritten from the card the human is actually looking at.
  useEffect(() => {
    setPrepared(null)
  }, [
    task, goal, acceptance, discipline, supervisorTasks,
    supervisorWorktree, supervisorEnforce, supervisorEvalRoute, supervisorEvalEffort, supervisorProbes,
    // Model/visual choices are part of the frozen run card too: changing them
    // after a failed start must not reuse the previously prepared directory.
    route, effort, executorFallbackRoute, executorFallbackEffort,
    evaluatorFallbackRoute, evaluatorFallbackEffort,
    visualEnabled, visualRoute, visualEffort, visualFallbackRoute, visualFallbackEffort,
  ])

  // Switching checkout mode (main workspace <-> isolated worktree) must mint a
  // fresh run id and operation id instead of reusing the previous mode's ledger.
  useEffect(() => {
    if (preparedRunId.current !== null) {
      preparedRunId.current = null
      operationId.current = randomUuid()
    }
  }, [supervisorWorktree])

  // The first token is the binary, the rest are argv — no shell, no quoting, one
  // exit code-0 expectation. Invalid lines are reported through `supervisorValid`.
  const supervisorProbeDefs = supervisorProbeParsed
    .filter(probe => probe.ok)
    .map((probe, index) => ({
      id: `C${index + 1}`,
      taskId: probe.id,
      // A command probe is a real build/test run: heavy, so it only executes
      // once the light probes pass or the model declares completion.
      weight: 'heavy' as const,
      spec: { kind: 'command' as const, cmd: probe.cmd, args: probe.args },
      enabled: true,
    }))

  useEffect(() => {
    if (!props.open || !valid) { setPlan(null); return }
    generation.current += 1
    const mine = generation.current
    const timer = setTimeout(() => {
      void (async () => {
        const answer = await props.planAnchor({ task, goal, acceptance, discipline })
        if (generation.current !== mine) return
        if (!answer.ok) { setError({ code: answer.code, message: answer.message }); setPlan(null); return }
        setError(null)
        setPlan(answer.value)
        // Only seed route/effort before the human explicitly picks one:
        // re-planning after filling tasks or editing text must NEVER wipe a
        // chosen model or reasoning effort (e.g. Max) back to Default.
        if (!modelTouched.current) {
          const config = answer.value.config
          setRoute(config === undefined ? '' : JSON.stringify([config.provider, config.model]))
          setEffort(config?.reasoningEffort ?? '')
        }
      })()
    }, 220)
    return () => { clearTimeout(timer) }
  }, [
    props.open, valid, task, goal, acceptance, discipline, props.planAnchor,
  ])

  const currentConfig = plan?.config
  const catalog = props.models
  const hasCurrent = currentConfig !== undefined && catalog.some(model =>
    model.provider === currentConfig.provider && model.model === currentConfig.model)
  const models = currentConfig !== undefined && !hasCurrent
    ? [{
      provider: currentConfig.provider, providerName: currentConfig.provider,
      model: currentConfig.model, modelName: currentConfig.model, efforts: [],
    }, ...catalog]
    : catalog
  const selectedModel = models.find(model => JSON.stringify([model.provider, model.model]) === route)
  const selectedEvalModel = models.find(model => JSON.stringify([model.provider, model.model]) === supervisorEvalRoute)
  const refused = !valid || plan === null
  const confirm = (): void => {
    if (busy || !valid || plan === null) return
    const frozen = plan
    setBusy(true)
    setError(null)
    setStage('idle')
    let activeRun: { runId: string; worktreePath?: string } | null = prepared
    setPrepared(null)
    const config = selectedModel === undefined ? undefined : {
      provider: selectedModel.provider,
      model: selectedModel.model,
      ...(effort === '' ? {} : { reasoningEffort: effort }),
    }
    void (async () => {
      let guardRunId: string | undefined
      if (supervisorEnabled) {
        if (activeRun !== null) {
          guardRunId = activeRun.runId
        } else {
          setStage('preparing')
          const selectedEvalModel = models.find(model => JSON.stringify([model.provider, model.model]) === supervisorEvalRoute)
          const preparedAnswer = await props.prepareGuard({
            task, goal, acceptance, discipline, tasks: supervisorTasks, worktree: supervisorWorktree,
            ...(supervisorEnforce ? { enforcement: 'enforce' as const } : {}),
            // "Follow the session model" plus an explicit level is still a
            // concrete judge route: sending nothing would silently drop the
            // level the human picked.
            ...(selectedEvalModel === undefined
              ? (selectedModel !== undefined && supervisorEvalEffort !== ''
                ? {
                  evaluator: {
                    provider: selectedModel.provider,
                    model: selectedModel.model,
                    reasoningEffort: supervisorEvalEffort,
                  },
                }
                : {})
              : {
                evaluator: {
                  provider: selectedEvalModel.provider,
                  model: selectedEvalModel.model,
                  ...(supervisorEvalEffort === '' ? {} : { reasoningEffort: supervisorEvalEffort }),
                },
              }),
            ...(routeRequest(route, effort) === undefined ? {} : { executor: routeRequest(route, effort) }),
            ...(routeRequest(executorFallbackRoute, executorFallbackEffort) === undefined
              ? {}
              : { executorFallback: routeRequest(executorFallbackRoute, executorFallbackEffort) }),
            ...(routeRequest(evaluatorFallbackRoute, evaluatorFallbackEffort) === undefined
              ? {}
              : { evaluatorFallback: routeRequest(evaluatorFallbackRoute, evaluatorFallbackEffort) }),
            ...(visualEnabled
              ? {
                visual: {
                  enabled: true as const,
                  ...(routeRequest(visualRoute, visualEffort) === undefined ? {} : { route: routeRequest(visualRoute, visualEffort) }),
                  ...(routeRequest(visualFallbackRoute, visualFallbackEffort) === undefined
                    ? {}
                    : { fallback: routeRequest(visualFallbackRoute, visualFallbackEffort) }),
                },
              }
              : {}),
            ...(supervisorProbeDefs.length === 0 ? {} : { probes: supervisorProbeDefs }),
            ...(preparedRunId.current === null ? {} : { runId: preparedRunId.current }),
          })
          if (!preparedAnswer.ok) {
            setBusy(false)
            setStage('idle')
            // A remembered run id that can no longer be prepared (it already
            // owns a mounted session) must not trap every later retry. The
            // operation id is reset with it: a fresh run id needs a fresh
            // carrier id, or the retry resumes the half-created session and
            // skips the supervisor mount entirely.
            if (/already exists/i.test(preparedAnswer.message)) {
              preparedRunId.current = null
              operationId.current = randomUuid()
            }
            setError({ code: preparedAnswer.code, message: preparedAnswer.message })
            return
          }
          preparedRunId.current = preparedAnswer.value.runId
          guardRunId = preparedAnswer.value.runId
          activeRun = {
            runId: preparedAnswer.value.runId,
            ...(preparedAnswer.value.worktreePath === undefined ? {} : { worktreePath: preparedAnswer.value.worktreePath }),
          }
          setPrepared({ ...activeRun, count: preparedAnswer.value.files.length })
        }
      }
      setStage('starting')
      const answer = await props.startAnchor(operationId.current, {
        task, goal, acceptance, discipline,
        ...(guardRunId === undefined ? {} : { guardRunId }),
        ...(activeRun?.worktreePath === undefined ? {} : { guardWorktreePath: activeRun.worktreePath }),
        ...(dangerFullAccess ? { permissionPreset: 'danger-full-access' as const } : {}),
      }, frozen.snapshotFingerprint, frozen.requestFingerprint, config)
      setBusy(false)
      setStage('idle')
      if (!answer.ok) {
        const held = /already exists/i.test(answer.message) || /held: workspace/i.test(answer.message)
        if (held) {
          preparedRunId.current = null
          operationId.current = randomUuid()
        }
        setError({ code: answer.code, message: answer.message })
        return
      }
      props.onClose()
      props.openSession(answer.value.sessionId)
    })()
  }
  const errKey = error === null ? null : `redline.err.${error.code.replace('redline/', '')}`
  // Every code carries its host-side detail; collapsing it to a generic line
  // hides the one sentence that says what to fix.
  const errText = error === null ? null : error.message === ''
    ? t(errKey ?? 'redline.err.internal')
    : `${t(errKey ?? 'redline.err.internal')}：${error.message}`

  if (!props.open) return null
  // The executor row is one control with two homes: with a supervised run it
  // sits in the run-options panel right before its own fallback (the two read
  // as one pair), otherwise it stays in the runtime section. Exactly one is
  // rendered, so the state and the picker identity never fork.
  const execModelRow = h('div', null,
    h('div', {
      className: 'redline-guard-row', 'data-redline-anchor-exec-model-row': '1',
    },
    h('div', { className: 'redline-guard-row-meta' },
      h('div', { className: 'redline-guard-row-title' }, t('anchor.execModelLabel')),
      h('div', { className: 'redline-guard-row-hint' }, t('anchor.execModelHint'))),
    h(CarrierSelectionBar, {
      models,
      selectedRoute: route,
      selectedEffort: effort,
      t,
      compact: true,
      onRoute: (next: string) => {
        modelTouched.current = true
        setRoute(next)
        setEffort('')
        // Only FOLLOW mode inherits this model: its level was chosen for the OLD
        // model and the new one need not advertise it, so the server would
        // refuse the prepared run. An independent judge route keeps its own
        // level, which this model change cannot invalidate.
        if (supervisorEvalRoute === '') setSupervisorEvalEffort('')
      },
      onEffort: (next: string) => { modelTouched.current = true; setEffort(next) },
    })),
    selectedModel?.provider === 'antigravity'
      ? h('div', {
        className: 'redline-editor-err', role: 'alert', 'data-redline-anchor-exec-bridge-warning': '1',
      }, t('anchor.executorBridgeWarn'))
      : null)
  return h('div', {
    className: 'redline-modal-backdrop',
    onMouseDown: (event: { target: unknown; currentTarget: unknown }) => {
      if (event.target === event.currentTarget && !busy) props.onClose()
    },
  }, h('div', { className: 'redline-modal-card', role: 'dialog', 'aria-modal': 'true', 'data-redline-anchor-modal': '1' },
    h('div', { className: 'redline-modal-head' },
      h('h2', { className: 'redline-modal-title' }, t('anchor.title')),
      h('button', { type: 'button', className: 'redline-modal-close', disabled: busy, onClick: props.onClose }, '×'),
    ),
    h('div', { className: 'redline-confirm-body' },
      h('p', { className: 'redline-confirm-intro' }, t('anchor.intro')),
      h('div', { className: 'redline-confirm-task' },
        h('span', { className: 'redline-confirm-task-label' }, t('anchor.taskLabel')),
        h('span', { className: 'redline-confirm-task-hint' }, t('anchor.taskHint')),
        h('textarea', {
          rows: 3, 'data-redline-anchor-task': '1', placeholder: t('anchor.taskPlaceholder'), value: task,
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
            const value = event.target.value
            setTask(value)
            if (!goalDirty) setGoal(value)
          },
        })),
      h('div', { className: 'redline-confirm-task' },
        h('span', { className: 'redline-confirm-task-label' },
          t('anchor.goalLabel'), ' ',
          h('button', {
            type: 'button', className: 'redline-anchor-follow', 'data-redline-anchor-follow': '1',
            onClick: () => { setGoalDirty(false); setGoal(task) },
          }, goalDirty ? t('anchor.followReset') : t('anchor.following'))),
        h('span', { className: 'redline-confirm-task-hint' }, t('anchor.goalHint')),
        h('textarea', {
          rows: 2, 'data-redline-anchor-goal': '1', value: goal,
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setGoalDirty(true); setGoal(event.target.value) },
        })),
      h('div', { className: 'redline-confirm-task' },
        h('span', { className: 'redline-confirm-task-label' }, t('anchor.acceptanceLabel')),
        h('span', { className: 'redline-confirm-task-hint' }, t('anchor.acceptanceHint')),
        h('textarea', {
          rows: 3, 'data-redline-anchor-acceptance': '1', placeholder: t('anchor.acceptancePlaceholder'),
          value: acceptance, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setAcceptance(event.target.value) },
        })),
      h('div', { className: 'redline-confirm-task' },
        h('span', { className: 'redline-confirm-task-label' }, t('anchor.disciplineLabel')),
        h('span', { className: 'redline-confirm-task-hint' }, t('anchor.disciplineHint')),
        h('textarea', {
          rows: 5, 'data-redline-anchor-discipline': '1', placeholder: t('anchor.disciplinePlaceholder'),
          value: discipline, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setDiscipline(event.target.value) },
        })),
      h('div', { className: 'redline-confirm-task' },
        // A real <label> around the box: the whole "督导运行" line is the hit
        // area, so the toggle does not require hitting a 13px square.
        h('label', SUPERVISOR_TOGGLE_PROPS,
          h('input', {
            type: 'checkbox', 'data-redline-anchor-supervisor': '1', checked: supervisorEnabled,
            onChange: (event: ChangeEvent<HTMLInputElement>) => {
              setSupervisorEnabled(event.target.checked)
            },
          }),
          h('span', null, t('anchor.supervisorLabel'))),
        h('span', { className: 'redline-confirm-task-hint' }, t('anchor.supervisorHint')),
        supervisorEnabled
          ? h('textarea', {
            rows: 5, 'data-redline-anchor-supervisor-tasks': '1', placeholder: t('anchor.supervisorTasksPlaceholder'),
            value: supervisorTasks, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setSupervisorTasks(event.target.value) },
          })
          : null,
        supervisorEnabled && supervisorTasksErr !== null
          ? h('div', { className: 'redline-editor-err', role: 'alert', 'data-redline-supervisor-tasks-err': '1' }, supervisorTasksErr)
          : null,
        supervisorEnabled
          ? h('label', { className: 'redline-anchor-guard-plan' },
            h('span', null, t('anchor.supervisorProbes')),
            h('textarea', {
              rows: 3, 'data-redline-anchor-supervisor-probes': '1',
              placeholder: t('anchor.supervisorProbesPlaceholder'),
              value: supervisorProbes, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setSupervisorProbes(event.target.value) },
            }),
            supervisorProbesErr !== null
              ? h('div', { className: 'redline-editor-err', role: 'alert', 'data-redline-supervisor-probes-err': '1' }, supervisorProbesErr)
              : null,
            h('span', { className: 'redline-confirm-task-hint' }, t('anchor.supervisorProbesHint')))
          : null,
        supervisorEnabled
          ? h('div', { className: 'redline-guard-panel', 'data-redline-anchor-supervisor-options': '1' },
            h('div', { className: 'redline-guard-row' },
              h('div', { className: 'redline-guard-row-meta' },
                h('span', { className: 'redline-guard-row-title' }, t('anchor.supervisorEvaluatorLabel')),
                h('span', { className: 'redline-guard-row-hint' }, t('anchor.supervisorEvaluatorHint'))),
              h(CarrierSelectionBar, {
                models,
                selectedRoute: supervisorEvalRoute,
                selectedEffort: supervisorEvalEffort,
                t,
                compact: true,
                followDefaultLabel: t('anchor.supervisorEvaluatorSame'),
                barDataAttr: 'data-redline-anchor-supervisor-eval-picker',
                modelDataAttr: 'data-redline-anchor-supervisor-evaluator',
                effortDataAttr: 'data-redline-anchor-supervisor-evaluator-effort',
                // Follow mode still allows an explicit effort: same model, lower
                // reasoning for the judge is a legitimate configuration.
                followEfforts: selectedModel?.efforts ?? [],
                onRoute: (next: string) => { setSupervisorEvalRoute(next); setSupervisorEvalEffort('') },
                onEffort: (next: string) => { setSupervisorEvalEffort(next) },
              })),
            // The visual routes only join the judge when the witness is enabled:
            // unchecking the box leaves the stale picks in state, but they are
            // not part of the submitted run.
            bridgeJudge(
              selectedEvalModel ?? selectedModel,
              evaluatorFallbackRoute,
              ...(visualEnabled ? [visualRoute, visualFallbackRoute] : []),
            )
              ? h('div', { className: 'redline-editor-err', role: 'alert', 'data-redline-anchor-eval-bridge-warning': '1' },
                t('anchor.supervisorEvalBridgeWarn'))
              : null,
            h('div', { className: 'redline-guard-row' },
              h('div', { className: 'redline-guard-row-meta' },
                h('span', { className: 'redline-guard-row-title' }, t('anchor.supervisorEvaluatorFallbackLabel')),
                h('span', { className: 'redline-guard-row-hint' }, t('anchor.supervisorEvaluatorFallbackHint'))),
              h(CarrierSelectionBar, {
                models, t, compact: true,
                selectedRoute: evaluatorFallbackRoute, selectedEffort: evaluatorFallbackEffort,
                followDefaultLabel: t('anchor.supervisorNoFallback'),
                barDataAttr: 'data-redline-anchor-evaluator-fallback-picker',
                modelDataAttr: 'data-redline-anchor-evaluator-fallback',
                effortDataAttr: 'data-redline-anchor-evaluator-fallback-effort',
                onRoute: (next: string) => { setEvaluatorFallbackRoute(next); setEvaluatorFallbackEffort('') },
                onEffort: (next: string) => { setEvaluatorFallbackEffort(next) },
              })),
            execModelRow,
            h('div', { className: 'redline-guard-row' },
              h('div', { className: 'redline-guard-row-meta' },
                h('span', { className: 'redline-guard-row-title' }, t('anchor.supervisorExecutorFallbackLabel')),
                h('span', { className: 'redline-guard-row-hint' }, t('anchor.supervisorExecutorFallbackHint'))),
              h(CarrierSelectionBar, {
                models, t, compact: true,
                selectedRoute: executorFallbackRoute, selectedEffort: executorFallbackEffort,
                followDefaultLabel: t('anchor.supervisorNoFallback'),
                barDataAttr: 'data-redline-anchor-executor-fallback-picker',
                modelDataAttr: 'data-redline-anchor-executor-fallback',
                effortDataAttr: 'data-redline-anchor-executor-fallback-effort',
                onRoute: (next: string) => { setExecutorFallbackRoute(next); setExecutorFallbackEffort('') },
                onEffort: (next: string) => { setExecutorFallbackEffort(next) },
              })),
            h('label', { className: 'redline-guard-check' },
              h('input', {
                type: 'checkbox', 'data-redline-anchor-visual': '1', checked: visualEnabled,
                onChange: (event: ChangeEvent<HTMLInputElement>) => { setVisualEnabled(event.target.checked) },
              }),
              h('div', { className: 'redline-guard-check-text' },
                h('div', { className: 'redline-guard-row-title' }, t('anchor.supervisorVisual')),
                h('div', { className: 'redline-guard-row-hint' }, t('anchor.supervisorVisualHint')))),
            visualEnabled
              ? [
                h('div', { key: 'visual-primary', className: 'redline-guard-row' },
                  h('div', { className: 'redline-guard-row-meta' },
                    h('span', { className: 'redline-guard-row-title' }, t('anchor.supervisorVisualModelLabel')),
                    h('span', { className: 'redline-guard-row-hint' }, t('anchor.supervisorVisualModelHint'))),
                  h(CarrierSelectionBar, {
                    models, t, compact: true,
                    selectedRoute: visualRoute, selectedEffort: visualEffort,
                    followDefaultLabel: t('anchor.supervisorVisualFollow'),
                    barDataAttr: 'data-redline-anchor-visual-picker',
                    modelDataAttr: 'data-redline-anchor-visual-model',
                    effortDataAttr: 'data-redline-anchor-visual-effort',
                    onRoute: (next: string) => { setVisualRoute(next); setVisualEffort('') },
                    onEffort: (next: string) => { setVisualEffort(next) },
                  })),
                // Its own titled row: a second picker squeezed next to the first
                // read as part of the primary choice.
                h('div', {
                  key: 'visual-fallback', className: 'redline-guard-row',
                  'data-redline-anchor-visual-fallback-row': '1',
                },
                h('div', { className: 'redline-guard-row-meta' },
                  h('span', { className: 'redline-guard-row-title' }, t('anchor.supervisorVisualFallbackLabel')),
                  h('span', { className: 'redline-guard-row-hint' }, t('anchor.supervisorVisualFallbackHint'))),
                h(CarrierSelectionBar, {
                  models, t, compact: true,
                  selectedRoute: visualFallbackRoute, selectedEffort: visualFallbackEffort,
                  followDefaultLabel: t('anchor.supervisorNoFallback'),
                  barDataAttr: 'data-redline-anchor-visual-fallback-picker',
                  modelDataAttr: 'data-redline-anchor-visual-fallback',
                  effortDataAttr: 'data-redline-anchor-visual-fallback-effort',
                  onRoute: (next: string) => { setVisualFallbackRoute(next); setVisualFallbackEffort('') },
                  onEffort: (next: string) => { setVisualFallbackEffort(next) },
                })),
              ]
              : null,
            h('div', { className: 'redline-guard-checks' },
              h('div', null,
                h('label', { className: 'redline-guard-check' },
                  h('input', {
                    type: 'checkbox', 'data-redline-anchor-supervisor-enforce': '1', checked: supervisorEnforce,
                    onChange: (event: ChangeEvent<HTMLInputElement>) => { setSupervisorEnforce(event.target.checked) },
                  }),
                  h('div', { className: 'redline-guard-check-text' },
                    h('div', { className: 'redline-guard-row-title' }, t('anchor.supervisorEnforce')),
                    h('div', { className: 'redline-guard-row-hint' }, t('anchor.supervisorEnforceHint'))))),
              h('div', null,
                h('label', { className: 'redline-guard-check' },
                  h('input', {
                    type: 'checkbox', 'data-redline-anchor-supervisor-worktree': '1', checked: supervisorWorktree,
                    onChange: (event: ChangeEvent<HTMLInputElement>) => {
                      worktreeTouched.current = true
                      setSupervisorWorktree(event.target.checked)
                    },
                  }),
                  h('div', { className: 'redline-guard-check-text' },
                    h('div', { className: 'redline-guard-row-title' }, t('anchor.supervisorWorktree')),
                    h('div', { className: 'redline-guard-row-hint' }, t('anchor.supervisorWorktreeHint')))))),
            repo !== null && repo.isGit
              ? h('div', {
                className: 'redline-guard-row-hint',
                'data-redline-anchor-repo-hint': '1',
              }, t(repo.remoteKind === 'gitlab' ? 'anchor.supervisorRepoGitlab' : repo.remoteKind === 'github' ? 'anchor.supervisorRepoGithub' : 'anchor.supervisorRepoGit',
                repo.branch === undefined ? {} : { branch: repo.branch }))
              : null,
            repo !== null && repo.isGit && !supervisorWorktree
              && repo.branch !== undefined && repo.defaultBranch !== undefined && repo.branch === repo.defaultBranch
              ? h('div', {
                className: 'redline-editor-err',
                role: 'alert',
                'data-redline-anchor-worktree-warn': '1',
              }, t('anchor.supervisorWorktreeMainWarn', { branch: repo.branch }))
              : null)
          : null),
      h('div', { className: 'redline-confirm-task' },
        h('span', { className: 'redline-confirm-task-label' }, t('anchor.runtimeLabel')),
        h('div', { className: 'redline-guard-panel' },
          plan !== null && plan.cwd !== undefined
            ? h('div', { className: 'redline-guard-row' },
              h('div', { className: 'redline-guard-row-meta' },
                h('div', { className: 'redline-guard-row-title' }, t('anchor.runDirLabel')),
                h('div', { className: 'redline-guard-row-hint' }, t('anchor.runDirHint'))),
              h('div', { className: 'redline-guard-run-dir', 'data-redline-anchor-run-dir': '1' },
                supervisorEnabled && supervisorWorktree
                  ? `${plan.cwd.replace(/\/+$/, '')}/.guard/worktrees/<runId>`
                  : plan.cwd))
            : null,
          supervisorEnabled ? null : execModelRow,
          h('div', { className: 'redline-guard-checks' },
            h('div', null,
              h('label', { className: 'redline-guard-check' },
                h('input', {
                  type: 'checkbox', 'data-redline-anchor-danger-full-access': '1', checked: dangerFullAccess,
                  onChange: (event: ChangeEvent<HTMLInputElement>) => { setDangerFullAccess(event.target.checked) },
                }),
                h('div', { className: 'redline-guard-check-text' },
                  h('div', { className: 'redline-guard-row-title' }, t('anchor.dangerFullAccess')),
                  h('div', { className: 'redline-guard-row-hint' }, t('anchor.dangerFullAccessHint')))))))),
      h('div', { className: 'redline-anchor-snapshot' },
        h('div', { className: 'redline-anchor-snapshot-head' }, t('anchor.snapshot')),
        h('pre', {
          'data-redline-anchor-snapshot': '1',
          'data-redline-anchor-snapshot-fingerprint': plan?.snapshotFingerprint ?? '',
        }, plan?.snapshot ?? t('anchor.preparing'))),
      errText !== null ? h('div', { className: 'redline-editor-err', role: 'alert' }, errText) : null,
      stage === 'idle' && prepared === null ? null : h('div', {
        className: 'redline-anchor-progress', 'data-redline-anchor-progress': '1',
      },
      h('div', null, `① ${t('anchor.stepCard')} ✓`),
      h('div', null,
        `② ${t('anchor.stepPrepare')} `,
        stage === 'preparing'
          ? `● ${t('anchor.preparing')}`
          : prepared === null
            ? '○'
            : `✓ ${prepared.runId} · ${t('anchor.stepFiles', { count: prepared.count })}`),
      stage === 'starting' ? h('div', null, t('anchor.stepEntering')) : null),
    ),
    h('div', { className: 'redline-modal-foot' },
      h('span', { className: 'redline-confirm-scope' }, t('anchor.scope')),
      h('button', { type: 'button', className: 'redline-confirm-btn redline-confirm-btn-cancel', disabled: busy, onClick: props.onClose }, t('anchor.cancel')),
      h('button', {
        type: 'button', className: 'redline-confirm-btn redline-confirm-btn-ok', 'data-redline-anchor-confirm': '1',
        disabled: busy || refused, onClick: confirm,
      }, t('anchor.confirm')),
    ),
  ))
}

export function makeChildCard(kit: ViewKit): (props: ChildCardProps) => ReactElement {
  const { t } = kit

  return function ChildCard(props): ReactElement {
    const [open, setOpen] = useState(false)
    const [anchorOpen, setAnchorOpen] = useState(false)
    const [task, setTask] = useState('')
    const [anchor, setAnchor] = useState('')
    const [anchorMode, setAnchorMode] = useState<CarrierAnchorMode>('message')
    const [plan, setPlan] = useState<ChildPlan | null>(null)
    const [finalText, setFinalText] = useState('')
    const [selectedRoute, setSelectedRoute] = useState('')
    const [selectedEffort, setSelectedEffort] = useState('')
    const childModelTouched = useRef(false)
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
      setAnchorOpen(false)
      setTask('')
      setAnchor('')
      setAnchorMode('message')
      setPlan(null)
      setFinalText('')
      setSelectedRoute('')
      setSelectedEffort('')
      childModelTouched.current = false
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
          const answer = await props.plan(task, anchor, anchorMode)
          if (generation.current !== mine) return
          if (!answer.ok) { setError({ code: answer.code, message: answer.message }); setPlan(null); return }
          setError(null)
          setPlan(answer.value)
          setFinalText(answer.value.prompt ?? '')
          if (!childModelTouched.current) {
            const config = answer.value.config
            setSelectedRoute(config === undefined ? '' : JSON.stringify([config.provider, config.model]))
            // Start from the selected model's own default; never carry an explicit source effort by accident.
            setSelectedEffort('')
          }
        })()
      }, 220)
      return () => { clearTimeout(timer) }
    }, [open, task, anchor, anchorMode, props.plan])

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
          : anchor.trim() === ''
            ? await props.start(task, plan.draftRevision, finalText, selectedConfig)
            : await props.start(task, plan.draftRevision, finalText, selectedConfig, anchor, anchorMode)
        if (startGeneration.current !== mine) return
        setBusy(false)
        if (!answer.ok) { setError({ code: answer.code, message: answer.message }); return }
        // The child is visible in the card's live index; do not replace the
        // confirmation with a second success screen that hides that outcome.
        close()
      })()
    }, [anchor, anchorMode, busy, close, finalText, legacyPlan, plan, refused, selectedEffort, selectedModel, props.start, task])

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
        h('div', { className: 'redline-orch-actions' },
          h('button', {
            type: 'button',
            className: 'redline-orch-open',
            'data-redline-spawn': '1',
            disabled: blockedKey !== null,
            onClick: () => { setTask(''); setOpen(true) },
          }, t('child.spawn.button')),
          h('button', {
            type: 'button',
            className: 'redline-orch-open redline-anchor-open',
            'data-redline-anchor-open': '1',
            disabled: blockedKey !== null,
            onClick: () => { setAnchorOpen(true) },
          }, t('anchor.entryButton'))),
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

      h(AnchorDialog, {
        open: anchorOpen,
        models: props.models ?? [],
        t,
        planAnchor: props.planAnchor,
        readRepo: props.readRepo,
        prepareGuard: props.prepareGuard,
        startAnchor: props.startAnchor,
        openSession: props.openSession,
        onClose: () => { setAnchorOpen(false) },
      }),

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
                if (!childModelTouched.current) {
                  setSelectedRoute('')
                  setSelectedEffort('')
                }
                setError(null)
              },
            })),
            legacyPlan ? null : h('label', { className: 'redline-confirm-task redline-confirm-anchor' },
              h('span', { className: 'redline-confirm-task-label' }, t('child.confirm.anchorLabel')),
              h('span', { className: 'redline-confirm-task-hint' }, t('child.confirm.anchorHint')),
              h('span', { className: 'redline-confirm-anchor-modes', role: 'group' },
                h('button', {
                  type: 'button',
                  className: 'redline-confirm-mode-btn' + (anchorMode === 'message' ? ' redline-confirm-mode-on' : ''),
                  'data-redline-anchor-mode': 'message',
                  onClick: () => {
                    generation.current += 1
                    setAnchorMode('message')
                    setPlan(null)
                    setFinalText('')
                    setError(null)
                  },
                }, t('child.confirm.anchorModeMessage')),
                h('button', {
                  type: 'button',
                  className: 'redline-confirm-mode-btn' + (anchorMode === 'runtime' ? ' redline-confirm-mode-on' : ''),
                  'data-redline-anchor-mode': 'runtime',
                  disabled: anchor.trim() === '',
                  title: anchor.trim() === '' ? t('child.confirm.anchorModeRuntimeDisabled') : t('child.confirm.anchorModeRuntimeHint'),
                  onClick: () => {
                    if (anchor.trim() === '') return
                    generation.current += 1
                    setAnchorMode('runtime')
                    setPlan(null)
                    setFinalText('')
                    setError(null)
                  },
                }, t('child.confirm.anchorModeRuntime'))),
              anchorMode === 'runtime'
                ? h('span', { className: 'redline-confirm-task-hint', 'data-redline-anchor-runtime-note': '1' }, t('child.confirm.anchorModeRuntimeHint'))
                : null,
              h('textarea', {
                rows: 2,
                'data-redline-anchor': '1',
                placeholder: t('child.confirm.anchorPlaceholder'),
                value: anchor,
                onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
                  generation.current += 1
                  setAnchor(event.target.value)
                  setPlan(null)
                  setFinalText('')
                  setError(null)
                },
              })),
            h(CarrierSelectionBar, {
              models: availableModels,
              selectedRoute,
              selectedEffort,
              t,
              onRoute: (route: string) => {
                childModelTouched.current = true
                setSelectedRoute(route)
                setSelectedEffort('')
              },
              onEffort: (effort: string) => {
                childModelTouched.current = true
                setSelectedEffort(effort)
              },
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
