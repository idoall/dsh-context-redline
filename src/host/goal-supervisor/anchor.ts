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

const RULES = '硬规则：主会话只规划/分派/审查，不直接写业务代码、不执行命令（写自己的计划/审查记录除外）；只改本任务 scope 内的文件；不扩范围。'
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
  readonly body: string
  /** True when any part of the rendering had to be shortened or dropped. */
  readonly clipped: boolean
}

function buildBody(state: GuardState): BuiltBody {
  const tasks = runningTasks(state)
  const passed = state.tasks.filter(item => item.status === 'DONE').length
  const goalLine = state.goal.split(/\r?\n/).map(line => line.trim()).find(line => line !== '') ?? state.goal

  const head = ['【目标守卫 · 锚点】', `目标 hash：${state.goalHash.slice(0, 16)}`].join('\n')
  const tail = [RULES, STOP].join('\n')
  const fixedBytes = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8') + 2
  let room = ANCHOR_BUDGET_BYTES - fixedBytes

  const taskBlock: string[] = []
  if (tasks.length === 1) {
    for (const task of tasks) {
      taskBlock.push(`当前任务：${task.id} | ${task.title}`)
      if (task.scope.length > 0) taskBlock.push(`本任务 scope：${task.scope.join('、')}`)
      taskBlock.push(`本任务验收：${task.acceptance.join('；')}`)
    }
  } else if (tasks.length > 1) {
    // A parallel batch: every running task and its scope must be visible, or the
    // model cannot know which of them it is allowed to write for.
    taskBlock.push(`并行在途 ${tasks.length} 条：${tasks.map(task => task.id).join('、')}`)
    for (const task of tasks) {
      const scope = task.scope.length === 0 ? '（未声明）' : task.scope.join('、')
      taskBlock.push(`- ${task.id} | ${task.title} | scope：${scope}`)
    }
  } else {
    // "Nothing running" is not "everything done": a blocked batch must say so,
    // or the model is told to stop on a run that is waiting for a human.
    const allDone = state.tasks.every(task => task.status === 'DONE')
    taskBlock.push(allDone ? '当前任务：（全部完成）' : '当前任务：（已阻塞，等待人工介入）')
  }
  const taskRaw = taskBlock.join('\n')
  const taskText = room > 16 ? clipBytes(taskRaw, room) : ''
  let clipped = taskText !== taskRaw
  room -= Buffer.byteLength(taskText, 'utf8') + (taskText === '' ? 0 : 1)

  // A blocked task's correction is the most actionable line in the anchor, so it
  // is listed for every running task rather than only the first.
  // A blocked task is not "running", so it can never come from `runningTasks`;
  // read them straight off the ledger or this list is always empty.
  const corrections = state.tasks
    .filter(task => task.status === 'BLOCKED' && task.blocked !== undefined)
    .map(task => `纠正（${task.id}）：${task.blocked?.reason} → ${task.blocked?.next}`)
  const extras: string[] = []
  for (const line of [
    `目标：${goalLine}`,
    `进度：${passed}/${state.tasks.length}；状态：${state.status}`,
    ...corrections,
  ]) {
    if (room <= 8) { clipped = true; continue }
    const kept = clipBytes(line, room)
    if (kept !== line) clipped = true
    extras.push(kept)
    room -= Buffer.byteLength(kept, 'utf8') + 1
  }

  const middle = [taskText, ...extras].filter(part => part !== '').join('\n')
  return { body: middle === '' ? `${head}\n${tail}` : `${head}\n${middle}\n${tail}`, clipped }
}

/** Render one anchor side; never throws and never exceeds the budget. */
export function renderAnchor(state: GuardState): string {
  return renderAnchorDetailed(state).text
}

/** Render one anchor side with the byte accounting used by `anchor.truncated`. */
export function renderAnchorDetailed(state: GuardState): RenderedAnchor {
  const { body, clipped } = buildBody(state)
  const text = clipBytes(body, ANCHOR_BUDGET_BYTES)
  const keptBytes = Buffer.byteLength(text, 'utf8')
  const budgetCut = text !== body
  // `originalBytes` is the size the unconstrained rendering would have had: the
  // clipped body plus the bytes the inner budget removed from the task/extras.
  const dropped = clipped && !budgetCut ? Math.max(0, ANCHOR_BUDGET_BYTES - keptBytes) : 0
  return {
    text,
    originalBytes: keptBytes + dropped,
    keptBytes,
    truncated: clipped || budgetCut,
  }
}
