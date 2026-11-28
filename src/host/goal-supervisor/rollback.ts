/**
 * Roll one run back to its last checkpoint and reopen the task in flight.
 *
 * Reverting commits alone is not a rollback: the in-progress task usually has
 * nothing committed yet, so its half-finished edits would survive and poison the
 * retry. This module therefore does, in this order:
 *
 *   1. capture the current dirty work as a patch inside the run directory;
 *   2. revert the commits above the revert base (history is never rewritten);
 *   3. restore the reopened task's own scope to that base, so a dirty
 *      half-finished edit cannot leak into the retry;
 *   4. delete the checkpoint tag of a reopened DONE task, or its next completion
 *      would fail with "tag already exists";
 *   5. reopen the task in the ledger and clear the run-level goal block.
 *
 * Two safety rules the previous version got wrong:
 *   - a task with NO declared scope grants nothing here: `pathInScope()` treats an
 *     empty scope as "everything", which would delete unrelated files in a shared
 *     worktree, so an unscoped task restores nothing and reports what it skipped;
 *   - reopening a DONE task needs its own commit reverted, not the one after it.
 *     The revert base for that case is the PREVIOUS checkpoint (or, for the very
 *     first task, that single commit).
 */

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  blobAt, changedPaths, changedPathsSince, commitsAfter, deleteRef, foreignPluginCommitPaths, hasRef, hashPath,
  headBlob, headCommit, isAncestor, isRevertSubject, matchesTaskBaseline, pathInScope, pluginCommitShas, refCommit,
  restorePaths, restoreTrackedToHead, revertCommitsProgress, rollbackToCheckpoint,
} from './git'
import { captureBlockedPatch } from './patch'
import { orderedByCompletion } from './schema'
import type { GuardState, GuardTask, RollbackResidueEntry } from './schema'
import { GuardStore } from './store'

export interface RollbackRequest {
  readonly cwd: string
  readonly runId: string
  /** Session that owns the run; `undefined` skips the ownership check (tests). */
  readonly sessionId?: string
}

export interface RollbackReport {
  readonly runId: string
  /** Ref the workspace was restored to (a tag, a commit, or `HEAD`). */
  readonly targetRef: string
  readonly taskId: string
  readonly reverted: readonly string[]
  readonly restored: readonly string[]
  readonly removed: readonly string[]
  /** Paths deliberately left untouched (outside the scope, or already dirty at run start). */
  readonly skipped: readonly string[]
  /** Tags removed because the task that owned them is no longer DONE. */
  readonly deletedTags: readonly string[]
  readonly evidencePath?: string
  /** True when the rollback deliberately left files alone (see `skipped`). */
  readonly partial: boolean
}

export type RollbackOutcome =
  | { readonly ok: true; readonly report: RollbackReport }
  | { readonly ok: false; readonly reason: string }

function evidencePathOf(store: GuardStore, patch: string): string {
  return patch.startsWith(store.root) ? patch.slice(store.root.length + 1) : patch
}

/**
 * DONE tasks in COMPLETION order.
 *
 * `state.tasks` is declaration order, and a parallel batch finishes out of
 * order: taking the last table row as "the newest checkpoint" reverted a healthy
 * sibling's commit (or restored the wrong base and silently did nothing).
 * `doneOrder` records the order the completions were observed (a repeated id
 * ranks by its LAST occurrence); a task missing from it was completed before
 * that field existed, so it sorts first.
 */
function doneTasksInOrder(state: GuardState): GuardTask[] {
  const done = state.tasks.filter(task => task.status === 'DONE' && typeof task.checkpointRef === 'string')
  return orderedByCompletion(state, done)
}

/**
 * DONE tasks whose own checkpoint commit sits inside `ref..HEAD`.
 *
 * A blanket range revert that crosses a sibling's checkpoint destroys work the
 * ledger still calls DONE. On a modern ledger the newest checkpoint is a
 * descendant of every sibling, so this returns nothing; a legacy ledger without
 * `doneOrder` may have guessed wrong, and then refusing is the only safe answer.
 */
async function siblingCheckpointsInRange(
  cwd: string,
  ref: string,
  done: readonly GuardTask[],
  targetId: string,
): Promise<string[]> {
  const range = new Set(
    (await commitsAfter(cwd, ref)).map(line => line.split('\t')[0] ?? '').filter(sha => sha !== ''),
  )
  if (range.size === 0) return []
  const crossing: string[] = []
  for (const task of done) {
    if (task.id === targetId || task.checkpointRef === undefined) continue
    const sha = await refCommit(cwd, task.checkpointRef)
    if (sha !== null && range.has(sha)) crossing.push(task.id)
  }
  return crossing
}

/** Roll the run back; never throws — every failure is a user-readable reason. */
export async function rollbackRun(request: RollbackRequest): Promise<RollbackOutcome> {
  const { cwd, runId } = request
  const store = new GuardStore(join(cwd, 'docs', 'guard', runId))
  let meta
  try {
    meta = await store.readMeta()
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'run meta is unreadable' }
  }
  if (meta === null) return { ok: false, reason: 'run is missing' }
  if (request.sessionId !== undefined && meta.sessionId !== undefined && meta.sessionId !== request.sessionId) {
    return { ok: false, reason: 'run does not belong to this session' }
  }
  const state = await store.readState()
  if (state === null) return { ok: false, reason: 'run ledger is missing' }
  const doneTasks = doneTasksInOrder(state)
  const last = doneTasks.at(-1)
  // A blocked task is what the card offers to roll back; preferring a healthy
  // `IN_PROGRESS` sibling would silently roll back the wrong task in a parallel
  // batch.
  const inFlight = state.tasks.find(task => task.status === 'BLOCKED')
    ?? state.tasks.find(task => task.status === 'IN_PROGRESS')
  const target = inFlight ?? last
  if (target === undefined) return { ok: false, reason: 'nothing to roll back' }

  // Two shapes of rollback, deliberately different:
  //   - a task in flight has nothing committed, so the commits above the last
  //     checkpoint are reverted and its own scope goes back to that checkpoint;
  //   - reopening a DONE task does NOT rewrite its commit. Its scope is restored
  //     to the previous checkpoint (or its own base commit) and its checkpoint
  //     tag is removed; the retry then commits the new state on top. Reverting a
  //     finished task's commit conflicts with the ledger that commit carries, so
  //     that path stays out of history entirely.
  const reopeningDone = inFlight === undefined
  const previous = reopeningDone ? doneTasks.filter(task => task.id !== target.id).at(-1) : last
  // A ref can be missing (tag deleted by hand, a ledger written before the tag
  // existed, a non-git workspace). Treat it as "no reference point": reverting
  // to it is impossible, and restoring to it would delete every scoped file.
  const refExists = async (ref: string | undefined): Promise<string | null> =>
    ref === undefined || ref === '' || !(await hasRef(cwd, ref)) ? null : ref
  const previousRef = await refExists(previous?.checkpointRef)
  const ownBaseRef = await refExists(target.baseCommit)
  // Both flags mean the task shipped code that later checkpoints may have
  // inherited. They only make us LOOK at each path: the restore ref is decided
  // per path below, never for the whole scope at once.
  const reopenedBefore = target.rollbackResidue !== undefined || target.reopenedAt !== undefined
  const earlierBase = ownBaseRef !== null && previousRef !== null && ownBaseRef !== previousRef
    && await isAncestor(cwd, ownBaseRef, previousRef)
    ? ownBaseRef
    : null
  // The task's own base is older than the sibling checkpoint AND it was reopened
  // before: a per-path restore has something to distinguish.
  const splitBase = earlierBase !== null && reopenedBefore ? earlierBase : null
  const restoreRef = splitBase ?? previousRef ?? ownBaseRef
  // A task in flight normally has nothing committed, but a subagent may have run
  // `git commit` itself. When there is no checkpoint yet, that reckless commit is
  // undone individually — never a blanket range revert, which could take a
  // parallel sibling's own `guard(...)` commit with it.
  const revertFrom = reopeningDone ? null : await refExists(last?.checkpointRef)
  // A range revert that reaches a still-DONE sibling's checkpoint would delete
  // committed work the ledger keeps calling finished. Never do that silently.
  if (revertFrom !== null) {
    const crossing = await siblingCheckpointsInRange(cwd, revertFrom, doneTasks, target.id)
    if (crossing.length > 0) {
      return {
        ok: false,
        reason: `回退范围 ${revertFrom}..HEAD 里还有 ${crossing.join('、')} 的检查点提交；整段 revert 会破坏仍标记 DONE 的任务，请手动处理`,
      }
    }
  }
  // Reopening a DONE task only undoes ITS work, so its checkpoint must be the
  // newest one. A legacy ledger without `doneOrder` can guess the wrong task: the
  // target's checkpoint then has a still-DONE sibling above it, the "previous"
  // ref restores nothing, and the tag is deleted anyway — a silent no-op dressed
  // up as success. Refuse and let a human name the task to reopen.
  if (reopeningDone && target.checkpointRef !== undefined && await hasRef(cwd, target.checkpointRef)) {
    const crossing = await siblingCheckpointsInRange(cwd, target.checkpointRef, doneTasks, target.id)
    if (crossing.length > 0) {
      return {
        ok: false,
        reason: `${target.checkpointRef}..HEAD 里还有 ${crossing.join('、')} 的检查点提交；回退 ${target.id} 不会恢复它自己的提交，请先回退 ${crossing.join('、')} 或手动处理`,
      }
    }
  }
  const foreignRevertBase = !reopeningDone && revertFrom === null ? restoreRef : null

  const guardDir = `docs/guard/${runId}`
  const dirty = await changedPaths(cwd, guardDir)
  // The task may have committed its work (a subagent `git commit`, or a DONE task
  // being reopened). `git status` is clean then, so a dirty-only view would
  // restore nothing at all.
  const candidates = restoreRef === null
    ? dirty
    : await changedPathsSince(cwd, restoreRef, guardDir, { runId, taskId: target.id })
  // Never pass unchanged run-start baseline files to `captureBlockedPatch`:
  // rollback never restores or removes them, and hashing/diffing thousands of
  // pre-existing cache files would stall or overflow the patch buffer.
  const nonBaselineDirty: string[] = []
  const chunk = 32
  for (let start = 0; start < dirty.length; start += chunk) {
    const slice = dirty.slice(start, start + chunk)
    const flags = await Promise.all(slice.map(path => matchesTaskBaseline(cwd, state.baselineDirty, target.baselineDirty, path)))
    slice.forEach((path, index) => { if (!flags[index]) nonBaselineDirty.push(path) })
  }
  const captured = nonBaselineDirty.length === 0 ? null : await captureBlockedPatch(cwd, store, target.id, nonBaselineDirty, 0)
  const patch = captured?.path ?? null
  // Coverage is per path: the patch is built from the WHOLE dirty set, so its
  // mere existence proves nothing about any single path below.
  const backedUpPaths: ReadonlySet<string> = captured?.coveredPaths ?? new Set<string>()

  const scoped: string[] = []
  const skipped: string[] = []
  for (const path of candidates) {
    // A file that is still byte-identical to the run-creation snapshot was the
    // user's own work before the run started; it is never restored or deleted.
    if (await matchesTaskBaseline(cwd, state.baselineDirty, target.baselineDirty, path)) { skipped.push(path); continue }
    // An unscoped task matches every path, so a rollback there would delete
    // unrelated work in the shared tree. Restore nothing and report the rest.
    if (target.scope.length > 0 && pathInScope(path, target.scope)) scoped.push(path)
    else skipped.push(path)
  }

  // Only a dirty worktree over the task's own scope is recoverable by clearing
  // it: resetting those dirty paths makes the second revert attempt succeed. A
  // merge conflict, a mixed revert range or an unknown ref never is, and
  // restoring (or deleting) files first would destroy work for no benefit. Every
  // `revertCommitsProgress` message carries git's own stderr, so match the real
  // hints instead of the wrapper text.
  const retryable = (reason: string): boolean =>
    /local changes|would be overwritten|uncommitted|unstaged/i.test(reason)

  /**
   * The foreign commits this rollback still has to revert, newest first.
   *
   * Computed ONCE, before the first attempt: `git revert` is not atomic, so a
   * failed attempt can leave part of the range reverted. Recomputing
   * `base..HEAD` afterwards sees a `Revert "..."` on top — the old code read that
   * as "already rolled back" and skipped every commit that had NOT been
   * reverted, returning success while the rest of the range survived forever.
   */
  const planForeignReverts = async (): Promise<
    { readonly ok: true; readonly shas: readonly string[] } | { readonly ok: false; readonly reason: string }
  > => {
    if (foreignRevertBase === null) return { ok: true, shas: [] }
    const commits = await commitsAfter(cwd, foreignRevertBase)
    if (commits.length === 0) return { ok: true, shas: [] }
    const ownShas = await pluginCommitShas(cwd, runId)
    const revertedSubjects = new Set<string>()
    const foreign: { sha: string; subject: string }[] = []
    for (const line of commits) {
      const [sha = '', subject = ''] = line.split('\t')
      if (sha === '') continue
      if (isRevertSubject(subject)) {
        const start = subject.indexOf('"')
        const end = subject.lastIndexOf('"')
        revertedSubjects.add(start >= 0 && end > start ? subject.slice(start + 1, end) : '')
        continue
      }
      // Only a tag the plugin wrote proves a commit is its own; a matching
      // message can be forged by the very subagent being audited.
      if (ownShas.has(sha)) continue
      foreign.push({ sha, subject })
    }
    // A revert with newer work above it mixes two directions; no blanket answer.
    const top = commits[0]?.split('\t')[1] ?? ''
    if (revertedSubjects.size > 0 && !isRevertSubject(top)) {
      return { ok: false, reason: 'the commit range mixes a rollback with newer work; resolve it by hand' }
    }
    // Subject matching is the only durable link between a revert commit and what
    // it undid; a duplicated subject cannot tell the two apart.
    const counts = new Map<string, number>()
    for (const item of foreign) counts.set(item.subject, (counts.get(item.subject) ?? 0) + 1)
    const ambiguous = foreign.filter(item => (counts.get(item.subject) ?? 0) > 1 && revertedSubjects.has(item.subject))
    if (ambiguous.length > 0) {
      return { ok: false, reason: '回退区间里有多条同标题提交被部分回退，无法判断剩余项；请手动处理' }
    }
    return { ok: true, shas: foreign.filter(item => !revertedSubjects.has(item.subject)).map(item => item.sha) }
  }

  /** Explain which commits were already undone when a rollback gives up. */
  const withReverted = (reason: string, done: readonly string[]): string =>
    done.length === 0 ? reason : `${reason}（已回退 ${done.length} 条提交：${done.join('、')}；其余未回退，请手动处理）`

  const plan = await planForeignReverts()
  if (!plan.ok) return { ok: false, reason: plan.reason }
  let pending: string[] = [...plan.shas]
  let reverted: string[] = []
  const attemptRevert = async (): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> => {
    if (revertFrom !== null) {
      try {
        const result = await rollbackToCheckpoint(cwd, revertFrom)
        reverted = [...reverted, ...result.reverted]
        pending = []
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'rollback failed' }
      }
    }
    if (pending.length === 0) return { ok: true }
    const progress = await revertCommitsProgress(cwd, pending)
    reverted = [...reverted, ...progress.reverted]
    pending = [...progress.remaining]
    return progress.failure === undefined ? { ok: true } : { ok: false, reason: progress.failure }
  }

  const first = await attemptRevert()
  if (!first.ok) {
    // Retry only when the failure is a dirty tree AND something in scope is
    // actually dirty right now. `scoped` also contains committed paths, so using
    // it directly deleted files the task had committed without any backup.
    const dirtySet = new Set(dirty)
    const dirtyScoped = scoped.filter(path => dirtySet.has(path))
    if (!retryable(first.reason) || dirtyScoped.length === 0 || restoreRef === null) {
      return { ok: false, reason: withReverted(first.reason, reverted) }
    }
    // Reset the dirty scoped files to HEAD (not to the checkpoint): a revert
    // refuses to run while a file it must patch is modified, and checking them out
    // at the checkpoint leaves the INDEX differing from HEAD, so the retry would
    // fail again. A path that does not exist at HEAD (a staged addition, or a file
    // re-created after a commit deleted it) also has its worktree copy removed —
    // but only when the patch above really backs it up, so nothing is lost.
    const cleared = await restoreTrackedToHead(cwd, dirtyScoped, { backedUpPaths })
    const second = await attemptRevert()
    if (!second.ok) {
      // Be explicit: the first attempt already reset these paths, so the operator
      // must not assume the tree is untouched — and say where the backup went.
      const backup = patch === null ? '没有可用的回退补丁' : `回退补丁 ${evidencePathOf(store, patch)}`
      // Report only what actually happened. `dirtyScoped` mixes four outcomes: a
      // HEAD-tracked path reset by `checkout HEAD`, a HEAD-tracked path whose
      // checkout FAILED (a lock or a permission error), a HEAD-absent copy
      // deleted because the patch covered it, and a HEAD-absent copy refused
      // because no backup covered it. Calling every dirty path "reset to HEAD"
      // contradicted the very next clause ("no backup, not deleted") for the
      // refused ones, and dropping the failed ones made the fallback below lie
      // about a dirty file that was still on disk.
      const clearedParts: string[] = []
      if (cleared.reset.length > 0) clearedParts.push(`${cleared.reset.length} 个已追踪脏文件已重置到 HEAD`)
      const failedReset = cleared.failed ?? []
      if (failedReset.length > 0) clearedParts.push(`${failedReset.join('、')} 重置到 HEAD 失败`)
      if (cleared.removed.length > 0) clearedParts.push(`${cleared.removed.length} 个 HEAD 中不存在的脏副本已移除`)
      if (cleared.refused.length > 0) clearedParts.push(`${cleared.refused.join('、')} 没有备份，未删除`)
      const scopeState = clearedParts.length === 0
        ? '本任务 scope 内没有成功重置的脏文件'
        : `本任务 scope 内 ${clearedParts.join('；')}`
      return {
        ok: false,
        reason: `${withReverted(second.reason, reverted)}（${scopeState}；备份：${backup}）`,
      }
    }
  }

  // A split rollback restores each path to the ref that actually owns it: a path
  // a sibling committed in `ownBase..checkpoint` keeps that newer content, a path
  // only this task's abandoned commits changed goes back to the task's own base
  // (restoring it to the inherited checkpoint would resurrect the abandoned blob).
  const restoreTarget = new Map<string, string>()
  if (splitBase !== null && previousRef !== null) {
    const foreign = await foreignPluginCommitPaths(cwd, splitBase, previousRef, { runId, taskId: target.id })
    for (const path of scoped) {
      const inherited = await blobAt(cwd, splitBase, path) !== await blobAt(cwd, previousRef, path)
      restoreTarget.set(path, inherited && !foreign.has(path) ? splitBase : previousRef)
    }
  } else if (restoreRef !== null) {
    for (const path of scoped) restoreTarget.set(path, restoreRef)
  }
  const restore = restoreRef === null
    ? { restored: [], removed: [], skipped: [...scoped] }
    : await (async (): Promise<{ restored: string[]; removed: string[]; skipped: string[] }> => {
      const groups = new Map<string, string[]>()
      for (const path of scoped) {
        const ref = restoreTarget.get(path)
        if (ref === undefined) continue
        groups.set(ref, [...(groups.get(ref) ?? []), path])
      }
      const merged = { restored: [] as string[], removed: [] as string[], skipped: [] as string[] }
      for (const [ref, paths] of groups) {
        const part = await restorePaths(cwd, ref, paths)
        merged.restored.push(...part.restored)
        merged.removed.push(...part.removed)
        merged.skipped.push(...part.skipped)
      }
      return merged
    })()

  // Reopening a `DONE` task never rewrites history, so its committed files come
  // back as uncommitted work in the shared worktree. Record exactly which paths
  // this rollback left differing from HEAD (and with what content): the next
  // task's retry must not read them as its own out-of-scope change, while a
  // later write with different content is still blamed (the hash must match).
  const dirtyAfter = new Set(await changedPaths(cwd, guardDir))
  // REBUILD the residue from what this rollback actually left dirty. Merging it
  // into the old record kept paths that had become clean again forever, and every
  // stale entry could excuse a later out-of-scope change.
  const residue: Record<string, RollbackResidueEntry> = {}
  for (const path of [...restore.restored, ...restore.removed]) {
    if (!dirtyAfter.has(path)) continue
    residue[path] = { headBlob: await headBlob(cwd, path), worktreeHash: await hashPath(cwd, path) }
  }

  const deletedTags: string[] = []
  if (reopeningDone && target.checkpointRef !== undefined && await hasRef(cwd, target.checkpointRef)) {
    if (await deleteRef(cwd, target.checkpointRef)) deletedTags.push(target.checkpointRef)
  }

  const at = Date.now()
  // A revert rewrote the history this task is measured from. Pin the new HEAD as
  // its base — otherwise the reverted files stay inside `baseCommit..HEAD` and
  // `enforce` keeps blaming them on every retry, which deadlocks the task.
  // A stale/reopened task keeps its ORIGINAL base: moving it onto the revert
  // commit would make the next rollback treat inherited (still committed) code as
  // that task's own base and resurrect it.
  const advancedBase = !reopeningDone && reverted.length > 0 && !reopenedBefore
    ? await headCommit(cwd)
    : null
  const notesLength = await readFile(store.notesPath(target.id), 'utf8')
    .then(text => text.length)
    .catch(() => 0)
  const reopened: GuardState = {
    ...state,
    tasks: state.tasks.map(task => task.id === target.id
      ? {
        ...task,
        status: 'TODO',
        checkpointRef: undefined,
        // The worktree state this rollback created stays owned by this task even
        // after it is reopened, so a sibling's retry does not inherit it.
        rollbackResidue: Object.keys(residue).length === 0 ? undefined : residue,
        reopenedAt: at,
        ...(advancedBase === null ? {} : { baseCommit: advancedBase }),
        blocked: undefined,
        // The attempt history is what blocked the task in the first place: a
        // task that hit the 50-attempt cap (or used up its exemptions) would be
        // re-blocked on its very first retry. `state.jsonl` keeps the audit trail.
        attempts: [],
        probeResults: {},
        lastEvalAt: undefined,
        lastEvalScopeHash: undefined,
        evalUnavailableStreak: undefined,
        // Keep the offset at the current end of notes.md: the guidance skeleton
        // (and anything already written) must not read as a fresh declaration.
        lastEvalOffset: notesLength,
        evidence: patch === null
          ? task.evidence
          : [...task.evidence, { id: `patch-rollback-${at}`, kind: 'patch' as const, path: evidencePathOf(store, patch), at }],
      }
      : task),
    activeTaskIds: state.activeTaskIds.filter(id => id !== target.id),
    // A reopened task is no longer completed: an id left in `doneOrder` would
    // make the milestone review (and the next rollback) treat it as finished.
    ...(state.doneOrder === undefined ? {} : { doneOrder: state.doneOrder.filter(id => id !== target.id) }),
    goalBlocked: undefined,
    // The block's source travels with `goalBlocked`: a stale `milestone` kind
    // would make the reopened run refuse every later resume.
    goalBlockKind: undefined,
    status: 'active',
    updatedAt: at,
  }
  // Report the ref the task's own work was taken back from. A split restore has
  // two refs; the task's own base is the honest answer whenever any path went
  // there, and it is the only base when nothing needed restoring.
  const ownPaths = scoped.filter(path => splitBase !== null && restoreTarget.get(path) === splitBase)
  const previousPaths = scoped.filter(path => previousRef !== null && restoreTarget.get(path) === previousRef)
  const targetRef = splitBase === null
    ? restoreRef ?? revertFrom ?? target.checkpointRef ?? 'HEAD'
    : ownPaths.length > 0 || previousPaths.length === 0 ? splitBase : previousRef ?? splitBase
  // A milestone failure is a RUN-level safety gate. Rolling back a BLOCKED
  // sibling does not reopen the DONE task that the review rejected, so clearing
  // the gate here would let the next resume walk past it. Only a rollback that
  // reopens a DONE task (the review's subject) clears it.
  const keepMilestoneGate = (current: GuardState): boolean =>
    !reopeningDone
    && (current.goalBlockKind === 'milestone'
      || current.goalBlocked?.includes('里程碑审阅未通过') === true)
  // Read-modify-write under the run lock: a `guard.switch` may have landed while
  // the git work above ran, and writing this snapshot back blind would erase it.
  const saved = await store.mutate(current => ({
    state: {
      ...reopened,
      // The six fields an operator may switch while this rollback runs come from
      // the lock-time ledger, never from the pre-git snapshot.
      evaluator: current.evaluator,
      evaluatorFallback: current.evaluatorFallback,
      executor: current.executor,
      executorFallback: current.executorFallback,
      activeExecutor: current.activeExecutor,
      visual: current.visual,
      ...(keepMilestoneGate(current)
        ? { goalBlocked: current.goalBlocked, goalBlockKind: current.goalBlockKind, status: 'blocked' as const }
        : {}),
    },
    events: [{
      type: 'checkpoint.rollback',
      at,
      targetRef,
      by: 'human',
      reverted,
      reopened: [target.id],
      restored: restore.restored,
      removed: restore.removed,
      skipped: [...skipped, ...restore.skipped],
    }],
  }), state)
  if (saved === null) return { ok: false, reason: 'run ledger is missing' }
  if (meta.phase === 'completed') {
    await store.updateMeta(current => ({ ...current, phase: 'running', updatedAt: at }))
  }
  return {
    ok: true,
    report: {
      runId,
      targetRef,
      taskId: target.id,
      reverted,
      restored: restore.restored,
      removed: restore.removed,
      skipped: [...skipped, ...restore.skipped],
      deletedTags,
      ...(patch === null ? {} : { evidencePath: evidencePathOf(store, patch) }),
      partial: target.scope.length === 0 || restore.skipped.length > 0 || skipped.length > 0,
    },
  }
}
