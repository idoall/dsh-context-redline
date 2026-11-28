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
import { carrierContentFingerprint } from '../../shared/redline-carrier'
import { splitTaskRow } from '../../shared/redline-supervisor'
import { GUARD_SCHEMA_VERSION } from './schema'
import type {
  EnforcementMode,
  EvaluatorRoute,
  GuardEvent,
  GuardTask,
  ModelRoute,
  ProbeDef,
  RunMeta,
  TaskProbeFile,
  VisualEvidenceConfig,
} from './schema'
import { buildRunId, SAFE_RUN_ID, sanitizeRefSegment } from './run-id'
import { createRunWorktree, dirtyHashes, excludeRunWorktreeRoot, existingGuardBranches, hasGit, headCommit, normalizeScopePath } from './git'
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
  /** Work in an isolated worktree on its own branch when the workspace is a repo; no extra DSH workspace is created. */
  readonly worktree?: boolean
  /** Optional dedicated evaluator model route; defaults to the session's main model. */
  readonly evaluator?: EvaluatorRoute
  /** Evaluator route tried when the primary judge cannot answer. */
  readonly evaluatorFallback?: ModelRoute
  /** Execution route the human chose for this run (record only; the session owns the live value). */
  readonly executor?: ModelRoute
  /** Execution route to switch to when the primary executor cannot run. */
  readonly executorFallback?: ModelRoute
  /** Observation-only visual witness configuration. */
  readonly visual?: VisualEvidenceConfig
}

/** Canonical hash over the frozen goal card and task table. */
export function guardHashOf(seed: {
  readonly goal: string
  readonly acceptance: string
  readonly discipline: string
  readonly tasks: string
}): string {
  return carrierContentFingerprint(JSON.stringify({
    goal: seed.goal.trim(),
    acceptance: seed.acceptance.trim(),
    discipline: seed.discipline.trim(),
    tasks: seed.tasks,
    planPath: '',
    planHash: '',
  }))
}

export interface PreparedRun {
  readonly runId: string
  readonly root: string
  readonly files: readonly string[]
  /** Set when the run works in its own `<cwd>/.guard/worktrees/<run-id>` checkout. */
  readonly worktreePath?: string
}

const TASK_LINE = /^([A-Za-z][A-Za-z0-9_-]*)\s*\|\s*(.+)$/

function splitAcceptance(raw: string): string[] {
  return raw.split(/[;；]\s*/).map(item => item.trim()).filter(item => item !== '')
}

function splitList(raw: string): string[] {
  return raw
    .split(/[,，、]\s*/)
    .map(item => item.trim().replace(/^`+|`+$/g, '').trim())
    .filter(item => item !== '')
}

const NO_DEP_SENTINEL = /^(?:-+|—|–|none|n\/a|null|无|无依赖|\(无\)|（无）)$/i

function splitDependsOn(raw: string): string[] {
  const items = splitList(raw)
  if (items.length === 1 && NO_DEP_SENTINEL.test(items[0] ?? '')) return []
  return items
}

type ParsedSupervisorTable =
  | {
    readonly ok: true
    readonly tasks: GuardTask[]
    /** True when at least one row explicitly provided column 5 (even `-` / empty). */
    readonly explicitDependsOn: boolean
  }
  | {
    readonly ok: false
    readonly reason: string
  }

function parseSupervisorTable(
  input: string,
  scopes: Readonly<Record<string, readonly string[]>> = {},
): ParsedSupervisorTable {
  const tasks: GuardTask[] = []
  const ids = new Set<string>()
  const pendingDeps: { readonly lineNo: number; readonly taskId: string; readonly dep: string }[] = []
  let explicitDependsOn = false
  const rawLines = input.split(/\r?\n/)
  for (let index = 0; index < rawLines.length; index += 1) {
    const lineNo = index + 1
    const line = (rawLines[index] ?? '').trim()
    if (line === '') continue
    const match = TASK_LINE.exec(line)
    if (match === null) {
      return { ok: false, reason: `第 ${lineNo} 行格式无效（需以任务 ID 开头，如 T1 | 标题 | 验收 | scope）：${line.slice(0, 48)}` }
    }
    const id = match[1]
    if (id === '' || ids.has(id)) {
      return { ok: false, reason: `第 ${lineNo} 行任务 ID「${id}」重复或为空` }
    }
    const rest = match[2]
    // Quote-aware: an acceptance cell may carry `-run "A|B"`, and a plain split
    // would shift the scope into the dependency column and reject the row.
    const parts = splitTaskRow(rest)
    const title = parts[0] ?? ''
    if (title === '') {
      return { ok: false, reason: `第 ${lineNo} 行（${id}）缺少任务标题` }
    }
    ids.add(id)
    const acceptance = splitAcceptance(parts[1] ?? '完成本任务并提交证据')
    const tableScope = parts.length > 2 ? splitList(parts[2] ?? '') : []
    if (parts.length > 3) explicitDependsOn = true
    const dependsOn = parts.length > 3 ? splitDependsOn(parts[3] ?? '') : []
    const mappedScope = scopes[id] ?? []
    // The table's inline scope column is how the dialog actually declares scope,
    // so it needs the same rules as the programmatic map: relative only, no `..`,
    // and never a blanket grant that would equal "no scope" everywhere else. The
    // stored form is NORMALIZED, because the matcher compares it against
    // worktree-relative paths: `././src/a.ts` would never match `src/a.ts`.
    const mergedScope = [...new Set([...tableScope, ...mappedScope].map(normalizeScopePath))]
    for (const entry of mergedScope) {
      if (!isSafeScopePath(entry) || isBroadScopePath(entry) || entry.length > 300) {
        return {
          ok: false,
          reason: `第 ${lineNo} 行（${id}）的 scope 路径「${entry}」不合法（需为工作区内相对路径，不能含 .. 或全局通配符）`,
        }
      }
    }
    for (const dep of dependsOn) {
      if (dep === id) return { ok: false, reason: `第 ${lineNo} 行（${id}）不能依赖自身` }
      pendingDeps.push({ lineNo, taskId: id, dep })
    }
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
  if (tasks.length === 0) return { ok: false, reason: '任务表为空' }
  for (const item of pendingDeps) {
    if (!ids.has(item.dep)) {
      return { ok: false, reason: `第 ${item.lineNo} 行（${item.taskId}）的依赖「${item.dep}」不在任务表中` }
    }
  }
  // A cycle (T1 → T2 → T1) never becomes startable, so the run would deadlock on
  // its first turn after the session already exists. Refuse it up front.
  if (hasDependencyCycle(tasks)) return { ok: false, reason: '任务依赖存在环路（cycle）' }
  return { ok: true, tasks, explicitDependsOn }
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
  const parsed = parseSupervisorTable(input, scopes)
  return parsed.ok ? parsed.tasks : null
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
    '（本段只能由主会话审查子会话产物后亲自写入，禁止让子会话代写。',
    '  写清做了什么、主会话如何复核的；新增一段“## 完成声明”后请立刻结束当前回合，',
    '  督导才会运行探针、独立评估并把锚点切到下一个任务。）',
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
  const parsedTable = parseSupervisorTable(input.tasks, input.scopes)
  if (!parsedTable.ok) throw new Error(`task table is invalid: ${parsedTable.reason}`)
  const parallel = clampParallel(input.parallel)
  // In sequential mode (parallel=1), a four-column table with no explicit
  // dependency column describes an ordered milestone pipeline: chain each row
  // on the previous task so a blocked earlier milestone cannot be silently
  // bypassed. Explicit column 5 (including `-`) or parallel>1 stays verbatim.
  const tasks: GuardTask[] = parallel === 1 && !parsedTable.explicitDependsOn
    ? parsedTable.tasks.map((task, index) => {
      const previous = index > 0 ? parsedTable.tasks.at(index - 1) : undefined
      return previous === undefined ? task : { ...task, dependsOn: [previous.id] }
    })
    : parsedTable.tasks
  const routeOf = (raw: ModelRoute | undefined): ModelRoute | undefined => {
    if (raw === undefined) return undefined
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
    const model = typeof raw.model === 'string' ? raw.model.trim() : ''
    const effort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : ''
    if (provider === '' || model === '') throw new Error('model route is invalid')
    return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
  }
  const evaluatorFallback = routeOf(input.evaluatorFallback)
  const executor = routeOf(input.executor)
  const executorFallback = routeOf(input.executorFallback)
  const visualRoute = routeOf(input.visual?.route)
  const visualFallback = routeOf(input.visual?.fallback)
  const visual: VisualEvidenceConfig | undefined = input.visual?.enabled === true
    ? {
      enabled: true,
      ...(visualRoute === undefined ? {} : { route: visualRoute }),
      ...(visualFallback === undefined ? {} : { fallback: visualFallback }),
    }
    : undefined
  let evaluator: EvaluatorRoute | undefined
  if (input.evaluator !== undefined) {
    const provider = typeof input.evaluator.provider === 'string' ? input.evaluator.provider.trim() : ''
    const model = typeof input.evaluator.model === 'string' ? input.evaluator.model.trim() : ''
    const reasoningEffort = typeof input.evaluator.reasoningEffort === 'string'
      ? input.evaluator.reasoningEffort.trim()
      : ''
    if (provider === '' || model === '') throw new Error('evaluator model is invalid')
    evaluator = {
      provider,
      model,
      ...(reasoningEffort === '' ? {} : { reasoningEffort }),
    }
  }

  const guardRoot = join(cwd, 'docs', 'guard')
  const gitRepo = await hasGit(cwd)
  // Include existing `guard/*` branches (and any `.guard/worktrees` dirs) so
  // auto-minted run ids never collide with a branch or worktree already in git.
  const taken = new Set([
    ...await existingRunIds(guardRoot),
    ...await existingRunIds(join(cwd, '.guard', 'worktrees')),
    ...(gitRepo ? await existingGuardBranches(cwd) : []),
  ])
  let runId: string
  if (input.runId !== undefined && input.runId !== '') {
    const candidate = input.runId.trim()
    if (!SAFE_RUN_ID.test(candidate) || candidate.length > 50) throw new Error('run id is invalid')
    runId = candidate
  } else {
    runId = buildRunId(new Date(), goal.split(/\r?\n/).find(line => line.trim() !== '') ?? goal, taken)
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

  const wantWorktree = input.worktree === true && gitRepo && (await headCommit(cwd)) !== null
  const worktreeDir = join(cwd, '.guard', 'worktrees', runId)
  // Check both checkout roots BEFORE touching git or creating any directory:
  // one run id may live in at most one checkout mode, and a running/completed
  // run must never be overwritten or forked into a second ledger.
  const sourceExisting = await new GuardStore(join(cwd, 'docs', 'guard', runId)).readMeta()
  const worktreeExisting = await new GuardStore(join(worktreeDir, 'docs', 'guard', runId)).readMeta()
  for (const meta of [sourceExisting, worktreeExisting]) {
    if (meta !== null && (meta.phase === 'running' || meta.phase === 'completed' || meta.sessionId !== undefined)) {
      throw new Error('run already exists')
    }
  }
  if (wantWorktree && sourceExisting !== null) {
    throw new Error('run already exists in the main workspace')
  }
  if (!wantWorktree && worktreeExisting !== null) {
    throw new Error('run already exists in a worktree')
  }

  let worktreePath: string | undefined
  if (wantWorktree) {
    worktreePath = worktreeDir
    // Write local-only ignore BEFORE creating `.guard/worktrees` so the main
    // checkout never briefly reports `.guard/` as untracked and no tracked
    // `.gitignore` in the user's repository has to change.
    await excludeRunWorktreeRoot(cwd, '.guard')
    let mounted = true
    try { await access(join(worktreePath, '.git')) } catch { mounted = false }
    if (!mounted) {
      await mkdir(join(cwd, '.guard', 'worktrees'), { recursive: true })
      await createRunWorktree(cwd, worktreePath, `guard/${runId}`)
    }
  }
  // Runs work in the worktree when they have one; the ledger keeps its
  // `docs/guard/<run-id>/` layout relative to whatever directory the runs
  // actually operate in.
  const runCwd = worktreePath ?? cwd
  const root = join(runCwd, 'docs', 'guard', runId)
  await mkdir(root, { recursive: true })
  const store = new GuardStore(root)
  const existing = wantWorktree ? worktreeExisting : sourceExisting

  const now = Date.now()
  // One baseline for the whole run, taken before any task touches the tree: a
  // file that was already dirty when the run started must never be blamed on a
  // task, and the model's own first-turn writes must never enter the baseline.
  const baselineDirty = await dirtyHashes(runCwd, `docs/guard/${runId}`)
  const baselineEntries = Object.keys(baselineDirty).length
  // Keep small baselines mirrored onto each task for backwards compatibility
  // with legacy readers; store large baselines only once on `state.baselineDirty`
  // so multi-task ledgers do not duplicate thousands of entries per task.
  const perTaskBaseline = baselineEntries <= 50 ? baselineDirty : {}
  const skeletons = new Map<string, string>()
  const stateTasks: GuardTask[] = tasks.map((task) => {
    const probes = probeMap.get(task.id) ?? []
    const shaped: GuardTask = {
      ...task,
      probes: probes.map(probe => probe.id),
      requiredProbes: probes.map(probe => probe.id),
      baselineDirty: perTaskBaseline,
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
    parallel,
    enforcement: input.enforcement ?? 'warn-only',
    worktree: worktreePath === undefined
      ? { enabled: false }
      : { enabled: true, path: worktreePath, branch: `guard/${runId}` },
    ...(input.smokeCommand === undefined ? {} : { smokeCommand: input.smokeCommand }),
    ...(evaluator === undefined ? {} : { evaluator }),
    ...(evaluatorFallback === undefined ? {} : { evaluatorFallback }),
    ...(executor === undefined ? {} : { executor }),
    ...(executorFallback === undefined ? {} : { executorFallback }),
    ...(visual === undefined ? {} : { visual }),
    milestoneEvery: Math.max(1, Math.trunc(input.milestoneEvery ?? 3)),
    ...(baselineEntries === 0 ? {} : { baselineDirty }),
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
/**
 * Record the route the anchored session actually runs on.
 *
 * The human's chosen execution model belongs to the session (DSH owns it); the
 * ledger keeps a copy so a later switch is visible and auditable. `executor` is
 * the frozen choice from the dialog, `activeExecutor` the route in force now.
 */
export async function recordActiveExecutor(cwd: string, runId: string, route: ModelRoute): Promise<void> {
  const store = new GuardStore(join(cwd, 'docs', 'guard', runId))
  // Under the store lock: a first turn racing the cold-start read must not erase
  // whatever the other writer just recorded.
  await store.mutate(current => (
    current.activeExecutor?.provider === route.provider
      && current.activeExecutor.model === route.model
      && current.activeExecutor.reasoningEffort === route.reasoningEffort
      ? current
      : { ...current, activeExecutor: route, updatedAt: Date.now() }
  ))
}

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
