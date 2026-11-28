/**
 * The short invariant block injected at the head and the tail of every prompt.
 *
 * The full goal card is reference material: it is read once, then compressed by
 * the context window and again by compaction. What survives is this block —
 * goal hash, the one task in front of the model, its write scope, the rules
 * that must not bend, and the only conditions that justify stopping. It is
 * rebuilt from the live ledger every turn and kept inside a small budget.
 */

import type { GuardTask, GuardState } from './schema'

/** Hard budget per side; the block is re-read on every step, so it stays short. */
export const ANCHOR_BUDGET_BYTES = 2048

/** How much of the run directory the block may spend; a clipped tail still names the root. */
const RUN_DIR_MAX_BYTES = 120

/** What the renderer may know beyond the ledger. */
export interface AnchorRenderOptions {
  /** Directory the guarded session runs in: probes and task scopes resolve here. */
  readonly cwd?: string
}

function rulesFor(enforcement: GuardState['enforcement'], runId: string): string {
  const role = enforcement === 'enforce'
    ? '主会话只规划/分派/审查，不直接写业务代码、不执行命令（工具守卫已硬拦）'
    : '主会话只规划/分派/审查，不直接写业务代码（提醒模式，建议交由子会话执行命令）'
  return `硬规则：${role}；只改本任务 scope 内的文件；不扩范围；所有写入与命令只限运行目录（勿跨工作区施工、勿自建外部 worktree，只读参考可以读）；`
    + `「## 完成声明」只能由主会话审查子会话产物后亲自写入 docs/guard/${runId}/tasks/<ID>/notes.md（该文件是督导要求主会话写入的例外，即使项目纪律写着不改 docs/guard/**）；不得让子会话代写；写入后立刻结束本回合（勿同回合派下个任务），等督导验收切锚点；`
    + '不要中途向用户提问、也不要逐任务等确认（若目标或纪律明确要求按里程碑确认，则按其执行）；遇阻塞把原因写入 notes.md 后停下。'
}
const STOP = '停止条件：目标或验收要改；实测前提被打破；不可逆或外部副作用；安全或合规冲突。'

function clipBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const ellipsis = '…'
  const room = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, 'utf8'))
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > room) break
    out += char
    used += size
  }
  return `${out}${ellipsis}`
}

/** One anchor side plus the byte accounting a truncation event needs. */
export interface RenderedAnchor {
  readonly text: string
  /** Size of the untruncated rendering. */
  readonly originalBytes: number
  readonly keptBytes: number
  readonly truncated: boolean
}

/** Every task this turn may write, in ledger order (a parallel batch has several). */
function runningTasks(state: GuardState): GuardTask[] {
  const live = state.activeTaskIds
    .map(id => state.tasks.find(task => task.id === id))
    .filter((task): task is GuardTask => task !== undefined)
  if (live.length > 0) return live
  const inFlight = state.tasks.filter(task => task.status === 'IN_PROGRESS')
  if (inFlight.length > 0) return inFlight
  const done = new Set(state.tasks.filter(task => task.status === 'DONE').map(task => task.id))
  const startable = state.tasks.find(task =>
    task.status === 'TODO' && task.dependsOn.every(dep => done.has(dep)))
  return startable === undefined ? [] : [startable]
}

interface BuiltBody {
  /** The rendering that fits the budget. */
  readonly body: string
  /** The same rendering with nothing dropped or shortened. */
  readonly full: string
  readonly clipped: boolean
}

interface Segment {
  readonly key: string
  readonly text: string
}

/**
 * The block a FINISHED run injects.
 *
 * A supervised run is a run-scoped guard, not a lifetime lockdown: once every
 * task is DONE the table, its scopes, the probes and the per-task commit rules
 * stop applying, and the session is an ordinary conversation again. Rendering
 * the live-task block here would keep telling the model "only change files in
 * this task's scope" with no task left — which is exactly how a finished run
 * started refusing the human's next request.
 */
function completedBody(state: GuardState, runDir: string, head: string, tailStop: string): BuiltBody {
  const done = state.tasks.filter(task => task.status === 'DONE').length
  const progress = state.tasks.length === 0 ? '（全部完成）' : `（全部完成 ${done}/${state.tasks.length}）`
  const lines = [
    `当前任务：${progress}`,
    '本次督导运行已收口：任务表、scope、探针与逐任务提交规则不再生效。',
    '用户的新需求按普通会话处理：可以直接改文件、执行命令，也可以新建 goal 或新的督导运行。',
    '台账只作历史记录；除非用户要求回退，不要再往 notes.md 写完成声明。',
    tailStop,
  ]
  const fixed = Buffer.byteLength(head, 'utf8') + 2
  let room = ANCHOR_BUDGET_BYTES - fixed - Buffer.byteLength(lines.at(-1) ?? '', 'utf8')
  const placed: string[] = []
  let clipped = false
  for (const line of lines.slice(0, -1)) {
    if (room <= 8) { clipped = true; continue }
    const kept = clipBytes(line, room)
    if (kept !== line) clipped = true
    placed.push(kept)
    room -= Buffer.byteLength(kept, 'utf8') + 1
  }
  const middle = placed.join('\n')
  const body = middle === '' ? `${head}\n${lines.at(-1) ?? ''}` : `${head}\n${middle}\n${lines.at(-1) ?? ''}`
  const full = [head, ...lines].join('\n')
  return { body, full, clipped: clipped || body !== full }
}

function buildBody(state: GuardState, options?: AnchorRenderOptions): BuiltBody {
  const tasks = runningTasks(state)
  const passed = state.tasks.filter(item => item.status === 'DONE').length
  const goalLine = state.goal.split(/\r?\n/).map(line => line.trim()).find(line => line !== '') ?? state.goal

  // The run directory is the only place the probes and the scopes resolve. A
  // session that has to reverse-engineer it burns the turn on read-only calls
  // and may try to "fix" the mismatch by creating a worktree in another repo.
  const runDir = options?.cwd === undefined ? '' : clipBytes(options.cwd.trim(), RUN_DIR_MAX_BYTES)
  const head = [
    '【目标守卫 · 锚点】',
    `目标 hash：${state.goalHash.slice(0, 16)}`,
    ...(runDir === '' ? [] : [`运行目录：${runDir}`]),
  ].join('\n')
  const tail = [rulesFor(state.enforcement, state.runId), STOP].join('\n')
  // A finished run stops being a supervisor: the session must be able to work
  // again (the tool guard stands down in `checkTool` for the same reason).
  if (state.status === 'completed') return completedBody(state, runDir, head, STOP)

  const taskLines: string[] = []
  if (tasks.length === 1) {
    for (const task of tasks) {
      taskLines.push(`当前任务：${task.id} | ${task.title}`)
      if (task.scope.length > 0) taskLines.push(`本任务 scope：${task.scope.join('、')}`)
      taskLines.push(`本任务验收：${task.acceptance.join('；')}`)
    }
  } else if (tasks.length > 1) {
    // A parallel batch: every running task and its scope must be visible, or the
    // model cannot know which of them it is allowed to write for.
    taskLines.push(`并行在途 ${tasks.length} 条：${tasks.map(task => task.id).join('、')}`)
    for (const task of tasks) {
      const scope = task.scope.length === 0 ? '（未声明）' : task.scope.join('、')
      taskLines.push(`- ${task.id} | ${task.title} | scope：${scope}`)
    }
  } else {
    // "Nothing running" is not "everything done": a blocked batch must say so,
    // or the model is told to stop on a run that is waiting for a human.
    const allDone = state.tasks.every(task => task.status === 'DONE')
    taskLines.push(allDone ? '当前任务：（全部完成）' : '当前任务：（已阻塞，等待人工介入）')
  }

  // A later task's declared scope is not free to write, and the running task
  // cannot know that unless it is shown. Finished scopes are omitted: they are
  // closed, not an invitation. Exclude `tasks` themselves: before turn 1 ends,
  // the starting task is still `TODO` in the ledger and must not be called
  // "another task".
  const runningIds = new Set(tasks.map(task => task.id))
  const upcoming = state.tasks.filter(item =>
    item.status === 'TODO'
    && !runningIds.has(item.id)
    && item.scope.length > 0)
  const otherScopes = upcoming.length === 0
    ? ''
    : `其他任务 scope（不是你的）：${upcoming.map(item => `${item.id} ${item.scope.join('、')}`).join('；')}`

  // A blocked task's correction is the most actionable line in the anchor, so it
  // is listed for every running task rather than only the first.
  // A blocked task is not "running", so it can never come from `runningTasks`;
  // read them straight off the ledger or this list is always empty.
  const corrections = state.tasks
    .filter(task => task.status === 'BLOCKED' && task.blocked !== undefined)
    .map(task => `纠正（${task.id}）：${task.blocked?.reason} → ${task.blocked?.next}`)
  // A task whose probes pass but which produced neither a scope change nor a new
  // completion declaration is idle. Say so in the highest-priority section: the
  // loop blocks it at `IDLE_STALL_LIMIT`, and this line is the way out.
  const idleLines = tasks
    .filter(task => (task.idleStreak ?? 0) > 0)
    .map(task => `待验收（${task.id}）：探针已通过，但已连续 ${task.idleStreak} 轮无代码改动且未新增「## 完成声明」。请审查产物后在 docs/guard/${state.runId}/tasks/${task.id}/notes.md 追加「## 完成声明」并立刻结束本回合。`)
  const progressLine = `进度：${passed}/${state.tasks.length}；状态：${state.status}`

  // Display order is fixed; the budget is spent in PRIORITY order instead, so a
  // long future-scope list or a long goal can never crowd out the running task,
  // the progress line or a blocked sibling's correction. Before this, the whole
  // task block (future scopes included) was written first and the goal/progress
  // lines were dropped when it happened to fill the budget.
  const display: Segment[] = [
    ...taskLines.map((text, index) => ({ key: `task-${index}`, text })),
    ...(otherScopes === '' ? [] : [{ key: 'other-scopes', text: otherScopes }]),
    { key: 'goal', text: `目标：${goalLine}` },
    { key: 'progress', text: progressLine },
    ...corrections.map((text, index) => ({ key: `correction-${index}`, text })),
    ...idleLines.map((text, index) => ({ key: `idle-${index}`, text })),
  ]
  const priority = [
    ...taskLines.map((_, index) => `task-${index}`),
    ...corrections.map((_, index) => `correction-${index}`),
    ...idleLines.map((_, index) => `idle-${index}`),
    'progress',
    'goal',
    'other-scopes',
  ]
  const full = [head, ...display.map(segment => segment.text).filter(text => text !== ''), tail].join('\n')

  const fixed = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8') + 2
  let room = ANCHOR_BUDGET_BYTES - fixed
  const placed = new Map<string, string>()
  let clipped = false
  for (const key of priority) {
    const segment = display.find(item => item.key === key)
    if (segment === undefined) continue
    const cost = Buffer.byteLength(segment.text, 'utf8')
    if (room <= 8) {
      clipped = true
      continue
    }
    // `+1` is the newline that joins this segment to the block.
    if (cost + 1 <= room) {
      placed.set(key, segment.text)
      room -= cost + 1
      continue
    }
    const kept = clipBytes(segment.text, room - 1)
    if (kept !== segment.text) clipped = true
    placed.set(key, kept)
    room = 0
  }
  const middle = display
    .map(segment => placed.get(segment.key))
    .filter((text): text is string => text !== undefined && text !== '')
  const body = [head, ...middle, tail].join('\n')
  return { body, full, clipped: clipped || body !== full }
}

/** Render one anchor side; never throws and never exceeds the budget. */
export function renderAnchor(state: GuardState, options?: AnchorRenderOptions): string {
  return renderAnchorDetailed(state, options).text
}

/** The full rendering with nothing dropped or shortened: accounting and diagnostics. */
export function renderAnchorUnclipped(state: GuardState, options?: AnchorRenderOptions): string {
  return buildBody(state, options).full
}

/** Render one anchor side with the byte accounting used by `anchor.truncated`. */
export function renderAnchorDetailed(state: GuardState, options?: AnchorRenderOptions): RenderedAnchor {
  const { body, full, clipped } = buildBody(state, options)
  // Final guard: the allocation above already fits, but the budget is a hard
  // promise to every prompt, so it is enforced once more on the joined block.
  const text = clipBytes(body, ANCHOR_BUDGET_BYTES)
  return {
    text,
    originalBytes: Buffer.byteLength(full, 'utf8'),
    keptBytes: Buffer.byteLength(text, 'utf8'),
    truncated: clipped || text !== full,
  }
}
