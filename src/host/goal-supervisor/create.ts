/**
 * Creation of one supervisor run: turn a frozen goal card into the on-disk
 * ledger that the dialog's second step reports progress for.
 *
 * This module only prepares files; it never creates a session, attaches a
 * guard or touches git. Session creation happens afterwards, and the mount
 * callback re-reads `run.json` by run id.
 *
 * Preparing the same explicit run id twice is a supported retry: the ledger is
 * rewritten from the latest card so a dialog that changed its task table never
 * starts a session against a stale one. Only a run that is already mounted
 * (`phase: running`, or `sessionId` present) refuses to be overwritten.
 */

import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { guardHashOf } from '../goal-guard'
import { GUARD_SCHEMA_VERSION } from './schema'
import type {
  EnforcementMode,
  GuardEvent,
  GuardTask,
  ProbeDef,
  RunMeta,
  TaskProbeFile,
} from './schema'
import { buildRunId, SAFE_RUN_ID, sanitizeRefSegment } from './run-id'
import { createRunWorktree, dirtyHashes, hasGit, headCommit, normalizeScopePath } from './git'
import { isBroadScopePath, isSafeScopePath } from './scope'
import { shellishProbeArg } from './probes'
import { GuardStore } from './store'

export interface PrepareRunInput {
  readonly goal: string
  readonly acceptance: string
  readonly discipline: string
  /** Task table: `ID | title | acceptance;acceptance[ | scope,scope[ | dependsOn,dependsOn]]`. */
  readonly tasks: string
  readonly parallel?: number
  readonly enforcement?: EnforcementMode
  readonly milestoneEvery?: number
  /** Optional per-task scope map; merged with the table's fourth field. */
  readonly scopes?: Readonly<Record<string, readonly string[]>>
  /** Probe definitions, typically built from the confirmed command list. */
  readonly probes?: readonly ProbeDef[]
  /** Project-level compile/smoke command used before a task is marked DONE. */
  readonly smokeCommand?: { readonly cmd: string; readonly args: readonly string[]; readonly timeoutMs?: number }
  /** Optional explicit run id (used when the dialog retries step two). */
  readonly runId?: string
  /** Run in an isolated git worktree when the workspace is a repo. */
  readonly worktree?: boolean
}

export interface PreparedRun {
  readonly runId: string
  readonly root: string
  readonly files: readonly string[]
  readonly worktreePath?: string
}

const TASK_LINE = /^([A-Za-z][A-Za-z0-9_-]*)\s*\|\s*(.+)$/

function splitAcceptance(raw: string): string[] {
  return raw.split(/[;；]\s*/).map(item => item.trim()).filter(item => item !== '')
}

function splitList(raw: string): string[] {
  return raw.split(/[,，]\s*/).map(item => item.trim()).filter(item => item !== '')
}

/**
 * Parse the task table; `null` means the table cannot be trusted.
 *
 * Columns: `ID | title | acceptance;acceptance | scope,scope | dependsOn,dependsOn`.
 * Dependencies must name tasks that exist in the same table.
 */
export function parseSupervisorTasks(
  input: string,
  scopes: Readonly<Record<string, readonly string[]>> = {},
): GuardTask[] | null {
  const tasks: GuardTask[] = []
  const ids = new Set<string>()
  const missing: string[] = []
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const match = TASK_LINE.exec(line)
    if (match === null) return null
    const id = match[1]
    if (id === '' || ids.has(id)) return null
    const rest = match[2]
    const parts = rest.split('|').map(part => part.trim())
    const title = parts[0] ?? ''
    if (title === '') return null
    ids.add(id)
    const acceptance = splitAcceptance(parts[1] ?? '完成本任务并提交证据')
    const tableScope = parts.length > 2 ? splitList(parts[2] ?? '') : []
    const dependsOn = parts.length > 3 ? splitList(parts[3] ?? '') : []
    const mappedScope = scopes[id] ?? []
    // The table's inline scope column is how the dialog actually declares scope,
    // so it needs the same rules as the programmatic map: relative only, no `..`,
    // and never a blanket grant that would equal "no scope" everywhere else. The
    // stored form is NORMALIZED, because the matcher compares it against
    // worktree-relative paths: `././src/a.ts` would never match `src/a.ts`.
    const mergedScope = [...new Set([...tableScope, ...mappedScope].map(normalizeScopePath))]
    for (const entry of mergedScope) {
      if (!isSafeScopePath(entry) || isBroadScopePath(entry) || entry.length > 300) return null
    }
    for (const dep of dependsOn) if (dep === id) return null
    missing.push(...dependsOn)
    tasks.push({
      id,
      title,
      status: 'TODO',
      scope: mergedScope,
      dependsOn,
      acceptance: acceptance.length === 0 ? ['完成本任务并提交证据'] : acceptance,
      probes: [],
      requiredProbes: [],
      probeResults: {},
      evidence: [],
      attempts: [],
      scopeApprovedCount: 0,
      baselineDirty: {},
    })
  }
  if (tasks.length === 0) return null
  for (const dep of missing) if (!ids.has(dep)) return null
  // A cycle (T1 → T2 → T1) never becomes startable, so the run would deadlock on
  // its first turn after the session already exists. Refuse it up front.
  if (hasDependencyCycle(tasks)) return null
  return tasks
}

/** True when following `dependsOn` from any task returns to itself. */
function hasDependencyCycle(tasks: readonly GuardTask[]): boolean {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const state = new Map<string, 'visiting' | 'done'>()
  const walk = (id: string): boolean => {
    const mark = state.get(id)
    if (mark === 'done') return false
    if (mark === 'visiting') return true
    state.set(id, 'visiting')
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (walk(dep)) return true
    }
    state.set(id, 'done')
    return false
  }
  return tasks.some(task => walk(task.id))
}

function notesSkeleton(task: GuardTask): string {
  const lines = [
    `# ${task.id} · ${task.title}`,
    '',
    '- 状态：TODO',
    `- 允许改动：${task.scope.length === 0 ? '（未声明）' : task.scope.map(path => `\`${path}\``).join('、')}`,
    '- 验收：',
    ...task.acceptance.map(item => `  - ${item}`),
    '- 证据：（待补）',
    '',
    '## 完成声明',
    '',
    '（写清做了什么、怎么验证的。新增一段“## 完成声明”会让督导立刻重新评估本任务；',
    '  不写这一节也可以，督导会在文件改动变化后自动评估。）',
    '',
  ]
  return lines.join('\n')
}

function clampParallel(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1
  return Math.min(10, Math.max(1, Math.trunc(value)))
}

async function existingRunIds(root: string): Promise<Set<string>> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Set()
    throw error
  }
}

/** Prepare the run directory. Throws a plain Error with a user-readable message. */
export async function prepareGuardRun(cwd: string, input: PrepareRunInput): Promise<PreparedRun> {
  const goal = input.goal.trim()
  const acceptance = input.acceptance.trim()
  const discipline = input.discipline.trim()
  if (goal === '') throw new Error('goal is empty')
  const tasks = parseSupervisorTasks(input.tasks, input.scopes)
  if (tasks === null) throw new Error('task table is invalid')

  const guardRoot = join(cwd, 'docs', 'guard')
  await mkdir(guardRoot, { recursive: true })
  // Worktree runs keep their ledger inside `.guard/worktrees/<run-id>`, so a
  // collision scan that only looks at `docs/guard` would miss every one of them
  // and silently overwrite a running run's ledger.
  const taken = new Set([
    ...await existingRunIds(guardRoot),
    ...await existingRunIds(join(cwd, '.guard', 'worktrees')),
  ])
  let runId: string
  if (input.runId !== undefined && input.runId !== '') {
    const candidate = input.runId.trim()
    if (!SAFE_RUN_ID.test(candidate) || candidate.length > 50) throw new Error('run id is invalid')
    runId = candidate
  } else {
    runId = buildRunId(new Date(), goal.split(/\r?\n/).find(line => line.trim() !== '') ?? goal, taken)
  }

  let root = join(guardRoot, runId)
  let worktreePath: string | undefined
  const wantWorktree = input.worktree === true && await hasGit(cwd) && (await headCommit(cwd)) !== null
  if (wantWorktree) {
    worktreePath = join(cwd, '.guard', 'worktrees', runId)
    let exists = true
    try { await access(join(worktreePath, '.git')) } catch { exists = false }
    if (!exists) {
      await mkdir(join(cwd, '.guard', 'worktrees'), { recursive: true })
      await createRunWorktree(cwd, worktreePath, `guard/${runId}`)
    }
    root = join(worktreePath, 'docs', 'guard', runId)
  }

  const store = new GuardStore(root)
  // One guard for every mode: a run that already owns a live session is never
  // rewritten, whether or not it lives in a worktree. Read the meta directly —
  // a missing directory simply answers `null`.
  const existing = await store.readMeta()
  if (existing !== null && (existing.phase === 'running' || existing.sessionId !== undefined)) {
    throw new Error('run already exists')
  }

  const probeMap = new Map<string, ProbeDef[]>()
  for (const probe of input.probes ?? []) {
    // A probe for an unknown task would be dropped silently and the task would
    // then pass on the evaluator alone. Refuse the run instead of losing a gate.
    if (!tasks.some(task => task.id === probe.taskId)) {
      throw new Error(`probe ${probe.id} names unknown task ${probe.taskId}`)
    }
    if (probe.spec.kind === 'command') {
      // The dialog splits the line on whitespace, so a shell-shaped argument is
      // always a misunderstanding: it would be passed through literally and the
      // probe would fail forever with no explanation in the ledger.
      const shellish = shellishProbeArg(probe.spec.args)
      if (shellish !== null) {
        throw new Error(
          `probe ${probe.id} argument ${JSON.stringify(shellish)} needs a shell: `
          + 'arguments are split on whitespace and run without a shell, so quotes, pipes and '
          + 'redirection are passed through literally. Drop the quotes, or wrap the command in a script.',
        )
      }
    }
    const list = probeMap.get(probe.taskId) ?? []
    list.push(probe)
    probeMap.set(probe.taskId, list)
  }

  const now = Date.now()
  // One baseline for the whole run, taken before any task touches the tree: a
  // file that was already dirty when the run started must never be blamed on a
  // task, and the model's own first-turn writes must never enter the baseline.
  const baselineDirty = await dirtyHashes(worktreePath ?? cwd, `docs/guard/${runId}`)
  const skeletons = new Map<string, string>()
  const stateTasks: GuardTask[] = tasks.map((task) => {
    const probes = probeMap.get(task.id) ?? []
    const shaped: GuardTask = {
      ...task,
      probes: probes.map(probe => probe.id),
      requiredProbes: probes.map(probe => probe.id),
      baselineDirty,
    }
    const skeleton = notesSkeleton(shaped)
    skeletons.set(task.id, skeleton)
    // The skeleton already contains the "## 完成声明" heading it teaches the model
    // to use. Starting the evaluation offset past it keeps turn one from looking
    // like a fresh completion declaration (which would force heavy probes and an
    // evaluation before anything changed).
    return { ...shaped, lastEvalOffset: skeleton.length }
  })

  const state = {
    version: GUARD_SCHEMA_VERSION,
    runId,
    goal,
    acceptance,
    discipline,
    goalHash: guardHashOf({ goal, acceptance, discipline, tasks: input.tasks }),
    tasks: stateTasks,
    activeTaskIds: [],
    parallel: clampParallel(input.parallel),
    enforcement: input.enforcement ?? 'warn-only',
    worktree: worktreePath === undefined ? { enabled: false } : { enabled: true, path: worktreePath, branch: `guard/${runId}` },
    ...(input.smokeCommand === undefined ? {} : { smokeCommand: input.smokeCommand }),
    milestoneEvery: Math.max(1, Math.trunc(input.milestoneEvery ?? 3)),
    status: 'active' as const,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  const created: GuardEvent = { type: 'run.created', at: now, runId, goalHash: state.goalHash }
  await store.update(state, [created])

  const meta: RunMeta = {
    version: GUARD_SCHEMA_VERSION,
    runId,
    epoch: (existing?.epoch ?? 0) + 1,
    goalHash: state.goalHash,
    phase: 'ready',
    setup: { goal: false, anchors: false, guard: false, firstMessage: false },
    mirror: { mode: 'auto' },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await store.writeMeta(meta)

  await pruneStaleTaskArtifacts(root, stateTasks.map(task => task.id))

  const files: string[] = ['tasks.json', 'state.jsonl', 'run.json', 'TASKS.md']
  for (const task of stateTasks) {
    const notes = store.notesPath(task.id)
    await mkdir(join(root, 'tasks', task.id, 'evidence'), { recursive: true })
    await writeFileSafe(notes, skeletons.get(task.id) ?? notesSkeleton(task))
    files.push(`tasks/${task.id}/notes.md`)

    const probes = probeMap.get(task.id) ?? []
    const probeFile: TaskProbeFile = {
      version: GUARD_SCHEMA_VERSION,
      taskId: task.id,
      confirmedAt: now,
      probes,
    }
    await store.writeProbeFile(task.id, probeFile)
    files.push(`probes/${task.id}.json`)
  }

  await mkdir(join(root, 'review'), { recursive: true })
  await mkdir(join(root, 'final-regression'), { recursive: true })
  await mkdir(join(root, 'logs'), { recursive: true })
  await writeFileSafe(join(root, 'logs', '.gitignore'), '*\n!.gitignore\n')
  files.push('logs/.gitignore')

  return { runId, root, files, ...(worktreePath === undefined ? {} : { worktreePath }) }
}

/**
 * Drop task/probe artifacts that the rewritten card no longer names.
 *
 * Preparing the same run id twice is a supported retry; without this, a task the
 * operator deleted would keep a stale `tasks/<ID>/` and `probes/<ID>.json`
 * behind, and the next mount would see probes for a task that no longer exists.
 */
async function pruneStaleTaskArtifacts(root: string, keep: readonly string[]): Promise<void> {
  const allowed = new Set(keep)
  for (const dir of ['tasks', 'probes']) {
    let entries: string[] = []
    try { entries = await readdir(join(root, dir)) } catch { continue }
    for (const entry of entries) {
      const id = dir === 'tasks' ? entry : entry.replace(/\.json$/, '')
      if (allowed.has(id)) continue
      await rm(join(root, dir, entry), { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

async function writeFileSafe(path: string, data: string): Promise<void> {
  await writeFile(path, data, 'utf8')
}

/** `guard/<run-id>/<task>` with both segments normalized for ref safety. */
export function checkpointRefOf(runId: string, taskId: string): string {
  return `guard/${sanitizeRefSegment(runId, 50)}/${sanitizeRefSegment(taskId)}`
}

/**
 * Record that the run's first message actually reached the session.
 *
 * `run.json.setup.firstMessage` stayed `false` forever, so the card could not
 * tell an armed run from one whose first task never arrived.
 */
export async function markFirstMessageDelivered(cwd: string, runId: string): Promise<void> {
  const store = new GuardStore(join(cwd, 'docs', 'guard', runId))
  // Mutate the LATEST meta under the store lock: this call races the first turn's
  // `syncMirror`, and a blind write from a stale snapshot erased the mirror
  // identity (or this very marker) depending on who finished last.
  await store.updateMeta(meta => meta.setup.firstMessage
    ? null
    : { ...meta, setup: { ...meta.setup, firstMessage: true }, updatedAt: Date.now() })
}

/** Mark a prepared-but-unmounted run as failed so the caller can report why. */
export async function markSetupFailed(
  cwd: string,
  runId: string,
  step: 'goal' | 'anchors' | 'guard' | 'firstMessage',
  message: string,
): Promise<void> {
  const store = new GuardStore(join(cwd, 'docs', 'guard', runId))
  const updated = await store.updateMeta(meta => ({
    ...meta,
    phase: 'setup-failed',
    setup: { ...meta.setup, failedStep: step, errorMessage: message.slice(0, 500) },
    updatedAt: Date.now(),
  }))
  if (updated === null) return
  await store.appendEvents([{ type: 'setup.failed', at: Date.now(), step, message: message.slice(0, 500) }])
}
