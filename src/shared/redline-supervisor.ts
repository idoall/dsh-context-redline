/** Read-only summary of one Goal Supervisor run, shared by the host and the panel. */

export interface SupervisorTaskSummary {
  readonly id: string
  readonly title: string
  readonly status: 'TODO' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED'
  readonly blockedReason?: string
}

export interface SupervisorSummary {
  readonly runId: string
  readonly phase: 'creating' | 'ready' | 'running' | 'aborted' | 'setup-failed'
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
}
