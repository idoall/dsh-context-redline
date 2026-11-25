/**
 * One turn-stopping audit: run probes, decide whether to evaluate, and when a
 * task passes, commit its scope, tag a checkpoint and advance the ledger.
 *
 * The loop is deliberately sequential unless the run declared parallelism; the
 * parallel path is only safe because every task's write scope is pairwise
 * disjoint (see `selectBatch`) and each commit names its own paths.
 *
 * Two invariants matter more than any single branch here:
 *   - the ledger is written BEFORE the commit and rolled back to IN_PROGRESS
 *     when the commit or the checkpoint tag fails, so a `DONE` row always has a
 *     matching commit and tag behind it;
 *   - the evaluation offset only advances when the evaluator actually ran, so a
 *     completion declaration can never be silently consumed by a turn that did
 *     not look at it.
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Attempt, EvidenceRef, GuardEvent, GuardState, GuardTask, ProbeDef, ProbeResult, ProbeSpec, RollbackResidueEntry } from './schema'
import { orderedByCompletion } from './schema'
import { evaluateProgress, evaluateTask, type EvalCandidate, type EvalProbeEvidence } from './evaluator'
import { checkpointRefOf } from './create'
import {
  changedPaths, changedPathsSince, commitPaths, committedPathsSince, hasGit, hasRef, headBlob, headCommit,
  matchesBaseline, pathInScope, resetPaths, revertCommit, scopeDiffExcerpt, scopesOverlap, tagCheckpoint,
} from './git'
import { isNetworkUse, probeEnv, runProbe, runProbes, type ProbeOutcome } from './probes'
import { processScopeRequests } from './scope'
import { captureBlockedPatch } from './patch'
import { commentRunIssue, createRunIssue, type MirrorConfig } from './mirror'
import { reviewMilestone } from './milestone'
import type { GuardStore } from './store'

/** A task that cannot make progress after this many attempts needs a human. */
export const ATTEMPT_LIMIT = 50
/** Identical failed approaches tolerated twice before the task blocks. */
export const EXEMPTION_LIMIT = 2
/** Consecutive identical failures that trigger the light progress evaluation. */
export const STREAK_LIMIT = 3
/** Consecutive evaluator outages (`unavailable`) tolerated before blocking the task. */
export const EVAL_UNAVAILABLE_LIMIT = 3
const MIRROR_RETRY_MS = 60_000

export interface LoopAgent {
  readonly id: string
  model?: { current?(): { provider?: string; model?: string } | undefined }
  options?: { provider?: string; model?: string }
}

interface GoalRef {
  readonly id: string
  readonly revision: number
}

interface GoalBlockReason {
  readonly code: string
  readonly message: string
}

interface GoalsFace {
  get?(agent: LoopAgent): GoalRef | undefined
  complete?(agent: LoopAgent, ref: GoalRef): unknown
  block?(agent: LoopAgent, ref: GoalRef, reason: GoalBlockReason): unknown
}

export interface LoopDeps {
  readonly ctx: { get(name: string): unknown }
  readonly agent: LoopAgent
  readonly cwd: string
  readonly runId: string
  readonly store: GuardStore
  readonly mirror?: MirrorConfig
}

function digest(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Tasks this turn is actually working on: every live id, not just the first.
 *
 * A parallel batch has more than one, and the tool guard must accept each of
 * their scopes — checking only `activeTaskIds[0]` rejected every sibling's
 * writes.
 */
export function runningTasks(state: GuardState): GuardTask[] {
  const live = state.activeTaskIds
    .map(id => state.tasks.find(task => task.id === id))
    .filter((task): task is GuardTask => task !== undefined)
  if (live.length > 0) return live
  const inFlight = state.tasks.filter(task => task.status === 'IN_PROGRESS')
  if (inFlight.length > 0) return inFlight
  // Nothing is running: only a task whose dependencies are all DONE can start,
  // so a blocked batch does not hand its scope to an unreachable task.
  const done = new Set(state.tasks.filter(task => task.status === 'DONE').map(task => task.id))
  const startable = state.tasks.find(task =>
    task.status === 'TODO' && task.dependsOn.every(dep => done.has(dep)))
  return startable === undefined ? [] : [startable]
}

export function currentTask(state: GuardState): GuardTask | undefined {
  return runningTasks(state).at(0)
}

function goalsOf(ctx: LoopDeps['ctx']): GoalsFace | undefined {
  return ctx.get('goals') as GoalsFace | undefined
}

/** Bounded candidate for the evaluator: recent assistant text and tool names only. */
async function candidateOf(ctx: LoopDeps['ctx'], sessionId: string): Promise<EvalCandidate> {
  const query = ctx.get('sessionQuery') as { readSession?(id: string): Promise<{ readonly events: readonly unknown[] }> } | undefined
  if (typeof query?.readSession !== 'function') return { summary: '', tools: [], writePaths: [], subagents: 0 }
  let events: readonly unknown[] = []
  try { events = (await query.readSession(sessionId)).events.slice(-80) } catch { return { summary: '', tools: [], writePaths: [], subagents: 0 } }
  const assistant: string[] = []
  const tools: string[] = []
  const writePaths: string[] = []
  let subagents = 0
  for (const raw of events) {
    if (raw === null || typeof raw !== 'object') continue
    const event = raw as Record<string, unknown>
    const data = event.data !== null && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
    if (event.type === 'assistant/message') {
      const message = data.message !== null && typeof data.message === 'object' ? data.message as Record<string, unknown> : {}
      const content = Array.isArray(message.content) ? message.content : []
      const text = content.flatMap(block => block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? [(block as { text?: unknown }).text].filter((item): item is string => typeof item === 'string')
        : []).join('\n')
      if (text !== '') assistant.push(text)
    }
    if (event.type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : ''
      if (name !== '') {
        tools.push(name)
        if (name === 'subagent') subagents += 1
        if ((name === 'write' || name === 'edit')) {
          let args: Record<string, unknown> = {}
          if (typeof data.arguments === 'string') {
            try { args = JSON.parse(data.arguments) as Record<string, unknown> } catch { args = {} }
          } else if (data.arguments !== null && typeof data.arguments === 'object') {
            args = data.arguments as Record<string, unknown>
          }
          if (typeof args.file_path === 'string') writePaths.push(args.file_path.slice(0, 240))
        }
      }
    }
  }
  return {
    summary: assistant.slice(-3).join('\n').slice(0, 4000),
    tools: tools.slice(-20),
    writePaths: writePaths.slice(-10),
    subagents,
  }
}

function describeProbeSpec(spec: ProbeSpec): string {
  switch (spec.kind) {
    case 'file_exists': return `file_exists: ${spec.path}`
    case 'file_contains': return `file_contains: ${spec.path} /${spec.pattern}/${spec.flags ?? ''}`
    case 'grep': return `grep: /${spec.pattern}/ in ${spec.paths.join(', ')}`
    case 'number_gte': return spec.source.type === 'file'
      ? `number_gte(${spec.threshold}): file ${spec.source.path}`
      : `number_gte(${spec.threshold}): ${spec.source.cmd} ${spec.source.args.join(' ')}`
    case 'command': return `command: ${spec.cmd}${spec.args.length === 0 ? '' : ` ${spec.args.join(' ')}`}`
    case 'scan': return `scan(${spec.scanKind})${spec.paths === undefined ? '' : `: ${spec.paths.join(', ')}`}`
  }
}

/**
 * Assemble the bounded candidate + deterministic evidence the evaluator reads.
 *
 * Without probe definitions, in-scope diff and `notes.md`, the evaluator only
 * sees `{ C1: 'pass' }` and the last three assistant replies, forcing it to
 * answer `insufficient` even when the workspace satisfies every criterion.
 */
async function buildEvalCandidate(
  deps: LoopDeps,
  state: GuardState,
  guardDir: string,
  task: GuardTask,
  probes: readonly ProbeDef[],
  outcomes: Readonly<Record<string, { result: ProbeResult; detail: string } | undefined>>,
): Promise<EvalCandidate> {
  const base = await candidateOf(deps.ctx, deps.agent.id)
  const probeEvidence: EvalProbeEvidence[] = probes.map((probe) => {
    const outcome = outcomes[probe.id]
    return {
      id: probe.id,
      weight: probe.weight,
      spec: describeProbeSpec(probe.spec).slice(0, 200),
      result: outcome?.result ?? 'unknown',
      ...(outcome?.detail === undefined || outcome.detail === '' ? {} : { detail: outcome.detail.slice(0, 300) }),
    }
  })
  const changed = (await taskPaths(deps, state, guardDir, task))
    .filter(path => pathInScope(path, task.scope))
    .sort()
  const diffExcerpt = await scopeDiffExcerpt(deps.cwd, task.baseCommit, changed, 4000)
  let notesExcerpt = ''
  try {
    notesExcerpt = (await readFile(deps.store.notesPath(task.id), 'utf8')).slice(-1500)
  } catch { /* notes may be absent */ }
  return {
    ...base,
    probes: probeEvidence,
    changedPaths: changed.slice(0, 30),
    ...(diffExcerpt === '' ? {} : { diffExcerpt }),
    ...(notesExcerpt === '' ? {} : { notesExcerpt }),
  }
}

/** Content hash of one workspace file; `'deleted'` when it cannot be read. */
async function hashOf(cwd: string, path: string): Promise<string> {
  try {
    return digest(await readFile(join(cwd, path)))
  } catch {
    return 'deleted'
  }
}

/** True when `path` still matches the hash captured when the task started. */
async function unchangedSinceBaseline(cwd: string, task: GuardTask, path: string): Promise<boolean> {
  return await matchesBaseline(cwd, task.baselineDirty, path)
}

/**
 * Paths this task is responsible for: everything changed since its own base
 * commit (a subagent may have committed its work), minus files that were already
 * dirty when the run started. A sibling's own `guard(<run>): <task> DONE`
 * commit inside that range belongs to the sibling, not to this task.
 *
 * A path another (still open) task's rollback moved is also excluded: reopening
 * a `DONE` task deliberately leaves its committed files as uncommitted work in
 * the shared tree, and HEAD still contains them. That residue belongs to the
 * reopened task, not to whoever retries first — unless the file no longer has
 * the recorded content, which means somebody actually wrote it.
 */
async function taskPaths(deps: LoopDeps, state: GuardState, guardDir: string, task: GuardTask): Promise<string[]> {
  const raw = task.baseCommit === undefined
    ? await changedPaths(deps.cwd, guardDir)
    : await changedPathsSince(deps.cwd, task.baseCommit, guardDir, { runId: deps.runId, taskId: task.id })
  const kept: string[] = []
  for (const path of raw) {
    if (await unchangedSinceBaseline(deps.cwd, task, path)) continue
    if (await explainedByRollbackResidue(deps.cwd, state, task, path)) continue
    kept.push(path)
  }
  return kept
}

/**
 * True when another open task's rollback, not this task, owns `path` now.
 *
 * Both halves of the residue record must still match: the HEAD blob (a later DONE
 * commit took ownership of the path, so the record is stale) and the worktree
 * content (somebody actually wrote it). Checking only the worktree hash let a
 * task that re-created the same deleted content excuse a genuine out-of-scope
 * deletion.
 */
async function explainedByRollbackResidue(
  cwd: string,
  state: GuardState,
  task: GuardTask,
  path: string,
): Promise<boolean> {
  // A path inside this task's own scope is always this task's business.
  if (pathInScope(path, task.scope)) return false
  const owners = state.tasks.filter(other =>
    other.id !== task.id
    && other.status !== 'DONE'
    && other.rollbackResidue !== undefined
    && Object.hasOwn(other.rollbackResidue, path))
  if (owners.length === 0) return false
  const current = await hashOf(cwd, path)
  const atHead = await headBlob(cwd, path)
  return owners.some((other) => {
    const entry = other.rollbackResidue?.[path]
    return entry !== undefined && entry.headBlob === atHead && entry.worktreeHash === current
  })
}

/**
 * Drop the rollback residue a DONE task has taken over.
 *
 * Two independent proofs of staleness; either one is enough:
 *
 *   - `committed` names the paths this completion settled (its own commit, or a
 *     path a subagent had already committed), so every other task's record for
 *     them is stale. `changed` is the whole changed set, not just the dirty one:
 *     a self-committed path is clean, and the old `staged`-only cleanup kept its
 *     record forever while a later out-of-scope deletion still matched it.
 *
 *   - a path whose recorded worktree content or HEAD blob no longer matches is
 *     stale even when nothing is dirty at all. A retry can legitimately ship the
 *     path BACK to the very blob HEAD holds: git then reports no change
 *     (`baseCommit === HEAD`, clean worktree), `committed` is empty, and the old
 *     `changed.length > 0` guard skipped the cleanup entirely. That stale record
 *     excused a later out-of-scope deletion of the same path forever.
 *
 * The staleness check is deliberately NOT limited to the finishing task's scope:
 * a residue restored to HEAD (by `git checkout HEAD -- path` or a warn-only
 * rollback) is objectively invalid for every task, and a task that does not own
 * the path would otherwise keep the dead record alive until an out-of-scope
 * deletion matched it again. Content, never intent: an entry whose hash and blob
 * still match is left alone, so a path the reopened task still owns keeps its
 * exemption no matter who finishes first.
 */
async function settleResidue(
  deps: LoopDeps,
  state: GuardState,
  taskId: string,
  committed: readonly string[],
): Promise<GuardState> {
  const settled = new Set(committed)
  let changed = false
  const tasks: GuardTask[] = []
  for (const task of state.tasks) {
    if (task.id === taskId || task.rollbackResidue === undefined) {
      tasks.push(task)
      continue
    }
    const kept: [string, RollbackResidueEntry][] = []
    for (const [path, entry] of Object.entries(task.rollbackResidue)) {
      // Committed by this task: HEAD now carries the ownership, nothing to check.
      if (settled.has(path)) continue
      // Otherwise the record only dies when the tree proves it stale — for ANY
      // task, not just the one whose scope mentions the path.
      const current = await hashOf(deps.cwd, path)
      const atHead = await headBlob(deps.cwd, path)
      if (current !== entry.worktreeHash || atHead !== entry.headBlob) continue
      kept.push([path, entry])
    }
    if (kept.length === Object.keys(task.rollbackResidue).length) {
      tasks.push(task)
      continue
    }
    changed = true
    tasks.push({ ...task, rollbackResidue: kept.length === 0 ? undefined : Object.fromEntries(kept) })
  }
  return changed ? { ...state, tasks, updatedAt: Date.now() } : state
}

/**
 * Persist one probe's output under the task's evidence directory.
 *
 * Only failing or heavy probes carry output, and the list is capped, so a long
 * run cannot fill the ledger with logs. The evaluator may read the summary; a
 * human can open the file.
 */
async function recordProbeEvidence(
  deps: LoopDeps,
  taskId: string,
  probeId: string,
  outcome: ProbeOutcome,
  at: number,
): Promise<EvidenceRef | undefined> {
  if (outcome.output === undefined || outcome.output === '') return undefined
  const name = `${probeId}-${at}.log`
  try {
    await writeFile(deps.store.evidencePath(taskId, name), outcome.output, 'utf8')
  } catch {
    return undefined
  }
  return {
    id: `probe-${probeId}-${at}`,
    kind: 'probe',
    path: `tasks/${taskId}/evidence/${name}`,
    probeId,
    ...(outcome.sha256 === undefined ? {} : { sha256: outcome.sha256 }),
    ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
    summary: outcome.detail.slice(0, 200),
    at,
  }
}

/** Fingerprint of the current task's changed files, used to decide whether to re-evaluate. */
async function scopeFingerprint(deps: LoopDeps, state: GuardState, guardDir: string, task: GuardTask): Promise<string> {
  const changed = (await taskPaths(deps, state, guardDir, task)).filter(path => pathInScope(path, task.scope)).sort()
  const parts: string[] = []
  for (const path of changed) parts.push(`${path}:${await hashOf(deps.cwd, path)}`)
  return digest(parts.join('\n'))
}

async function completionOffset(store: GuardStore, task: GuardTask): Promise<{ declared: boolean; offset: number }> {
  try {
    const text = await readFile(store.notesPath(task.id), 'utf8')
    const tail = text.slice(task.lastEvalOffset ?? 0)
    return { declared: /##\s*完成声明/.test(tail), offset: text.length }
  } catch {
    return { declared: false, offset: task.lastEvalOffset ?? 0 }
  }
}

function probeVector(task: GuardTask, results: Readonly<Record<string, ProbeResult>>): Record<string, ProbeResult> {
  const vector: Record<string, ProbeResult> = {}
  for (const id of task.probes) vector[id] = results[id] ?? 'unknown'
  return vector
}

function failedDetails(task: GuardTask, outcomes: Readonly<Record<string, { result: ProbeResult; detail: string } | undefined>>): string {
  return task.probes
    .filter(id => outcomes[id]?.result !== 'pass')
    .map(id => `${id}:${outcomes[id]?.detail ?? 'not run'}`)
    .join('|')
}

function signatureOf(paths: readonly string[], tools: readonly string[], failed: string): string {
  return digest(JSON.stringify({ paths: [...paths].sort(), tools: [...tools].sort(), failed }))
}

function updateTask(state: GuardState, id: string, patch: Partial<GuardTask>): GuardTask[] {
  return state.tasks.map(task => task.id === id ? { ...task, ...patch } : task)
}

function blockedTask(reason: string, next: string): GuardTask['blocked'] {
  return { reason, next, remainingCandidates: [], at: Date.now() }
}

/** Next attempt index; the window on `attempts` must never hide the 50-attempt ceiling. */
function nextAttemptIndex(task: GuardTask): number {
  return (task.attempts.at(-1)?.index ?? 0) + 1
}

/** One-way mirror: create the issue once, then append a status comment. Best effort. */
async function syncMirror(deps: LoopDeps, state: GuardState, note: string): Promise<void> {
  const config = deps.mirror
  if (config?.mode !== 'auto') return
  const meta = await deps.store.readMeta()
  if (meta === null) return
  // Only the retry-window check uses the pre-call instant. Every timestamp this
  // function PERSISTS is taken after the CLI call it describes: a comment that
  // takes 60s used to write `updatedAt`/`nextRetryAt` from before the call, so
  // `updatedAt` moved backwards past a concurrent write and the retry window was
  // already partly spent when it was stored.
  if (meta.mirror.nextRetryAt !== undefined && Date.now() < meta.mirror.nextRetryAt) return
  const runDir = `docs/guard/${deps.runId}`
  let issueNumber = meta.mirror.issueNumber
  let issueUrl = meta.mirror.issueUrl
  if (issueNumber === undefined) {
    const created = await createRunIssue(config, deps.cwd, state, runDir)
    if (created.issueNumber === undefined) {
      const doneAt = Date.now()
      const reason = created.error ?? 'issue create failed'
      // Everything below merges into the LATEST meta under the store lock: the
      // `gh` call above can take seconds, and the first turn's first-message
      // marker (or a concurrent arm's provider/host) must survive it.
      await deps.store.updateMeta(current => ({
        ...current,
        mirror: { ...current.mirror, lastError: reason, nextRetryAt: doneAt + MIRROR_RETRY_MS },
        updatedAt: doneAt,
      }))
      await deps.store.appendEvents([{ type: 'mirror.failed', at: doneAt, reason }])
      return
    }
    issueNumber = created.issueNumber
    issueUrl = created.issueUrl
    const createdAt = Date.now()
    await deps.store.updateMeta(current => ({
      ...current,
      mirror: {
        ...current.mirror,
        ...(config.provider === undefined ? {} : { provider: config.provider }),
        ...(config.host === undefined ? {} : { host: config.host }),
        issueNumber,
        ...(issueUrl === undefined ? {} : { issueUrl }),
      },
      updatedAt: createdAt,
    }))
  }
  const error = await commentRunIssue(config, deps.cwd, issueNumber, note)
  const commentedAt = Date.now()
  if (error !== null) {
    await deps.store.updateMeta(current => ({
      ...current,
      mirror: {
        ...current.mirror,
        issueNumber,
        // The create call may have JUST produced the URL; dropping it here would
        // lose the link the card shows when the very first comment fails.
        ...(issueUrl === undefined ? {} : { issueUrl }),
        lastError: error,
        nextRetryAt: commentedAt + MIRROR_RETRY_MS,
      },
      updatedAt: commentedAt,
    }))
    await deps.store.appendEvents([{ type: 'mirror.failed', at: commentedAt, reason: error }])
    return
  }
  // A successful sync clears the error the card was showing; otherwise the old
  // failure stays visible forever.
  await deps.store.updateMeta(current => ({
    ...current,
    mirror: {
      ...current.mirror,
      issueNumber,
      ...(issueUrl === undefined ? {} : { issueUrl }),
      lastError: undefined,
      nextRetryAt: undefined,
    },
    updatedAt: commentedAt,
  }))
  await deps.store.appendEvents([{ type: 'mirror.synced', at: commentedAt }])
}

/** Mark the host goal complete; a missing or failing goal service never fails the ledger. */
function completeGoal(deps: LoopDeps): void {
  const goals = goalsOf(deps.ctx)
  if (goals?.get === undefined || goals.complete === undefined) return
  try {
    const ref = goals.get(deps.agent)
    if (ref !== undefined) goals.complete(deps.agent, { id: ref.id, revision: ref.revision })
  } catch { /* the ledger is still complete */ }
}

/** Ask the host goal to stop; a valid `{ code, message }` is mandatory. */
function blockGoal(deps: LoopDeps, reason: string): void {
  const goals = goalsOf(deps.ctx)
  if (goals?.get === undefined || goals.block === undefined) return
  try {
    const ref = goals.get(deps.agent)
    if (ref === undefined) return
    goals.block(deps.agent, { id: ref.id, revision: ref.revision }, { code: 'supervisor-blocked', message: reason })
  } catch { /* an already paused or blocked goal is not an error */ }
}

/** Undo one just-created commit so the ledger and the history cannot disagree. */
/**
 * Commit the task's scope plus the ledger, tag it, then record the commit.
 *
 * `doneState` has already been written to disk (so `task.done` and the rendered
 * page travel with the commit). Any failure restores `rollbackState`, which is
 * the same ledger with the task still IN_PROGRESS and no checkpoint reference.
 */
async function finishTask(
  deps: LoopDeps,
  doneState: GuardState,
  rollbackState: GuardState,
  task: GuardTask,
  changed: readonly string[],
  allDone: boolean,
): Promise<GuardState> {
  const guardDir = `docs/guard/${deps.runId}`
  // Stage only what is DIRTY right now. `changed` also names work the task (or a
  // subagent) already committed; a path that no longer exists in the worktree or
  // the index makes `git add -A -- <path>` fail with "pathspec did not match",
  // which used to bounce a task that had actually finished back to IN_PROGRESS on
  // every single turn.
  const dirtyNow = new Set(await changedPaths(deps.cwd, guardDir))
  const staged = changed.filter(path => dirtyNow.has(path))
  const paths = [...new Set([...staged, guardDir])]
  const failCommit = async (message: string, reason: string): Promise<GuardState> => {
    await resetPaths(deps.cwd, paths)
    await deps.store.update(rollbackState, [
      { type: 'commit.failed', at: Date.now(), taskId: task.id, message },
      { type: 'task.reopened', at: Date.now(), taskId: task.id, reason },
    ])
    return rollbackState
  }
  if (!(await hasGit(deps.cwd))) {
    await deps.store.appendEvents([{ type: 'commit.done', at: Date.now(), taskId: task.id, sha: '', checkpointRef: '' }])
    // No repository means no commit and no tag — but the milestone review does
    // not depend on git, so skipping it here would silently drop a safety gate.
    await syncMirror(deps, doneState, `${task.id} ${task.title} DONE（无 git，未提交）${allDone ? '（全部完成）' : ''}`)
    const reviewedNoGit = await maybeMilestoneReview(deps, doneState)
    if (reviewedNoGit.status === 'blocked') return reviewedNoGit
    if (allDone) {
      completeGoal(deps)
      return reviewedNoGit
    }
    return reviewedNoGit
  }
  if (task.checkpointRef !== undefined && await hasRef(deps.cwd, task.checkpointRef)) {
    return await failCommit(`checkpoint ${task.checkpointRef} already exists`, 'checkpoint tag already exists')
  }
  let committed: { readonly created: boolean; readonly sha: string | null }
  try {
    committed = await commitPaths(deps.cwd, paths, `guard(${deps.runId}): ${task.id} DONE`)
  } catch (error) {
    return await failCommit(error instanceof Error ? error.message : 'commit failed', 'commit failed')
  }
  const at = Date.now()
  const sha = committed.sha ?? ''
  if (committed.created && sha !== '' && task.checkpointRef !== undefined) {
    try {
      await tagCheckpoint(deps.cwd, task.checkpointRef, `${task.id} ${task.title}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'tag failed'
      const undone = await revertCommit(deps.cwd, sha)
      return await failCommit(
        undone ? message : `${message}（提交 ${sha.slice(0, 8)} 未能回退）`,
        'checkpoint tag failed',
      )
    }
  }
  // The commit moved HEAD for these paths, so any other task's rollback residue
  // that names one of them is stale. Persist the cleanup before the review reads
  // the ledger. `changed` is the task's whole changed set, including work a
  // subagent already committed itself; a path the task restored to the very byte
  // content HEAD already held changes nothing for git and is still taken over (the
  // residue's recorded hash no longer describes the tree). Neither case may wait
  // for `changed.length > 0`.
  const settled = await settleResidue(deps, doneState, task.id, changed)
  if (settled !== doneState) await deps.store.update(settled)
  await deps.store.appendEvents([{
    type: 'commit.done', at, taskId: task.id, sha, checkpointRef: task.checkpointRef ?? '',
  }])
  await syncMirror(deps, settled, `${task.id} ${task.title} DONE${allDone ? '（全部完成）' : ''}`)
  // The review runs BEFORE the goal is completed: a failing final milestone must
  // be able to stop the run instead of being skipped because everything is DONE.
  const reviewed = await maybeMilestoneReview(deps, settled)
  if (reviewed.status === 'blocked') return reviewed
  if (allDone) {
    completeGoal(deps)
    return reviewed
  }
  return reviewed
}

/**
 * Every `milestoneEvery` completed tasks, three reviewers plus one adjudicator
 * look at the batch. A `fail` stops the run for a human; `insufficient` is
 * recorded and the run keeps going (nothing is marked done by a review).
 */
async function maybeMilestoneReview(deps: LoopDeps, state: GuardState): Promise<GuardState> {
  const every = Math.max(1, state.milestoneEvery)
  const doneTasks = state.tasks.filter(task => task.status === 'DONE')
  const completed = doneTasks.length
  if (completed === 0 || completed % every !== 0) return state
  const round = completed / every
  // Completion order, shared with the rollback path: a duplicated `doneOrder` id
  // ranks by its LAST occurrence and every task appears exactly once, so the batch
  // can neither review the same task twice nor drop a genuinely completed one.
  const batch = orderedByCompletion(state, doneTasks).slice(-every)
  const review = await reviewMilestone(deps.ctx, deps.agent, state, batch, round, deps.store)
  if (review === null) {
    // No evaluator model: record the skip instead of pretending it passed.
    await deps.store.appendEvents([{ type: 'review.milestone', at: Date.now(), round, verdict: 'insufficient' }])
    return state
  }
  await deps.store.appendEvents([{ type: 'review.milestone', at: Date.now(), round, verdict: review.verdict }])
  await syncMirror(deps, state, `里程碑 ${round}：${review.verdict}（${review.path}）`)
  if (review.verdict !== 'fail') return state
  const reason = `里程碑审阅未通过（第 ${round} 轮）：见 ${review.path}`
  blockGoal(deps, reason)
  const blocked: GuardState = { ...state, status: 'blocked', goalBlocked: reason, updatedAt: Date.now() }
  await deps.store.update(blocked, [{ type: 'run.blocked', at: Date.now(), reason }])
  return blocked
}

function depsDone(state: GuardState, task: GuardTask): boolean {
  return task.dependsOn.every(dep => state.tasks.find(item => item.id === dep)?.status === 'DONE')
}


/** Up to `limit` runnable tasks with pairwise-disjoint write scopes. */
function selectBatch(state: GuardState, limit: number): GuardTask[] {
  const active = state.activeTaskIds.map(id => state.tasks.find(task => task.id === id))
  const ready = state.tasks.filter(task => task.status === 'TODO' && depsDone(state, task))
  const chosen: GuardTask[] = []
  for (const task of [...active, ...ready]) {
    if (task === undefined) continue
    if (task.status === 'DONE' || task.status === 'BLOCKED') continue
    if (chosen.some(other => scopesOverlap(task.scope, other.scope))) continue
    chosen.push(task)
    if (chosen.length >= limit) break
  }
  return chosen
}

function runSmoke(cwd: string, smoke: NonNullable<GuardState['smokeCommand']>): Promise<{ ok: boolean; detail: string }> {
  // The smoke command is configured by the run, so it gets the same network
  // refusal as a probe instead of reaching out silently.
  if (isNetworkUse(smoke.cmd, smoke.args)) {
    return Promise.resolve({ ok: false, detail: 'smoke command would use the network' })
  }
  return new Promise((resolve) => {
    execFile(smoke.cmd, [...smoke.args], {
      cwd,
      timeout: smoke.timeoutMs ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
      env: probeEnv(),
    }, (error) => {
      if (error === null) { resolve({ ok: true, detail: 'smoke ok' }); return }
      const code = (error as { code?: unknown }).code
      const killed = (error as { killed?: boolean }).killed === true || code === 'ETIMEDOUT'
      resolve({ ok: false, detail: killed ? 'smoke timed out' : error.message.slice(0, 300) })
    })
  })
}

/** Why the run cannot advance without a human. */
function stuckReason(state: GuardState): string {
  const blocked = state.tasks.filter(task => task.status === 'BLOCKED')
  if (blocked.length > 0) {
    const first = blocked[0]
    const detail = first.blocked === undefined ? '' : `：${first.blocked.reason}`
    return `${blocked.map(task => task.id).join('、')} 已阻塞${detail}`
  }
  const waiting = state.tasks.filter(task => task.status === 'TODO' && !depsDone(state, task))
  if (waiting.length > 0) {
    return `${waiting.map(task => task.id).join('、')} 的依赖未完成`
  }
  return state.tasks.length === 0 ? '任务表为空' : '没有可执行的任务'
}

/**
 * Reconcile the run with its goal after every audit: complete, blocked, or
 * running. Keeps `goalBlocked` idempotent so a blocked run does not call the
 * host goal again on every turn.
 */
async function settle(deps: LoopDeps, state: GuardState): Promise<GuardState> {
  if (state.status !== 'active') return state
  if (state.tasks.length > 0 && state.tasks.every(task => task.status === 'DONE')) {
    const done: GuardState = { ...state, status: 'completed', activeTaskIds: [], goalBlocked: undefined, updatedAt: Date.now() }
    await deps.store.update(done)
    await syncMirror(deps, done, '全部任务完成')
    completeGoal(deps)
    return done
  }
  const runnable = state.activeTaskIds.some(id => state.tasks.some(task => task.id === id))
    || state.tasks.some(task => task.status === 'TODO' && depsDone(state, task))
  if (runnable) {
    if (state.goalBlocked === undefined) return state
    const cleared: GuardState = { ...state, goalBlocked: undefined, updatedAt: Date.now() }
    await deps.store.update(cleared)
    return cleared
  }
  const reason = stuckReason(state)
  if (state.goalBlocked === reason) return state
  blockGoal(deps, reason)
  const blocked: GuardState = { ...state, goalBlocked: reason, updatedAt: Date.now() }
  await deps.store.update(blocked, [{ type: 'run.blocked', at: Date.now(), reason }])
  await syncMirror(deps, blocked, `运行暂停：${reason}`)
  return blocked
}

/** Audit every runnable task in this turn's batch (one task unless parallel > 1). */
export async function auditTurn(deps: LoopDeps): Promise<GuardState | null> {
  const initial = await deps.store.readState()
  if (initial === null || initial.status !== 'active') return initial
  const limit = initial.parallel > 1 && (await hasGit(deps.cwd)) ? initial.parallel : 1
  const batch = selectBatch(initial, limit)
  let state: GuardState = initial
  if (batch.length === 0) return await settle(deps, state)
  for (const task of batch) {
    const latest = await deps.store.readState()
    if (latest === null || latest.status !== 'active') return latest
    state = (await auditTask(deps, task.id, batch.map(item => item.id))) ?? latest
  }
  return await settle(deps, state)
}

export interface ProgressDecision {
  readonly attempt: Attempt
  /** `null` means "keep going"; otherwise the task blocks with this reason. */
  readonly blockedReason: string | null
  readonly blockedNext: string
}

/**
 * Shared three-strike logic for every kind of failed turn: identical signatures
 * trigger one lightweight progress evaluation, `advancing` buys two exemptions,
 * and the third identical signature after both exemptions blocks the task.
 *
 * Both the probe-failure and the evaluator-failure branches call this, so an
 * evaluator outage cannot silently burn the whole attempt budget.
 */
async function progressDecision(
  deps: LoopDeps,
  state: GuardState,
  task: GuardTask,
  signature: string,
  baseAttempt: Attempt,
  events: GuardEvent[],
): Promise<ProgressDecision> {
  // Count the trailing run of identical signatures, but stop at the last
  // exemption: an `advancing` verdict buys a fresh streak, not a free pass.
  let streak = 1
  for (const item of [...task.attempts].reverse()) {
    if (item.signature !== signature) break
    if (item.progressEval?.verdict === 'advancing') break
    streak += 1
  }
  const exemptions = task.attempts.filter(item => item.signature === signature && item.progressEval?.verdict === 'advancing').length
  let attempt: Attempt = baseAttempt
  let blockedReason: string | null = null
  let blockedNext = '换一种思路，或在界面上补充新方法'
  if (streak < STREAK_LIMIT) return { attempt, blockedReason, blockedNext }
  if (exemptions >= EXEMPTION_LIMIT) {
    return {
      attempt,
      blockedReason: `同一做法已被轻量评估豁免 ${EXEMPTION_LIMIT} 次仍无进展`,
      blockedNext,
    }
  }
  const progress = await evaluateProgress(deps.ctx, deps.agent, state, task, [...task.attempts, baseAttempt])
  if (progress.verdict === 'unknown') {
    // The evaluator itself is unavailable (no model, timeout, unparseable
    // answer). That is exactly the case this budget exists for: without this
    // branch, an outage would repeat the same failure fifty times.
    events.push({ type: 'progress.eval', at: Date.now(), taskId: task.id, verdict: 'unknown', signature, exemptionCount: exemptions })
    return {
      attempt,
      blockedReason: `同一失败重复 ${STREAK_LIMIT} 次且进展评估不可用：${progress.reason}`,
      blockedNext: '检查模型配置 / 网络后重试，或换个思路',
    }
  }
  if (progress.verdict === 'advancing') {
    attempt = { ...baseAttempt, progressEval: { verdict: 'advancing', reason: progress.reason, at: Date.now() } }
    events.push({ type: 'progress.eval', at: Date.now(), taskId: task.id, verdict: 'advancing', signature, exemptionCount: exemptions + 1 })
  } else if (progress.verdict === 'spinning') {
    events.push({ type: 'progress.eval', at: Date.now(), taskId: task.id, verdict: 'spinning', signature, exemptionCount: exemptions })
    blockedReason = `进展评估确认同一思路打转：${progress.reason}`
  } else {
    // `scope_blocked` is the only verdict left, but spelling it out keeps the
    // compiler from assuming the branch after `unknown` cannot exist.
    events.push({ type: 'progress.eval', at: Date.now(), taskId: task.id, verdict: 'scope_blocked', signature, exemptionCount: exemptions })
    blockedReason = `卡点在当前 scope 外：${progress.reason}`
    blockedNext = '提交范围变更请求（ScopeChangeRequest），或由用户批准扩范围'
  }
  return { attempt, blockedReason, blockedNext }
}

/** Write the BLOCKED row plus its patch evidence; caller decides what happens to the goal. */async function blockTask(
  deps: LoopDeps,
  state: GuardState,
  task: GuardTask,
  reason: string,
  next: string,
  events: GuardEvent[],
  attempts?: readonly Attempt[],
): Promise<GuardState> {
  const guardDir = `docs/guard/${deps.runId}`
  const captured = await captureBlockedPatch(
    deps.cwd, deps.store, task.id, await changedPaths(deps.cwd, guardDir), nextAttemptIndex(task),
  )
  const evidence = captured === null
    ? task.evidence
    : [...task.evidence, { id: `patch-${Date.now()}`, kind: 'patch' as const, path: captured.path.slice(deps.store.root.length + 1), at: Date.now() }]
  const blocked: GuardState = {
    ...state,
    tasks: updateTask(state, task.id, {
      status: 'BLOCKED',
      ...(attempts === undefined ? {} : { attempts }),
      evidence,
      blocked: blockedTask(reason, next),
    }),
    activeTaskIds: state.activeTaskIds.filter(id => id !== task.id),
    updatedAt: Date.now(),
  }
  events.push({ type: 'task.blocked', at: Date.now(), taskId: task.id, reason })
  await deps.store.update(blocked, events)
  return blocked
}

/**
 * Audit one task.
 *
 * `batchIds` names the tasks audited in the same turn: they share one worktree,
 * so another batch task's declared scope is never "out of scope" for this one.
 */
export async function auditTask(deps: LoopDeps, taskId?: string, batchIds: readonly string[] = []): Promise<GuardState | null> {
  const initial = await deps.store.readState()
  if (initial === null || initial.status !== 'active') return initial
  const guardDir = `docs/guard/${deps.runId}`
  const task = taskId === undefined
    ? currentTask(initial)
    : initial.tasks.find(item => item.id === taskId)
  if (task === undefined) {
    // No runnable task: only a run whose every task is DONE is complete. A run
    // with only BLOCKED tasks is stuck, not finished, and `settle` will stop it.
    if (!initial.tasks.every(item => item.status === 'DONE')) return await settle(deps, initial)
    const done: GuardState = { ...initial, status: 'completed', activeTaskIds: [], updatedAt: Date.now() }
    await deps.store.update(done)
    completeGoal(deps)
    return done
  }

  const starting = !initial.activeTaskIds.includes(task.id) && task.status !== 'IN_PROGRESS'
  // `baseCommit` is the commit this task's work is measured FROM, so it is only
  // ever recorded once. Overwriting it on a restart would hide the work done
  // before the block — and, for a task reopened out of DONE, it would move the
  // baseline onto the very commit the rollback just undid, so a later rollback
  // would restore that stale code.
  const head = starting && task.baseCommit === undefined ? await headCommit(deps.cwd) : null
  const base: GuardTask = starting
    ? { ...task, status: 'IN_PROGRESS', ...(head === null ? {} : { baseCommit: head }) }
    : { ...task, status: 'IN_PROGRESS' }
  const events: GuardEvent[] = []
  let state: GuardState = {
    ...initial,
    activeTaskIds: initial.activeTaskIds.includes(task.id) ? initial.activeTaskIds : [...initial.activeTaskIds, task.id],
    tasks: updateTask(initial, task.id, base),
    updatedAt: Date.now(),
  }
  if (starting) {
    events.push({ type: 'task.started', at: Date.now(), taskId: task.id, ...(head === null ? {} : { baseCommit: head }) })
  }
  const probeFile = await deps.store.readProbeFile(task.id)
  const probes = probeFile?.probes ?? []
  const light = probes.filter(probe => probe.enabled && probe.weight === 'light')
  const lightOutcomes = await runProbes(deps.cwd, light)
  const outcomes: Record<string, { result: ProbeResult; detail: string } | undefined> = { ...lightOutcomes }
  // A sibling audited in this same turn shares the worktree; its scope must not
  // be handed to this task by an auto-approved request.
  const siblingScopesForScope = state.tasks
    .filter(item => item.id !== task.id && (state.activeTaskIds.includes(item.id) || batchIds.includes(item.id)))
    .map(item => item.scope)
  const scopeOutcome = await processScopeRequests(deps.store, state, base, siblingScopesForScope)
  state = scopeOutcome.state
  events.push(...scopeOutcome.events)
  if (scopeOutcome.pending.length > 0) {
    const currentTask = state.tasks.find(item => item.id === task.id) ?? base
    return await blockTask(deps, state, currentTask, '范围变更等待人工批准', '在界面上批准或拒绝该请求', events)
  }
  const at = Date.now()
  for (const [probeId, outcome] of Object.entries(lightOutcomes)) {
    events.push({
      type: 'probe.run', at, taskId: task.id, probeId, weight: 'light', result: outcome.result,
      ...(outcome.sha256 === undefined ? {} : { sha256: outcome.sha256 }),
    })
  }

  const completion = await completionOffset(deps.store, task)
  const lightAllPass = light.every(probe => outcomes[probe.id]?.result === 'pass')
  if (lightAllPass || completion.declared) {
    for (const probe of probes.filter(item => item.enabled && item.weight === 'heavy')) {
      const heavy = await runProbe(deps.cwd, probe)
      outcomes[probe.id] = heavy
      events.push({
        type: 'probe.run', at, taskId: task.id, probeId: probe.id, weight: 'heavy', result: heavy.result,
        ...(heavy.sha256 === undefined ? {} : { sha256: heavy.sha256 }),
      })
    }
  }

  const results: Record<string, ProbeResult> = {}
  for (const probe of probes) results[probe.id] = outcomes[probe.id]?.result ?? 'unknown'
  const allRequiredPass = task.requiredProbes.every(id => results[id] === 'pass')

  // Evidence for failed or heavy probes only; the list is bounded per task.
  const evidenceRefs: EvidenceRef[] = []
  for (const probe of probes) {
    const outcome = outcomes[probe.id]
    if (outcome === undefined) continue
    if (outcome.result === 'pass' && probe.weight === 'light') continue
    const ref = await recordProbeEvidence(deps, task.id, probe.id, outcome, at)
    if (ref !== undefined) evidenceRefs.push(ref)
  }

  // Point every probe verdict at the evidence file it produced, so the card and
  // the evaluator can both trace a verdict back to an artifact.
  const evidenceByProbe = new Map<string, string>()
  for (const ref of evidenceRefs) if (ref.probeId !== undefined) evidenceByProbe.set(ref.probeId, ref.id)
  const probeResults: Record<string, { result: ProbeResult; at: number; evidenceId?: string }> = {}
  for (const probe of probes) {
    const evidenceId = evidenceByProbe.get(probe.id)
    probeResults[probe.id] = { result: results[probe.id] ?? 'unknown', at, ...(evidenceId === undefined ? {} : { evidenceId }) }
  }

  // Merge onto the CURRENT row: `state` already carries what `processScopeRequests`
  // approved (scope, scopeApprovedCount), and spreading the pre-scope snapshot
  // here used to erase an approval the same turn had just written.
  const scopedTask = state.tasks.find(item => item.id === task.id) ?? base
  state = {
    ...state,
    tasks: updateTask(state, task.id, {
      status: 'IN_PROGRESS',
      probeResults,
      ...(evidenceRefs.length === 0 ? {} : { evidence: [...scopedTask.evidence, ...evidenceRefs].slice(-20) }),
    }),
  }

  const liveTask = state.tasks.find(item => item.id === task.id) ?? base
  // Tasks audited in the same turn share the worktree; their scopes are not
  // "outside this task" just because they are not ours.
  const siblingScopes = state.tasks
    .filter(item => item.id !== task.id && batchIds.includes(item.id))
    .map(item => item.scope)
  // A task that has not started yet still DECLARED its files. An agent that
  // prepares the next task's file in the worktree is not writing out of scope —
  // that path is the next task's business, and its own audit will judge it.
  // Deliberately NOT excused:
  //   - a DONE task's scope (touching finished work is a real violation);
  //   - a task a rollback put back to TODO (`reopenedAt` set);
  //   - a path COMMITTED into `baseCommit..HEAD` for a future task: letting this
  //     task tag above that commit would move the future task's `baseCommit`
  //     past its own file and break its audit and rollback.
  const upcomingScopes = state.tasks
    .filter(item => item.id !== task.id
      && item.status === 'TODO'
      && item.baseCommit === undefined
      && item.reopenedAt === undefined
      && item.scope.length > 0)
    .map(item => item.scope)
  const withSiblingsExcluded = (committedInRange: ReadonlySet<string>) => (path: string): boolean =>
    !pathInScope(path, liveTask.scope)
    && !siblingScopes.some(scope => pathInScope(path, scope))
    && (committedInRange.has(path) || !upcomingScopes.some(scope => pathInScope(path, scope)))

  if (allRequiredPass) {
    const scopeHash = await scopeFingerprint(deps, state, guardDir, liveTask)
    // The project smoke command is a deterministic gate, so it runs whenever the
    // required probes pass — not only on turns where the evaluator would also
    // run. Advancing `lastEvalScopeHash` here would make a failed smoke command
    // invisible to every later turn that does not touch the scope again.
    if (state.smokeCommand !== undefined) {
      const smoke = await runSmoke(deps.cwd, state.smokeCommand)
      if (!smoke.ok) {
        events.push({ type: 'probe.run', at: Date.now(), taskId: task.id, probeId: 'smoke', weight: 'heavy', result: 'fail' })
        const signature = digest(`smoke:${smoke.detail}`)
        const baseAttempt: Attempt = {
          index: nextAttemptIndex(task), at: Date.now(), signature,
          failureFingerprint: digest(smoke.detail),
          probeVector: probeVector(task, { ...results, smoke: 'fail' }), evidenceIds: [],
        }
        // The same three-strike rule as a probe failure: a permanently broken
        // smoke command must reach a human after three identical outputs, not
        // after fifty silent attempts.
        const decision = await progressDecision(deps, state, liveTask, signature, baseAttempt, events)
        const attempts = [...task.attempts, decision.attempt].slice(-20)
        const failed: GuardState = {
          ...state,
          tasks: updateTask(state, task.id, {
            attempts,
            probeResults: { ...probeResults, smoke: { result: 'fail', at: Date.now() } },
          }),
          updatedAt: Date.now(),
        }
        const reason = decision.blockedReason
          ?? (nextAttemptIndex(task) >= ATTEMPT_LIMIT ? `冒烟命令连续失败，已达 ${ATTEMPT_LIMIT} 次上限` : null)
        if (reason !== null) {
          return await blockTask(deps, failed, liveTask, reason, decision.blockedReason === null ? '检查项目是否能编译/自测' : decision.blockedNext, events, attempts)
        }
        await deps.store.update(failed, events)
        return failed
      }
    }
    const shouldEvaluate = scopeHash !== task.lastEvalScopeHash || completion.declared
    if (shouldEvaluate) {
      const candidate = await buildEvalCandidate(deps, state, guardDir, liveTask, probes, outcomes)
      const evaluated = await evaluateTask(deps.ctx, deps.agent, state, liveTask, candidate)
      if (evaluated.unavailable === true) {
        const streak = (task.evalUnavailableStreak ?? 0) + 1
        const reason = evaluated.reason ?? evaluated.missing.at(0) ?? '评估器不可用'
        events.push({
          type: 'eval.unavailable', at: Date.now(), taskId: task.id, reason,
          model: evaluated.model, latencyMs: evaluated.latencyMs, streak,
        })
        // Outages never consume an attempt and never advance `lastEvalScopeHash`
        // or `lastEvalOffset`, so the next turn retries cleanly on the same state.
        const retrying: GuardState = {
          ...state,
          tasks: updateTask(state, task.id, {
            evalUnavailableStreak: streak,
            lastEvalScopeHash: task.lastEvalScopeHash,
            lastEvalOffset: task.lastEvalOffset,
          }),
          updatedAt: Date.now(),
        }
        if (streak >= EVAL_UNAVAILABLE_LIMIT) {
          return await blockTask(
            deps, retrying, liveTask,
            `评估器连续 ${EVAL_UNAVAILABLE_LIMIT} 次不可用：${reason}`,
            '检查模型配置、网络或输出格式后回退重试',
            events,
          )
        }
        await deps.store.update(retrying, events)
        return retrying
      }
      events.push({
        type: 'eval.done', at: Date.now(), taskId: task.id, verdict: evaluated.verdict,
        model: evaluated.model, latencyMs: evaluated.latencyMs,
        ...(evaluated.reason === undefined ? {} : { reason: evaluated.reason }),
      })
      if (evaluated.goalHashMismatch === true) {
        const cleared: GuardState = {
          ...state,
          tasks: updateTask(state, task.id, { evalUnavailableStreak: undefined, lastEvalAt: Date.now() }),
          updatedAt: Date.now(),
        }
        return await blockTask(
          deps, cleared, liveTask,
          evaluated.reason ?? '目标 hash 不匹配',
          '目标卡被改过或评估器看错了目标；停下来等用户确认',
          events,
        )
      }
      if (evaluated.verdict === 'pass') {
        const changedAll = await taskPaths(deps, state, guardDir, liveTask)
        const committedInRange = liveTask.baseCommit === undefined
          ? new Set<string>()
          : new Set(await committedPathsSince(deps.cwd, liveTask.baseCommit, guardDir, { runId: deps.runId, taskId: task.id }))
        const changed = changedAll.filter(path => pathInScope(path, liveTask.scope))
        const outside = changedAll.filter(withSiblingsExcluded(committedInRange))
        if (outside.length > 0) {
          events.push({ type: 'scope.violation', at: Date.now(), taskId: task.id, paths: outside, enforcement: state.enforcement })
          if (state.enforcement === 'enforce') {
            return await blockTask(deps, state, liveTask, 'scope 外改动', '回退或把范围变更交给用户批准', events)
          }
        }
        const allDone = state.tasks.every(item => item.id === task.id || item.status === 'DONE')
        // A workspace that is not a repository has no commit and no tag. Writing
        // the ref name into the ledger there would be a fiction the rollback path
        // then chases (`checkpoint ... does not exist`), so it stays undefined.
        const gitRepo = await hasGit(deps.cwd)
        const checkpointRef = checkpointRefOf(deps.runId, task.id)
        // A tag that already exists (a rolled-back retry, or a hand-made tag)
        // cannot be re-created; refs are unique. Stop and let a human decide
        // instead of writing DONE over a checkpoint that is not ours.
        if (gitRepo && await hasRef(deps.cwd, checkpointRef)) {
          return await blockTask(
            deps, state, liveTask,
            `检查点 tag ${checkpointRef} 已存在`,
            '确认后删除旧 tag，或把任务改成新的 id 再重试',
            events,
          )
        }
        const doneState: GuardState = {
          ...state,
          tasks: updateTask(state, task.id, {
            status: 'DONE',
            ...(gitRepo ? { checkpointRef } : {}),
            // The task's work is committed again, so nothing it left in the
            // worktree still needs to be excluded from a sibling's audit.
            rollbackResidue: undefined,
            evalUnavailableStreak: undefined,
            lastEvalScopeHash: scopeHash, lastEvalAt: Date.now(),
            lastEvalOffset: completion.offset,
          }),
          activeTaskIds: state.activeTaskIds.filter(id => id !== task.id),
          // Completion order, not table order: a parallel batch finishes out of
          // order and the milestone review must see the tasks that just landed.
          doneOrder: [...(state.doneOrder ?? []).filter(id => id !== task.id), task.id],
          status: allDone ? 'completed' : 'active',
          updatedAt: Date.now(),
        }
        // On a failed commit the evaluation hash must NOT advance: the task still
        // has to re-evaluate (and retry the commit) once the transient failure is
        // gone, even when it declared no completion note.
        const rollbackState: GuardState = {
          ...state,
          tasks: updateTask(state, task.id, {
            status: 'IN_PROGRESS', lastEvalAt: Date.now(), evalUnavailableStreak: undefined,
          }),
          status: 'active',
          updatedAt: Date.now(),
        }
        events.push({ type: 'task.done', at: Date.now(), taskId: task.id, checkpointRef: gitRepo ? checkpointRef : '' })
        await deps.store.update(doneState, events)
        return await finishTask(deps, doneState, rollbackState, { ...liveTask, checkpointRef }, changed, allDone)
      }
      // State-based signature: omit model phrasing (`correction`) and verdict
      // wobble (`fail` vs `insufficient`), so an unchanged workspace oscillating
      // between non-pass verdicts converges through `progressDecision` instead
      // of resetting the streak forever.
      const vector = probeVector(task, results)
      const signature = digest(JSON.stringify({ kind: 'eval-not-pass', scopeHash, probeVector: vector }))
      const failureDetail = evaluated.reason ?? evaluated.correction
      const baseAttempt: Attempt = {
        index: nextAttemptIndex(task), at: Date.now(), signature,
        ...(failureDetail === '' ? {} : { failureFingerprint: digest(failureDetail) }),
        probeVector: vector, evalVerdict: evaluated.verdict, evidenceIds: [],
      }
      const decision = await progressDecision(deps, state, liveTask, signature, baseAttempt, events)
      const attempts = [...task.attempts, decision.attempt].slice(-20)
      const failed: GuardState = {
        ...state,
        tasks: updateTask(state, task.id, {
          attempts, evalUnavailableStreak: undefined,
          lastEvalAt: Date.now(), lastEvalScopeHash: scopeHash,
          lastEvalOffset: completion.offset,
        }),
        updatedAt: Date.now(),
      }
      if (decision.blockedReason !== null) {
        return await blockTask(deps, failed, liveTask, decision.blockedReason, decision.blockedNext, events, attempts)
      }
      if (nextAttemptIndex(task) >= ATTEMPT_LIMIT) {
        return await blockTask(deps, failed, liveTask, `单任务尝试达到 ${ATTEMPT_LIMIT} 次上限`, '检查目标与验收是否可执行，或由用户补充新方法', events, attempts)
      }
      await deps.store.update(failed, events)
      return failed
    }
    // No new scope change and no new declaration: keep the offset untouched so a
    // completion note written before the probes passed is still seen later.
    await deps.store.update({ ...state, updatedAt: Date.now() }, events)
    return state
  }

  const signature = signatureOf(
    await taskPaths(deps, state, guardDir, liveTask),
    (await candidateOf(deps.ctx, deps.agent.id)).tools,
    failedDetails(task, outcomes),
  )
  const baseAttempt: Attempt = {
    index: nextAttemptIndex(task), at: Date.now(), signature,
    probeVector: probeVector(task, results), evidenceIds: [],
  }
  const decision = await progressDecision(deps, state, liveTask, signature, baseAttempt, events)
  let blockedReason = decision.blockedReason
  let blockedNext = decision.blockedNext
  if (blockedReason === null && nextAttemptIndex(task) >= ATTEMPT_LIMIT) {
    blockedReason = `单任务尝试达到 ${ATTEMPT_LIMIT} 次上限`
    blockedNext = '检查目标与验收是否可执行，或由用户补充新方法'
  }
  const attempts = [...task.attempts, decision.attempt].slice(-20)
  if (blockedReason !== null) {
    return await blockTask(deps, state, liveTask, blockedReason, blockedNext, events, attempts)
  }
  const waiting: GuardState = {
    ...state,
    tasks: updateTask(state, task.id, { ...liveTask, attempts, lastEvalOffset: task.lastEvalOffset }),
    updatedAt: Date.now(),
  }
  await deps.store.update(waiting, events)
  return waiting
}
