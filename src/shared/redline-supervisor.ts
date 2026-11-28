/** Read-only summary of one Goal Supervisor run, shared by the host and the panel. */

export interface SupervisorTaskSummary {
  readonly id: string
  readonly title: string
  readonly status: 'TODO' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED'
  readonly blockedReason?: string
}

export interface SupervisorSummary {
  readonly runId: string
  readonly phase: 'creating' | 'ready' | 'running' | 'completed' | 'aborted' | 'setup-failed'
  readonly status: 'active' | 'paused' | 'completed' | 'blocked'
  readonly goal: string
  readonly parallel: number
  readonly enforcement: 'warn-only' | 'enforce'
  readonly done: number
  readonly total: number
  readonly currentTaskId?: string
  readonly tasks: readonly SupervisorTaskSummary[]
  readonly pendingRequests: number
  /** Set when the plugin asked the host goal to stop because nothing could run. */
  readonly blockedReason?: string
  /** A mount step that failed, rendered as `step: message`. */
  readonly setupError?: string
  readonly mirror?: {
    readonly issueUrl?: string
    readonly reason?: string
    readonly lastError?: string
  }
  readonly updatedAt: number
  /**
   * False when the run was read from disk because the session's agent is not
   * live. The card still shows, but nothing here can be acted on.
   */
  readonly agentLive?: boolean
  /**
   * The branch an isolated run committed to. The merge is the human's job:
   * nothing here merges it back, so the card has to name it.
   */
  readonly worktreeBranch?: string
  /** Configured dedicated evaluator route (`provider/model`), omitted when following main session. */
  readonly evaluatorModel?: string
  /** Configured evaluator fallback route. */
  readonly evaluatorFallbackModel?: string
  /** Execution route frozen at run creation. */
  readonly executorModel?: string
  /** Execution fallback route. */
  readonly executorFallbackModel?: string
  /** Execution route the session uses right now (differs after a switch). */
  readonly activeExecutorModel?: string
  /** Observation-only visual witness is enabled for this run. */
  readonly visualWitness?: boolean
  /**
   * Result of re-arming the host goal after a `guard.continue` / `guard.switch`
   * with `resume`. False means the ledger is open but nothing drives the next
   * turn, which the card must not hide.
   */
  readonly goalResumed?: boolean
  /**
   * A `guard.switch` reply can carry this when the model switch committed but
   * the resume half was refused (the run is still blocked). It is NOT a failed
   * switch, so the card must not label it as one.
   */
  readonly resumeRefused?: string
  /**
   * The HOST goal behind this run, read live from `GoalService` whenever the
   * session's agent is attached.
   *
   * The ledger and the host goal can disagree: a round-limit block or a
   * session-start disarm stops the driver while `tasks.json` still says
   * `active`. Showing only the ledger is what made a dead session render as
   * "running" forever, so the card reads this instead of guessing from
   * timestamps.
   */
  readonly hostGoal?: {
    readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
    readonly activation: 'armed' | 'disarmed'
    readonly roundsStarted?: number
    readonly maxGoalRounds?: number
    readonly blockedCode?: string
    readonly blockedMessage?: string
  }
}

/**
 * Split one task-table row on `|` while keeping a separator that sits inside a
 * quoted or backticked span.
 *
 * Acceptance text routinely carries a Go/diff regex such as
 * `go test ./internal/... -run "Playbook|WalkForward"`. A naive `split('|')`
 * shifts every later column one to the left, so the scope lands in the
 * dependency slot and the run is refused with an error naming a path that was
 * never a task id. Escaped `\|` is likewise literal.
 *
 * A quote only opens a span when its closing partner exists later in the row, so
 * a lone apostrophe in prose cannot swallow the remaining columns.
 */
export function splitTaskRow(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let quote: string | null = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index)
    if (quote !== null) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '\\' && line.charAt(index + 1) === '|') {
      current += '|'
      index += 1
      continue
    }
    if (char === '`' || char === '"' || char === '\'') {
      if (line.indexOf(char, index + 1) >= 0) {
        quote = char
        current += char
        continue
      }
      current += char
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}
