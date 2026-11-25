import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import { findSupervisorRun, recallSupervisorRun, rememberSupervisorRun } from '../../src/host/goal-supervisor/status'
import { GUARD_SCHEMA_VERSION, type GuardState, type RunMeta } from '../../src/host/goal-supervisor/schema'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function state(runId: string, updatedAt: number): GuardState {
  return {
    version: GUARD_SCHEMA_VERSION, runId, goal: '目标', acceptance: '验收', discipline: '纪律', goalHash: 'h',
    tasks: [
      { id: 'T1', title: '一', status: 'DONE', scope: [], dependsOn: [], acceptance: [], probes: [], requiredProbes: [], probeResults: {}, evidence: [], attempts: [], scopeApprovedCount: 0, baselineDirty: {} },
      { id: 'T2', title: '二', status: 'BLOCKED', scope: [], dependsOn: [], acceptance: [], probes: [], requiredProbes: [], probeResults: {}, evidence: [], attempts: [], scopeApprovedCount: 0, baselineDirty: {}, blocked: { reason: '卡住', next: '换方法', remainingCandidates: [], at: 1 } },
    ],
    activeTaskIds: [], parallel: 1, enforcement: 'enforce', worktree: { enabled: false }, milestoneEvery: 3,
    status: 'active', createdAt: 1, updatedAt,
  }
}

function meta(sessionId: string, issueUrl?: string): RunMeta {
  return {
    version: GUARD_SCHEMA_VERSION, runId: 'r', sessionId, epoch: 1, goalHash: 'h', phase: 'running',
    setup: { goal: true, anchors: true, guard: true, firstMessage: true },
    mirror: { mode: 'auto', ...(issueUrl === undefined ? {} : { issueUrl }) },
    createdAt: 1, updatedAt: 1,
  }
}

async function run(cwd: string, runId: string, sessionId: string, updatedAt: number, issueUrl?: string): Promise<void> {
  const dir = join(cwd, 'docs', 'guard', runId)
  await mkdir(join(dir, 'requests'), { recursive: true })
  await writeFile(join(dir, 'tasks.json'), JSON.stringify(state(runId, updatedAt)), 'utf8')
  await writeFile(join(dir, 'run.json'), JSON.stringify(meta(sessionId, issueUrl)), 'utf8')
  await writeFile(join(dir, 'requests', 'scope-T2-a.json'), JSON.stringify({ version: 1, status: 'pending', taskId: 'T2' }), 'utf8')
}

describe('goal-supervisor status', () => {
  test('finds the newest run for the session and summarizes it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'guard-status-'))
    roots.push(cwd)
    await run(cwd, 'old', 'session-a', 1)
    await run(cwd, 'new', 'session-a', 5, 'https://github.com/o/r/issues/7')
    await run(cwd, 'other', 'session-b', 9)

    const summary = await findSupervisorRun(cwd, 'session-a')
    assert.equal(summary?.runId, 'new')
    assert.equal(summary?.done, 1)
    assert.equal(summary?.total, 2)
    assert.equal(summary?.currentTaskId, 'T2')
    assert.equal(summary?.tasks[1]?.blockedReason, '卡住')
    assert.equal(summary?.pendingRequests, 1)
    assert.equal(summary?.mirror?.issueUrl, 'https://github.com/o/r/issues/7')
  })

  test('returns null without a matching run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'guard-status-'))
    roots.push(cwd)
    assert.equal(await findSupervisorRun(cwd, 'session-none'), null)
  })
})

describe('goal-supervisor status current task', () => {
  test('prefers a runnable TODO over a blocked row earlier in the table', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'guard-status-current-'))
    roots.push(cwd)
    const dir = join(cwd, 'docs', 'guard')
    await mkdir(dir, { recursive: true })
    const state: GuardState = {
      version: GUARD_SCHEMA_VERSION, runId: 'r', goal: '目标', acceptance: '验收', discipline: '纪律', goalHash: 'h',
      tasks: [
        { id: 'T1', title: '一', status: 'DONE', scope: [], dependsOn: [], acceptance: [], probes: [], requiredProbes: [], probeResults: {}, evidence: [], attempts: [], scopeApprovedCount: 0, baselineDirty: {} },
        { id: 'T2', title: '二', status: 'BLOCKED', scope: [], dependsOn: [], acceptance: [], probes: [], requiredProbes: [], probeResults: {}, evidence: [], attempts: [], scopeApprovedCount: 0, baselineDirty: {}, blocked: { reason: '卡住', next: '换方法', remainingCandidates: [], at: 1 } },
        { id: 'T3', title: '三', status: 'TODO', scope: [], dependsOn: [], acceptance: [], probes: [], requiredProbes: [], probeResults: {}, evidence: [], attempts: [], scopeApprovedCount: 0, baselineDirty: {} },
      ],
      activeTaskIds: [], parallel: 1, enforcement: 'enforce', worktree: { enabled: false }, milestoneEvery: 3,
      status: 'active', createdAt: 1, updatedAt: 1,
    }
    await mkdir(join(dir, 'r'), { recursive: true })
    await writeFile(join(dir, 'r', 'tasks.json'), JSON.stringify(state), 'utf8')
    await writeFile(join(dir, 'r', 'run.json'), JSON.stringify(meta('session-current')), 'utf8')

    const summary = await findSupervisorRun(cwd, 'session-current')
    assert.equal(summary?.currentTaskId, 'T3', 'only a TODO whose dependencies are met can run now')
  })

  test('the mount index round-trips a run and survives a missing directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'guard-index-'))
    const dir = join(home, 'supervisor')
    await rememberSupervisorRun(dir, { sessionId: 'session-x', cwd: '/work/repo', runId: 'r1' })
    const entry = await recallSupervisorRun(dir, 'session-x')
    assert.equal(entry?.cwd, '/work/repo')
    assert.equal(entry?.runId, 'r1')
    // Unknown sessions and an unavailable home are both "no run", never a throw.
    assert.equal(await recallSupervisorRun(dir, 'session-other'), null)
    assert.equal(await recallSupervisorRun(null, 'session-x'), null)
    await rememberSupervisorRun(null, { sessionId: 'session-y', cwd: '/work', runId: 'r2' })
  })
})
