import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, test } from 'vitest'
import { prepareGuardRun } from '../../src/host/goal-supervisor/create'
import { rollbackRun } from '../../src/host/goal-supervisor/rollback'
import { changedPaths } from '../../src/host/goal-supervisor/git'
import type { GuardState, RunMeta } from '../../src/host/goal-supervisor/schema'

const run = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guard-rollback-'))
  roots.push(root)
  await run('git', ['init', '-q'], { cwd: root })
  await run('git', ['config', 'user.email', 'guard@test'], { cwd: root })
  await run('git', ['config', 'user.name', 'guard'], { cwd: root })
  await writeFile(join(root, 'a.ts'), 'base')
  await run('git', ['add', '.'], { cwd: root })
  await run('git', ['commit', '-qm', 'base'], { cwd: root })
  return root
}

async function prepared(cwd: string, scopes: Record<string, readonly string[]> = { T1: ['a.ts'], T2: ['b.ts'] }): Promise<string> {
  const result = await prepareGuardRun(cwd, {
    goal: 'g', acceptance: 'a', discipline: 'd',
    tasks: 'T1 | 一 | 通过\nT2 | 二 | 通过',
    scopes,
  })
  const store = join(cwd, 'docs', 'guard', result.runId)
  const meta = JSON.parse(await readFile(join(store, 'run.json'), 'utf8')) as RunMeta
  await writeFile(join(store, 'run.json'), JSON.stringify({ ...meta, sessionId: 'session-owner' }, null, 2), 'utf8')
  return result.runId
}

/** Write a ledger state directly: the unit under test only reads it. */
async function writeState(cwd: string, runId: string, patch: Partial<GuardState>): Promise<void> {
  const path = join(cwd, 'docs', 'guard', runId, 'tasks.json')
  const state = JSON.parse(await readFile(path, 'utf8')) as GuardState
  await writeFile(path, JSON.stringify({ ...state, ...patch }, null, 2), 'utf8')
}

describe('goal-supervisor rollback', () => {
  test('reopens a blocked task and restores its dirty scope to the checkpoint', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    // T1 already committed and tagged; T2 is dirty and blocked.
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'guard: T1 DONE'], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'half-finished')
    await writeFile(join(cwd, 'b.ts'), 'in-progress')
    await writeState(cwd, runId, {
      tasks: [
        { ...(JSON.parse(await readFile(join(cwd, 'docs', 'guard', runId, 'tasks.json'), 'utf8')) as GuardState).tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1` },
        { ...(JSON.parse(await readFile(join(cwd, 'docs', 'guard', runId, 'tasks.json'), 'utf8')) as GuardState).tasks[1]!, status: 'BLOCKED', blocked: { reason: '卡住', next: '回退', remainingCandidates: [], at: Date.now() } },
      ],
      status: 'active',
    })

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.report.taskId, 'T2')
    assert.equal(outcome.report.targetRef, `guard/${runId}/T1`)
    assert.deepEqual(outcome.report.restored, [])
    assert.deepEqual(outcome.report.removed, ['b.ts'], 'a file the checkpoint never had is removed')
    assert.ok(outcome.report.evidencePath !== undefined, 'the dirty work is kept as a patch')
    await assert.rejects(() => readFile(join(cwd, 'b.ts'), 'utf8'))

    const state = JSON.parse(await readFile(join(cwd, 'docs', 'guard', runId, 'tasks.json'), 'utf8')) as GuardState
    const reopened = state.tasks.find(task => task.id === 'T2')
    assert.equal(reopened?.status, 'TODO')
    assert.equal(reopened?.blocked, undefined)
    assert.equal(reopened?.checkpointRef, undefined)
    assert.ok(reopened?.evidence.some(item => item.path.includes('patch')))
    assert.equal(state.tasks.find(task => task.id === 'T1')?.status, 'DONE', 'a finished task stays done')
    assert.equal(state.goalBlocked, undefined)
    assert.equal(state.status, 'active')

    const events = (await readFile(join(cwd, 'docs', 'guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; skipped?: string[] })
    const rollbackEvent = events.find(event => event.type === 'checkpoint.rollback')
    assert.ok(rollbackEvent !== undefined)
  })

  test('a dirty edit inside the task scope is restored, not deleted', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'guard: T1 DONE'], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'broken edit')
    const baseCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit },
        { ...state.tasks[1]!, status: 'TODO' },
      ],
      activeTaskIds: [],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    // Nothing is in flight, so the last DONE task is reopened: its scope goes back
    // to its own base commit and its checkpoint tag is removed for the retry.
    assert.equal(outcome.report.taskId, 'T1')
    assert.deepEqual(outcome.report.restored, ['a.ts'])
    assert.deepEqual(outcome.report.deletedTags, [`guard/${runId}/T1`])
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'base')
  })

  test('a second rollback does not flip the previous revert', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'guard: T1 DONE'], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    await writeFile(join(cwd, 'late.ts'), 'after checkpoint')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'late commit'], { cwd })
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1` },
        { ...state.tasks[1]!, status: 'BLOCKED', blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } },
      ],
    }, null, 2), 'utf8')

    const first = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.deepEqual(first.report.reverted, ['late commit'])
    // A second click reopens the previous task; it must never re-apply what the
    // first rollback removed.
    const second = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(second.ok, true)
    assert.deepEqual(second.report.reverted, [], 'the second rollback reverts nothing')
    const log = await run('git', ['log', '--oneline'], { cwd })
    assert.equal(log.stdout.split('\n').filter(line => /^Revert/.test(line) || /Revert "/.test(line)).length, 1)
    await assert.rejects(() => readFile(join(cwd, 'late.ts'), 'utf8'), 'the reverted file never comes back')
  })

  test('refuses a run owned by another session and a run without a ledger', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const foreign = await rollbackRun({ cwd, runId, sessionId: 'someone-else' })
    assert.equal(foreign.ok, false)
    if (!foreign.ok) assert.match(foreign.reason, /does not belong/)
    const missing = await rollbackRun({ cwd, runId: 'no-such-run', sessionId: 'session-owner' })
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.match(missing.reason, /missing/)
  })

  test('a run with everything still TODO has nothing to roll back', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.match(outcome.reason, /nothing to roll back/)
  })

  test('a task with no declared scope deletes nothing and says so', async () => {
    const cwd = await repo()
    // No scopes at all: the task table gives every task an empty scope, which
    // `pathInScope` treats as "everything". A rollback must not act on that.
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 通过',
    })).runId
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [{ ...state.tasks[0]!, status: 'BLOCKED', blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } }],
    }, null, 2), 'utf8')
    await writeFile(join(cwd, 'user-notes.md'), 'mine')
    await writeFile(join(cwd, 'a.ts'), 'half done')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.report.partial, true)
    assert.deepEqual(outcome.report.restored, [])
    assert.deepEqual(outcome.report.removed, [])
    assert.ok(outcome.report.skipped.includes('user-notes.md') || outcome.report.skipped.includes('a.ts'))
    // Both files are still on disk with their content.
    assert.equal(await readFile(join(cwd, 'user-notes.md'), 'utf8'), 'mine')
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'half done')
  })

  test('files that were already dirty when the run started are left alone', async () => {
    const cwd = await repo()
    // Prepare while `scratch.md` is already dirty: it becomes part of baselineDirty.
    await writeFile(join(cwd, 'scratch.md'), 'pre-existing')
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 通过\nT2 | 二 | 通过',
      scopes: { T1: ['a.ts'], T2: ['a.ts'] },
    })).runId
    await run('git', ['add', 'a.ts', 'scratch.md'], { cwd })
    await run('git', ['commit', '-qm', 'guard: T1 DONE'], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    await writeFile(join(cwd, 'scratch.md'), 'still mine')
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baselineDirty: { 'scratch.md': 'placeholder' } },
        { ...state.tasks[1]!, status: 'BLOCKED', scope: ['a.ts'], baselineDirty: { 'scratch.md': 'placeholder' }, blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } },
      ],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    // `scratch.md` is outside T2's scope, so it is reported as skipped and kept.
    assert.ok(outcome.report.skipped.includes('scratch.md'))
    assert.equal(await readFile(join(cwd, 'scratch.md'), 'utf8'), 'still mine')
  })

  test('reopening a DONE task restores the files it committed', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const baseCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    // T1 ships a real change and commits it: the worktree is clean afterwards.
    await writeFile(join(cwd, 'a.ts'), 'T1 work')
    await mkdir(join(cwd, 'docs/guard', runId), { recursive: true })
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T1 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    assert.deepEqual(await changedPaths(cwd, `docs/guard/${runId}`), [], 'the tree is clean before the rollback')
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit },
        { ...state.tasks[1]!, status: 'TODO' },
      ],
      activeTaskIds: [],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.report.taskId, 'T1')
    assert.deepEqual(outcome.report.restored, ['a.ts'], 'the committed file goes back to its base commit')
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'base')
    assert.deepEqual(outcome.report.deletedTags, [`guard/${runId}/T1`])
  })

  test('a file that is byte-identical to the run-creation baseline is never touched', async () => {
    const cwd = await repo()
    // `scratch.md` is dirty BEFORE the run exists, so it lands in baselineDirty.
    await writeFile(join(cwd, 'scratch.md'), 'mine')
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 通过',
      // The task's scope covers the file: only the baseline can save it.
      scopes: { T1: ['scratch.md'] },
    })).runId
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.ok(Object.hasOwn(state.tasks[0]!.baselineDirty, 'scratch.md'), 'the baseline recorded it')
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [{ ...state.tasks[0]!, status: 'BLOCKED', blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } }],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.ok(outcome.report.skipped.includes('scratch.md'), 'reported as skipped, not restored')
    assert.deepEqual(outcome.report.restored, [])
    assert.equal(await readFile(join(cwd, 'scratch.md'), 'utf8'), 'mine', 'the user file survives')
  })

  test('the reopened task does not re-trigger an old completion declaration', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const notesPath = join(cwd, 'docs', 'guard', runId, 'tasks', 'T1', 'notes.md')
    const notes = '# T1\n\n## 完成声明\n\n早先写下的\n'
    await writeFile(notesPath, notes, 'utf8')
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [{ ...state.tasks[0]!, status: 'BLOCKED', blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } }],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true)
    const after = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(after.tasks[0]?.lastEvalOffset, notes.length, 'the offset sits at the end of notes.md')
  })

  test('a first task that committed its own work is restored, not left in HEAD', async () => {
    const cwd = await repo()
    // No scopes: T1 is the first task and declares `a.ts` inline.
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 通过 | a.ts',
    })).runId
    const baseCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [{ ...state.tasks[0]!, status: 'BLOCKED', baseCommit, blocked: { reason: 'scope 外改动', next: '回退', remainingCandidates: [], at: Date.now() } }],
    }, null, 2), 'utf8')
    // A subagent ran `git commit` itself: the worktree is clean, HEAD moved.
    await writeFile(join(cwd, 'a.ts'), 'reckless work')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', 'subagent did this'], { cwd })
    assert.deepEqual(await changedPaths(cwd, `docs/guard/${runId}`), [], 'nothing is dirty')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.deepEqual(outcome.report.reverted, ['subagent did this'], 'the reckless commit is undone')
    assert.deepEqual(outcome.report.restored, ['a.ts'])
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'base')
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.ok(!status.stdout.includes('a.ts'), 'the tree is back at the base content')
  })

  test('a second rollback still reopens the task after the first one reverted', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'guard: T1 DONE'], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    const blocked = { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() }
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1` },
        { ...state.tasks[1]!, status: 'BLOCKED', blocked },
      ],
    }, null, 2), 'utf8')
    // A subagent commit lands after the checkpoint, then the task blocks.
    await writeFile(join(cwd, 'late.ts'), 'late')
    await run('git', ['add', 'late.ts'], { cwd })
    await run('git', ['commit', '-qm', 'late commit'], { cwd })

    const first = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(first.ok, true)
    // The retry blocks again with fresh dirt: the second rollback must not fail
    // just because the first one already created a revert commit.
    const afterFirst = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...afterFirst,
      tasks: afterFirst.tasks.map(task => task.id === 'T2'
        ? { ...task, status: 'BLOCKED', blocked }
        : task),
    }, null, 2), 'utf8')
    await writeFile(join(cwd, 'b.ts'), 'dirty again')
    const second = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(second.ok, true, second.ok ? '' : second.reason)
    if (!second.ok) return
    assert.deepEqual(second.report.reverted, [], 'the earlier revert is not flipped')
    const reopened = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(reopened.tasks.find(task => task.id === 'T2')?.status, 'TODO')
  })

  test('several subagent commits are reverted newest-first and all disappear', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 通过 | a.ts',
    })).runId
    const baseCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [{ ...state.tasks[0]!, status: 'BLOCKED', baseCommit, blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } }],
    }, null, 2), 'utf8')
    // Two commits touching the same file: reverting them in the WRONG order
    // conflicts, so this pins the newest-first contract.
    await writeFile(join(cwd, 'a.ts'), 'one')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', 'step one'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'one two')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', 'step two'], { cwd })

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    if (!outcome.ok) return
    assert.deepEqual(outcome.report.reverted, ['step two', 'step one'], 'newest first')
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'base')
  })

  test('reopening a first DONE task does not pin its base commit to the undone commit', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 通过 | a.ts',
    })).runId
    const baseCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    // T1 already shipped 'bad' and was tagged, then the ledger says DONE.
    await writeFile(join(cwd, 'a.ts'), 'bad')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T1 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [{ ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit }],
      status: 'completed',
    }, null, 2), 'utf8')

    // Reopen it: the file goes back to base and the tag is gone.
    const first = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(first.ok, true)
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'base')
    const reopened = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(reopened.tasks[0]?.baseCommit, baseCommit, 'the original base commit is kept')
    assert.equal(reopened.tasks[0]?.status, 'TODO')

  })

  test('a rollback with a missing checkpoint tag never deletes the scoped file', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'tracked')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过 | a.ts\nT2 | 二 | 通过 | a.ts',
    })).runId
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    // The tag was deleted by hand (or never created): the ledger still names it.
    const blocked = { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() }
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1` },
        { ...state.tasks[1]!, status: 'BLOCKED', scope: ['a.ts'], blocked },
      ],
    }, null, 2), 'utf8')
    // Dirty the file so `scoped` really contains it: without that, the test
    // would pass even with the hasRef guard removed.
    await writeFile(join(cwd, 'a.ts'), 'changed')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    assert.ok(existsSync(join(cwd, 'a.ts')), 'the tracked file is not deleted')
    if (!outcome.ok) return
    assert.deepEqual(outcome.report.removed, [])
  })


  test('a task blocked at the attempt cap gets a clean retry after rollback', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过\nT2 | 二 | 通过 | a.ts',
    })).runId
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    const attempt = (index: number, signature: string): Record<string, unknown> => ({
      index, at: Date.now(), signature, failureFingerprint: signature, probeVector: {}, evidenceIds: [],
    })
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1` },
        {
          ...state.tasks[1]!, status: 'BLOCKED', scope: ['a.ts'],
          attempts: [attempt(50, 'probe:P1')],
          blocked: { reason: '单任务尝试达到 50 次上限', next: '回退', remainingCandidates: [], at: Date.now() },
        },
      ],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    const reopened = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(reopened.tasks[1]?.status, 'TODO')
    assert.deepEqual(reopened.tasks[1]?.attempts, [], 'the exhausted history is not carried into the retry')
    assert.deepEqual(reopened.tasks[1]?.probeResults, {})
  })

  test('a blocked task is rolled back before a healthy sibling', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过 | a.ts\nT2 | 二 | 通过 | b.ts',
      parallel: 2,
    })).runId
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'IN_PROGRESS', scope: ['a.ts'] },
        { ...state.tasks[1]!, status: 'BLOCKED', scope: ['b.ts'], blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } },
      ],
      activeTaskIds: ['T1'],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.report.taskId, 'T2', 'the card was showing T2')
    const after = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(after.tasks[1]?.status, 'TODO')
    assert.equal(after.tasks[0]?.status, 'IN_PROGRESS', 'the healthy sibling is untouched')
  })
})

// Round-7 fix verification (round 8): the retry after a failed revert must only
// restore the DIRTY scoped paths, never the committed ones.
describe('goal-supervisor rollback retry', () => {
  test('a merge failure is not retryable and restores nothing', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    // T1 DONE at c1, so the rollback has a real checkpoint to return to.
    await writeFile(join(cwd, 'a.ts'), 'T1 work')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', 'T1 DONE'], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c1 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim()
    // A merge inside T2's range makes `git revert <range>` fail for a reason no
    // scope restore can fix, so the second attempt fails too — which is exactly
    // the state where the caller must know WHICH files were already restored.
    await run('git', ['checkout', '-q', '-b', 'feature', c1], { cwd })
    await writeFile(join(cwd, 'b.ts'), 'feature')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', 'feature adds b.ts'], { cwd })
    await run('git', ['checkout', '-q', branch], { cwd })
    await writeFile(join(cwd, 'committed.ts'), 'main')
    await run('git', ['add', 'committed.ts'], { cwd })
    await run('git', ['commit', '-qm', 'main adds committed.ts'], { cwd })
    await run('git', ['merge', '--no-ff', 'feature', '-m', 'merge feature', '-q'], { cwd })

    // T2 is in flight with a dirty in-scope file. `committed.ts` is in scope too,
    // but it is committed and clean: restoring it would silently delete it.
    await writeFile(join(cwd, 'b.ts'), 'dirty')
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit: c1 },
        { ...state.tasks[1]!, status: 'IN_PROGRESS', baseCommit: c1, scope: ['b.ts', 'committed.ts'] },
      ],
      activeTaskIds: ['T2'],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    // A merge commit is a NON-retryable revert failure. The old `retryable()`
    // matched the `git revert failed:` wrapper prefix, so it restored (deleted)
    // the dirty scoped path first and only then reported the conflict.
    assert.match(outcome.reason, /is a merge but no -m option|CONFLICT|could not revert/i, outcome.reason)
    assert.equal(await readFile(join(cwd, 'b.ts'), 'utf8'), 'dirty', 'a non-retryable failure touches no scoped file')
    assert.equal(await readFile(join(cwd, 'committed.ts'), 'utf8'), 'main', 'a committed clean path is never restored')
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.ok(!status.stdout.includes('committed.ts'), `the committed path stays clean: ${status.stdout}`)
  })

  test('a dirty worktree blocks the revert once: restoring the dirty scope lets the retry succeed', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    // T1 checkpoint, then a sibling commit that rewrites `a.ts`.
    await writeFile(join(cwd, 'a.ts'), 'T1 work')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', 'T1 DONE'], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c1 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await writeFile(join(cwd, 'a.ts'), 'late rewrite')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', 'late rewrite'], { cwd })

    // T2 is in flight on the same file and left a dirty edit in it, so the first
    // `git revert` refuses ("local changes would be overwritten"). Restoring that
    // one dirty scoped path is the retry path, and it must be the only one.
    await writeFile(join(cwd, 'a.ts'), 'half-finished')
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit: c1 },
        { ...state.tasks[1]!, status: 'IN_PROGRESS', baseCommit: c1, scope: ['a.ts'] },
      ],
      activeTaskIds: ['T2'],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    if (!outcome.ok) return
    assert.deepEqual(outcome.report.reverted, ['late rewrite'], 'the retry reverts the sibling commit')
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'T1 work', 'the dirty edit is gone and the tree matches the checkpoint')
    assert.equal(outcome.report.partial, false)
  })

  test('a non-retryable failure touches no file at all', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    // T1's checkpoint, then a hand-written revert plus newer work: the range is
    // mixed and can only be resolved by a human.
    await writeFile(join(cwd, 'a.ts'), 'T1 work')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', 'T1 DONE'], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c1 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await writeFile(join(cwd, 'late.ts'), 'late')
    await run('git', ['add', 'late.ts'], { cwd })
    await run('git', ['commit', '-qm', 'late commit'], { cwd })
    const lateSha = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await run('git', ['revert', '--no-edit', lateSha], { cwd })
    await writeFile(join(cwd, 'after.ts'), 'after the revert')
    await run('git', ['add', 'after.ts'], { cwd })
    await run('git', ['commit', '-qm', 'newer work'], { cwd })
    // A dirty in-scope file would make the old code "restore then retry".
    await writeFile(join(cwd, 'b.ts'), 'dirty')
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit: c1 },
        { ...state.tasks[1]!, status: 'IN_PROGRESS', baseCommit: c1, scope: ['b.ts'] },
      ],
      activeTaskIds: ['T2'],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.match(outcome.reason, /mixes a rollback with newer work/, outcome.reason)
    assert.equal(await readFile(join(cwd, 'b.ts'), 'utf8'), 'dirty', 'a non-retryable failure restores nothing')
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.ok(status.stdout.includes('b.ts'), 'the dirty file is still there')
  })

  test('reopening clears the attempt history and probe results that blocked the task', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    const attempts = Array.from({ length: 50 }, (_, index) => ({
      index, at: 1, signature: `sig-${index}`, probeVector: { P1: 'fail' as const }, evidenceIds: [],
    }))
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1` },
        {
          ...state.tasks[1]!, status: 'BLOCKED',
          attempts,
          probeResults: { P1: { result: 'fail' as const, at: 1 } },
          lastEvalAt: 1, lastEvalScopeHash: 'old-hash',
          blocked: { reason: '达到 50 次上限', next: '回退', remainingCandidates: [], at: Date.now() },
        },
      ],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    if (!outcome.ok) return
    assert.equal(outcome.report.taskId, 'T2')
    const after = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    const reopened = after.tasks.find(task => task.id === 'T2')
    assert.deepEqual(reopened?.attempts, [], 'the attempt budget is fresh again')
    assert.deepEqual(reopened?.probeResults, {}, 'stale probe verdicts do not survive the reopen')
    assert.equal(reopened?.lastEvalScopeHash, undefined)
  })

  test('a BLOCKED task wins over an IN_PROGRESS sibling', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'BLOCKED', blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } },
        { ...state.tasks[1]!, status: 'IN_PROGRESS' },
      ],
      activeTaskIds: ['T2'],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    if (!outcome.ok) return
    assert.equal(outcome.report.taskId, 'T1', 'the blocked card is the one the user sees')
  })

  test('a hand-deleted checkpoint tag falls back to the task base commit', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const baseCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await writeFile(join(cwd, 'a.ts'), 'T1 work')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', 'T1 DONE'], { cwd })
    // The tag is never created (or was deleted by hand): the ref is missing but
    // the ledger still names it.
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit },
        { ...state.tasks[1]!, status: 'TODO' },
      ],
      activeTaskIds: [],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    if (!outcome.ok) return
    assert.equal(outcome.report.taskId, 'T1')
    assert.equal(outcome.report.targetRef, baseCommit, 'the base commit is a usable fallback')
    assert.deepEqual(outcome.report.restored, ['a.ts'])
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'base')
  })
})

// Round-9 P0 fixes: `doneOrder` is the completion order, not the task table.
// A parallel batch that finishes out of order used to make the rollback revert a
// HEALTHY sibling's commit, or reopen the wrong task and silently restore nothing.
describe('goal-supervisor rollback completion order', () => {
  /** T2 commits b.ts FIRST, T1 commits a.ts SECOND: table order is T1, T2. */
  async function outOfOrder(cwd: string, runId: string): Promise<void> {
    await writeFile(join(cwd, 'b.ts'), 'T2 work')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T2 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T2`, '-m', 'T2'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'T1 work')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T1 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
  }

  async function parallelRun(): Promise<{ cwd: string; runId: string; tasksPath: string }> {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过 | a.ts\nT2 | 二 | 通过 | b.ts\nT3 | 三 | 通过 | c.ts',
      parallel: 3,
      scopes: { T1: ['a.ts'], T2: ['b.ts'], T3: ['c.ts'] },
    })).runId
    await outOfOrder(cwd, runId)
    return { cwd, runId, tasksPath: join(cwd, 'docs', 'guard', runId, 'tasks.json') }
  }

  test('an in-flight rollback reverts only commits above the NEWEST checkpoint', async () => {
    const { cwd, runId, tasksPath } = await parallelRun()
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1` },
        { ...state.tasks[1]!, status: 'DONE', checkpointRef: `guard/${runId}/T2` },
        { ...state.tasks[2]!, status: 'BLOCKED', scope: ['c.ts'], blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } },
      ],
      activeTaskIds: [],
      doneOrder: ['T2', 'T1'],
    }, null, 2), 'utf8')
    await writeFile(join(cwd, 'c.ts'), 'half done')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    if (!outcome.ok) return
    assert.equal(outcome.report.taskId, 'T3')
    assert.deepEqual(outcome.report.reverted, [], 'nothing sits above T1, the actually-newest checkpoint')
    // The old code took T2 (last table row) as newest and reverted T1's commit:
    // `a.ts` vanished while its ledger row still said DONE.
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'T1 work', 'the healthy sibling commit survives')
    assert.equal(await readFile(join(cwd, 'b.ts'), 'utf8'), 'T2 work')
    await assert.rejects(() => readFile(join(cwd, 'c.ts'), 'utf8'), 'the blocked task keeps no half-finished file')
    const after = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(after.tasks[0]?.status, 'DONE')
    assert.equal(after.tasks[1]?.status, 'DONE')
    assert.equal(after.tasks[2]?.status, 'TODO')
  })

  test('reopening a DONE task picks the newest completion and restores its own work', async () => {
    const { cwd, runId, tasksPath } = await parallelRun()
    const base = (await run('git', ['rev-parse', 'HEAD~2'], { cwd })).stdout.trim()
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', baseCommit: base, checkpointRef: `guard/${runId}/T1` },
        { ...state.tasks[1]!, status: 'DONE', baseCommit: base, checkpointRef: `guard/${runId}/T2` },
        { ...state.tasks[2]!, status: 'TODO', scope: ['c.ts'], baseCommit: base },
      ],
      activeTaskIds: [],
      doneOrder: ['T2', 'T1'],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    if (!outcome.ok) return
    // T1 completed LAST, even though it is the first table row.
    assert.equal(outcome.report.taskId, 'T1')
    assert.deepEqual(outcome.report.restored, ['a.ts'], 'its own committed work comes back as a dirty restore')
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'base')
    assert.deepEqual(outcome.report.deletedTags, [`guard/${runId}/T1`])
    const after = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.deepEqual(after.doneOrder, ['T2'], 'a reopened task is no longer a completed one')
    assert.equal(after.tasks[1]?.status, 'DONE', 'the earlier finisher is untouched')
  })

  test('a legacy ledger without doneOrder never range-reverts across a sibling checkpoint', async () => {
    const { cwd, runId, tasksPath } = await parallelRun()
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1` },
        { ...state.tasks[1]!, status: 'DONE', checkpointRef: `guard/${runId}/T2` },
        { ...state.tasks[2]!, status: 'BLOCKED', scope: ['c.ts'], blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } },
      ],
      activeTaskIds: [],
      // Written before `doneOrder` existed: table order now guesses wrongly.
      doneOrder: undefined,
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.match(outcome.reason, /检查点提交/, outcome.reason)
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'T1 work', 'no healthy DONE commit is reverted')
  })
})

// Round-9 P0-3: a rollback residue used to be a bare content hash, so once the
// worktree matched again it excused a genuine out-of-scope deletion, never
// converged, and could resurrect old code through a later checkpoint.
describe('goal-supervisor rollback residue binding', () => {
  test('a rollback that leaves nothing dirty clears the old residue instead of merging it', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const base = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'guard: T1 DONE'], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1` },
        {
          ...state.tasks[1]!, status: 'BLOCKED', baseCommit: base, scope: ['b.ts'],
          rollbackResidue: { 'b.ts': { headBlob: 'absent', worktreeHash: 'deleted' } },
          blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() },
        },
      ],
      activeTaskIds: [],
      doneOrder: ['T1'],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    if (!outcome.ok) return
    const after = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(after.tasks[1]?.rollbackResidue, undefined, 'a clean retry does not inherit a stale record')
  })

  test('a reopened task restores to its own base, never to the checkpoint that inherited its old code', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const c0 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    // T1 DONE, then T2 DONE on top.
    await writeFile(join(cwd, 'a.ts'), 'T1 work')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T1 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c1 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await writeFile(join(cwd, 'b.ts'), 'T2-BAD')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T2 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T2`, '-m', 'T2'], { cwd })
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', baseCommit: c0, checkpointRef: `guard/${runId}/T1` },
        { ...state.tasks[1]!, status: 'DONE', baseCommit: c1, checkpointRef: `guard/${runId}/T2` },
      ],
      activeTaskIds: [],
      doneOrder: ['T1', 'T2'],
    }, null, 2), 'utf8')

    // Reopen T2 (its bad b.ts is restored to c1, where it did not exist).
    const first = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(first.ok, true, first.ok ? '' : first.reason)
    // Reopen T1 too, then let a retry commit T1's work again. That commit's tree
    // still contains the old T2-BAD blob (it rides on T2's commit).
    const second = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(second.ok, true, second.ok ? '' : second.reason)
    assert.equal(second.ok ? second.report.taskId : '', 'T1')
    await writeFile(join(cwd, 'a.ts'), 'T1 retry')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T1 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c3 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const reopened = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...reopened,
      tasks: [
        { ...reopened.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit: c0, reopenedAt: Date.now() },
        { ...reopened.tasks[1]!, status: 'BLOCKED', baseCommit: c1, reopenedAt: Date.now(), blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } },
      ],
      activeTaskIds: [],
      doneOrder: ['T1'],
    }, null, 2), 'utf8')

    // T2's retry blocks; rolling it back must NOT check out T1's checkpoint (c3),
    // whose tree still carries T2-BAD.
    const third = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(third.ok, true, third.ok ? '' : third.reason)
    if (!third.ok) return
    await assert.rejects(() => readFile(join(cwd, 'b.ts'), 'utf8'), 'the stale T2-BAD blob is not resurrected')
    assert.ok(third.report.targetRef !== c3, `restore base predates the inherited commit: ${third.report.targetRef}`)
  })
})

// Round-10 fixes. Three separate rollback guarantees are pinned here:
//   - a FOREIGN range revert is not atomic, and a partial attempt must resume
//     with only the commits it has not reverted (the old code saw the revert on
//     top and reported success while the rest of the range survived forever);
//   - a stale checkpoint must be chosen per PATH: an inherited blob of the
//     reopened task is discarded, a sibling's newer commit on the same path is
//     kept;
//   - a legacy ledger without `doneOrder` must never silently reopen the wrong
//     task when its checkpoint is older than a sibling's.
describe('goal-supervisor partial revert and stale checkpoints', () => {
  test('a partially reverted foreign range resumes with the commits it has not reverted', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 通过 | a.ts',
      scopes: { T1: ['a.ts'] },
    })).runId
    const base = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [{ ...state.tasks[0]!, status: 'BLOCKED', baseCommit: base, blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } }],
    }, null, 2), 'utf8')
    // `subagent-1` wrote the in-scope file AND an out-of-scope one; `subagent-2`
    // added another file. Newest first, `subagent-2` reverts cleanly, then the
    // dirty in-scope file blocks `subagent-1`.
    await writeFile(join(cwd, 'a.ts'), 'one')
    await writeFile(join(cwd, 'outside.ts'), 'escaped scope')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'subagent-1'], { cwd })
    await writeFile(join(cwd, 'x.ts'), 'x')
    await run('git', ['add', 'x.ts'], { cwd })
    await run('git', ['commit', '-qm', 'subagent-2'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'dirty retry work')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    if (!outcome.ok) return
    assert.deepEqual(outcome.report.reverted, ['subagent-2', 'subagent-1'], 'the retry continues the ORIGINAL list')
    // The out-of-scope file the first commit introduced must be gone from history
    // and from the tree: the old code reported `reverted: []` and left it behind,
    // so every retry was blocked again forever.
    await assert.rejects(() => readFile(join(cwd, 'outside.ts'), 'utf8'))
    const atHead = await run('git', ['cat-file', '-e', 'HEAD:outside.ts'], { cwd }).then(() => true, () => false)
    assert.equal(atHead, false, 'outside.ts is not in HEAD any more')
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'base', 'the in-scope file is back at its base')
  })

  test('a later click resumes only the commits a previous partial revert left behind', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 通过 | a.ts',
      scopes: { T1: ['a.ts'] },
    })).runId
    const base = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [{ ...state.tasks[0]!, status: 'BLOCKED', baseCommit: base, blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } }],
    }, null, 2), 'utf8')
    await writeFile(join(cwd, 'a.ts'), 'one')
    await writeFile(join(cwd, 'outside.ts'), 'escaped scope')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'subagent-1'], { cwd })
    const first = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await writeFile(join(cwd, 'x.ts'), 'x')
    await run('git', ['add', 'x.ts'], { cwd })
    await run('git', ['commit', '-qm', 'subagent-2'], { cwd })
    // A previous click already reverted `subagent-2` and then died on a dirty
    // file. A new click must undo the REMAINING commit, never flip that revert
    // back nor report success while `outside.ts` survives in history.
    await run('git', ['revert', '--no-edit', 'HEAD'], { cwd })

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    if (!outcome.ok) return
    assert.deepEqual(outcome.report.reverted, ['subagent-1'], 'only the outstanding commit is reverted')
    const log = await run('git', ['log', '--oneline'], { cwd })
    const reverts = log.stdout.split('\n').filter(line => /Revert "/.test(line))
    assert.equal(reverts.length, 2, 'the earlier revert is kept, not flipped')
    await assert.rejects(() => readFile(join(cwd, 'outside.ts'), 'utf8'))
    const outsideAtHead = await run('git', ['cat-file', '-e', `HEAD:outside.ts`], { cwd }).then(() => true, () => false)
    assert.equal(outsideAtHead, false)
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'base')
    assert.ok(first !== '', 'fixture sanity')
  })

  test('reopening a task after its retry never resurrects an inherited abandoned blob', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const c0 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    // T1 DONE, then T2 DONE on top.
    await writeFile(join(cwd, 'a.ts'), 'T1 work')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T1 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c1 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await writeFile(join(cwd, 'b.ts'), 'T2-BAD')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T2 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T2`, '-m', 'T2'], { cwd })
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const readState = async (): Promise<GuardState> => JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    /** Replace the task rows / completion order, keeping every other live field. */
    const writeState = async (patch: Partial<GuardState>): Promise<void> => {
      await writeFile(tasksPath, JSON.stringify({ ...(await readState()), ...patch }, null, 2), 'utf8')
    }
    const state = await readState()
    await writeState({
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', baseCommit: c0, checkpointRef: `guard/${runId}/T1` },
        { ...state.tasks[1]!, status: 'DONE', baseCommit: c1, checkpointRef: `guard/${runId}/T2` },
      ],
      activeTaskIds: [],
      doneOrder: ['T1', 'T2'],
    })

    // Reopen T2 (b.ts goes back to c1, where it did not exist), then T1.
    const first = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(first.ok, true, first.ok ? '' : first.reason)
    await assert.rejects(() => readFile(join(cwd, 'b.ts'), 'utf8'))
    const second = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(second.ok, true, second.ok ? '' : second.reason)

    // T1 retries and commits on top of T2's old commit, so its tree still carries
    // the abandoned `T2-BAD` blob; T2 retries and commits `T2-v2`.
    await writeFile(join(cwd, 'a.ts'), 'T1 retry')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T1 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c3 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await writeFile(join(cwd, 'b.ts'), 'T2-v2')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T2 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T2`, '-m', 'T2'], { cwd })
    const reopened = await readState()
    await writeState({
      tasks: [
        { ...reopened.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit: c0, reopenedAt: Date.now() },
        { ...reopened.tasks[1]!, status: 'DONE', checkpointRef: `guard/${runId}/T2`, baseCommit: c1, reopenedAt: Date.now() },
      ],
      activeTaskIds: [],
      doneOrder: ['T1', 'T2'],
    })

    // Reopen T2 again: its previous checkpoint (c3, T1's retry) inherits T2-BAD.
    // The per-path rule must send b.ts back to T2's OWN base (c1), not to c3.
    const third = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(third.ok, true, third.ok ? '' : third.reason)
    if (!third.ok) return
    assert.equal(third.report.taskId, 'T2')
    await assert.rejects(() => readFile(join(cwd, 'b.ts'), 'utf8'), 'the abandoned T2-BAD blob stays gone')
    assert.notEqual(third.report.targetRef, c3, 'the inherited checkpoint is not the restore base')
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'T1 retry', 'T1 keeps its completed work')
  })

  test('a shared-scope retry keeps the sibling commit that landed after its own base', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过 | a.ts\nT2 | 二 | 通过 | a.ts | T1',
      scopes: { T1: ['a.ts'], T2: ['a.ts'] },
    })).runId
    const c0 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await writeFile(join(cwd, 'a.ts'), 'T1-v1')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T1 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c1 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await writeFile(join(cwd, 'a.ts'), 'T2 work')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T2 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T2`, '-m', 'T2'], { cwd })
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', baseCommit: c0, checkpointRef: `guard/${runId}/T1` },
        { ...state.tasks[1]!, status: 'DONE', baseCommit: c1, checkpointRef: `guard/${runId}/T2` },
      ],
      activeTaskIds: [],
      doneOrder: ['T1', 'T2'],
    }, null, 2), 'utf8')

    // Reopen T2 (it was reopened before, so `reopenedAt` is permanent), then let
    // T1 retry and commit a newer version of the SHARED path.
    const first = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(first.ok, true, first.ok ? '' : first.reason)
    assert.equal(first.ok ? first.report.taskId : '', 'T2')
    const afterT2 = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(afterT2.ok, true, afterT2.ok ? '' : afterT2.reason)
    assert.equal(afterT2.ok ? afterT2.report.taskId : '', 'T1')
    await writeFile(join(cwd, 'a.ts'), 'T1-v2')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T1 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c3 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()

    // T2's retry fails with a dirty edit on the shared path; rolling it back must
    // not restore T2's stale base (c1) over T1's freshly committed `T1-v2`.
    const reopened = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...reopened,
      tasks: reopened.tasks.map(task => task.id === 'T2'
        ? { ...task, status: 'BLOCKED', scope: ['a.ts'], baseCommit: c1, blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } }
        : { ...task, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit: c0 }),
      activeTaskIds: [],
      doneOrder: ['T1'],
    }, null, 2), 'utf8')
    await writeFile(join(cwd, 'a.ts'), 'T2 retry dirty')

    const third = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(third.ok, true, third.ok ? '' : third.reason)
    if (!third.ok) return
    assert.equal(third.report.taskId, 'T2')
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'T1-v2', 'the newer sibling commit is preserved')
    assert.notEqual(third.report.targetRef, c1, 'the stale base is not the restore base for this path')
    assert.equal(
      third.report.targetRef, `guard/${runId}/T1`,
      `the path is restored to the newest sibling checkpoint (head ${c3})`,
    )
  })

  test('a legacy ledger never reopens a task whose checkpoint an older sibling completion sits above', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const base = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    // Out-of-order completion: T2 commits first, T1 second. Without `doneOrder`
    // the table order (T1, T2) guesses T2 as "newest", whose checkpoint is NOT
    // the one above T1's.
    await writeFile(join(cwd, 'b.ts'), 'T2 work')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T2 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T2`, '-m', 'T2'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'T1 work')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T1 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', baseCommit: base, checkpointRef: `guard/${runId}/T1` },
        { ...state.tasks[1]!, status: 'DONE', baseCommit: base, checkpointRef: `guard/${runId}/T2` },
      ],
      activeTaskIds: [],
      // Written before `doneOrder` existed.
      doneOrder: undefined,
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, false, 'silently reopening the wrong task is worse than refusing')
    if (outcome.ok) return
    assert.match(outcome.reason, /检查点提交/, outcome.reason)
    // Nothing was deleted or restored behind the operator's back.
    assert.equal(await readFile(join(cwd, 'b.ts'), 'utf8'), 'T2 work')
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'T1 work')
    const tags = await run('git', ['tag', '-l', `guard/${runId}/*`], { cwd })
    assert.match(tags.stdout, /T1/)
    assert.match(tags.stdout, /T2/)
  })

  test('a duplicated doneOrder id ranks by its LAST completion', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const base = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    // History order: T1's commit, then T2's (so T2 is genuinely newest).
    await writeFile(join(cwd, 'a.ts'), 'T1 work')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T1 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c1 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await writeFile(join(cwd, 'b.ts'), 'T2 work')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T2 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T2`, '-m', 'T2'], { cwd })
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', baseCommit: base, checkpointRef: `guard/${runId}/T1` },
        { ...state.tasks[1]!, status: 'DONE', baseCommit: c1, checkpointRef: `guard/${runId}/T2` },
      ],
      activeTaskIds: [],
      // T2 completed, then T1, then T2 again (a reopen/re-complete cycle that the
      // milestone order kept appending). The LAST occurrence is the newest.
      doneOrder: ['T2', 'T1', 'T2'],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    if (!outcome.ok) return
    assert.equal(outcome.report.taskId, 'T2', 'the last completion of T2 is the newest checkpoint')
    assert.deepEqual(outcome.report.deletedTags, [`guard/${runId}/T2`])
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'T1 work', 'the sibling stays untouched')
  })

  test('a staged new file does not keep the foreign revert blocked forever', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 通过 | a.ts',
      scopes: { T1: ['a.ts', 'brandnew.ts'] },
    })).runId
    const base = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [{ ...state.tasks[0]!, status: 'BLOCKED', baseCommit: base, blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } }],
    }, null, 2), 'utf8')
    await writeFile(join(cwd, 'a.ts'), 'subagent work')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', 'subagent-1'], { cwd })
    // A staged ADDITION (its path is not in HEAD) makes `git revert` refuse with
    // "your local changes would be overwritten by revert"; `restoreTrackedToHead`
    // used to skip it and the retry failed identically every time.
    await writeFile(join(cwd, 'brandnew.ts'), 'staged new')
    await run('git', ['add', 'brandnew.ts'], { cwd })

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    if (!outcome.ok) return
    assert.deepEqual(outcome.report.reverted, ['subagent-1'], 'unstaging the addition unlocks the retry')
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'base')
    assert.ok(outcome.report.evidencePath !== undefined, 'the discarded work is still backed up')
  })

  // Round-11 P1-4: after a subagent COMMITTED a deletion, the worktree can still
  // recreate the same name. `restoreTrackedToHead` only reset the index (HEAD has
  // no entry), left the file on disk, and the second `git revert` — which must
  // check the deleted file back out — failed identically on every click.
  test('a committed deletion plus a re-created file no longer deadlocks the retry', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 通过 | f.ts',
      scopes: { T1: ['f.ts'] },
    })).runId
    const base = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [{ ...state.tasks[0]!, status: 'BLOCKED', baseCommit: base, blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } }],
    }, null, 2), 'utf8')
    // f.ts did not exist at the base: a subagent shipped it and then committed
    // its deletion, so HEAD has no f.ts while the task is still measured at base.
    await writeFile(join(cwd, 'f.ts'), 'shipped')
    await run('git', ['add', 'f.ts'], { cwd })
    await run('git', ['commit', '-qm', 'ships f.ts'], { cwd })
    await run('git', ['rm', '--quiet', 'f.ts'], { cwd })
    await run('git', ['commit', '-qm', 'deletes f.ts'], { cwd })
    // The scope is re-created in the worktree (a staged addition). The revert that
    // restores the deletion collides with it twice: first as local changes, then —
    // after the index reset — as an untracked file that checkout refuses to
    // overwrite.
    await writeFile(join(cwd, 'f.ts'), 'recreated')
    await run('git', ['add', 'f.ts'], { cwd })

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    if (!outcome.ok) return
    assert.deepEqual(outcome.report.reverted, ['deletes f.ts', 'ships f.ts'], 'both foreign commits are undone')
    assert.equal(existsSync(join(cwd, 'f.ts')), false, 'the base has no f.ts, so the re-created copy is gone')
    // The guard ledger stays untracked in this fixture; only f.ts matters here.
    const status = await run('git', ['status', '--porcelain', '--', 'f.ts'], { cwd })
    assert.equal(status.stdout.trim(), '', `the path is not left dirty or staged: ${status.stdout}`)
    assert.ok(outcome.report.evidencePath !== undefined, 'the discarded copy is backed up before it is deleted')
  })

  // Round-12 P1-2: the retry reset used a single global "a patch exists" boolean,
  // so one unrelated dirty file made every HEAD-absent scoped copy look backed
  // up. A dangling symlink was skipped by `access()`/`stat()` (they FOLLOW the
  // link), was absent from the patch, and was still deleted — while the failure
  // text claimed it had been saved. Coverage is now per path.
  test('a failed retry only deletes HEAD-absent copies the patch really covers', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    // T1 ships both a.ts and x.ts.
    await writeFile(join(cwd, 'x.ts'), 'x base')
    await writeFile(join(cwd, 'a.ts'), 'T1 work')
    await run('git', ['add', 'a.ts', 'x.ts'], { cwd })
    await run('git', ['commit', '-qm', 'T1 DONE'], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c1 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    // Two foreign commits above the checkpoint. The OLDER one deletes x.ts and
    // the NEWER one rewrites a.ts, so the newest revert hits the dirty a.ts first.
    await run('git', ['rm', '--quiet', 'x.ts'], { cwd })
    await run('git', ['commit', '-qm', 'F1 deletes x'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'F2 work')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', 'F2 rewrites a'], { cwd })
    // T2's half-finished edit blocks the first revert; the dangling symlink is a
    // HEAD-absent dirty copy that only exists in the worktree.
    await writeFile(join(cwd, 'a.ts'), 'half-finished')
    await symlink('/nonexistent/guard-target', join(cwd, 'f.ts'))
    // x.ts is re-created as an UNTRACKED file outside T2's scope: it makes the
    // older revert fail AFTER a.ts was reset, so the retry fails a second time.
    await writeFile(join(cwd, 'x.ts'), 'untracked x')
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit: c1 },
        { ...state.tasks[1]!, status: 'IN_PROGRESS', baseCommit: c1, scope: ['a.ts', 'f.ts'] },
      ],
      activeTaskIds: ['T2'],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, false, 'the second revert still fails on the untracked x.ts')
    if (outcome.ok) return
    const patchPath = join(cwd, 'docs', 'guard', runId, 'tasks', 'T2', 'evidence', 'blocked-0.patch')
    const patchText = await readFile(patchPath, 'utf8')
    assert.match(patchText, /f\.ts/, 'the dangling symlink is part of the backup')
    assert.match(patchText, /\/nonexistent\/guard-target/, 'its link target is recorded')
    assert.equal(existsSync(join(cwd, 'f.ts')), false, 'the covered copy is removed')
    assert.match(outcome.reason, /1 个 HEAD 中不存在的脏副本已移除/)
    assert.doesNotMatch(outcome.reason, /没有备份，未删除/, 'the covered copy is not reported as refused')
  })

  // Round-13 P2-1: `dirtyScoped` mixes three different outcomes. The failure text
  // used to call ALL of them "reset to HEAD" and then add "no backup, not deleted"
  // for a path it had just refused — a self-contradiction the operator cannot act
  // on. `a.ts` is genuinely reset here, while the untracked nested repository
  // `sub/` has no patch coverage and must stay on disk.
  test('a retry failure never calls a refused path reset to HEAD', async () => {
    const cwd = await repo()
    // x.ts is part of the base so a foreign commit can delete it: reverting that
    // commit must check x.ts back out, which the untracked copy below blocks.
    await writeFile(join(cwd, 'x.ts'), 'x base')
    await run('git', ['add', 'x.ts'], { cwd })
    await run('git', ['commit', '-qm', 'add x'], { cwd })
    const runId = await prepared(cwd, { T1: ['a.ts'], T2: ['a.ts', 'sub'] })
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'guard: T1 DONE'], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c1 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    // Foreign commit: deletes x.ts.
    await run('git', ['rm', '--quiet', 'x.ts'], { cwd })
    await run('git', ['commit', '-qm', 'F1 deletes x'], { cwd })
    // The recreated x.ts is untracked and OUTSIDE T2's scope, so every revert that
    // restores the deletion fails while the message must not mention it.
    await writeFile(join(cwd, 'x.ts'), 'untracked x')
    // A dirty scoped TRACKED path: this one really is reset to HEAD.
    await writeFile(join(cwd, 'a.ts'), 'half-finished')
    // A scoped path that only exists as a nested repository: git reports it as the
    // untracked directory `sub/`, `git add -N` refuses it and the captured patch
    // cannot cover it, so `restoreTrackedToHead` must refuse to delete it.
    await mkdir(join(cwd, 'sub'))
    await run('git', ['init', '-q'], { cwd: join(cwd, 'sub') })
    await writeFile(join(cwd, 'sub', 'child.ts'), 'nested')
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit: c1 },
        { ...state.tasks[1]!, status: 'IN_PROGRESS', baseCommit: c1, scope: ['a.ts', 'sub'] },
      ],
      activeTaskIds: ['T2'],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, false, 'the untracked x.ts keeps the revert blocked')
    if (outcome.ok) return
    assert.match(outcome.reason, /sub\/ 没有备份，未删除/, outcome.reason)
    assert.match(outcome.reason, /1 个已追踪脏文件已重置到 HEAD/, `only the tracked path was reset: ${outcome.reason}`)
    assert.doesNotMatch(outcome.reason, /2 个脏文件已重置到 HEAD/, `the refused path is not counted as reset: ${outcome.reason}`)
    // The refused path is untouched; the reset one really went back to HEAD.
    assert.equal(existsSync(join(cwd, 'sub', '.git')), true, 'the refused nested repository is still on disk')
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'base', 'the tracked dirty file was reset')
  })

  // Round-14 P2-1: a scoped path that exists at HEAD but whose `checkout HEAD`
  // fails (a locked file, a permission error) used to be silently dropped — not
  // reset, not removed, not refused — and the retry failure text then claimed
  // there was nothing dirty to reset while the dirty copy was still on disk.
  // Only that one checkout is intercepted, so the test does not depend on file
  // permissions or on running as a non-root user.
  test('a checkout failure is reported as a failed reset', async () => {
    const cwd = await repo()
    // x.ts is part of the base so a foreign commit can delete it: reverting that
    // commit must check x.ts back out, which the untracked copy below blocks.
    await writeFile(join(cwd, 'x.ts'), 'x base')
    await run('git', ['add', 'x.ts'], { cwd })
    await run('git', ['commit', '-qm', 'add x'], { cwd })
    const runId = await prepared(cwd, { T1: ['a.ts'], T2: ['a.ts'] })
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'guard: T1 DONE'], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c1 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await run('git', ['rm', '--quiet', 'x.ts'], { cwd })
    await run('git', ['commit', '-qm', 'F1 deletes x'], { cwd })
    // Out of scope, so the retry never touches it; it keeps the revert blocked.
    await writeFile(join(cwd, 'x.ts'), 'untracked x')
    // A dirty scoped TRACKED path: the retry tries to reset it.
    await writeFile(join(cwd, 'a.ts'), 'half-finished')
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit: c1 },
        { ...state.tasks[1]!, status: 'IN_PROGRESS', baseCommit: c1, scope: ['a.ts'] },
      ],
      activeTaskIds: ['T2'],
    }, null, 2), 'utf8')

    const realGit = (await run('sh', ['-c', 'command -v git'])).stdout.trim()
    assert.ok(realGit !== '', 'the real git binary is resolvable')
    const bin = await mkdtemp(join(tmpdir(), 'guard-fakebin-'))
    roots.push(bin)
    await writeFile(
      join(bin, 'git'),
      `#!/bin/sh\nif [ "$1" = "checkout" ] && [ "$2" = "HEAD" ] && [ "$3" = "--" ] && [ "$4" = "a.ts" ]; then\n  echo "simulated checkout failure" >&2\n  exit 1\nfi\nexec "${realGit}" "$@"\n`,
      'utf8',
    )
    await chmod(join(bin, 'git'), 0o755)
    const originalPath = process.env.PATH ?? ''
    let outcome: Awaited<ReturnType<typeof rollbackRun>>
    try {
      process.env.PATH = `${bin}:${originalPath}`
      outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    } finally {
      process.env.PATH = originalPath
    }
    assert.equal(outcome.ok, false, 'the untracked x.ts keeps the revert blocked')
    if (outcome.ok) return
    assert.match(outcome.reason, /a\.ts 重置到 HEAD 失败/, outcome.reason)
    assert.doesNotMatch(outcome.reason, /已重置到 HEAD/, `the failed checkout is not announced as a reset: ${outcome.reason}`)
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'half-finished', 'the dirty copy is untouched')
  })

  // Round-14 P2-1 (fallback wording): a dirty path whose HEAD-absent copy is
  // already gone leaves every outcome bucket empty (`AD`: staged addition, then
  // deleted from disk). The old fallback said there was NOTHING to reset, which
  // hid the fact that a dirty scoped path existed; the text now says no dirty
  // file was SUCCESSFULLY reset.
  test('the fallback text does not claim there was nothing dirty to reset', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'x.ts'), 'x base')
    await run('git', ['add', 'x.ts'], { cwd })
    await run('git', ['commit', '-qm', 'add x'], { cwd })
    const runId = await prepared(cwd, { T1: ['a.ts'], T2: ['a.ts', 'y.ts'] })
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'guard: T1 DONE'], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c1 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await run('git', ['rm', '--quiet', 'x.ts'], { cwd })
    await run('git', ['commit', '-qm', 'F1 deletes x'], { cwd })
    await writeFile(join(cwd, 'x.ts'), 'untracked x')
    // `AD y.ts`: staged addition deleted from disk again. `restoreTrackedToHead`
    // unstages it, finds no copy to remove and reports it in no bucket at all.
    await writeFile(join(cwd, 'y.ts'), 'staged then gone')
    await run('git', ['add', 'y.ts'], { cwd })
    await rm(join(cwd, 'y.ts'))
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit: c1 },
        { ...state.tasks[1]!, status: 'IN_PROGRESS', baseCommit: c1, scope: ['a.ts', 'y.ts'] },
      ],
      activeTaskIds: ['T2'],
    }, null, 2), 'utf8')

    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, false, 'the untracked x.ts keeps the revert blocked')
    if (outcome.ok) return
    assert.match(outcome.reason, /本任务 scope 内没有成功重置的脏文件/, outcome.reason)
    assert.doesNotMatch(outcome.reason, /没有可重置的脏文件/, `a dirty path did exist: ${outcome.reason}`)
  })
})
