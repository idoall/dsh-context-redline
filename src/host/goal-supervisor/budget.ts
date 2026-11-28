/**
 * Round budget for a long supervised run.
 *
 * The host's `GoalService` defaults `maxGoalRounds` to 256. A real project
 * (15 tasks, several attempts each, plus the audits between them) can exhaust
 * that before the work is done — and a round-limit block is NOT a supervisor
 * block, so the ledger would keep saying "active" while nothing drives the
 * next turn. Long runs must survive thousands of rounds without a human.
 *
 * The plugin therefore arms the goal with its own budget and rolls it forward
 * while the run is making progress. A run that is spinning makes no progress,
 * so it never earns an extension: the idle limiter blocks it first.
 */

/** Base cap handed to `goals.create`; a bigger task table raises it. */
export const GOAL_ROUNDS_INITIAL = 2000

/** How much one roll-over adds. */
export const GOAL_ROUNDS_STEP = 1000

/** Extend once the remaining budget drops to (or below) this. */
export const GOAL_ROUNDS_HEADROOM = 200

/** Pure: the cap to arm a fresh goal with. */
export function initialGoalRounds(tasks: number): number {
  const scaled = Number.isFinite(tasks) && tasks > 0 ? tasks * 200 : 0
  return Math.max(GOAL_ROUNDS_INITIAL, scaled)
}

/** Pure: the next cap after one roll-over, always strictly larger than `current`. */
export function nextGoalRounds(current: number): number {
  const base = Number.isFinite(current) && current > 0 ? current : 0
  return Math.max(base + GOAL_ROUNDS_STEP, GOAL_ROUNDS_INITIAL)
}

/** The subset of the host `GoalView` this decision needs. */
export interface GoalBudgetView {
  readonly roundsStarted?: number
  readonly maxGoalRounds?: number
}

/** `null` when the host did not report both numbers (older host, or no goal). */
export function goalRounds(view: GoalBudgetView | undefined): { started: number; max: number } | null {
  if (view === undefined) return null
  const started = view.roundsStarted
  const max = view.maxGoalRounds
  if (typeof started !== 'number' || typeof max !== 'number') return null
  return { started, max }
}

/** True when the goal has used every round it was given. */
export function goalExhausted(view: GoalBudgetView | undefined): boolean {
  const rounds = goalRounds(view)
  return rounds !== null && rounds.started >= rounds.max
}

/** True when the remaining rounds are at or below the headroom. */
export function goalBudgetLow(view: GoalBudgetView | undefined): boolean {
  const rounds = goalRounds(view)
  return rounds !== null && rounds.max - rounds.started <= GOAL_ROUNDS_HEADROOM
}
