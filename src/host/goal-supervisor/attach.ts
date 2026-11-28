/**
 * Attach the supervisor to one freshly mounted session.
 *
 * Responsibilities here are deliberately small and observable:
 *   - register the head/tail anchors from the live ledger;
 *   - install the tool guard the run's enforcement mode asks for;
 *   - on each turn stop, audit the current task's probes and persist results.
 *
 * Creating the host goal is NOT part of this module's attach step: `setup` runs
 * before the agent enters the registry, and the goal service rejects any call
 * for an agent that is not live yet. `armSupervisorGoal` therefore runs from the
 * session-control path *after* `agents.create`/`resume` resolves, and is also
 * what a cold start uses to restore a run that was mounted in a previous
 * process.
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import type { GuardState, GuardTask, RunMeta } from './schema'
import { renderAnchorDetailed } from './anchor'
import { initialGoalRounds, nextGoalRounds, goalExhausted, GOAL_ROUNDS_INITIAL } from './budget'
import { RUNTIME_ANCHOR_NAME, RUNTIME_ANCHOR_ORDER } from '../../shared/redline-carrier'
import { pathInScope } from './git'
import { REDLINE_DATA_DIR_NAME } from '../../shared/redline-paths'
import { auditTurn, runningTasks } from './loop'
import { detectMirror, type MirrorConfig } from './mirror'
import { GuardStore, SerialLock } from './store'
import { rememberSupervisorRun } from './status'
import { effectiveCwdOf } from '../effective-cwd'

export const SUPERVISOR_ANCHOR_HEAD = 'redline:goal-supervisor-head'
export const SUPERVISOR_ANCHOR_TAIL = 'redline:goal-supervisor-tail'

/** Writes the main session may make inside its own run directory. */
const GUARD_WRITABLE = [
  /^tasks\/[A-Za-z0-9_-]+\/notes\.md$/,
  /^review\/[^/]+\.md$/,
  /^requests\/[^/]+\.json$/,
]

/** Tools that would sidestep the write-scope rules; denied in enforce mode. */
const DENIED_IN_ENFORCE = new Set(['apply_patch', 'str_replace_editor', 'pwsh'])
/**
 * Shell-shaped tools; the supervisor's whole point is that probes, not the
 * model, run commands.
 *
 * The installed DSH terminal plugin registers `terminal_open` / `terminal_send` /
 * `terminal_signal`, not `terminal` — matching only the bare name left a full
 * shell reachable in strict mode.
 */
const SHELL_TOOLS = new Set(['bash', 'run_code', 'shell', 'exec', 'terminal'])

function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name) || /^terminal(?:_|$)/.test(name)
}

export interface SupervisorAgentFace {
  readonly id: string
  steer?(message: string): void
}

/** The live agent as the channel sees it: identity plus its session header. */
export interface SupervisorAgent extends SupervisorAgentFace {
  readonly session?: { readonly header?: { readonly cwd?: string } }
}

interface SystemPromptFace {
  context?(contribution: {
    readonly name: string
    readonly order: number
    readonly text: string | (() => string)
    readonly interpolate: boolean
    readonly required: boolean
  }): unknown
}

interface GoalRef {
  readonly id: string
  readonly revision: number
}

/** The host `GoalView` fields this plugin reads; all optional for older hosts. */
interface GoalViewFace extends GoalRef {
  readonly phase?: string
  readonly activation?: string
  readonly roundsStarted?: number
  readonly maxGoalRounds?: number
  readonly blockedReason?: { readonly code?: string; readonly message?: string }
}

interface GoalsFace {
  get?(agent: SupervisorAgentFace): GoalViewFace | undefined
  create?(agent: SupervisorAgentFace, request: { readonly objective: string; readonly maxGoalRounds?: number }): unknown
  edit?(
    agent: SupervisorAgentFace,
    ref: GoalRef,
    request: { readonly objective?: string; readonly maxGoalRounds?: number },
  ): GoalViewFace | undefined
  complete?(agent: SupervisorAgentFace, ref: GoalRef): unknown
  block?(agent: SupervisorAgentFace, ref: GoalRef, reason: { readonly code: string; readonly message: string }): unknown
  resume?(agent: SupervisorAgentFace, ref: GoalRef): unknown
}

/**
 * Raise an exhausted round cap and resume with the NEW revision.
 *
 * `GoalService.resume` refuses a goal whose `roundsStarted >= maxGoalRounds`,
 * and its own error says to raise the cap first. `edit` accepts a `blocked`
 * goal and bumps `revision`, so resume must use the revision `edit` returned.
 */
async function extendAndResume(goals: GoalsFace, agent: SupervisorAgentFace, view: GoalViewFace): Promise<boolean> {
  if (goals.edit === undefined || goals.resume === undefined) return false
  const rounds = typeof view.roundsStarted === 'number' && typeof view.maxGoalRounds === 'number'
    ? { started: view.roundsStarted, max: view.maxGoalRounds }
    : null
  const target = nextGoalRounds(rounds === null ? GOAL_ROUNDS_INITIAL : rounds.max)
  const edited = goals.edit(agent, { id: view.id, revision: view.revision }, { maxGoalRounds: target })
  if (edited !== undefined && typeof edited.revision !== 'number') return false
  const revision = typeof edited?.revision === 'number' ? edited.revision : view.revision + 1
  await goals.resume(agent, { id: view.id, revision })
  return true
}

export interface SupervisorDeps {
  readonly ctx: { get(name: string): GoalsFace | { (name: string): string } | undefined }
  readonly agentCtx: {
    get?(name: string): SystemPromptFace | undefined
    on?(name: string, handler: (...args: unknown[]) => unknown): unknown
  }
  readonly agent: SupervisorAgentFace
  readonly runId: string
  readonly cwd: string
  /** Override the remote-probe budget; tests use it to prove the degrade path fast. */
  readonly mirrorProbeMs?: number
}

export interface AttachedSupervisor {
  readonly store: GuardStore
  readonly state: GuardState
  readonly handler: () => Promise<void>
  /** Re-read the ledger so a rollback done elsewhere is visible to anchors and guards. */
  readonly refresh: () => Promise<void>
  /** The tool guard's decision for one call; exported for the tests. */
  readonly checkTool: (exec: Record<string, unknown>) => string | undefined
  /** The exact live agent object this attachment belongs to. */
  readonly agent: SupervisorAgentFace
}

export interface ArmGoalDeps {
  readonly ctx: { get(name: string): GoalsFace | undefined }
  readonly agent: SupervisorAgentFace
  readonly cwd: string
  readonly runId: string
}

/** Live attachments in this process, keyed by session + workspace + run. */
const ATTACHED = new Map<string, AttachedSupervisor>()

function attachKey(sessionId: string, cwd: string, runId: string): string {
  return `${sessionId}\u0000${cwd}\u0000${runId}`
}

export function attachedSupervisorFor(sessionId: string, runId?: string): AttachedSupervisor | undefined {
  for (const [key, value] of ATTACHED) {
    const [session, , run] = key.split('\u0000')
    if (session !== sessionId) continue
    if (runId !== undefined && run !== runId) continue
    return value
  }
  return undefined
}

export function forgetSupervisor(sessionId: string, cwd: string, runId: string): void {
  ATTACHED.delete(attachKey(sessionId, cwd, runId))
}

/** Drop every attachment owned by one session id (used on `agent/disposed`). */
export function forgetSessionAttachments(sessionId: string): void {
  for (const key of [...ATTACHED.keys()]) {
    const [session] = key.split('\u0000')
    if (session === sessionId) ATTACHED.delete(key)
  }
}

/** The plugin's data directory, or null when the harness home is not composed. */
function homeDirOf(ctx: SupervisorDeps['ctx']): string | null {
  const home = ctx.get('dshHomePath')
  if (typeof home !== 'function') return null
  try {
    return join(home(REDLINE_DATA_DIR_NAME), 'supervisor')
  } catch {
    return null
  }
}

function systemPromptOf(agentCtx: SupervisorDeps['agentCtx']): SystemPromptFace | undefined {
  return agentCtx.get?.('systemPrompt')
}

/**
 * The frozen goal card a run was created with. The ledger stores exactly the
 * three fields the card was composed from, so a cold start can re-declare the
 * same text the original session saw.
 */
export function frozenCardText(state: GuardState): string {
  return `目标：${state.goal}\n\n验收：${state.acceptance}\n\n纪律：${state.discipline}`
}

/**
 * Re-declare the frozen card after a process restart. Without it the model only
 * sees the supervisor's head/tail anchors (first goal line, current task) and
 * silently loses the acceptance criteria and the discipline it was created with.
 */
function restoreFrozenCard(agentCtx: SupervisorDeps['agentCtx'], state: GuardState): void {
  const systemPrompt = systemPromptOf(agentCtx)
  if (typeof systemPrompt?.context !== 'function') return
  systemPrompt.context({
    name: RUNTIME_ANCHOR_NAME,
    order: RUNTIME_ANCHOR_ORDER,
    text: frozenCardText(state),
    interpolate: false,
    required: true,
  })
}

function goalsOf(ctx: SupervisorDeps['ctx']): GoalsFace | undefined {
  const goals = ctx.get('goals')
  return typeof goals === 'function' ? undefined : goals
}

/** Tool arguments are `unknown`; a JSON string is accepted defensively. */
function argsOf(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return {}
}

/** Budget for the one shell-out on the mount path (gh/glab auth check). */
const MIRROR_PROBE_MS = 5_000

/** Resolve `task`, or reject after `ms`; the loser is discarded, not awaited. */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`timed out after ${ms}ms`)) }, ms)
    task.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * Candidate roots of the workspace: the path the caller named and its REAL path.
 *
 * macOS `/tmp` (and therefore every `mkdtemp(tmpdir())` workspace) is itself a
 * symlink, so a tool that reports the canonical `/private/tmp/...` path used to
 * be rejected as "outside the workspace" although the same file was inside it.
 */
function workspaceRoots(cwd: string): string[] {
  const roots = [cwd]
  try {
    // `.native` reports the DISK's own spelling, which is what makes a
    // case-mismatched path (`docs/GUARD/...` on APFS) recognizably different from
    // the declared one. Plain `realpathSync` echoes the caller's case, so the
    // equality check below could never fire.
    const real = nativeRealpath(cwd)
    if (real !== cwd) roots.push(real)
  } catch { /* a missing workspace fails the lexical check below anyway */ }
  return roots
}

/**
 * `realpathSync.native`, or plain `realpathSync` when the runtime has no native
 * variant (a non-Node launcher). The native form is required for the
 * case-insensitive-filesystem check: it resolves to the name on disk.
 */
function nativeRealpath(path: string): string {
  const native = (realpathSync as unknown as { native?: (value: string) => string }).native
  return typeof native === 'function' ? native(path) : realpathSync(path)
}

/**
 * Workspace-relative path, or `null` when it escapes the workspace.
 *
 * Both sides go through `realpath` first, so a symlink inside the workspace that
 * points at the ledger (or outside the checkout) cannot be written through its
 * innocent-looking name.
 */
function relativePathOf(cwd: string, declared: string): string | null {
  for (const root of workspaceRoots(cwd)) {
    const absolute = isAbsolute(declared) ? declared : join(root, declared)
    const path = relative(root, absolute)
    if (path === '') return '.'
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) continue
    const relativePart = path.split(sep).join('/')
    const real = realPathOrNull(root, absolute)
    if (real === null) return null
    if (real !== relativePart) return null
    return relativePart
  }
  return null
}

/**
 * True only when `probe` genuinely does not exist yet.
 *
 * `realpathSync` fails identically for a missing path and for a DANGLING symlink:
 * treating both as "does not exist yet" appended the link's own name and let a
 * `write` create its target outside the workspace through `O_CREAT`. A symlink
 * (any link, dangling or not) and every other stat error are refusals; only
 * `ENOENT` climbs to the parent.
 */
function missingEntry(probe: string): boolean {
  try {
    lstatSync(probe)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/**
 * The real, workspace-relative form of `absolute`, or `null` when it resolves
 * outside the workspace.
 *
 * A path that does not exist yet is fine: the nearest existing ancestor is
 * resolved and the remaining segments are appended, which is what a `write` to a
 * new file needs while still catching a symlinked parent.
 */
function realPathOrNull(cwd: string, absolute: string): string | null {
  let realCwd: string
  try {
    realCwd = nativeRealpath(cwd)
  } catch {
    return null
  }
  let probe = absolute
  const tail: string[] = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      // Native resolution: a caller-supplied uppercase spelling of an existing
      // path is NOT the same string, and must not be accepted as the real path.
      const real = nativeRealpath(probe)
      const resolved = tail.length === 0 ? real : join(real, ...tail.reverse())
      const rel = relative(realCwd, resolved)
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
      return rel.split(sep).join('/')
    } catch {
      if (!missingEntry(probe)) return null
      const parent = dirname(probe)
      if (parent === probe) return null
      tail.push(basename(probe))
      probe = parent
    }
  }
  return null
}

/**
 * True when the current sequential task has written a fresh `## 完成声明` past
 * `lastEvalOffset` that has not been audited yet.
 */
function pendingCompletionTaskSync(store: GuardStore, state: GuardState): GuardTask | undefined {
  if (state.status !== 'active' || state.parallel !== 1) return undefined
  const task = runningTasks(state).at(0)
  if (task === undefined || task.status === 'DONE' || task.status === 'BLOCKED') return undefined
  try {
    const text = readFileSync(store.notesPath(task.id), 'utf8')
    const tail = text.slice(task.lastEvalOffset ?? 0)
    return /##\s*完成声明/.test(tail) ? task : undefined
  } catch {
    return undefined
  }
}

/** `undefined` when the write is allowed inside the run directory. */
function guardDirDenial(relativeToRun: string): string | undefined {
  return GUARD_WRITABLE.some(pattern => pattern.test(relativeToRun))
    ? undefined
    : 'guard: 记录目录里只允许写 tasks/<ID>/notes.md、review/*.md、requests/*.json。'
}

function objectiveOf(state: GuardState): string {
  const checklist = state.tasks.map(task => `${task.id} | ${task.title}`).join('\n')
  return `${state.goal}\n\n任务清单：\n${checklist}`
}

/** Locate a run mounted for one session; `null` when this session has none. */
export async function findRunForSession(cwd: string, sessionId: string): Promise<{ runId: string; meta: RunMeta } | null> {
  let entries: string[] = []
  try { entries = await readdir(join(cwd, 'docs', 'guard')) } catch { return null }
  for (const entry of entries) {
    try {
      const meta = JSON.parse(await readFile(join(cwd, 'docs', 'guard', entry, 'run.json'), 'utf8')) as RunMeta
      if (meta.sessionId === sessionId) return { runId: entry, meta }
    } catch { /* not a run directory */ }
  }
  return null
}

/** Attach anchors, tool guard and the probe audit; throws only when the run is unusable. */
export async function attachSupervisor(deps: SupervisorDeps): Promise<AttachedSupervisor> {
  const key = attachKey(deps.agent.id, deps.cwd, deps.runId)
  const existing = ATTACHED.get(key)
  if (existing !== undefined && existing.agent === deps.agent) return existing
  const root = join(deps.cwd, 'docs', 'guard', deps.runId)
  const store = new GuardStore(root)
  const initial = await store.readState()
  if (initial === null) throw new Error('supervisor run is missing')
  let live = initial

  const systemPrompt = systemPromptOf(deps.agentCtx)
  const anchorsAvailable = typeof systemPrompt?.context === 'function'
  const reported = { head: false, tail: false }
  const sideText = (side: 'head' | 'tail'): string => {
    const rendered = renderAnchorDetailed(live, { cwd: deps.cwd })
    if (rendered.truncated && !reported[side]) {
      reported[side] = true
      void store.appendEvents([{
        type: 'anchor.truncated', at: Date.now(), side,
        originalBytes: rendered.originalBytes, keptBytes: rendered.keptBytes,
      }]).catch(() => undefined)
    }
    return rendered.text
  }
  if (systemPrompt?.context === undefined) {
    // An anchor-less session still gets the audit; record the degraded mount.
    await store.appendEvents([{ type: 'setup.failed', at: Date.now(), step: 'anchors', message: 'systemPrompt.context is unavailable' }])
  } else {
    systemPrompt.context({
      name: SUPERVISOR_ANCHOR_HEAD,
      order: 90,
      text: () => sideText('head'),
      interpolate: false,
      required: true,
    })
    systemPrompt.context({
      name: SUPERVISOR_ANCHOR_TAIL,
      order: 900,
      text: () => sideText('tail'),
      interpolate: false,
      required: true,
    })
  }

  const meta = await store.readMeta()
  // Probing the remote shells out to gh/glab (`auth status`). It runs inside
  // `setup` and inside the SERIAL `agent/created` dispatch, so a hung CLI would
  // hold up every later session: give the probe its own short budget and fall
  // back to "off" instead of the 60s mirror timeout.
  const mirror = await withTimeout(detectMirror(deps.cwd), deps.mirrorProbeMs ?? MIRROR_PROBE_MS)
    .catch((): MirrorConfig => ({ mode: 'off', reason: 'remote probe timed out' }))
  if (meta !== null) {
    // Merge into the latest meta under the store lock: the probe above shells out
    // to `gh`/`glab` and a concurrent first-message marker must not be erased.
    await store.updateMeta(current => ({
      ...current,
      sessionId: deps.agent.id,
      phase: initial.status === 'completed' ? 'completed' : 'running',
      // A successful mount clears the previous failure: a red "mount incomplete"
      // line that never goes away is worse than no line at all.
      setup: { ...current.setup, anchors: anchorsAvailable, guard: true, failedStep: undefined, errorMessage: undefined },
      mirror: {
        // Keep the durable issue identity and retry state: re-attaching after a
        // restart must not make the next DONE create a second issue.
        ...current.mirror,
        mode: mirror.mode,
        ...(mirror.provider === undefined ? {} : { provider: mirror.provider }),
        ...(mirror.host === undefined ? {} : { host: mirror.host }),
        // A successful probe clears the old failure: a cold start that timed out
        // once kept `'remote probe timed out'` on a healthy `auto` mirror forever.
        ...(mirror.mode === 'auto' ? { reason: undefined } : mirror.reason === undefined ? {} : { reason: mirror.reason }),
      },
      updatedAt: Date.now(),
    }))
  }

  // Remember where this run lives, outside the repository. `guard.supervisor`
  // needs a live agent to learn the workspace, so without this an ordinary
  // restart made the whole card vanish while its ledger sat on disk.
  await rememberSupervisorRun(homeDirOf(deps.ctx), {
    sessionId: deps.agent.id,
    cwd: deps.cwd,
    runId: deps.runId,
  })

  const auditLock = new SerialLock()
  const handler = async (): Promise<void> => {
    await auditLock.run(async () => {
      const next = await auditTurn({ ctx: deps.ctx, agent: deps.agent, cwd: deps.cwd, runId: deps.runId, store, mirror })
      if (next !== null) live = next
    })
  }

  const refresh = async (): Promise<void> => {
    const next = await store.readState()
    if (next !== null) live = next
  }

  const guardDir = join('docs', 'guard', deps.runId).split(sep).join('/')
  const guardDirLower = guardDir.toLowerCase()

  /** The tool guard's decision; `undefined` means the call is allowed. */
  const checkTool = (exec: Record<string, unknown>): string | undefined => {
    const caller = (exec as { agent?: { readonly id?: unknown } }).agent
    if (caller !== undefined && typeof caller.id === 'string' && caller.id !== deps.agent.id) return undefined
    // Once the supervised run has completed, stand down completely so follow-up
    // conversation in the same session is not locked read-only forever. A later
    // human rollback calls `refresh()` and reopens `status` to `'active'`,
    // which immediately re-engages every rule below.
    if (live.status === 'completed') return undefined
    const name = typeof exec.name === 'string' ? exec.name : ''
    const args = argsOf(exec.arguments)
    if (name === 'create_goal') {
      return 'guard: 这次运行已经有督导目标；不要另建 goal。'
    }
    if (name === 'update_goal') {
      if (args.action === 'complete') {
        // Name the exact file and the exact next action. The old sentence
        // ("还有任务未通过") was read as "this session has no guard tool" by a
        // bridged model, which then spun `update_goal(complete)` for 200+ rounds.
        const pending = live.tasks.filter(task => task.status !== 'DONE')
        const current = runningTasks(live)
        const focus = (current.length > 0 ? current : pending).slice(0, 3).map(task => task.id)
        const paths = focus.map(id => `docs/guard/${deps.runId}/tasks/${id}/notes.md`).join('、')
        const count = `${pending.length}/${live.tasks.length}`
        const where = focus.length === 0 ? '' : `（当前：${focus.join('、')}）`
        return `guard: 还有 ${count} 个任务未通过${where}，不能标记目标完成。请审查产物后在 ${paths} 追加「## 完成声明」（该文件是督导允许主会话写入的例外），然后直接结束本回合，由督导跑探针并切换锚点；不要调用 update_goal(complete)。`
      }
      if (args.action === 'edit') return 'guard: 目标变更必须由用户确认。'
      // `pause` disarms the host goal just like `blocked`: a model-initiated
      // stop leaves the ledger `active` with nothing on the card that explains
      // it. Pausing is the human's decision, from the host UI.
      if (args.action === 'pause') return 'guard: 暂停只能由用户在宿主界面发起；不要自行暂停目标。'
      // `blocked` is recorded only by the supervisor loop, which also writes the
      // reason the card shows.
      if (args.action === 'blocked') {
        const focus = (runningTasks(live).length > 0 ? runningTasks(live) : live.tasks).slice(0, 3).map(task => task.id)
        const paths = focus.map(id => `docs/guard/${deps.runId}/tasks/${id}/notes.md`).join('、')
        return `guard: 只有督导循环可以判定阻塞；请把卡点写进 ${paths}（督导允许主会话写入的例外），然后继续尝试。`
      }
      return undefined
    }
    if (name === 'subagent' || name === 'subagent_fork') {
      const claimed = pendingCompletionTaskSync(store, live)
      if (claimed !== undefined) {
        return `guard: 当前任务（${claimed.id}）已写入「## 完成声明」，请先结束本回合让督导完成探针与评估并切换锚点，再派发下一个任务。`
      }
    }
    if (live.enforcement !== 'enforce') return undefined
    if (DENIED_IN_ENFORCE.has(name) || isShellTool(name)) {
      return isShellTool(name)
        ? 'guard: 主会话不直接执行命令；交给子会话或插件的探针。'
        : `guard: ${name} 不在严格模式允许的工具内；改用 write/edit，或交子会话。`
    }
    if (name === 'write' || name === 'edit') {
      const raw = typeof args.file_path === 'string' ? args.file_path : ''
      if (raw === '') return 'guard: 写操作缺少文件路径。'
      const path = relativePathOf(deps.cwd, raw)
      if (path === null) return 'guard: 只允许写工作区内的文件。'
      if (path === guardDir) return guardDirDenial('')
      if (path.startsWith(`${guardDir}/`)) return guardDirDenial(path.slice(guardDir.length + 1))
      // A file that does not exist yet keeps the caller's spelling through
      // `realpath` (the nearest existing ancestor is resolved, the tail is
      // appended). Compare case-insensitively as well: on APFS `docs/GUARD/...`
      // is the same directory as the plugin's own ledger.
      const lower = path.toLowerCase()
      if (lower === guardDirLower) return guardDirDenial('')
      if (lower.startsWith(`${guardDirLower}/`)) return guardDirDenial(path.slice(guardDir.length + 1))
      const tasks = runningTasks(live)
      if (tasks.some(task => pathInScope(path, task.scope))) return undefined
      const names = tasks.map(task => task.id).join('、')
      return `guard: ${path} 不在当前任务 scope 内${names === '' ? '' : `（${names}）`}；先提交范围变更。`
    }
    return undefined
  }

  const tools = (deps.agentCtx as unknown as { get?(name: string): unknown; tools?: unknown }).get?.('tools')
    ?? (deps.agentCtx as unknown as { tools?: unknown }).tools
  if (typeof (tools as { guard?: unknown } | undefined)?.guard === 'function') {
    ;(tools as { guard(fn: (exec: Record<string, unknown>) => string | undefined): unknown }).guard(checkTool)
  }

  if (typeof deps.agentCtx.on === 'function') {
    deps.agentCtx.on('agent/turn-stopping', () => handler())
    // Also advance the audit between steps whenever the current sequential task
    // writes a new `## 完成声明`: a model that stays inside turn 1 after writing
    // its completion note cannot starve probes, checkpoints and anchor updates.
    deps.agentCtx.on('agent/pre-step', async (_payload, next) => {
      if (pendingCompletionTaskSync(store, live) !== undefined) {
        await handler()
      }
      return typeof next === 'function' ? await (next as () => unknown)() : undefined
    })
  }

  const attached: AttachedSupervisor = {
    store,
    get state(): GuardState { return live },
    handler,
    refresh,
    checkTool,
    agent: deps.agent,
  }
  ATTACHED.set(key, attached)
  return attached
}

/**
 * Create the host goal for an already-live agent.
 *
 * Must be called after `agents.create`/`resume` resolves: the goal service
 * throws `GOAL_AGENT_NOT_LIVE` for any agent still inside its `setup` callback.
 * A failure is recorded on the run instead of thrown, so a mounted session is
 * never destroyed by a goal-service problem.
 */
export async function armSupervisorGoal(deps: ArmGoalDeps): Promise<boolean> {
  const store = new GuardStore(join(deps.cwd, 'docs', 'guard', deps.runId))
  const meta = await store.readMeta()
  const state = await store.readState()
  if (meta === null || state === null) return false
  // A finished, paused or stopped run must not grow a fresh goal: opening its
  // session to read the record would otherwise arm a goal that nothing ever
  // completes. A rollback clears `goalBlocked` and sets `active` first.
  if (state.status !== 'active' || state.goalBlocked !== undefined) return false
  const goals = goalsOf(deps.ctx)
  if (goals?.create === undefined) return false
  let existing: GoalViewFace | undefined
  try {
    existing = goals.get?.(deps.agent)
  } catch {
    existing = undefined
  }
  // A completed goal is not "already armed": only `create` replaces it, which is
  // exactly what a rollback back into a finished run needs.
  if (existing !== undefined && existing.phase !== 'complete') {
    // On a cold start the host `GoalService` sets the goal it finds on
    // `agent/created` to `activation: 'disarmed'`. Reporting "already armed" then
    // left the ledger healthy while the round driver saw `activation !== 'armed'`
    // and never drove another turn. A `paused` goal stays paused: that is the
    // human's own pause, and only an explicit rollback may resume it.
    //
    // An exhausted `round-limit` block is different: it was not a human decision
    // and `resume` refuses it, so the cap is raised first. Otherwise reopening
    // this session after a long run leaves a ledger that says "active" with a
    // goal that can never drive another turn.
    const needsResume = (existing.phase === 'active' && existing.activation === 'disarmed')
      || (existing.phase === 'blocked' && goalExhausted(existing))
    if (needsResume) {
      if (goalExhausted(existing)) {
        try {
          if (!await extendAndResume(goals, deps.agent, existing)) {
            await recordGoalFailure(store, 'goal round budget exhausted and the host cannot raise it')
            return false
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'goal resume failed'
          await recordGoalFailure(store, message)
          return false
        }
      } else {
        if (goals.resume === undefined) return false
        try {
          await goals.resume(deps.agent, { id: existing.id, revision: existing.revision })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'goal resume failed'
          await recordGoalFailure(store, message)
          return false
        }
      }
    }
    await markGoalReady(store)
    return true
  }
  try {
    goals.create(deps.agent, {
      objective: objectiveOf(state),
      maxGoalRounds: initialGoalRounds(state.tasks.length),
    })
  } catch (error) {
    await recordGoalFailure(store, error instanceof Error ? error.message : 'goal creation failed')
    return false
  }
  await markGoalReady(store)
  return true
}

/** Persist "the goal is armed" onto the latest `run.json` under the store lock. */
async function markGoalReady(store: GuardStore): Promise<void> {
  await store.updateMeta(current => ({
    ...current,
    phase: 'running',
    setup: { ...current.setup, goal: true, failedStep: undefined, errorMessage: undefined },
    updatedAt: Date.now(),
  }))
}

/** Record a goal-service refusal without throwing away the mounted session. */
async function recordGoalFailure(store: GuardStore, message: string): Promise<void> {
  const clipped = message.slice(0, 500)
  await store.updateMeta(current => ({
    ...current,
    phase: 'setup-failed',
    setup: { ...current.setup, goal: false, failedStep: 'goal', errorMessage: clipped },
    updatedAt: Date.now(),
  }))
  await store.appendEvents([{ type: 'setup.failed', at: Date.now(), step: 'goal', message: clipped }])
}

/**
 * Make sure the host goal can continue after a rollback reopened a task.
 *
 * A blocked, paused, disarmed or completed goal does not drive rounds, so the
 * reopened task would never run. The run's own ledger has just been reset to
 * `active`; this brings the host side back in line with it.
 *
 * The ledger gate comes FIRST, exactly like `armSupervisorGoal`: a sibling-only
 * rollback deliberately keeps a milestone block (`status:'blocked'` +
 * `goalBlocked`), and resuming then drove turns that `auditTurn` immediately
 * refuses to supervise — the model wrote files with no audit, probes or
 * evaluator behind it.
 */
export async function resumeSupervisorGoal(deps: ArmGoalDeps): Promise<boolean> {
  const goals = goalsOf(deps.ctx)
  const store = new GuardStore(join(deps.cwd, 'docs', 'guard', deps.runId))
  const state = await store.readState()
  if (state === null || state.status !== 'active' || state.goalBlocked !== undefined) return false
  let current: GoalViewFace | undefined
  try {
    current = goals?.get?.(deps.agent)
  } catch {
    current = undefined
  }
  // No goal, or a completed one: only `create` can put the run back in motion.
  if (current === undefined || current.phase === 'complete') return await armSupervisorGoal(deps)
  if (current.phase === 'active' && current.activation === 'armed') return true
  if (goals?.resume === undefined) return false
  try {
    // An exhausted round budget is the one case `resume` cannot fix: raise the
    // cap through `edit` and resume on the revision it returns.
    if (goalExhausted(current)) return await extendAndResume(goals, deps.agent, current)
    await goals.resume(deps.agent, { id: current.id, revision: current.revision })
    return true
  } catch {
    return false
  }
}

export interface SupervisorWatcherContext {
  on?(name: string, handler: (payload: { readonly agent: unknown }) => void | Promise<void>): unknown
  get?(name: string): unknown
}

/**
 * Cold start: when a supervised session is reopened (fresh process, or cleared
 * and resumed), re-attach its anchors and guard from the ledger.
 *
 * The listener must never fail session creation, so every failure is swallowed
 * after the run records why.
 */
export function watchGoalSupervisors(ctx: SupervisorWatcherContext): void {
  if (typeof ctx.on !== 'function') return
  ctx.on('agent/created', async ({ agent }) => {
    const face = agent as {
      readonly id?: unknown
      readonly session?: { readonly header?: { readonly cwd?: string } }
      readonly ctx?: unknown
    }
    if (typeof face.id !== 'string' || face.ctx === undefined) return
    const headerCwd = face.session?.header?.cwd
    if (headerCwd === undefined) return
    // A worktree run keeps its header on the source project and records the
    // checkout as a working-directory change; the ledger lives in the checkout.
    const cwd = effectiveCwdOf(ctx, face.session, headerCwd)
    try {
      const found = await findRunForSession(cwd, face.id)
      if (found === null) return
      const slot = ATTACHED.get(attachKey(face.id, cwd, found.runId))
      if (slot !== undefined && slot.agent === face) return
      const attached = await attachSupervisor({
        ctx: ctx as never,
        agentCtx: face.ctx as never,
        agent: face as never,
        runId: found.runId,
        cwd,
      })
      await attached.refresh()
      // A cold start must rebuild the rendered page from the ledger: the run may
      // have been changed by another process or interrupted mid-write.
      await attached.store.refreshRendered()
      restoreFrozenCard(face.ctx as SupervisorDeps['agentCtx'], attached.state)
      // `GoalService` also listens on `agent/created` and DISARMS the goal it
      // sees there. Listeners run in registration order, so arming inside this
      // one loses whenever the goal service registered later. Defer past the
      // serial dispatch and re-check that this is still the live agent.
      setImmediate(() => {
        const registry = (ctx as {
          get?(name: string): { get?(id: string): unknown } | undefined
        }).get?.('agents')
        if (registry?.get?.(face.id as string) !== face) return
        // `setImmediate` callbacks cannot reject to anyone: swallow so a goal
        // service failure never becomes an unhandled rejection.
        void armSupervisorGoal({ ctx: ctx as never, agent: face as never, cwd, runId: found.runId })
          .catch(() => undefined)
      })
    } catch {
      /* a run that cannot be restored must not break the session itself */
    }
  })
  // A disposed session frees its slot; the next open re-attaches from run.json.
  ctx.on('agent/disposed', ({ agent }) => {
    const id = (agent as { readonly id?: unknown }).id
    if (typeof id === 'string') forgetSessionAttachments(id)
  })
}
