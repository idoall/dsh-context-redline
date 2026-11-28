/**
 * Durable storage for one supervisor run.
 *
 * `tasks.json` is replaced atomically (same-directory temp file + rename) so a
 * crash never leaves a half-written ledger; `state.jsonl` is append-only; and
 * `TASKS.md` is regenerated from the ledger on every commit — never parsed.
 *
 * All writes for a run go through one in-process lock, so the sequence
 * "write tasks.json → append state.jsonl → render TASKS.md" cannot interleave
 * with another writer in the same process.
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { GuardEvent, GuardState, RunMeta, TaskProbeFile } from './schema'

const TASKS_FILE = 'tasks.json'
const EVENTS_FILE = 'state.jsonl'
const META_FILE = 'run.json'
const RENDERED_FILE = 'TASKS.md'

/** Serializes async operations; a rejected task does not poison the chain. */
export class SerialLock {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release: () => void = () => {}
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await task()
    } finally {
      release()
    }
  }
}

/** Write `data` through a temp file in the SAME directory, then rename. */
async function writeFileAtomic(file: string, data: string): Promise<void> {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const temp = join(dir, `.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(temp, data, 'utf8')
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Pure rendering of the ledger for humans. Never read back as state. */
/** True when both route records name the same provider, model and effort. */
function sameRoute(
  a: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined,
  b: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string },
): boolean {
  return a !== undefined && a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

/** `provider/model（推理：effort）` for the human-readable page. */
function routeText(route: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }): string {
  return `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : `（推理：${route.reasoningEffort}）`}`
}

export function renderTasksMarkdown(state: GuardState): string {
  const done = state.tasks.filter(task => task.status === 'DONE').length
  const lines: string[] = [
    `# 任务表 · ${state.runId}`,
    '',
    `- 目标 hash：\`${state.goalHash}\``,
    `- 状态：${state.status}`,
    `- 并行：${state.parallel}`,
    `- 进度：${done}/${state.tasks.length} 已完成`,
    ...(state.evaluator === undefined ? [] : [
      `- 评估模型：\`${state.evaluator.provider}/${state.evaluator.model}\`${state.evaluator.reasoningEffort === undefined ? '' : `（推理：\`${state.evaluator.reasoningEffort}\`）`}`,
    ]),
    ...(state.evaluatorFallback === undefined ? [] : [
      `- 评估回退：\`${state.evaluatorFallback.provider}/${state.evaluatorFallback.model}\`${state.evaluatorFallback.reasoningEffort === undefined ? '' : `（推理：\`${state.evaluatorFallback.reasoningEffort}\`）`}`,
    ]),
    ...(state.executor === undefined ? [] : [
      `- 执行模型：\`${state.executor.provider}/${state.executor.model}\`${state.executor.reasoningEffort === undefined ? '' : `（推理：\`${state.executor.reasoningEffort}\`）`}`,
    ]),
    ...(state.activeExecutor === undefined || sameRoute(state.executor, state.activeExecutor)
      ? []
      : [`- 当前执行模型：\`${routeText(state.activeExecutor)}\``]),
    ...(state.executorFallback === undefined ? [] : [
      `- 执行回退：\`${state.executorFallback.provider}/${state.executorFallback.model}\`${state.executorFallback.reasoningEffort === undefined ? '' : `（推理：\`${state.executorFallback.reasoningEffort}\`）`}`,
    ]),
    ...(state.visual?.enabled === true ? ['- 视觉取证：启用（观察型取证，不参与裁决）'] : []),
    // An isolated run commits to its own branch and NOTHING merges it back, so
    // the page a human reads on disk has to name it.
    ...(state.worktree.enabled && state.worktree.branch !== undefined
      ? [`- 隔离分支：\`${state.worktree.branch}\`（提交在这个分支上，**不会自动合入**，需要手动 merge）`]
      : []),
    '',
  ]
  for (const task of state.tasks) {
    lines.push(`## ${task.id} · ${task.title}`, '')
    lines.push(`- 状态：${task.status}`)
    lines.push(`- 允许改动：${task.scope.length === 0 ? '（未声明）' : task.scope.map(path => `\`${path}\``).join('、')}`)
    if (task.dependsOn.length > 0) lines.push(`- 依赖：${task.dependsOn.join('、')}`)
    if (task.acceptance.length > 0) lines.push(`- 验收：${task.acceptance.join('；')}`)
    if (task.probes.length > 0) {
      const required = new Set(task.requiredProbes)
      const probes = task.probes.map(id => `${id}${required.has(id) ? '（必选）' : ''}`).join('、')
      lines.push(`- 探针：${probes}`)
    }
    if (task.evidence.length > 0) lines.push(`- 证据：${task.evidence.map(item => `\`${item.path}\``).join('、')}`)
    if (task.blocked !== undefined) {
      lines.push(`- 阻塞原因：${task.blocked.reason}`)
      lines.push(`- 下一步：${task.blocked.next}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * One lock per run directory, shared by every `GuardStore` instance.
 *
 * `attachSupervisor`, `rollbackRun`, `armSupervisorGoal` and `markSetupFailed`
 * each construct their own store; with an instance lock they would write the same
 * `tasks.json` / `state.jsonl` concurrently and interleave.
 */
const LOCKS = new Map<string, SerialLock>()

function lockFor(root: string): SerialLock {
  const key = root.replace(/\/+$/, '')
  const existing = LOCKS.get(key)
  if (existing !== undefined) return existing
  const created = new SerialLock()
  LOCKS.set(key, created)
  return created
}

/** One atomic ledger commit: the new state plus the events it produced. */
export interface GuardMutation {
  readonly state: GuardState
  readonly events?: readonly GuardEvent[]
}

/** A `GuardState` has no `state` key, so the presence of one identifies a mutation. */
function isMutation(value: GuardState | GuardMutation): value is GuardMutation {
  return 'state' in value
}

function mutationStateOf(value: GuardState | GuardMutation): GuardState {
  return isMutation(value) ? value.state : value
}

function mutationEventsOf(value: GuardState | GuardMutation): readonly GuardEvent[] {
  return isMutation(value) ? (value.events ?? []) : []
}

/** Storage rooted at one run directory (`docs/guard/<run-id>/`). */
export class GuardStore {
  private readonly lock: SerialLock

  constructor(readonly root: string) {
    this.lock = lockFor(root)
  }

  get tasksPath(): string { return join(this.root, TASKS_FILE) }
  get eventsPath(): string { return join(this.root, EVENTS_FILE) }
  get metaPath(): string { return join(this.root, META_FILE) }
  get renderedPath(): string { return join(this.root, RENDERED_FILE) }
  probePath(taskId: string): string { return join(this.root, 'probes', `${taskId}.json`) }
  notesPath(taskId: string): string { return join(this.root, 'tasks', taskId, 'notes.md') }
  evidencePath(taskId: string, name: string): string { return join(this.root, 'tasks', taskId, 'evidence', name) }

  async readState(): Promise<GuardState | null> {
    return this.readJson<GuardState>(this.tasksPath)
  }

  async readMeta(): Promise<RunMeta | null> {
    return this.readJson<RunMeta>(this.metaPath)
  }

  async readProbeFile(taskId: string): Promise<TaskProbeFile | null> {
    return this.readJson<TaskProbeFile>(this.probePath(taskId))
  }

  /** Commit the ledger: state first, then events, then the rendered page. */
  async update(state: GuardState, events: readonly GuardEvent[] = []): Promise<void> {
    await this.lock.run(async () => {
      await writeFileAtomic(this.tasksPath, serialize(state))
      for (const event of events) await this.appendEventUnlocked(event)
      await writeFileAtomic(this.renderedPath, renderTasksMarkdown(state))
    })
  }

  /**
   * Read-modify-write the ledger under the same lock as `update`.
   *
   * Two callers that both `readState()` before the lock and then `update()` a
   * stale snapshot would otherwise silently drop each other's change (a runtime
   * model switch racing the audit is exactly that case).
   *
   * The callback may also hand back the events that belong to this very commit
   * (`{ state, events }`), so the ledger write, `state.jsonl` and `TASKS.md`
   * land together instead of an append racing a reader between two locks.
   * Returning `null` means "nothing to change": nothing is written, and the
   * current ledger is answered. Returning the same state object is the same
   * short circuit.
   */
  async mutate(
    apply: (state: GuardState) => GuardState | GuardMutation | null,
    /**
     * State to apply when `tasks.json` is already gone.
     *
     * Only for a caller whose OWN side effects can remove the ledger: a rollback
     * reverts commits, and a commit that carried `tasks.json` (a subagent's
     * `git add -A`, or a checkpoint above the base) takes the file with it. That
     * caller must still write the reopened ledger; every other caller keeps
     * treating a missing ledger as a failure (`null`).
     */
    missing?: GuardState,
  ): Promise<GuardState | null> {
    return await this.lock.run(async () => {
      const state = await this.readJson<GuardState>(this.tasksPath) ?? missing ?? null
      if (state === null) return null
      const applied = apply(state)
      if (applied === null) return state
      const next = mutationStateOf(applied)
      const events = mutationEventsOf(applied)
      if (next === state && events.length === 0) return state
      await writeFileAtomic(this.tasksPath, serialize(next))
      for (const event of events) await this.appendEventUnlocked(event)
      await writeFileAtomic(this.renderedPath, renderTasksMarkdown(next))
      return next
    })
  }

  async appendEvents(events: readonly GuardEvent[]): Promise<void> {
    await this.lock.run(async () => {
      for (const event of events) await this.appendEventUnlocked(event)
    })
  }

  async writeMeta(meta: RunMeta): Promise<void> {
    await this.lock.run(async () => {
      await writeFileAtomic(this.metaPath, serialize(meta))
    })
  }

  /**
   * Read-modify-write `run.json` under the run's lock.
   *
   * The caller does its slow work (a `gh` call, git) OUTSIDE the lock, then hands
   * in a pure mutation receiving the LATEST meta. A blind `writeMeta({ ...meta })`
   * based on a snapshot taken before that work erased whatever another writer
   * stored meanwhile — `syncMirror` dropped `mirror.provider`/`host` and the
   * concurrent `setup.firstMessage` marker this way. Returning `null` means
   * "nothing to change".
   */
  async updateMeta(mutate: (current: RunMeta) => RunMeta | null): Promise<RunMeta | null> {
    return this.lock.run(async () => {
      const current = await this.readMeta()
      if (current === null) return null
      const next = mutate(current)
      if (next === null) return current
      await writeFileAtomic(this.metaPath, serialize(next))
      return next
    })
  }

  async writeProbeFile(taskId: string, file: TaskProbeFile): Promise<void> {
    await this.lock.run(async () => {
      await writeFileAtomic(this.probePath(taskId), serialize(file))
    })
  }

  /** Cold start: regenerate the rendered page from the ledger unconditionally. */
  async refreshRendered(): Promise<GuardState | null> {
    const state = await this.readState()
    if (state === null) return null
    await this.lock.run(async () => {
      await writeFileAtomic(this.renderedPath, renderTasksMarkdown(state))
    })
    return state
  }

  private async appendEventUnlocked(event: GuardEvent): Promise<void> {
    await mkdir(dirname(this.eventsPath), { recursive: true })
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, 'utf8')
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      const text = await readFile(file, 'utf8')
      return JSON.parse(text) as T
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }
}
