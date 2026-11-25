/**
 * The on-disk contract for a Goal Supervisor run.
 *
 * One run owns `docs/guard/<run-id>/`; `tasks.json` is the machine source of
 * truth, `state.jsonl` is append-only audit, `run.json` is the mount/mirror
 * metadata, and `TASKS.md` is a pure rendering of `tasks.json` for humans.
 *
 * Everything is `version: 1`; a future shape change must go through a
 * migration function instead of silently reinterpreting old files.
 */

export const GUARD_SCHEMA_VERSION = 1 as const

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED'
export type ProbeResult = 'pass' | 'fail' | 'unknown'
export type Verdict = 'pass' | 'fail' | 'insufficient'
export type ProgressVerdict = 'advancing' | 'spinning' | 'scope_blocked'
/** What the progress evaluator asked for; `unknown` means it could not answer. */
export type ProgressEvalVerdict = ProgressVerdict | 'unknown'
export type EnforcementMode = 'warn-only' | 'enforce'
export type MethodCategory = 'config' | 'reinstall' | 'rewrite' | 'probe' | 'other'

export interface Attempt {
  /** Monotonic index within the task. */
  readonly index: number
  readonly at: number
  /** Machine-computed approach signature (sha256). */
  readonly signature: string
  /** Failure-output fingerprint (sha256); absent when the attempt produced no output. */
  readonly failureFingerprint?: string
  /** Coarse label assigned by the evaluator; never free text. */
  readonly method?: MethodCategory
  readonly probeVector: Readonly<Record<string, ProbeResult>>
  readonly evalVerdict?: Verdict
  /** Lightweight progress evaluation triggered by three identical signatures. */
  readonly progressEval?: {
    readonly verdict: ProgressEvalVerdict
    readonly reason: string
    readonly at: number
  }
  readonly evidenceIds: readonly string[]
}

export interface EvidenceRef {
  readonly id: string
  readonly kind: 'probe' | 'command' | 'patch' | 'commit' | 'review'
  /** Relative to `docs/guard/<run-id>/`. */
  readonly path: string
  readonly sha256?: string
  readonly exitCode?: number
  /** Short, redacted summary the evaluator may read instead of the full file. */
  readonly summary?: string
  readonly probeId?: string
  readonly at: number
}

/**
 * One path a rollback of a task left differing from HEAD.
 *
 * Both halves are required, and both are compared before the residue excuses a
 * path: `headBlob` proves the commit range still holds the state the rollback
 * recorded (a later DONE commit must invalidate it), `worktreeHash` proves
 * nobody wrote the path since. A bare content hash excused a genuine
 * out-of-scope deletion as soon as the worktree happened to match again.
 */
export interface RollbackResidueEntry {
  // oxlint-disable-next-line typescript/no-redundant-type-constituents -- 'absent' is a sentinel, not a sha
  readonly headBlob: string | 'absent'
  /** Content hash of the worktree file, or `'deleted'` when it is gone. */
  // oxlint-disable-next-line typescript/no-redundant-type-constituents -- 'deleted' is a sentinel, not a hash
  readonly worktreeHash: string | 'deleted'
}

export interface GuardTask {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  /** Paths/globs this task may change; the frozen write scope. */
  readonly scope: readonly string[]
  readonly dependsOn: readonly string[]
  readonly acceptance: readonly string[]
  readonly probes: readonly string[]
  readonly requiredProbes: readonly string[]
  readonly probeResults: Readonly<Record<string, { readonly result: ProbeResult; readonly at: number; readonly evidenceId?: string }>>
  readonly evidence: readonly EvidenceRef[]
  readonly attempts: readonly Attempt[]
  /** Number of approved scope expansions; >3 forces human approval. */
  readonly scopeApprovedCount: number
  readonly blocked?: {
    readonly reason: string
    readonly next: string
    readonly remainingCandidates: readonly string[]
    readonly at: number
  }
  /** Git HEAD at task start; the base of the scope diff. */
  readonly baseCommit?: string
  /**
   * Pre-existing dirty files, exempt from this task's scope diff.
   * The value is a content hash, or the literal sentinel `'deleted'` when the
   * file was already removed before the task started.
   */
  // oxlint-disable-next-line typescript/no-redundant-type-constituents -- 'deleted' is a sentinel, not a hash
  readonly baselineDirty: Readonly<Record<string, string | 'deleted'>>
  /** `guard/<run-id>/<task>`; a ref name, never a SHA (avoids circularity). */
  readonly checkpointRef?: string
  /**
   * Paths a rollback of THIS task left differing from HEAD, with the HEAD blob
   * and worktree content the rollback created.
   *
   * Reopening a `DONE` task deliberately does not rewrite history, so its
   * committed files come back as uncommitted work in the shared worktree. A
   * later task's retry would otherwise read that residue as its own
   * out-of-scope change and block. Ownership is only excluded while this task
   * is not `DONE` AND both the HEAD blob and the file content still match what
   * the rollback recorded; `enforce` still refuses new writes outside the
   * running task's scope.
   */
  readonly rollbackResidue?: Readonly<Record<string, RollbackResidueEntry>>
  /** When this task was last rolled back to `TODO`; its old base commit predates any later work. */
  readonly reopenedAt?: number
  readonly lastEvalAt?: number
  /** Hash of the scope file set at the last evaluation. */
  readonly lastEvalScopeHash?: string
  /** JS string offset of notes.md at the last evaluation, for new-completion detection. */
  readonly lastEvalOffset?: number
  /** Consecutive evaluator outages (`unavailable`); cleared on any real verdict or rollback. */
  readonly evalUnavailableStreak?: number
}

export interface SmokeCommand {
  readonly cmd: string
  readonly args: readonly string[]
  readonly timeoutMs?: number
}

/** `tasks.json`: the machine source of truth for one run. */
export interface GuardState {
  readonly version: typeof GUARD_SCHEMA_VERSION
  readonly runId: string
  /**
   * Ids in the order their `DONE` was observed, so the milestone review sees the
   * batch that actually completed rather than a slice of the task table.
   */
  readonly doneOrder?: readonly string[]
  readonly goal: string
  /** The frozen project acceptance text, kept verbatim. */
  readonly acceptance: string
  /** The frozen discipline text, kept verbatim. */
  readonly discipline: string
  readonly goalHash: string
  readonly tasks: readonly GuardTask[]
  /** Tasks currently IN_PROGRESS; several entries only in parallel mode. */
  readonly activeTaskIds: readonly string[]
  /** 1–10; 1 means strictly sequential. */
  readonly parallel: number
  readonly enforcement: EnforcementMode
  readonly worktree: {
    readonly enabled: boolean
    readonly path?: string
    readonly branch?: string
  }
  /** Optional project-level compile/smoke command for the merge queue. */
  readonly smokeCommand?: SmokeCommand
  /** Every N DONE tasks trigger the milestone review. */
  readonly milestoneEvery: number
  /**
   * Why the plugin last asked the host goal to stop. Cleared as soon as a batch
   * becomes runnable again, so a human re-arming the goal resumes the run.
   */
  readonly goalBlocked?: string
  readonly status: 'active' | 'paused' | 'completed' | 'blocked'
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * `tasks` sorted by COMPLETION order, not declaration order.
 *
 * `state.tasks` is table order and a parallel batch finishes out of order, so
 * both the milestone review and the rollback ask the same question: which task
 * completed last? The LAST occurrence of an id wins: a task that was reopened and
 * completed again is appended again, and that newer completion owns the highest
 * checkpoint. A task `doneOrder` never named (a ledger written before the field
 * existed) sorts first in table order, which is the old fallback. Every task is
 * returned exactly once, so a duplicated id can neither fill a review batch twice
 * nor crowd out a genuinely completed task.
 */
export function orderedByCompletion(
  state: Pick<GuardState, 'tasks' | 'doneOrder'>,
  tasks: readonly GuardTask[],
): GuardTask[] {
  const order = state.doneOrder
  if (order === undefined || order.length === 0) return [...tasks]
  const rank = new Map<string, number>()
  order.forEach((id, index) => { rank.set(id, index) })
  return tasks
    .map((task, index) => ({ task, index, rank: rank.get(task.id) ?? -1 }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(entry => entry.task)
}

/** `run.json`: mount and mirror metadata, not task state. */
export interface RunMeta {
  readonly version: typeof GUARD_SCHEMA_VERSION
  readonly runId: string
  readonly sessionId?: string
  /** Reserved for the optional epoch fallback; starts at 1. */
  readonly epoch: number
  readonly goalHash: string
  readonly phase: 'creating' | 'ready' | 'running' | 'aborted' | 'setup-failed'
  readonly setup: {
    readonly goal: boolean
    readonly anchors: boolean
    readonly guard: boolean
    readonly firstMessage: boolean
    readonly failedStep?: 'goal' | 'anchors' | 'guard' | 'firstMessage'
    readonly errorMessage?: string
  }
  readonly mirror: {
    readonly mode: 'auto' | 'off'
    readonly provider?: 'github' | 'gitlab'
    readonly host?: string
    readonly issueNumber?: number
    readonly issueUrl?: string
    readonly reason?: string
    readonly lastError?: string
    readonly nextRetryAt?: number
  }
  readonly createdAt: number
  readonly updatedAt: number
}

export type ProbeSpec =
  | { readonly kind: 'file_exists'; readonly path: string }
  | { readonly kind: 'file_contains'; readonly path: string; readonly pattern: string; readonly flags?: string }
  | { readonly kind: 'grep'; readonly pattern: string; readonly paths: readonly string[]; readonly expect: 'match' | 'no_match' | { readonly minMatches: number } }
  | {
    readonly kind: 'number_gte'
    readonly source: { readonly type: 'file'; readonly path: string; readonly pattern?: string } | { readonly type: 'command'; readonly cmd: string; readonly args: readonly string[] }
    readonly threshold: number
  }
  | { readonly kind: 'command'; readonly cmd: string; readonly args: readonly string[]; readonly cwd?: string; readonly expectExit?: number }
  | { readonly kind: 'scan'; readonly scanKind: 'doclinks' | 'todo-tbd' | 'inline-code-path'; readonly paths?: readonly string[] }

export interface ProbeDef {
  readonly id: string
  readonly taskId: string
  readonly weight: 'light' | 'heavy'
  readonly spec: ProbeSpec
  readonly timeoutMs?: number
  readonly enabled: boolean
}

/** `probes/<TASK-ID>.json`. */
export interface TaskProbeFile {
  readonly version: typeof GUARD_SCHEMA_VERSION
  readonly taskId: string
  /** When the dialog's first step confirmed the command list. */
  readonly confirmedAt: number
  readonly probes: readonly ProbeDef[]
}

/** `requests/scope-<task>-<n>.json`. */
export interface ScopeChangeRequest {
  readonly version: typeof GUARD_SCHEMA_VERSION
  readonly id: string
  readonly taskId: string
  readonly requestedBy: 'main' | 'subagent'
  readonly reason: string
  readonly addedPaths: readonly string[]
  readonly evidenceIds: readonly string[]
  /** True when a sensitive path or `scopeApprovedCount >= 3` forces human approval. */
  readonly requiresHuman: boolean
  readonly status: 'pending' | 'approved' | 'rejected'
  readonly decidedBy?: 'adjudicator' | 'human'
  readonly decisionNote?: string
  readonly createdAt: number
  readonly decidedAt?: number
}

/** `state.jsonl`: one event per line, append-only. */
export type GuardEvent =
  | { readonly type: 'run.created'; readonly at: number; readonly runId: string; readonly goalHash: string }
  | { readonly type: 'setup.failed'; readonly at: number; readonly step: string; readonly message: string }
  | { readonly type: 'anchor.truncated'; readonly at: number; readonly side: 'head' | 'tail'; readonly originalBytes: number; readonly keptBytes: number }
  | { readonly type: 'task.started'; readonly at: number; readonly taskId: string; readonly baseCommit?: string }
  | { readonly type: 'probe.run'; readonly at: number; readonly taskId: string; readonly probeId: string; readonly weight: 'light' | 'heavy'; readonly result: ProbeResult; readonly sha256?: string }
  | { readonly type: 'eval.done'; readonly at: number; readonly taskId: string; readonly verdict: Verdict; readonly model: string; readonly latencyMs: number; readonly reason?: string }
  | { readonly type: 'eval.unavailable'; readonly at: number; readonly taskId: string; readonly reason: string; readonly model: string; readonly latencyMs: number; readonly streak: number }
  | { readonly type: 'progress.eval'; readonly at: number; readonly taskId: string; readonly verdict: ProgressEvalVerdict; readonly signature: string; readonly exemptionCount: number }
  | { readonly type: 'scope.violation'; readonly at: number; readonly taskId: string; readonly paths: readonly string[]; readonly enforcement: EnforcementMode }
  | { readonly type: 'scope.request' | 'scope.approved' | 'scope.rejected'; readonly at: number; readonly requestId: string; readonly taskId: string; readonly paths: readonly string[]; readonly by?: 'adjudicator' | 'human' }
  | { readonly type: 'commit.done'; readonly at: number; readonly taskId: string; readonly sha: string; readonly checkpointRef: string }
  | { readonly type: 'commit.failed'; readonly at: number; readonly taskId: string; readonly message: string }
  | { readonly type: 'task.done'; readonly at: number; readonly taskId: string; readonly checkpointRef: string }
  | { readonly type: 'task.blocked'; readonly at: number; readonly taskId: string; readonly reason: string }
  | { readonly type: 'task.unblocked'; readonly at: number; readonly taskId: string; readonly note: string }
  | { readonly type: 'review.milestone'; readonly at: number; readonly round: number; readonly verdict: Verdict }
  | { readonly type: 'run.blocked'; readonly at: number; readonly reason: string }
  | { readonly type: 'task.reopened'; readonly at: number; readonly taskId: string; readonly reason: string }
  | {
    readonly type: 'checkpoint.rollback'
    readonly at: number
    readonly targetRef: string
    readonly by: 'human'
    /** Commit subjects reverted by the rollback. */
    readonly reverted?: readonly string[]
    readonly reopened?: readonly string[]
    /** Paths brought back from the checkpoint. */
    readonly restored?: readonly string[]
    /** Paths that did not exist at the checkpoint and were deleted. */
    readonly removed?: readonly string[]
    /** Paths left untouched (outside the workspace, or the checkout failed). */
    readonly skipped?: readonly string[]
  }
  | { readonly type: 'mirror.synced' | 'mirror.skipped' | 'mirror.failed'; readonly at: number; readonly reason?: string }
