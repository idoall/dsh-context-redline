/** Locate and summarize the supervisor run attached to one session. */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GuardState, RunMeta, ScopeChangeRequest } from './schema'
import type { SupervisorSummary } from '../../shared/redline-supervisor'
import { runningTasks } from './loop'

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** `provider/model (effort)` — the reasoning level is part of the identity here. */
function routeLabel(route: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }): string {
  return route.reasoningEffort === undefined
    ? `${route.provider}/${route.model}`
    : `${route.provider}/${route.model} (${route.reasoningEffort})`
}

function summaryOf(runId: string, state: GuardState, meta: RunMeta, pendingRequests: number): SupervisorSummary {
  const done = state.tasks.filter(task => task.status === 'DONE').length
  // Same rule as the tool guard and the anchors: only a task that can actually
  // run now. A `TODO` whose dependency is still blocked is not "current".
  const active = runningTasks(state).at(0)?.id
    ?? state.tasks.find(task => task.status === 'BLOCKED')?.id
  return {
    runId,
    phase: meta.phase,
    status: state.status,
    goal: state.goal,
    parallel: state.parallel,
    enforcement: state.enforcement,
    done,
    total: state.tasks.length,
    ...(active === undefined ? {} : { currentTaskId: active }),
    tasks: state.tasks.map(task => ({
      id: task.id,
      title: task.title,
      status: task.status,
      ...(task.blocked === undefined ? {} : { blockedReason: task.blocked.reason }),
    })),
    pendingRequests,
    ...(state.goalBlocked === undefined ? {} : { blockedReason: state.goalBlocked }),
    ...(meta.setup.errorMessage === undefined ? {} : { setupError: `${meta.setup.failedStep ?? 'setup'}: ${meta.setup.errorMessage}` }),
    ...(state.worktree.enabled && state.worktree.branch !== undefined
      ? { worktreeBranch: state.worktree.branch }
      : {}),
    ...(state.evaluator === undefined ? {} : { evaluatorModel: routeLabel(state.evaluator) }),
    // The fallback exists independently of the primary: a run that follows the
    // session model can still have a configured fallback, and hiding it would
    // hide the only "switch and continue" action the card can offer.
    ...(state.evaluatorFallback === undefined ? {} : { evaluatorFallbackModel: routeLabel(state.evaluatorFallback) }),
    ...(state.executor === undefined ? {} : { executorModel: routeLabel(state.executor) }),
    ...(state.executorFallback === undefined ? {} : { executorFallbackModel: routeLabel(state.executorFallback) }),
    ...(state.activeExecutor === undefined ? {} : { activeExecutorModel: routeLabel(state.activeExecutor) }),
    ...(state.visual?.enabled === true ? { visualWitness: true } : {}),
    ...(meta.mirror.issueUrl === undefined && meta.mirror.reason === undefined && meta.mirror.lastError === undefined
      ? {}
      : {
        mirror: {
          ...(meta.mirror.issueUrl === undefined ? {} : { issueUrl: meta.mirror.issueUrl }),
          ...(meta.mirror.reason === undefined ? {} : { reason: meta.mirror.reason }),
          ...(meta.mirror.lastError === undefined ? {} : { lastError: meta.mirror.lastError }),
        },
      }),
    updatedAt: state.updatedAt,
  }
}

/** Newest run whose `run.json` points at `sessionId`; `null` when none exists. */
/**
 * One remembered mount: enough to find the run directory again after the agent
 * is gone (tab closed, or the process restarted and has not re-attached yet).
 */
export interface SupervisorIndexEntry {
  readonly cwd: string
  readonly runId: string
  readonly updatedAt: number
}

/**
 * Record where this session's run lives, outside the repository.
 *
 * `guard.supervisor` needs a live agent to learn the workspace, so without this
 * an ordinary restart made the whole card vanish with no explanation — a run
 * whose ledger was sitting on disk the entire time.
 */
export async function rememberSupervisorRun(
  dir: string | null,
  entry: { readonly sessionId: string; readonly cwd: string; readonly runId: string },
): Promise<void> {
  if (dir === null) return
  try {
    await mkdir(dir, { recursive: true })
    const payload: SupervisorIndexEntry = { cwd: entry.cwd, runId: entry.runId, updatedAt: Date.now() }
    await writeFile(join(dir, `${entry.sessionId}.json`), JSON.stringify(payload), 'utf8')
  } catch {
    /* the index is a convenience, never a reason to fail a mount */
  }
}

/** Read back one remembered mount; `null` when this session never had one. */
export async function recallSupervisorRun(
  dir: string | null,
  sessionId: string,
): Promise<SupervisorIndexEntry | null> {
  if (dir === null) return null
  const entry = await readJson<SupervisorIndexEntry>(join(dir, `${sessionId}.json`))
  if (entry === null) return null
  return typeof entry.cwd === 'string' && entry.cwd !== '' && typeof entry.runId === 'string'
    ? entry
    : null
}

export async function findSupervisorRun(cwd: string, sessionId: string): Promise<SupervisorSummary | null> {
  let entries: string[] = []
  try { entries = await readdir(join(cwd, 'docs', 'guard')) } catch { return null }
  let best: SupervisorSummary | null = null
  for (const entry of entries) {
    const dir = join(cwd, 'docs', 'guard', entry)
    const meta = await readJson<RunMeta>(join(dir, 'run.json'))
    if (meta === null || meta.sessionId !== sessionId) continue
    const state = await readJson<GuardState>(join(dir, 'tasks.json'))
    if (state === null) continue
    let pendingRequests = 0
    try {
      const files = await readdir(join(dir, 'requests'))
      for (const file of files) {
        const request = await readJson<ScopeChangeRequest>(join(dir, 'requests', file))
        if (request?.status === 'pending') pendingRequests += 1
      }
    } catch { /* no requests directory */ }
    const summary = summaryOf(entry, state, meta, pendingRequests)
    if (best === null || summary.updatedAt > best.updatedAt) best = summary
  }
  return best
}
