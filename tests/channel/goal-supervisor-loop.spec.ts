import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, test } from 'vitest'
import { markFirstMessageDelivered, prepareGuardRun } from '../../src/host/goal-supervisor/create'
import { attachSupervisor } from '../../src/host/goal-supervisor/attach'
import { IDLE_STALL_LIMIT, auditTask, auditTurn, canResume, imageCandidates, mergeRuntimeConfig, needsVisualEvidence, resumeBlockedRun } from '../../src/host/goal-supervisor/loop'
import { rollbackRun } from '../../src/host/goal-supervisor/rollback'
import { GuardStore } from '../../src/host/goal-supervisor/store'
import type { GuardState } from '../../src/host/goal-supervisor/schema'

const run = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guard-loop-'))
  roots.push(root)
  await run('git', ['init', '-q'], { cwd: root })
  await run('git', ['config', 'user.email', 'guard@test'], { cwd: root })
  await run('git', ['config', 'user.name', 'guard'], { cwd: root })
  await writeFile(join(root, 'README.md'), 'base')
  await run('git', ['add', '.'], { cwd: root })
  await run('git', ['commit', '-qm', 'base'], { cwd: root })
  return root
}

async function prepared(cwd: string, probePath = 'a.ts'): Promise<string> {
  const result = await prepareGuardRun(cwd, {
    goal: '把目标漂移修好', acceptance: '所有任务 DONE', discipline: '主会话只规划/分派/审查',
    tasks: 'T1 | 落盘 | 文件存在',
    probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: probePath }, enabled: true }],
  })
  return result.runId
}

async function preparedHeavy(cwd: string): Promise<string> {
  const result = await prepareGuardRun(cwd, {
    goal: '把目标漂移修好', acceptance: '所有任务 DONE', discipline: '主会话只规划/分派/审查',
    tasks: 'T1 | 落盘 | 文件存在',
    probes: [{ id: 'H1', taskId: 'T1', weight: 'heavy', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
  })
  return result.runId
}

async function preparedTwo(cwd: string): Promise<string> {
  const result = await prepareGuardRun(cwd, {
    goal: '把目标漂移修好', acceptance: '所有任务 DONE', discipline: '主会话只规划/分派/审查',
    tasks: 'T1 | 落盘 | 文件存在\nT2 | 收尾 | 文件存在',
    probes: [
      { id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true },
      { id: 'P2', taskId: 'T2', weight: 'light', spec: { kind: 'file_exists', path: 'b.ts' }, enabled: true },
    ],
  })
  return result.runId
}

interface LoopHooks {
  readonly complete?: () => void
  readonly block?: (reason: { code: string; message: string }) => void
  /** Verdict the per-task evaluation returns; defaults to `pass`. */
  readonly evaluate?: 'pass' | 'fail' | 'insufficient'
  /** Verdict the lightweight progress evaluation returns. */
  readonly progress?: 'advancing' | 'spinning' | 'scope_blocked'
  /** Host goal view reported by the `goals` service. */
  readonly goal?: {
    readonly phase?: 'active' | 'paused' | 'blocked' | 'complete'
    readonly activation?: 'armed' | 'disarmed'
    readonly roundsStarted?: number
    readonly maxGoalRounds?: number
  }
  /** Milestone reviewer verdicts, cycled per call; defaults to `pass`. */
  readonly reviewers?: readonly ('pass' | 'fail' | 'insufficient')[]
  /** Milestone adjudicator verdict when the reviewers split. */
  readonly adjudicate?: 'pass' | 'fail' | 'insufficient'
  /** Verbatim reviewer output, used to exercise the unparseable path. */
  readonly reviewerPayload?: string
}

function deps(cwd: string, runId: string, hooks: LoopHooks | (() => void) = {}) {
  const resolved: LoopHooks = typeof hooks === 'function' ? { complete: hooks } : hooks
  let progressCalls = 0
  let reviewerCalls = 0
  const goalEdits: { maxGoalRounds?: number }[] = []
  const state = {
    get progressCalls(): number { return progressCalls },
    get reviewerCalls(): number { return reviewerCalls },
    goalEdits,
  }
  const api = {
    views: state,
    ctx: {
      get(name: string) {
        if (name === 'llm') {
          return {
            prepareCall: async (config: Record<string, unknown>) => ({
              config: { provider: 'p', model: 'm', temperature: 0, maxTokens: config.maxTokens },
              stream: (options: { system?: string }) => (async function* () {
                const tasks = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
                const system = options?.system ?? ''
                let payload: string
                if (system.includes('里程碑裁决者')) {
                  payload = JSON.stringify({ verdict: resolved.adjudicate ?? 'fail', why: '裁决理由' })
                } else if (system.includes('里程碑独立审阅者')) {
                  const verdicts = resolved.reviewers ?? ['pass']
                  reviewerCalls += 1
                  payload = resolved.reviewerPayload
                    ?? JSON.stringify({ verdict: verdicts[(reviewerCalls - 1) % verdicts.length], reasons: ['审阅理由'], defects: [] })
                } else if (system.includes('进度审计员')) {
                  progressCalls += 1
                  payload = JSON.stringify({ verdict: resolved.progress ?? 'spinning', reason: 'same failure' })
                } else {
                  payload = JSON.stringify({
                    goal_hash: tasks.goalHash, verdict: resolved.evaluate ?? 'pass', criteria: [], violations: [], missing: [], correction: resolved.evaluate === undefined || resolved.evaluate === 'pass' ? '' : '未通过', next_action: 'continue',
                  })
                }
                yield { type: 'text-delta', index: 0, text: payload }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
              })(),
            }),
          }
        }
        if (name === 'goals') {
          return {
            get: () => ({
              id: 'goal-1',
              revision: 1,
              phase: resolved.goal?.phase ?? 'active',
              activation: resolved.goal?.activation ?? 'armed',
              roundsStarted: resolved.goal?.roundsStarted ?? 0,
              maxGoalRounds: resolved.goal?.maxGoalRounds ?? 2000,
            }),
            edit: (_agent: unknown, _ref: unknown, request: { maxGoalRounds?: number }) => {
              goalEdits.push(request)
              return { id: 'goal-1', revision: 2, phase: 'active', activation: 'armed', ...request }
            },
            complete: () => { resolved.complete?.() },
            block: (_agent: unknown, _ref: unknown, reason: { code: string; message: string }) => { resolved.block?.(reason) },
          }
        }
        if (name === 'sessionQuery') {
          return { readSession: async () => ({ events: [
            { seq: 1, type: 'tool/call', data: { name: 'subagent' } },
            { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
          ] }) }
        }
        return undefined
      },
    },
    agentCtx: { get: () => undefined, on: () => {} },
    agent: { id: 'session-supervisor', model: { current: () => ({ provider: 'p', model: 'm' }) } },
  }
  return api
}

describe('goal-supervisor loop', () => {
  test('a passing task is committed, tagged and completed', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')
    let completed = 0
    const attached = await attachSupervisor({ ...deps(cwd, runId, () => { completed += 1 }), cwd, runId } as never)
    await attached.handler()

    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'DONE')
    assert.equal(state.status, 'completed')
    assert.equal(state.tasks[0]?.checkpointRef, `guard/${runId}/T1`)
    assert.equal(completed, 1)

    const log = await run('git', ['log', '--oneline'], { cwd })
    assert.match(log.stdout, /T1 DONE/)
    const tags = await run('git', ['tag', '-l', `guard/${runId}/T1`], { cwd })
    assert.match(tags.stdout, /T1/)
  })

  test('parallel tasks with disjoint scopes both finish in one audit', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在\nT2 | 二 | 文件存在',
      parallel: 2,
      scopes: { T1: ['a.ts'], T2: ['b.ts'] },
      probes: [
        { id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true },
        { id: 'P2', taskId: 'T2', weight: 'light', spec: { kind: 'file_exists', path: 'b.ts' }, enabled: true },
      ],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'a')
    await writeFile(join(cwd, 'b.ts'), 'b')
    const attached = await attachSupervisor({ ...deps(cwd, runId, () => {}), cwd, runId } as never)
    await attached.handler()

    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'DONE')
    assert.equal(state.tasks[1]?.status, 'DONE')
    const log = await run('git', ['log', '--oneline'], { cwd })
    const guardCommits = log.stdout.split('\n').filter(line => /guard\(/.test(line))
    assert.equal(guardCommits.length, 2)
    const tags = await run('git', ['tag', '-l', `guard/${runId}/*`], { cwd })
    assert.equal(tags.stdout.trim().split('\n').length, 2)
  })

  test('a failing smoke command keeps the task open', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 文件存在',
      smokeCommand: { cmd: process.execPath, args: ['-e', 'process.exit(1)'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'a')
    const attached = await attachSupervisor({ ...deps(cwd, runId, () => {}), cwd, runId } as never)
    await attached.handler()
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.notEqual(state.tasks[0]?.status, 'DONE')
    assert.equal(state.tasks[0]?.probeResults.smoke?.result, 'fail')
    assert.ok((state.tasks[0]?.attempts.length ?? 0) >= 1)
  })

  test('three identical failing audits block the task', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd, 'missing.ts')
    const attached = await attachSupervisor({ ...deps(cwd, runId, () => {}), cwd, runId } as never)
    await attached.handler()
    await attached.handler()
    await attached.handler()

    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'BLOCKED')
    assert.match(state.tasks[0]?.blocked?.reason ?? '', /打转|same failure/)
  })

  test('a failed commit keeps the task IN_PROGRESS and records the failure', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')
    // A pre-commit hook that always fails is the cheapest honest commit failure.
    await writeFile(join(cwd, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()

    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'IN_PROGRESS')
    assert.equal(state.tasks[0]?.checkpointRef, undefined)
    assert.notEqual(state.status, 'completed')
    const tags = await run('git', ['tag', '-l', `guard/${runId}/*`], { cwd })
    assert.equal(tags.stdout.trim(), '')
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => (JSON.parse(line) as { type: string }).type)
    assert.ok(events.includes('commit.failed'), 'commit.failed recorded')
    assert.ok(events.includes('task.reopened'), 'task.reopened recorded')
  })

  test('a checkpoint tag that already exists blocks the task instead of lying about DONE', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')
    await run('git', ['tag', `guard/${runId}/T1`], { cwd })
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()

    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'BLOCKED')
    assert.match(state.tasks[0]?.blocked?.reason ?? '', /已存在/)
  })

  test('a completion declaration is not consumed while required probes still fail', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd, 'missing.ts')
    // The model declares completion, but the deterministic probe still fails.
    await writeFile(join(cwd, 'docs/guard', runId, 'tasks/T1/notes.md'), '# T1\n\n## 完成声明\n\n做完了\n', 'utf8')
    const before = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    const skeletonOffset = before.tasks[0]?.lastEvalOffset
    assert.equal(typeof skeletonOffset, 'number', 'the notes skeleton is excluded from the offset')
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.lastEvalOffset, skeletonOffset, 'the offset must not advance without an evaluation')
    assert.notEqual(state.tasks[0]?.status, 'DONE')
  })

  test('an advancing verdict resets the identical-failure streak', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd, 'missing.ts')
    const fake = deps(cwd, runId, { progress: 'advancing' })
    const attached = await attachSupervisor({ ...fake, cwd, runId } as never)
    for (let index = 0; index < 5; index += 1) await attached.handler()
    // Three identical failures trigger one evaluation; the exemption restarts the
    // count, so the next two turns must not burn another evaluation.
    assert.equal(fake.views.progressCalls, 1)
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.notEqual(state.tasks[0]?.status, 'BLOCKED')
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; verdict?: string })
    const advancing = events.filter(event => event.type === 'progress.eval' && event.verdict === 'advancing')
    assert.equal(advancing.length, 1)
  })

  test('the third identical failure blocks without a third evaluation once exemptions run out', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd, 'missing.ts')
    const fake = deps(cwd, runId, { progress: 'advancing' })
    const attached = await attachSupervisor({ ...fake, cwd, runId } as never)
    for (let index = 0; index < 9; index += 1) await attached.handler()
    assert.equal(fake.views.progressCalls, 2, 'exactly two exemptions, no third call')
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'BLOCKED')
    assert.match(state.tasks[0]?.blocked?.reason ?? '', /豁免 2 次/)
  })

  test('the 50-attempt ceiling is reachable even though the attempt window is 20', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd, 'missing.ts')
    const tasksPath = join(cwd, 'docs/guard', runId, 'tasks.json')
    const before = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    const filled = {
      ...before,
      tasks: before.tasks.map(task => ({
        ...task,
        attempts: Array.from({ length: 20 }, (_, index) => ({
          index: 30 + index, at: Date.now(), signature: `s-${index}`, probeVector: {}, evidenceIds: [],
        })),
      })),
    }
    await writeFile(tasksPath, JSON.stringify(filled, null, 2), 'utf8')
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'BLOCKED')
    assert.match(state.tasks[0]?.blocked?.reason ?? '', /50 次上限/)
  })

  test('a run with no runnable task asks the host goal to stop, once', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd, 'missing.ts')
    const tasksPath = join(cwd, 'docs/guard', runId, 'tasks.json')
    const before = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...before,
      tasks: before.tasks.map(task => ({ ...task, status: 'BLOCKED', blocked: { reason: '需要人工', next: '看看', remainingCandidates: [], at: Date.now() } })),
    }, null, 2), 'utf8')
    const reasons: { code: string; message: string }[] = []
    const attached = await attachSupervisor({ ...deps(cwd, runId, { block: reason => reasons.push(reason) }), cwd, runId } as never)
    await attached.handler()
    await attached.handler()
    assert.equal(reasons.length, 1, 'the block is idempotent')
    assert.equal(reasons[0]?.code, 'supervisor-blocked')
    assert.match(reasons[0]?.message ?? '', /T1/)
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.match(state.goalBlocked ?? '', /T1/)
    // The milestone block writes `status: 'blocked'`; a settle block that left the
    // run `active` made the card show "in progress + blocked" at the same time.
    assert.equal(state.status, 'blocked')
  })

  test('parallel tasks do not blame each other for their own scope in enforce mode', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在\nT2 | 二 | 文件存在',
      parallel: 2,
      enforcement: 'enforce',
      scopes: { T1: ['a.ts'], T2: ['b.ts'] },
      probes: [
        { id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true },
        { id: 'P2', taskId: 'T2', weight: 'light', spec: { kind: 'file_exists', path: 'b.ts' }, enabled: true },
      ],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'a')
    await writeFile(join(cwd, 'b.ts'), 'b')
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'DONE')
    assert.equal(state.tasks[1]?.status, 'DONE')
    const log = await run('git', ['log', '--oneline'], { cwd })
    const guardCommits = log.stdout.split('\n').filter(line => /guard\(/.test(line))
    assert.equal(guardCommits.length, 2)
  })

  test('a file that was already dirty before the run is not blamed on the task', async () => {
    const cwd = await repo()
    // Pre-existing local edit outside the task scope, present BEFORE prepare.
    await writeFile(join(cwd, 'scratch.md'), 'local notes')
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在',
      enforcement: 'enforce',
      scopes: { T1: ['src/**'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    })).runId
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src/a.ts'), 'ok')
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'DONE', 'the pre-existing dirty file is not an out-of-scope change')
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => (JSON.parse(line) as { type: string }).type)
    assert.ok(!events.includes('scope.violation'))
    // The scratch file is still there: a baseline entry is never committed or deleted.
    assert.equal(await readFile(join(cwd, 'scratch.md'), 'utf8'), 'local notes')
  })

  test('a failing probe writes its output into the task evidence directory', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 命令通过',
      probes: [{
        id: 'P1', taskId: 'T1', weight: 'light', enabled: true,
        spec: { kind: 'command', cmd: process.execPath, args: ['-e', 'console.error("boom"); process.exit(3)'] },
      }],
    })).runId
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    const evidence = state.tasks[0]?.evidence ?? []
    const probeEvidence = evidence.find(item => item.kind === 'probe')
    assert.ok(probeEvidence !== undefined, 'the failing probe kept its output')
    assert.equal(probeEvidence?.exitCode, 3)
    const text = await readFile(join(cwd, 'docs/guard', runId, probeEvidence?.path ?? ''), 'utf8')
    assert.match(text, /boom/)
  })

  test('a worktree run commits and tags inside the worktree, leaving the source checkout untouched', async () => {
    const cwd = await repo()
    const sourceBranch = (await run('git', ['branch', '--show-current'], { cwd })).stdout.trim()
    const sourceHead = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const prepared = await prepareGuardRun(cwd, {
      goal: 'worktree 模式', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 落盘 | 文件存在 | src/**',
      worktree: true,
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    })
    const worktree = prepared.worktreePath ?? ''
    assert.notEqual(worktree, '')
    await mkdir(join(worktree, 'src'), { recursive: true })
    await writeFile(join(worktree, 'src/a.ts'), 'export const a = 1\n')
    await writeFile(join(prepared.root, 'tasks/T1/notes.md'), '# T1\n\n## 完成声明\n\n完了\n', 'utf8')
    const attached = await attachSupervisor({ ...deps(worktree, prepared.runId, {}), cwd: worktree, runId: prepared.runId } as never)
    await attached.handler()

    const state = JSON.parse(await readFile(join(prepared.root, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'DONE')
    assert.equal((await run('git', ['branch', '--show-current'], { cwd: worktree })).stdout.trim(), `guard/${prepared.runId}`)
    assert.match((await run('git', ['log', '--oneline', '-1'], { cwd: worktree })).stdout, /T1 DONE/)
    assert.match((await run('git', ['tag', '-l'], { cwd: worktree })).stdout, new RegExp(`guard/${prepared.runId}/T1`))
    // The source checkout keeps its branch and gains nothing.
    assert.equal((await run('git', ['rev-parse', sourceBranch], { cwd })).stdout.trim(), sourceHead)
    assert.equal((await run('git', ['branch', '--show-current'], { cwd })).stdout.trim(), sourceBranch)
    assert.equal((await run('git', ['status', '--porcelain'], { cwd })).stdout.trim(), '')
  })

  test('a milestone review runs every N completed tasks and writes review/round-<n>.md', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过\nT2 | 二 | 通过',
      milestoneEvery: 1,
      scopes: { T1: ['a.ts'], T2: ['b.ts'] },
      probes: [
        { id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true },
        { id: 'P2', taskId: 'T2', weight: 'light', spec: { kind: 'file_exists', path: 'b.ts' }, enabled: true },
      ],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'a')
    const fake = deps(cwd, runId, { reviewers: ['pass'] })
    const attached = await attachSupervisor({ ...fake, cwd, runId } as never)
    await attached.handler()

    // T1 is DONE but T2 is still pending, so the milestone fired for round 1.
    assert.equal(fake.views.reviewerCalls, 3)
    const report = await readFile(join(cwd, 'docs/guard', runId, 'review/round-1.md'), 'utf8')
    assert.match(report, /第 1 轮/)
    assert.match(report, /结论：pass/)
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; verdict?: string })
    assert.ok(events.some(event => event.type === 'review.milestone' && event.verdict === 'pass'))
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'DONE')
    assert.equal(state.status, 'active', 'a passing milestone does not stop the run')
  })

  test('a split milestone review is settled by the adjudicator, and a fail stops the run', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过\nT2 | 二 | 通过',
      milestoneEvery: 1,
      scopes: { T1: ['a.ts'], T2: ['b.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'a')
    const blocks: { code: string; message: string }[] = []
    const fake = deps(cwd, runId, { reviewers: ['pass', 'fail', 'pass'], adjudicate: 'fail', block: reason => blocks.push(reason) })
    const attached = await attachSupervisor({ ...fake, cwd, runId } as never)
    await attached.handler()

    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.status, 'blocked')
    assert.match(state.goalBlocked ?? '', /里程碑审阅未通过/)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]?.code, 'supervisor-blocked')
    const report = await readFile(join(cwd, 'docs/guard', runId, 'review/round-1.md'), 'utf8')
    assert.match(report, /## 裁决/)
    // A blocked run no longer audits.
    const before = fake.views.reviewerCalls
    await attached.handler()
    assert.equal(fake.views.reviewerCalls, before)
  })

  test('an unparseable milestone review records insufficient instead of passing', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过\nT2 | 二 | 通过',
      milestoneEvery: 1,
      scopes: { T1: ['a.ts'], T2: ['b.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'a')
    // Reviewers answer prose instead of JSON: the review cannot be produced.
    const fake = deps(cwd, runId, { reviewerPayload: '我觉得还行，但没有结论。' })
    const attached = await attachSupervisor({ ...fake, cwd, runId } as never)
    await attached.handler()
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; verdict?: string; path?: string; reason?: string })
    const milestone = events.find(event => event.type === 'review.milestone')
    assert.ok(milestone !== undefined)
    assert.equal(milestone?.verdict, 'insufficient')
    assert.equal(milestone?.path, 'review/round-1.md')
    assert.match(milestone?.reason ?? '', /不可解析/)
    const report = await readFile(join(cwd, 'docs/guard', runId, 'review/round-1.md'), 'utf8')
    assert.match(report, /不可解析/)
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.status, 'active', 'insufficient never stops the run by itself')
  })

  test('an approved scope expansion survives the rest of the audit and the commit', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 落盘 | 文件存在 | src/a.ts',
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'other/b.ts' }, enabled: true }],
    })).runId
    // The task needs a file its own scope does not cover: it must ask for it.
    await mkdir(join(cwd, 'other'), { recursive: true })
    await writeFile(join(cwd, 'other/b.ts'), 'ok')
    await mkdir(join(cwd, 'docs/guard', runId, 'requests'), { recursive: true })
    await writeFile(join(cwd, 'docs/guard', runId, 'requests', 'r1.json'), JSON.stringify({
      version: 1, id: 'r1', taskId: 'T1', requestedBy: 'main', reason: 'need b',
      addedPaths: ['other/b.ts'], evidenceIds: [], requiresHuman: false, status: 'pending', createdAt: 1,
    }), 'utf8')
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'DONE', 'the approved scope must survive into the commit')
    assert.ok(state.tasks[0]?.scope.includes('other/b.ts'), 'the ledger keeps the approved scope')
    assert.ok(state.tasks[0]?.scopeApprovedCount === 1)
    const log = await run('git', ['show', '--stat', '--oneline', 'HEAD'], { cwd })
    assert.match(log.stdout, /other\/b\.ts/)
  })

  test('the notes skeleton does not count as a completion declaration on turn one', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 落盘 | 文件存在 | src/**',
      scopes: { T1: ['src/a.ts'] },
      probes: [
        { id: 'L1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true },
        { id: 'H1', taskId: 'T1', weight: 'heavy', spec: { kind: 'command', cmd: process.execPath, args: ['-e', 'process.exit(1)'] }, enabled: true },
      ],
    })).runId
    const fake = deps(cwd, runId, {})
    const attached = await attachSupervisor({ ...fake, cwd, runId } as never)
    // Nothing written yet: the light probe fails, so no heavy probe may run.
    await attached.handler()
    assert.equal(fake.views.reviewerCalls, 0)
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; probeId?: string; weight?: string })
    assert.ok(!events.some(event => event.type === 'probe.run' && event.weight === 'heavy'), 'no heavy probe on turn one')
  })

  test('a failing smoke command is retried on the next turn instead of being latched', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 文件存在',
      smokeCommand: { cmd: process.execPath, args: ['-e', 'process.exit(1)'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'a')
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    await attached.handler()
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; probeId?: string })
    const smokeRuns = events.filter(event => event.type === 'probe.run' && event.probeId === 'smoke')
    assert.equal(smokeRuns.length, 2, 'the smoke gate runs again while it keeps failing')
  })

  test('a milestone review also runs for the final batch, before the goal is completed', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 唯一 | 文件存在',
      milestoneEvery: 1,
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'a')
    let completed = 0
    const fake = deps(cwd, runId, { reviewers: ['pass'], complete: () => { completed += 1 } })
    const attached = await attachSupervisor({ ...fake, cwd, runId } as never)
    await attached.handler()
    const report = await readFile(join(cwd, 'docs/guard', runId, 'review/round-1.md'), 'utf8')
    assert.match(report, /结论：pass/)
    assert.equal(completed, 1, 'the review runs before the goal is completed')
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.status, 'completed')
  })

  test('a failing final milestone stops the run instead of completing the goal', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 唯一 | 文件存在',
      milestoneEvery: 1,
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'a')
    let completed = 0
    const fake = deps(cwd, runId, { reviewers: ['pass', 'fail', 'pass'], adjudicate: 'fail', complete: () => { completed += 1 } })
    const attached = await attachSupervisor({ ...fake, cwd, runId } as never)
    await attached.handler()
    assert.equal(completed, 0, 'a failed final review must not complete the goal')
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.status, 'blocked')
  })

  test('the adjudicator keeps its reason and insufficient is never upgraded by a split', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 通过\nT2 | 二 | 通过',
      milestoneEvery: 1,
      scopes: { T1: ['a.ts'], T2: ['b.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'a')
    const split = deps(cwd, runId, { reviewers: ['pass', 'fail', 'pass'], adjudicate: 'fail' })
    const attached = await attachSupervisor({ ...split, cwd, runId } as never)
    await attached.handler()
    const report = await readFile(join(cwd, 'docs/guard', runId, 'review/round-1.md'), 'utf8')
    assert.match(report, /- 理由：裁决理由/, 'the adjudicator reason is rendered, not dropped')

    const cwd2 = await repo()
    const runId2 = (await prepareGuardRun(cwd2, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 通过\nT2 | 二 | 通过',
      milestoneEvery: 1,
      scopes: { T1: ['a.ts'], T2: ['b.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd2, 'a.ts'), 'a')
    const mixed = deps(cwd2, runId2, { reviewers: ['pass', 'pass', 'insufficient'], adjudicate: 'pass' })
    const attached2 = await attachSupervisor({ ...mixed, cwd: cwd2, runId: runId2 } as never)
    await attached2.handler()
    const events = (await readFile(join(cwd2, 'docs/guard', runId2, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; verdict?: string })
    const milestone = events.filter(event => event.type === 'review.milestone').at(-1)
    assert.equal(milestone?.verdict, 'insufficient', 'a missing-evidence reviewer cannot be outvoted')
  })

  test('a subagent commit outside the scope is still caught in enforce mode', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 文件存在 | src/**',
      enforcement: 'enforce',
      scopes: { T1: ['src/**'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    })).runId
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    // First turn: start the task (records baseCommit) and keep it open on a failing probe.
    await attached.handler()
    const started = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(typeof started.tasks[0]?.baseCommit, 'string', 'the task records its base commit')
    // A subagent writes outside the scope and commits it itself: the worktree is clean.
    await writeFile(join(cwd, 'straggler.ts'), 'out of scope')
    await run('git', ['add', 'straggler.ts'], { cwd })
    await run('git', ['commit', '-qm', 'subagent did this'], { cwd })
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src/a.ts'), 'ok')
    await attached.handler()

    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'BLOCKED', 'the committed out-of-scope file still blocks the task')
    assert.match(state.tasks[0]?.blocked?.reason ?? '', /scope 外改动/)
  })

  test('a sibling that finished in an earlier turn is not blamed on this task', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在\nT2 | 二 | 文件存在',
      parallel: 2,
      enforcement: 'enforce',
      scopes: { T1: ['a.ts'], T2: ['b.ts'] },
      probes: [
        { id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true },
        { id: 'P2', taskId: 'T2', weight: 'light', spec: { kind: 'file_exists', path: 'b.ts' }, enabled: true },
      ],
    })).runId
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)

    // Turn 1: nothing exists yet, so BOTH tasks start and share one base commit.
    await attached.handler()
    const started = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(started.tasks[0]?.status, 'IN_PROGRESS')
    assert.equal(started.tasks[1]?.status, 'IN_PROGRESS')
    assert.equal(started.tasks[0]?.baseCommit, started.tasks[1]?.baseCommit, 'one shared base commit')

    // Turn 2: only T1 becomes ready, so its commit lands INSIDE T2's range.
    await writeFile(join(cwd, 'a.ts'), 'a')
    await attached.handler()
    const afterSecond = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(afterSecond.tasks[0]?.status, 'DONE')
    assert.equal(afterSecond.tasks[1]?.status, 'IN_PROGRESS', 'T2 is still open')
    assert.match((await run('git', ['log', '-1', '--format=%s'], { cwd })).stdout, new RegExp(`guard\\(${runId}\\): T1 DONE`))

    // Turn 3: T2 finishes. T1's commit sits inside its range and must not count.
    await writeFile(join(cwd, 'b.ts'), 'b')
    await attached.handler()
    const afterThird = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(afterThird.tasks[1]?.status, 'DONE', 'the sibling commit is not an out-of-scope change')
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string })
    assert.ok(!events.some(event => event.type === 'scope.violation'), 'no false violation is recorded')
  })

  test('a restart never moves baseCommit onto the undone DONE commit', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 文件存在 | a.ts',
      scopes: { T1: ['a.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    const baseCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    // T1 already shipped 'bad' as a plugin commit, then was reopened to TODO by a
    // rollback: the ledger keeps the ORIGINAL base commit and HEAD still holds the
    // undone commit.
    await writeFile(join(cwd, 'a.ts'), 'bad')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T1 DONE`], { cwd })
    const tasksPath = join(cwd, 'docs/guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [{ ...state.tasks[0]!, status: 'TODO', baseCommit }],
    }, null, 2), 'utf8')
    assert.notEqual(baseCommit, (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim())

    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const restarted = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(restarted.tasks[0]?.baseCommit, baseCommit, 'the original base commit survives the restart')
  })

  test('an out-of-scope subagent commit is revertible and the retry then passes', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在 | a.ts',
      enforcement: 'enforce',
      scopes: { T1: ['a.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    const baseCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    // A subagent commits an out-of-scope file; the audit blocks in enforce mode.
    await writeFile(join(cwd, 'straggler.ts'), 'bad')
    await run('git', ['add', 'straggler.ts'], { cwd })
    await run('git', ['commit', '-qm', 'subagent did this'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'ok')
    await attached.handler()
    const tasksPath = join(cwd, 'docs/guard', runId, 'tasks.json')
    const blocked = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(blocked.tasks[0]?.status, 'BLOCKED')
    assert.equal(blocked.tasks[0]?.baseCommit, baseCommit)

    // Roll back: the reckless commit is reverted and the base commit advances.
    // The run must be bound to the asking session first.
    const metaPath = join(cwd, 'docs/guard', runId, 'run.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    await writeFile(metaPath, JSON.stringify({ ...meta, sessionId: 'session-owner' }), 'utf8')
    const outcome = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(outcome.ok, true, outcome.ok ? 'OK' : outcome.reason)
    const reopened = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(reopened.tasks[0]?.status, 'TODO')
    assert.notEqual(reopened.tasks[0]?.baseCommit, baseCommit, 'the base commit follows the revert')

    // The rollback also removed the in-scope file it had created, so the retry
    // writes it again — and only that. It must reach DONE, not a scope block.
    await writeFile(join(cwd, 'a.ts'), 'ok again')
    await attached.handler()
    const retried = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(
      retried.tasks[0]?.status, 'DONE',
      `the reverted file is not blamed again: status=${retried.tasks[0]?.status} blocked=${JSON.stringify(retried.tasks[0]?.blocked)} attempts=${retried.tasks[0]?.attempts.length}`,
    )
  })

  test('an unavailable progress evaluator blocks the task instead of spinning', async () => {
    const cwd = await repo()
    // The evaluator never answers: `llm.prepareCall` throws every time.
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 文件存在 | a.ts',
      scopes: { T1: ['a.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    const base = deps(cwd, runId, {})
    const broken = {
      ...base,
      ctx: {
        get(name: string) {
          if (name === 'llm') return { prepareCall: async () => { throw new Error('provider unavailable') } }
          return base.ctx.get(name)
        },
      },
    }
    const attached = await attachSupervisor({ ...broken, cwd, runId } as never)
    // Three identical probe failures trigger one progress evaluation; it cannot
    // answer, so the task must stop instead of repeating fifty times.
    for (let round = 0; round < 3; round += 1) await attached.handler()
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'BLOCKED')
    assert.match(state.tasks[0]?.blocked?.reason ?? '', /进展评估不可用/)
    assert.ok((state.tasks[0]?.attempts.length ?? 0) <= 4, 'the attempt budget is not burned')
  })

  test('enforce denies the real terminal tools and a symlinked escape', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 一 | 文件存在 | src/**',
      enforcement: 'enforce',
      scopes: { T1: ['src/**'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    })).runId
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src/a.ts'), 'ok')
    // The DSH terminal plugin registers these exact names.
    for (const tool of ['terminal_open', 'terminal_send', 'terminal_signal']) {
      const denial = attached.checkTool({ name: tool, arguments: {} })
      assert.match(String(denial), /不直接执行命令/, `${tool} must be denied in enforce mode`)
    }
    // A symlink inside the scope that points at the ledger must not be writable.
    const link = join(cwd, 'src/escape.json')
    await symlink(join(cwd, 'docs', 'guard', runId, 'tasks.json'), link).catch(() => undefined)
    const denied = attached.checkTool({ name: 'write', arguments: { file_path: 'src/escape.json' } })
    assert.ok(denied !== undefined, 'writing through the symlink is refused')
  })
})

// Round-8 regression: two consecutive `DONE` rollbacks used to leave the second
// task's restored-to-checkpoint file dirty in the shared worktree, and the first
// task's retry then saw it as its own out-of-scope change (enforce => BLOCKED).
// Round-9 fixes: finishing a task must stage only what is dirty NOW, and the
// mirror's slow CLI call must not erase a concurrent `run.json` update.
describe('goal-supervisor finish and meta races', () => {
  test('a task whose deletion a subagent already committed can still finish', async () => {
    const cwd = await repo()
    // The task's scope names a tracked file it is going to delete.
    await writeFile(join(cwd, 'a.ts'), 'to be removed')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', 'add a.ts'], { cwd })
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 删掉 a.ts | 通过 | a.ts',
      scopes: { T1: ['a.ts'] },
    })).runId
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    const base = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    // The task is already in flight, measured from the commit before the work.
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [{ ...state.tasks[0]!, status: 'IN_PROGRESS', baseCommit: base }],
      activeTaskIds: ['T1'],
    }, null, 2), 'utf8')
    // A subagent removes the file and commits the removal itself: nothing named
    // by `a.ts` remains in the worktree OR the index.
    await run('git', ['rm', '-q', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', 'subagent removes a.ts'], { cwd })

    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const after = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(after.tasks[0]?.status, 'DONE', JSON.stringify(after.tasks[0]?.blocked))
    assert.ok(after.tasks[0]?.checkpointRef !== undefined, 'the checkpoint tag was written')
    const tags = await run('git', ['tag', '--list', `guard/${runId}/T1`], { cwd })
    assert.equal(tags.stdout.trim(), `guard/${runId}/T1`)
  })

  test('a mirror sync does not erase the first-message marker written while the CLI ran', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')
    // A fake `gh` that blocks long enough for the marker write to interleave.
    const bin = join(cwd, 'bin')
    await mkdir(bin, { recursive: true })
    const marker = join(bin, 'started')
    const gh = join(bin, 'gh')
    await writeFile(gh, `#!/bin/sh\ncase "$1 $2" in\n  "issue create") touch "${marker}"; sleep 0.3; echo https://github.com/acme/repo/issues/7 ;;\n  *) exit 0 ;;\nesac\n`)
    await chmod(gh, 0o755)
    const store = new GuardStore(join(cwd, 'docs', 'guard', runId))
    const auditing = auditTurn({
      ...deps(cwd, runId, {}),
      cwd,
      runId,
      store,
      mirror: { mode: 'auto', provider: 'github', host: 'github.com', command: gh },
    })
    for (let tick = 0; tick < 300 && !existsSync(marker); tick += 1) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
    }
    assert.ok(existsSync(marker), 'the mirror CLI is mid-call')
    await markFirstMessageDelivered(cwd, runId)
    await auditing
    const meta = JSON.parse(await readFile(join(cwd, 'docs', 'guard', runId, 'run.json'), 'utf8')) as {
      setup: { firstMessage: boolean }
      mirror: { provider?: string, host?: string, issueNumber?: number }
    }
    assert.equal(meta.setup.firstMessage, true, 'the marker survives the mirror write')
    assert.equal(meta.mirror.issueNumber, 7)
    assert.equal(meta.mirror.provider, 'github')
    assert.equal(meta.mirror.host, 'github.com')
  })

  test('a slow mirror CLI cannot stamp the run with a pre-call timestamp', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')
    const bin = join(cwd, 'bin')
    await mkdir(bin, { recursive: true })
    const marker = join(bin, 'commented')
    // `issue create` answers immediately; the status comment blocks for a moment
    // and then fails, so the failure branch is the one that writes the timestamps.
    const gh = join(bin, 'gh')
    await writeFile(gh, `#!/bin/sh\ncase "$1 $2" in\n  "issue create") echo https://github.com/acme/repo/issues/7 ;;\n  *) touch "${marker}"; sleep 0.4; echo "rate limited" >&2; exit 1 ;;\nesac\n`)
    await chmod(gh, 0o755)
    const store = new GuardStore(join(cwd, 'docs', 'guard', runId))
    const auditing = auditTurn({
      ...deps(cwd, runId, {}),
      cwd,
      runId,
      store,
      mirror: { mode: 'auto', provider: 'github', host: 'github.com', command: gh },
    })
    for (let tick = 0; tick < 400 && !existsSync(marker); tick += 1) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
    }
    assert.ok(existsSync(marker), 'the mirror CLI is mid-call')
    // Another writer serializes a `run.json` update while the CLI is running. Its
    // timestamp is later than the pre-call instant the audit captured, so writing
    // that instant back afterwards moves `updatedAt` BACKWARDS in time.
    const metaPath = join(cwd, 'docs', 'guard', runId, 'run.json')
    const during = Date.now()
    const live = JSON.parse(await readFile(metaPath, 'utf8')) as { updatedAt: number }
    await writeFile(metaPath, JSON.stringify({ ...live, updatedAt: during }, null, 2), 'utf8')
    await auditing
    const after = JSON.parse(await readFile(metaPath, 'utf8')) as { updatedAt: number; mirror: { lastError?: string } }
    assert.match(after.mirror.lastError ?? '', /rate limited/)
    assert.ok(after.updatedAt >= during, `updatedAt moved backwards: ${after.updatedAt} < ${during}`)
  })
})

describe('goal-supervisor cross-task rollback residue', () => {
  /** C0 -> T1 DONE (a.ts) -> T2 DONE (b.ts), then both rolled back newest-first. */
  async function twoDoneTasksRolledBack(): Promise<{ cwd: string; runId: string; tasksPath: string; c0: string }> {
    const cwd = await repo()
    // `a.ts` has to exist at the base commit: the probe needs it present after
    // T1's scope is restored to that commit.
    await writeFile(join(cwd, 'a.ts'), 'base')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', 'base with a.ts'], { cwd })
    const c0 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在\nT2 | 二 | 文件存在',
      enforcement: 'enforce',
      scopes: { T1: ['a.ts'], T2: ['b.ts'] },
      probes: [
        { id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true },
        { id: 'P2', taskId: 'T2', weight: 'light', spec: { kind: 'file_exists', path: 'b.ts' }, enabled: true },
      ],
    })).runId
    // T1 DONE: its own commit plus checkpoint tag.
    await writeFile(join(cwd, 'a.ts'), 'T1 work')
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T1 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T1`, '-m', 'T1'], { cwd })
    const c1 = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    // T2 DONE: the next commit, measured from T1's checkpoint.
    await writeFile(join(cwd, 'b.ts'), 'T2 work')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T2 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T2`, '-m', 'T2'], { cwd })

    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', checkpointRef: `guard/${runId}/T1`, baseCommit: c0 },
        { ...state.tasks[1]!, status: 'DONE', checkpointRef: `guard/${runId}/T2`, baseCommit: c1 },
      ],
      activeTaskIds: [],
    }, null, 2), 'utf8')
    const metaPath = join(cwd, 'docs', 'guard', runId, 'run.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    await writeFile(metaPath, JSON.stringify({ ...meta, sessionId: 'session-supervisor' }), 'utf8')

    const first = await rollbackRun({ cwd, runId, sessionId: 'session-supervisor' })
    assert.equal(first.ok, true, first.ok ? '' : first.reason)
    if (!first.ok) return { cwd, runId, tasksPath, c0 }
    assert.equal(first.report.taskId, 'T2')
    await assert.rejects(() => readFile(join(cwd, 'b.ts'), 'utf8'), 'b.ts is removed from the worktree')

    const second = await rollbackRun({ cwd, runId, sessionId: 'session-supervisor' })
    assert.equal(second.ok, true, second.ok ? '' : second.reason)
    if (!second.ok) return { cwd, runId, tasksPath, c0 }
    assert.equal(second.report.taskId, 'T1')
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'base', 'T1 scope goes back to its base commit')
    return { cwd, runId, tasksPath, c0 }
  }

  test('a rolled-back DONE task is not blamed on the task retried after it', async () => {
    const { cwd, runId, tasksPath } = await twoDoneTasksRolledBack()
    // T1's retry: HEAD still contains b.ts, so the worktree diff over C0 names it.
    // It is T2's rollback residue, not T1's change.
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const after = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(
      after.tasks[0]?.status, 'DONE',
      `T1 must not be re-blocked by T2's residue: ${JSON.stringify(after.tasks[0]?.blocked)}`,
    )
  })

  test('a residue no longer excuses an out-of-scope deletion after a sibling rewrote the file', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'd.ts'), 'd')
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过 | a.ts\nT2 | 二 | 通过 | b.ts\nT3 | 三 | 通过 | b.ts\nT4 | 四 | 通过 | d.ts',
      enforcement: 'enforce',
      scopes: { T1: ['a.ts'], T2: ['b.ts'], T3: ['b.ts'], T4: ['d.ts'] },
      probes: [{ id: 'P4', taskId: 'T4', weight: 'light', spec: { kind: 'file_exists', path: 'd.ts' }, enabled: true }],
    })).runId
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const base = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    // T2 ships b.ts, then the human rolls it back: b.ts is removed and recorded
    // as this task's residue.
    await writeFile(join(cwd, 'b.ts'), 'T2 work')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T2 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T2`, '-m', 'T2'], { cwd })
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'TODO', baseCommit: base },
        { ...state.tasks[1]!, status: 'DONE', baseCommit: base, checkpointRef: `guard/${runId}/T2` },
        { ...state.tasks[2]!, status: 'TODO', baseCommit: base },
        { ...state.tasks[3]!, status: 'TODO', baseCommit: base },
      ],
      activeTaskIds: [],
      doneOrder: ['T2'],
    }, null, 2), 'utf8')
    const first = await rollbackRun({ cwd, runId, sessionId: 'session-owner' })
    assert.equal(first.ok, true, first.ok ? '' : first.reason)
    const roled = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    const residue = roled.tasks[1]?.rollbackResidue
    assert.equal(residue?.['b.ts']?.worktreeHash, 'deleted', 'the rollback recorded the deletion')
    assert.equal(typeof residue?.['b.ts']?.headBlob, 'string', 'and the HEAD blob it was deleted from')

    // T3 legitimately recreates and commits the same path (a sibling's own DONE),
    // then T4 deletes it even though its scope never allowed b.ts.
    await writeFile(join(cwd, 'b.ts'), 'T3 work')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T3 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T3`, '-m', 'T3'], { cwd })
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const staged = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...staged,
      tasks: [
        { ...staged.tasks[0]!, status: 'TODO', baseCommit: base },
        { ...staged.tasks[1]!, status: 'BLOCKED', baseCommit: base, blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() } },
        { ...staged.tasks[2]!, status: 'DONE', baseCommit: base, checkpointRef: `guard/${runId}/T3` },
        { ...staged.tasks[3]!, status: 'IN_PROGRESS', baseCommit: head },
      ],
      activeTaskIds: ['T4'],
      doneOrder: ['T2', 'T3'],
    }, null, 2), 'utf8')
    // The out-of-scope deletion leaves the worktree matching the old residue hash.
    await rm(join(cwd, 'b.ts'), { force: true })

    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const after = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(after.tasks[3]?.status, 'BLOCKED', 'the deletion is blamed on T4, not excused by T2')
    assert.match(after.tasks[3]?.blocked?.reason ?? '', /scope 外改动/)
  })

  test('a DONE commit clears the same path from another task residue', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过 | a.ts\nT2 | 二 | 通过 | b.ts\nT3 | 三 | 通过 | b.ts',
      scopes: { T1: ['a.ts'], T2: ['b.ts'], T3: ['b.ts'] },
      probes: [{ id: 'P3', taskId: 'T3', weight: 'light', spec: { kind: 'file_exists', path: 'b.ts' }, enabled: true }],
    })).runId
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'TODO', baseCommit: head },
        {
          ...state.tasks[1]!, status: 'BLOCKED', baseCommit: head,
          rollbackResidue: { 'b.ts': { headBlob: 'absent', worktreeHash: 'deleted' } },
          blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() },
        },
        { ...state.tasks[2]!, status: 'IN_PROGRESS', baseCommit: head },
      ],
      activeTaskIds: ['T3'],
      doneOrder: [],
    }, null, 2), 'utf8')
    await writeFile(join(cwd, 'b.ts'), 'T3 ships it')

    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const after = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(after.tasks[2]?.status, 'DONE')
    assert.equal(after.tasks[1]?.rollbackResidue, undefined, 'the commit took ownership of the path')
  })

  test('the residue exemption stops as soon as the path content changes', async () => {
    const { cwd, runId, tasksPath } = await twoDoneTasksRolledBack()
    // A subagent recreates b.ts with different content and commits it. The
    // recorded residue hash ('deleted') no longer matches, so this is a real
    // out-of-scope change again and enforce must still catch it.
    await writeFile(join(cwd, 'b.ts'), 'sneaky new work')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', 'subagent recreates b.ts'], { cwd })
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const after = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(after.tasks[0]?.status, 'BLOCKED')
    assert.match(after.tasks[0]?.blocked?.reason ?? '', /scope 外改动/)
  })
})

// Round-10 P1-3: a subagent can commit its own work, so the finishing task's
// paths are not dirty and the old cleanup — which only looked at `staged` —
// cleared nothing. A stale residue then excused a later out-of-scope deletion.
describe('goal-supervisor self-committed residue', () => {
  test('a self-committed path clears a sibling residue even when nothing is dirty', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过 | a.ts\nT2 | 二 | 通过 | b.ts\nT3 | 三 | 通过 | b.ts\nT4 | 四 | 通过 | d.ts',
      enforcement: 'enforce',
      scopes: { T1: ['a.ts'], T2: ['b.ts'], T3: ['b.ts'], T4: ['d.ts'] },
      probes: [{ id: 'P3', taskId: 'T3', weight: 'light', spec: { kind: 'file_exists', path: 'b.ts' }, enabled: true }],
    })).runId
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const base = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    // `b.ts` ships once, then a rollback removes it from the worktree and records
    // the residue (HEAD blob + `deleted`).
    await writeFile(join(cwd, 'b.ts'), 'same blob')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', 'ships b.ts'], { cwd })
    const blob = (await run('git', ['rev-parse', 'HEAD:b.ts'], { cwd })).stdout.trim()
    await rm(join(cwd, 'b.ts'))
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'TODO', baseCommit: base },
        {
          ...state.tasks[1]!, status: 'BLOCKED', baseCommit: base,
          rollbackResidue: { 'b.ts': { headBlob: blob, worktreeHash: 'deleted' } },
          blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() },
        },
        // T3 is measured from the run's own base: its `changed` set still names
        // b.ts (T2's ship commit is inside base..HEAD), even though the file is
        // byte-identical in HEAD right now.
        { ...state.tasks[2]!, status: 'IN_PROGRESS', baseCommit: base },
        { ...state.tasks[3]!, status: 'TODO', baseCommit: head },
      ],
      activeTaskIds: ['T3'],
      doneOrder: [],
    }, null, 2), 'utf8')
    // T3's subagent recreates the file with the SAME content: for git that is a
    // no-op (HEAD's blob is unchanged and the worktree is clean), which is exactly
    // why `staged` is empty here while the path is still the task's own.
    await writeFile(join(cwd, 'b.ts'), 'same blob')

    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const afterT3 = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(afterT3.tasks[2]?.status, 'DONE', JSON.stringify(afterT3.tasks[2]?.blocked))
    assert.equal(afterT3.tasks[1]?.rollbackResidue, undefined, 'the self-commit took ownership of the path')

    // A later task may not delete the path it never declared.
    const tail = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const current = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...current,
      tasks: current.tasks.map((task, index) => index === 3
        ? { ...task, status: 'IN_PROGRESS', baseCommit: tail }
        : task),
      activeTaskIds: ['T4'],
    }, null, 2), 'utf8')
    await rm(join(cwd, 'b.ts'), { force: true })
    const next = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await next.handler()
    const afterT4 = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(afterT4.tasks[3]?.status, 'BLOCKED', 'the stale residue must not excuse the deletion')
    assert.match(afterT4.tasks[3]?.blocked?.reason ?? '', /scope 外改动/)
  })
})

// Round-7 fix: the milestone batch must be sliced by completion order, not by
// the task table (parallel batches finish out of order).
describe('goal-supervisor milestone batch order', () => {
  test('the review sees completion order, not table order', async () => {
    const cwd = await repo()
    // Four tasks with `milestoneEvery: 2`: the second review fires at four DONE
    // and must look at the LAST two completed, in the order they landed.
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在\nT2 | 二 | 文件存在\nT3 | 三 | 文件存在\nT4 | 四 | 文件存在',
      milestoneEvery: 2,
      scopes: { T1: ['a.ts'], T2: ['b.ts'], T3: ['c.ts'], T4: ['d.ts'] },
      probes: [
        { id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true },
        { id: 'P2', taskId: 'T2', weight: 'light', spec: { kind: 'file_exists', path: 'b.ts' }, enabled: true },
        { id: 'P3', taskId: 'T3', weight: 'light', spec: { kind: 'file_exists', path: 'c.ts' }, enabled: true },
        { id: 'P4', taskId: 'T4', weight: 'light', spec: { kind: 'file_exists', path: 'd.ts' }, enabled: true },
      ],
    })).runId
    await writeFile(join(cwd, 'd.ts'), 'd')
    const base = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', baseCommit: base, checkpointRef: `guard/${runId}/T1` },
        { ...state.tasks[1]!, status: 'DONE', baseCommit: base, checkpointRef: `guard/${runId}/T2` },
        { ...state.tasks[2]!, status: 'DONE', baseCommit: base, checkpointRef: `guard/${runId}/T3` },
        { ...state.tasks[3]!, status: 'IN_PROGRESS', baseCommit: base },
      ],
      activeTaskIds: ['T4'],
      // Completion order was T3, T2, T1; the table lists them T1, T2, T3.
      doneOrder: ['T3', 'T2', 'T1'],
    }, null, 2), 'utf8')

    const attached = await attachSupervisor({ ...deps(cwd, runId, { reviewers: ['pass'] }), cwd, runId } as never)
    await attached.handler()
    const report = await readFile(join(cwd, 'docs', 'guard', runId, 'review', 'round-2.md'), 'utf8')
    assert.match(report, /- 本批任务：T1、T4/, report)
  })
})

// Round-11 P1-2: a DONE retry can ship a path BACK to the very blob HEAD already
// holds (a rollback deleted it, the retry restores the same content). For git the
// worktree is clean and `baseCommit === HEAD`, so `changed` is EMPTY; the old
// cleanup only ran for `changed.length > 0` and the stale residue survived. A
// later task could then delete that path and match both halves of the record —
// `headBlob` unchanged and `worktreeHash: 'deleted'` again — so `enforce` excused
// a genuine out-of-scope deletion.
describe('goal-supervisor stale residue on a clean retry', () => {
  test('a DONE retry that restores the same blob still clears the residue', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过 | a.ts\nT2 | 二 | 通过 | b.ts\nT3 | 三 | 通过 | b.ts\nT4 | 四 | 通过 | d.ts',
      enforcement: 'enforce',
      scopes: { T1: ['a.ts'], T2: ['b.ts'], T3: ['b.ts'], T4: ['d.ts'] },
      probes: [{ id: 'P3', taskId: 'T3', weight: 'light', spec: { kind: 'file_exists', path: 'b.ts' }, enabled: true }],
    })).runId
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    // T2 shipped b.ts, then a rollback removed it from the worktree and recorded
    // the residue while HEAD still held the blob (the opened task is not reverted).
    await writeFile(join(cwd, 'b.ts'), 'same blob')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T2 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T2`, '-m', 'T2'], { cwd })
    const blob = (await run('git', ['rev-parse', 'HEAD:b.ts'], { cwd })).stdout.trim()
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await rm(join(cwd, 'b.ts'))
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'TODO', baseCommit: head },
        {
          ...state.tasks[1]!, status: 'BLOCKED', baseCommit: head,
          rollbackResidue: { 'b.ts': { headBlob: blob, worktreeHash: 'deleted' } },
          blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() },
        },
        // T3 starts naturally HERE, so its baseCommit is the rollback-era HEAD.
        { ...state.tasks[2]!, status: 'IN_PROGRESS', baseCommit: head },
        { ...state.tasks[3]!, status: 'TODO', baseCommit: head },
      ],
      activeTaskIds: ['T3'],
      doneOrder: [],
    }, null, 2), 'utf8')
    // T3 restores the exact blob HEAD holds: no worktree change, nothing to commit.
    await writeFile(join(cwd, 'b.ts'), 'same blob')

    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const afterT3 = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(afterT3.tasks[2]?.status, 'DONE', JSON.stringify(afterT3.tasks[2]?.blocked))
    assert.equal(afterT3.tasks[1]?.rollbackResidue, undefined, 'the DONE retry took the path back even though nothing was dirty')

    // T4 may not delete a path its scope never declared. The stale record used to
    // match again here (same HEAD blob, `deleted`), excusing the deletion.
    const tail = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const current = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...current,
      tasks: current.tasks.map((task, index) => index === 3
        ? { ...task, status: 'IN_PROGRESS', baseCommit: tail }
        : task),
      activeTaskIds: ['T4'],
    }, null, 2), 'utf8')
    await rm(join(cwd, 'b.ts'), { force: true })
    const next = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await next.handler()
    const afterT4 = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(afterT4.tasks[3]?.status, 'BLOCKED', 'the out-of-scope deletion is caught')
    assert.match(afterT4.tasks[3]?.blocked?.reason ?? '', /scope 外改动/)
  })
})

// Round-11 P2-2: `doneOrder` may repeat an id (a ledger written by a version that
// did not remove it on reopen). The milestone batch mapped the array verbatim, so
// a duplicated recent id filled the batch twice while an older completed task was
// never reviewed. The rollback path already ranked by the LAST occurrence.
describe('goal-supervisor milestone duplicate doneOrder', () => {
  test('a duplicated doneOrder id is reviewed once and does not crowd out a finished task', async () => {
    const cwd = await repo()
    // Three completed tasks with `milestoneEvery: 3` fire the first review; T3 is
    // the one finishing in this turn and is appended to `doneOrder`.
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在\nT2 | 二 | 文件存在\nT3 | 三 | 文件存在\nT4 | 四 | 文件存在',
      milestoneEvery: 3,
      scopes: { T1: ['a.ts'], T2: ['b.ts'], T3: ['c.ts'], T4: ['d.ts'] },
      probes: [{ id: 'P3', taskId: 'T3', weight: 'light', spec: { kind: 'file_exists', path: 'c.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'c.ts'), 'c')
    const base = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'DONE', baseCommit: base, checkpointRef: `guard/${runId}/T1` },
        { ...state.tasks[1]!, status: 'DONE', baseCommit: base, checkpointRef: `guard/${runId}/T2` },
        { ...state.tasks[2]!, status: 'IN_PROGRESS', baseCommit: base },
        { ...state.tasks[3]!, status: 'TODO', baseCommit: base },
      ],
      activeTaskIds: ['T3'],
      // T2 appears twice: mapping this verbatim gave the batch [T2, T2, T3] and
      // reviewed T2 twice while T1 was never looked at.
      doneOrder: ['T1', 'T2', 'T2'],
    }, null, 2), 'utf8')

    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const report = await readFile(join(cwd, 'docs', 'guard', runId, 'review', 'round-1.md'), 'utf8')
    assert.match(report, /- 本批任务：T1、T2、T3/, report)
  })
})

// Round-12 P1-3: `settleResidue` only checked stale records that fell inside the
// FINISHING task's scope. A sibling residue restored to HEAD while an unrelated
// task completed therefore survived, and a later out-of-scope deletion matched
// it again — `enforce` excused the deletion. Staleness is objective: if the
// recorded worktree hash or HEAD blob no longer matches, no task can use it.
describe('goal-supervisor residue outside the finishing scope', () => {
  test('a restored residue is settled even when the finishing task does not own it', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过 | a.ts\nT2 | 二 | 通过 | b.ts\nT3 | 三 | 通过 | c.ts\nT4 | 四 | 通过 | d.ts',
      enforcement: 'enforce',
      scopes: { T1: ['a.ts'], T2: ['b.ts'], T3: ['c.ts'], T4: ['d.ts'] },
      probes: [{ id: 'P3', taskId: 'T3', weight: 'light', spec: { kind: 'file_exists', path: 'c.ts' }, enabled: true }],
    })).runId
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    // T2 shipped b.ts, then a rollback removed it: the residue remembers the HEAD
    // blob it was deleted from plus the worktree hash `deleted`.
    await writeFile(join(cwd, 'b.ts'), 'same blob')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', `guard(${runId}): T2 DONE`], { cwd })
    await run('git', ['tag', '-a', `guard/${runId}/T2`, '-m', 'T2'], { cwd })
    const blob = (await run('git', ['rev-parse', 'HEAD:b.ts'], { cwd })).stdout.trim()
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    await rm(join(cwd, 'b.ts'))
    // `git checkout HEAD -- b.ts` (or a warn-only restore) put the file back with
    // the very content HEAD holds: the recorded `deleted` hash is now stale for
    // every task, including one whose scope never mentions b.ts.
    await writeFile(join(cwd, 'b.ts'), 'same blob')
    await writeFile(join(cwd, 'c.ts'), 'c')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        { ...state.tasks[0]!, status: 'TODO', baseCommit: head },
        {
          ...state.tasks[1]!, status: 'BLOCKED', baseCommit: head,
          rollbackResidue: { 'b.ts': { headBlob: blob, worktreeHash: 'deleted' } },
          blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: Date.now() },
        },
        // T3 owns only c.ts.
        { ...state.tasks[2]!, status: 'IN_PROGRESS', baseCommit: head },
        { ...state.tasks[3]!, status: 'TODO', baseCommit: head },
      ],
      activeTaskIds: ['T3'],
      doneOrder: [],
    }, null, 2), 'utf8')

    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const afterT3 = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(afterT3.tasks[2]?.status, 'DONE', JSON.stringify(afterT3.tasks[2]?.blocked))
    assert.equal(
      afterT3.tasks[1]?.rollbackResidue, undefined,
      'a residue restored to HEAD is objectively stale even outside the finishing task scope',
    )

    // T4 may not delete a path its scope never declared. The stale record used to
    // match again here (same HEAD blob, `deleted`), excusing the deletion.
    const tail = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    const current = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...current,
      tasks: current.tasks.map((task, index) => index === 3
        ? { ...task, status: 'IN_PROGRESS', baseCommit: tail }
        : task),
      activeTaskIds: ['T4'],
    }, null, 2), 'utf8')
    await rm(join(cwd, 'b.ts'), { force: true })
    const next = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await next.handler()
    const afterT4 = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(afterT4.tasks[3]?.status, 'BLOCKED', 'the stale residue must not excuse the deletion')
    assert.match(afterT4.tasks[3]?.blocked?.reason ?? '', /scope 外改动/)
  })

  test('preparing the next task file early is not blamed on the running task', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在 | src/a.ts\nT2 | 二 | 文件存在 | src/b.ts',
      // sequential: T2 is not in this turn's batch, so it is not a "sibling" —
      // but its scope is still a declared claim on src/b.ts.
      parallel: 1,
      enforcement: 'enforce',
      scopes: { T1: ['src/a.ts'], T2: ['src/b.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    })).runId
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src/a.ts'), 'a')
    // The agent also prepares T2's file in the same turn.
    await writeFile(join(cwd, 'src/b.ts'), 'b')
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()

    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'DONE', 'a later task\'s declared file is not this task\'s violation')
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string })
    assert.ok(!events.some(event => event.type === 'scope.violation'))
  })

  test('modifying a FINISHED task file is still a violation', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在 | src/a.ts\nT2 | 二 | 文件存在 | src/b.ts',
      parallel: 1,
      enforcement: 'enforce',
      scopes: { T1: ['src/a.ts'], T2: ['src/b.ts'] },
      probes: [
        { id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true },
        { id: 'P2', taskId: 'T2', weight: 'light', spec: { kind: 'file_exists', path: 'src/b.ts' }, enabled: true },
      ],
    })).runId
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src/a.ts'), 'a')
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    // T2 now runs and stomps on T1's finished file.
    await writeFile(join(cwd, 'src/b.ts'), 'b')
    await writeFile(join(cwd, 'src/a.ts'), 'tampered')
    await attached.handler()

    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[1]?.status, 'BLOCKED', 'a DONE task\'s file is not a free pass')
    assert.match(state.tasks[1]?.blocked?.reason ?? '', /scope 外改动/)
  })

  test('a task a rollback reopened owns its files again even without a base commit', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在 | a.ts\nT2 | 二 | 文件存在 | b.ts',
      parallel: 1,
      enforcement: 'enforce',
      scopes: { T1: ['a.ts'], T2: ['b.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    // A ledger a rollback edited: T2 is back to TODO, and this workspace has no
    // commit to advance it to, so it has no baseCommit. It still owns b.ts.
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      tasks: [
        state.tasks[0],
        { ...state.tasks[1]!, status: 'TODO', reopenedAt: Date.now(), scope: ['b.ts'] },
      ],
      activeTaskIds: [],
    }, null, 2), 'utf8')
    await writeFile(join(cwd, 'a.ts'), 'a')
    await writeFile(join(cwd, 'b.ts'), 'stomped by the retry')
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()

    const after = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(after.tasks[0]?.status, 'BLOCKED', 'a reopened task is not an excuse')
    assert.match(after.tasks[0]?.blocked?.reason ?? '', /scope 外改动/)
  })

  test('a committed write to a future task scope is NOT excused in enforce mode', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在 | src/a.ts\nT2 | 二 | 文件存在 | src/b.ts',
      parallel: 1,
      enforcement: 'enforce',
      scopes: { T1: ['src/a.ts'], T2: ['src/b.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    })).runId
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    // Turn 1: start T1 and record its baseCommit while probe fails.
    await attached.handler()
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src/a.ts'), 'a')
    // A subagent commits T2's file while T1 is running: letting T1 tag above it
    // would move T2's baseCommit past src/b.ts and break T2's audit/rollback.
    await writeFile(join(cwd, 'src/b.ts'), 'committed early')
    await run('git', ['add', 'src/b.ts'], { cwd })
    await run('git', ['commit', '-qm', 'subagent committed T2 file'], { cwd })
    await attached.handler()

    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'BLOCKED', 'a committed future-task file must block T1')
    assert.match(state.tasks[0]?.blocked?.reason ?? '', /scope 外改动/)
  })
})

describe('goal-supervisor evaluator reliability and evidence', () => {
  test('evaluator outage does not burn attempts or cursors, resets on recovery, and blocks after 3 consecutive outages', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在 | src/a.ts',
      scopes: { T1: ['src/a.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    })).runId
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src/a.ts'), 'export const a = 1\n')
    const notesPath = join(cwd, 'docs/guard', runId, 'tasks/T1/notes.md')
    const initial = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    const initialOffset = initial.tasks[0]?.lastEvalOffset ?? 0
    await writeFile(notesPath, `${await readFile(notesPath, 'utf8')}\n## 完成声明\n完成 T1\n`, 'utf8')

    // One observation retries a dropped call once, so an outage that lasts two
    // turns costs four failed calls, not two.
    let failuresLeft = 4
    const base = deps(cwd, runId, {})
    const flaky = {
      ...base,
      ctx: {
        get(name: string) {
          if (name !== 'llm') return base.ctx.get(name)
          return {
            prepareCall: async () => {
              if (failuresLeft > 0) {
                failuresLeft -= 1
                throw new Error('gateway timeout 504')
              }
              const tasks = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
              const payload = JSON.stringify({
                goal_hash: tasks.goalHash, verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue',
              })
              return {
                config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 4000 },
                stream: () => (async function* () {
                  yield { type: 'text-delta', index: 0, text: payload }
                  yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
                })(),
              }
            },
          }
        },
      },
    }
    const attached = await attachSupervisor({ ...flaky, cwd, runId } as never)
    // Outage #1 and #2: no attempt consumed, cursors untouched, streak increments.
    await attached.handler()
    let after = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(after.tasks[0]?.status, 'IN_PROGRESS')
    assert.equal(after.tasks[0]?.attempts.length, 0, 'outage must not consume attempts')
    assert.equal(after.tasks[0]?.lastEvalScopeHash, undefined, 'outage must not advance scope hash')
    assert.equal(after.tasks[0]?.lastEvalOffset, initialOffset, 'outage must not consume completion note offset')
    assert.equal(after.tasks[0]?.evalUnavailableStreak, 1)

    await attached.handler()
    after = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(after.tasks[0]?.evalUnavailableStreak, 2)
    assert.equal(after.tasks[0]?.attempts.length, 0)

    // Turn 3 recovers: task completes and streak resets.
    await attached.handler()
    after = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(after.tasks[0]?.status, 'DONE')
    assert.equal(after.tasks[0]?.evalUnavailableStreak, undefined)

    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; reason?: string; streak?: number })
    const outages = events.filter(event => event.type === 'eval.unavailable')
    assert.equal(outages.length, 2)
    assert.equal(outages[0]?.streak, 1)
    assert.match(outages[0]?.reason ?? '', /gateway timeout 504/)

    // Now test 3 consecutive outages blocking with a clear reason.
    const cwd2 = await repo()
    const runId2 = (await prepareGuardRun(cwd2, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在 | src/a.ts',
      scopes: { T1: ['src/a.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    })).runId
    await mkdir(join(cwd2, 'src'), { recursive: true })
    await writeFile(join(cwd2, 'src/a.ts'), 'a')
    const base2 = deps(cwd2, runId2, {})
    const alwaysDown = {
      ...base2,
      ctx: {
        get(name: string) {
          if (name === 'llm') return { prepareCall: async () => { throw new Error('connection refused') } }
          return base2.ctx.get(name)
        },
      },
    }
    const attached2 = await attachSupervisor({ ...alwaysDown, cwd: cwd2, runId: runId2 } as never)
    await attached2.handler()
    await attached2.handler()
    await attached2.handler()
    const blocked = JSON.parse(await readFile(join(cwd2, 'docs/guard', runId2, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(blocked.tasks[0]?.status, 'BLOCKED')
    assert.equal(blocked.tasks[0]?.attempts.length, 0)
    assert.match(blocked.tasks[0]?.blocked?.reason ?? '', /评估器连续 3 次不可用/)
    assert.match(blocked.tasks[0]?.blocked?.reason ?? '', /connection refused/)
  })

  test('评估器连续输出被截断时，阻断原因直接给出「降到 High / 配回退」的修法', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在 | a.ts',
      scopes: { T1: ['a.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'ok')
    const base = deps(cwd, runId, {})
    const truncated = {
      ...base,
      ctx: {
        get(name: string) {
          if (name === 'llm') {
            return {
              prepareCall: async () => ({
                config: {},
                stream: () => (async function* () {
                  yield { type: 'finish', reason: { kind: 'max-tokens' } }
                })(),
              }),
            }
          }
          return base.ctx.get(name)
        },
      },
    }
    const attached = await attachSupervisor({ ...truncated, cwd, runId } as never)
    await attached.handler()
    await attached.handler()
    await attached.handler()
    const blocked = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(blocked.tasks[0]?.status, 'BLOCKED')
    assert.match(blocked.tasks[0]?.blocked?.reason ?? '', /MAX_TOKENS/)
    assert.match(blocked.tasks[0]?.blocked?.reason ?? '', /降到 High/)
    assert.match(blocked.tasks[0]?.blocked?.next ?? '', /降到 High/)
    assert.match(blocked.tasks[0]?.blocked?.next ?? '', /继续运行/)
  })

  test('goal hash mismatch blocks immediately instead of retrying as an outage', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在 | a.ts',
      scopes: { T1: ['a.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'ok')
    const base = deps(cwd, runId, {})
    const wrongHash = {
      ...base,
      ctx: {
        get(name: string) {
          if (name !== 'llm') return base.ctx.get(name)
          const payload = JSON.stringify({ goal_hash: 'tampered', verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue' })
          return {
            prepareCall: async () => ({
              config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 4000 },
              stream: () => (async function* () {
                yield { type: 'text-delta', index: 0, text: payload }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
              })(),
            }),
          }
        },
      },
    }
    const attached = await attachSupervisor({ ...wrongHash, cwd, runId } as never)
    await attached.handler()
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'BLOCKED', 'integrity mismatch must block on the first hit')
    assert.match(state.tasks[0]?.blocked?.reason ?? '', /目标 hash 不匹配/)
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; reason?: string })
    assert.ok(events.some(event => event.type === 'eval.done' && /目标 hash 不匹配/.test(event.reason ?? '')))
  })

  test('alternating fail and insufficient verdicts on an unchanged workspace still converge via progress evaluation', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在 | a.ts',
      scopes: { T1: ['a.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'same content')
    const notesPath = join(cwd, 'docs/guard', runId, 'tasks/T1/notes.md')
    const replies = [
      { verdict: 'insufficient', missing: ['缺证据 A'], correction: '措辞一' },
      { verdict: 'fail', violations: [{ type: 'quality', why: '未达标 B' }], missing: [], correction: '措辞二' },
      { verdict: 'insufficient', missing: ['缺证据 C'], correction: '措辞三' },
    ]
    let evalCalls = 0
    let progressCalls = 0
    const base = deps(cwd, runId, {})
    const oscillating = {
      ...base,
      ctx: {
        get(name: string) {
          if (name !== 'llm') return base.ctx.get(name)
          return {
            prepareCall: async (config: Record<string, unknown>) => ({
              config: { provider: 'p', model: 'm', temperature: 0, maxTokens: config.maxTokens },
              stream: (options: { system?: string }) => (async function* () {
                const tasks = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
                let payload: string
                if ((options?.system ?? '').includes('进度审计员')) {
                  progressCalls += 1
                  payload = JSON.stringify({ verdict: 'spinning', reason: 'unchanged tree oscillating' })
                } else {
                  const reply = replies[evalCalls] ?? replies.at(-1)!
                  evalCalls += 1
                  payload = JSON.stringify({
                    goal_hash: tasks.goalHash, criteria: [], violations: [], ...reply, next_action: 'retry',
                  })
                }
                yield { type: 'text-delta', index: 0, text: payload }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
              })(),
            }),
          }
        },
      },
    }
    const attached = await attachSupervisor({ ...oscillating, cwd, runId } as never)
    for (let turn = 0; turn < 3; turn += 1) {
      await writeFile(notesPath, `${await readFile(notesPath, 'utf8')}\n## 完成声明\n轮次 ${turn + 1}\n`, 'utf8')
      await attached.handler()
    }
    assert.equal(evalCalls, 3)
    assert.equal(progressCalls, 1, 'state-based signature must converge despite alternating verdicts and wording')
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'BLOCKED')
    assert.match(state.tasks[0]?.blocked?.reason ?? '', /打转/)
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; reason?: string })
    const evalEvents = events.filter(event => event.type === 'eval.done')
    assert.equal(evalEvents.length, 3)
    assert.match(evalEvents[0]?.reason ?? '', /缺证据 A/)
    assert.match(evalEvents[1]?.reason ?? '', /未达标 B/)
    assert.match(evalEvents[2]?.reason ?? '', /缺证据 C/)
  })

  test('auditTask passes deterministic probe specs, in-scope diff excerpt, and notes to the evaluator', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 加 multiply | 文件含 multiply | src/math.ts',
      scopes: { T1: ['src/math.ts'] },
      probes: [{ id: 'C1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/math.ts' }, enabled: true }],
    })).runId
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src/math.ts'), 'export function multiply(a: number, b: number) { return a * b }\n')
    const notesPath = join(cwd, 'docs/guard', runId, 'tasks/T1/notes.md')
    await writeFile(notesPath, `${await readFile(notesPath, 'utf8')}\n## 完成声明\n已经实现 multiply\n`, 'utf8')

    let capturedPrompt = ''
    const base = deps(cwd, runId, {})
    const capturing = {
      ...base,
      ctx: {
        get(name: string) {
          if (name !== 'llm') return base.ctx.get(name)
          return {
            prepareCall: async () => ({
              config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 4000 },
              stream: (options: { messages?: readonly { content?: readonly { text?: string }[] }[] }) => {
                capturedPrompt = options.messages?.[0]?.content?.[0]?.text ?? ''
                return (async function* () {
                  const tasks = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
                  const payload = JSON.stringify({
                    goal_hash: tasks.goalHash, verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue',
                  })
                  yield { type: 'text-delta', index: 0, text: payload }
                  yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
                })()
              },
            }),
          }
        },
      },
    }
    const attached = await attachSupervisor({ ...capturing, cwd, runId } as never)
    await attached.handler()
    assert.match(capturedPrompt, /file_exists: src\/math\.ts/)
    assert.match(capturedPrompt, /export function multiply/)
    assert.match(capturedPrompt, /已经实现 multiply/)
  })

  test('a workspace with over 200 pre-existing dirty files does not trigger false enforce violations or bloat task rows', async () => {
    const cwd = await repo()
    await mkdir(join(cwd, '.next-cache'), { recursive: true })
    await Promise.all(Array.from({ length: 220 }, (_, i) =>
      writeFile(join(cwd, '.next-cache', `chunk-${String(i).padStart(3, '0')}.js`), `chunk-${i}`)))
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在 | src/a.ts\nT2 | 二 | 文件存在 | src/b.ts',
      enforcement: 'enforce',
      scopes: { T1: ['src/a.ts'], T2: ['src/b.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    })).runId
    const before = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(Object.keys(before.baselineDirty ?? {}).length, 220, 'run-level baseline holds every dirty path')
    assert.equal(Object.keys(before.tasks[0]?.baselineDirty ?? {}).length, 0, 'large baseline is not duplicated onto every task')

    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src/a.ts'), 'export const a = 1\n')
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const after = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(after.tasks[0]?.status, 'DONE', `pre-existing cache must not block T1: ${JSON.stringify(after.tasks[0]?.blocked)}`)
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string })
    assert.ok(!events.some(event => event.type === 'scope.violation'))

    // Negative case: when T2 really writes outside scope, the blocked patch only
    // captures the new dirty file and never sweeps the 220 baseline cache files.
    await writeFile(join(cwd, 'src/b.ts'), 'export const b = 2\n')
    await writeFile(join(cwd, 'rogue.ts'), 'outside scope\n')
    await attached.handler()
    const afterT2 = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(afterT2.tasks[1]?.status, 'BLOCKED')
    const patchRef = afterT2.tasks[1]?.evidence.find(item => item.kind === 'patch')
    assert.ok(patchRef !== undefined, 'blocked patch was captured')
    const patchText = await readFile(join(cwd, 'docs/guard', runId, patchRef?.path ?? ''), 'utf8')
    assert.match(patchText, /rogue\.ts/)
    assert.ok(!patchText.includes('.next-cache/chunk-000.js'), 'unchanged baseline cache must not bloat the blocked patch')
  })

  test('gitignored scope directories still feed deterministic file snapshot, excerpt and fingerprint to the evaluator', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, '.gitignore'), '/_archive/\n')
    await run('git', ['add', '.gitignore'], { cwd })
    await run('git', ['commit', '-qm', 'ignore archive'], { cwd })

    const runId = (await prepareGuardRun(cwd, {
      goal: '逆向分析', acceptance: '00-baseline.md 含版本串', discipline: 'd',
      tasks: 'T1 | 基线固定 | 00-baseline.md 含版本串 | _archive/x9-work',
      probes: [{ id: 'C1', taskId: 'T1', weight: 'heavy', spec: { kind: 'command', cmd: 'test', args: ['-f', '_archive/x9-work/00-baseline.md'] }, enabled: true }],
    })).runId

    await mkdir(join(cwd, '_archive/x9-work/bin'), { recursive: true })
    await writeFile(join(cwd, '_archive/x9-work/00-baseline.md'), '# Baseline\nxuan-daemon 1.6.85\nsha256: 05befeef\n')
    await writeFile(join(cwd, '_archive/x9-work/bin/x9.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]))

    const prompts: string[] = []
    let evalCount = 0
    const base = deps(cwd, runId, {})
    const capturing = {
      ...base,
      ctx: {
        get(name: string) {
          if (name !== 'llm') return base.ctx.get(name)
          return {
            prepareCall: async () => ({
              config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 4000 },
              stream: (options: { messages?: readonly { content?: readonly { text?: string }[] }[] }) => {
                prompts.push(options.messages?.[0]?.content?.[0]?.text ?? '')
                evalCount += 1
                const verdict = evalCount === 1 ? 'insufficient' : 'pass'
                return (async function* () {
                  const tasks = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
                  const payload = JSON.stringify({
                    goal_hash: tasks.goalHash, verdict, criteria: [], violations: [],
                    missing: verdict === 'pass' ? [] : ['need sha256'], correction: '', next_action: 'continue',
                  })
                  yield { type: 'text-delta', index: 0, text: payload }
                  yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
                })()
              },
            }),
          }
        },
      },
    }
    const attached = await attachSupervisor({ ...capturing, cwd, runId } as never)
    // Turn 1: without even writing notes, changing the ignored scope file triggers evaluation.
    await attached.handler()
    assert.equal(evalCount, 1)
    const p1 = prompts[0] ?? ''
    assert.match(p1, /_archive\/x9-work\/00-baseline\.md/)
    assert.match(p1, /ignored_scope_files/)
    assert.match(p1, /xuan-daemon 1\.6\.85/)
    assert.ok(!p1.includes('\u0000'), 'binary files must not leak NUL bytes into the prompt')

    // Turn 2: modifying the ignored file changes scopeFingerprint and triggers re-evaluation.
    await writeFile(join(cwd, '_archive/x9-work/00-baseline.md'), '# Baseline\nxuan-daemon 1.6.85\nsha256: 05befeef full\n')
    await attached.handler()
    assert.equal(evalCount, 2, 'modifying an ignored scope file must advance scopeHash and re-evaluate')
    const after = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(after.tasks[0]?.status, 'DONE')
    // Respect .gitignore: ignored files must NOT be force-added into git HEAD.
    const tracked = await run('git', ['ls-files', '_archive'], { cwd })
    assert.equal(tracked.stdout.trim(), '', 'gitignored artifacts must stay untracked')
  })

  test('auditTurn drains consecutive tasks that already wrote completion claims in the same turn', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 文件存在 | a.ts\nT2 | 二 | 文件存在 | b.ts\nT3 | 三 | 文件存在 | c.ts',
      probes: [
        { id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true },
        { id: 'P2', taskId: 'T2', weight: 'light', spec: { kind: 'file_exists', path: 'b.ts' }, enabled: true },
        { id: 'P3', taskId: 'T3', weight: 'light', spec: { kind: 'file_exists', path: 'c.ts' }, enabled: true },
      ],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'a\n')
    await writeFile(join(cwd, 'b.ts'), 'b\n')
    const notesT1 = join(cwd, 'docs/guard', runId, 'tasks/T1/notes.md')
    const notesT2 = join(cwd, 'docs/guard', runId, 'tasks/T2/notes.md')
    await writeFile(notesT1, `${await readFile(notesT1, 'utf8')}\n## 完成声明\nT1 done\n`)
    await writeFile(notesT2, `${await readFile(notesT2, 'utf8')}\n## 完成声明\nT2 done\n`)
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(state.tasks[0]?.status, 'DONE')
    assert.equal(state.tasks[1]?.status, 'DONE')
    assert.equal(state.tasks[2]?.status, 'TODO', 'T3 has no completion claim so auditTurn stops before starting it')
  })

  test('ignoredScopeExcerpt prioritizes the newest gitignored text artifacts over older alphabetically earlier files', async () => {
    const { utimes } = await import('node:fs/promises')
    const { ignoredScopeExcerpt, ignoredScopeSnapshot } = await import('../../src/host/goal-supervisor/git')
    const cwd = await repo()
    await writeFile(join(cwd, '.gitignore'), 'tmp/\n', 'utf8')
    await run('git', ['add', '.gitignore'], { cwd })
    await run('git', ['commit', '-m', 'ignore tmp'], { cwd })

    await mkdir(join(cwd, 'tmp/work/00-old'), { recursive: true })
    await mkdir(join(cwd, 'tmp/work/zz-docs'), { recursive: true })
    const oldTime = new Date('2026-01-01T00:00:00Z')
    for (let i = 0; i < 32; i += 1) {
      const name = join(cwd, 'tmp/work/00-old', `artifact-${String(i).padStart(2, '0')}.md`)
      await writeFile(name, `old filler ${i} `.repeat(30), 'utf8')
      await utimes(name, oldTime, oldTime)
    }
    const freshPath = join(cwd, 'tmp/work/zz-docs/fresh-report.md')
    await writeFile(freshPath, '# Fresh Report\nANCHOR_MAPPING_VERIFIED: 0x10148a914 -> 0x101487bb4\n', 'utf8')
    const freshTime = new Date('2026-11-26T20:00:00Z')
    await utimes(freshPath, freshTime, freshTime)

    // Even a brand-new binary file must be skipped without blocking the newest text artifact.
    const binPath = join(cwd, 'tmp/work/zz-docs/newest.bin')
    await writeFile(binPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))
    const newestTime = new Date('2026-11-26T20:05:00Z')
    await utimes(binPath, newestTime, newestTime)

    const snapshot = await ignoredScopeSnapshot(cwd, ['tmp/work'], 'docs/guard/r1')
    // Snapshot itself stays alphabetically sorted so scopeFingerprint remains deterministic.
    assert.deepEqual(
      snapshot.map(item => item.path),
      [...snapshot.map(item => item.path)].sort((a, b) => a.localeCompare(b)),
    )
    assert.ok(snapshot.every(item => typeof item.mtimeMs === 'number' && Number.isFinite(item.mtimeMs)))

    const excerpt = await ignoredScopeExcerpt(cwd, snapshot, 2500)
    assert.ok(excerpt.includes('tmp/work/zz-docs/fresh-report.md'), `newest artifact must appear in excerpt: ${excerpt}`)
    assert.ok(excerpt.includes('ANCHOR_MAPPING_VERIFIED'), `newest artifact body must not be squeezed out: ${excerpt}`)
    assert.ok(!excerpt.includes('\u0000'), 'binary files must never leak NUL bytes')

    // Fallback: entries without mtimeMs still produce deterministic path-ordered output.
    const synthetic = [
      { path: 'tmp/work/zz-docs/fresh-report.md', size: 64, fingerprint: 'a' },
      { path: 'tmp/work/00-old/artifact-00.md', size: 64, fingerprint: 'b' },
    ]
    const fallback = await ignoredScopeExcerpt(cwd, synthetic, 2500)
    assert.ok(
      fallback.indexOf('00-old/artifact-00.md') < fallback.indexOf('zz-docs/fresh-report.md'),
      'missing mtimeMs falls back to alphabetical order',
    )
  })

  test('appending substantive notes after an insufficient verdict triggers re-evaluation without repeating the heading', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 补证重评 | 测试清单齐全 | a.ts',
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'export const x = 1\n')

    let evalCount = 0
    const base = deps(cwd, runId, {})
    const sequenced = {
      ...base,
      ctx: {
        get(name: string) {
          if (name !== 'llm') return base.ctx.get(name)
          return {
            prepareCall: async () => ({
              config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 4000 },
              stream: () => {
                evalCount += 1
                const verdict = evalCount === 1 ? 'insufficient' : 'pass'
                return (async function* () {
                  const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
                  const payload = JSON.stringify({
                    goal_hash: state.goalHash,
                    verdict,
                    criteria: [],
                    violations: [],
                    missing: verdict === 'pass' ? [] : ['需要测试清单'],
                    correction: verdict === 'pass' ? '' : '补齐测试清单',
                    next_action: 'continue',
                  })
                  yield { type: 'text-delta', index: 0, text: payload }
                  yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
                })()
              },
            }),
          }
        },
      },
    }

    const attached = await attachSupervisor({ ...sequenced, cwd, runId } as never)
    // Turn 1: initial evaluation returns insufficient.
    await attached.handler()
    assert.equal(evalCount, 1)
    assert.equal(attached.state.tasks[0]?.status, 'IN_PROGRESS')

    // Adversarial: appending whitespace only must NOT re-evaluate.
    const notesPath = join(cwd, 'docs/guard', runId, 'tasks/T1/notes.md')
    await writeFile(notesPath, `${await readFile(notesPath, 'utf8')}\n   \n`, 'utf8')
    await attached.handler()
    assert.equal(evalCount, 1, 'whitespace-only notes append must not trigger re-evaluation')

    // Positive: appending real evidence without repeating "## 完成声明" and without
    // modifying a.ts immediately triggers re-evaluation and finishes the task.
    await writeFile(notesPath, `${await readFile(notesPath, 'utf8')}cargo test -- --list: 57 tests passed\n`, 'utf8')
    await attached.handler()
    assert.equal(evalCount, 2, 'substantive notes evidence after insufficient must trigger re-evaluation')
    assert.equal(attached.state.tasks[0]?.status, 'DONE')
    assert.equal(attached.state.status, 'completed')

    // Completed run also synchronizes run.json phase to 'completed' and refuses overwrite.
    const metaAfterDone = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'run.json'), 'utf8')) as { phase: string }
    assert.equal(metaAfterDone.phase, 'completed')

    // Rolling back the completed run resets run.json phase back to 'running'.
    const { rollbackRun } = await import('../../src/host/goal-supervisor/rollback')
    const rolled = await rollbackRun({ cwd, runId })
    assert.equal(rolled.ok, true)
    const metaAfterRollback = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'run.json'), 'utf8')) as { phase: string }
    assert.equal(metaAfterRollback.phase, 'running')
  })

  test('plain WIP notes on a task whose last attempt was not evaluated do not trigger premature evaluation', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 草稿笔记 | 文件存在 | a.ts',
      probes: [{ id: 'P1', taskId: 'T1', weight: 'heavy', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId

    let evalCount = 0
    const base = deps(cwd, runId, {})
    const counting = {
      ...base,
      ctx: {
        get(name: string) {
          if (name !== 'llm') return base.ctx.get(name)
          return {
            prepareCall: async () => ({
              config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 4000 },
              stream: () => {
                evalCount += 1
                return (async function* () {
                  const state = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
                  const payload = JSON.stringify({
                    goal_hash: state.goalHash, verdict: 'pass', criteria: [], violations: [],
                    missing: [], correction: '', next_action: 'continue',
                  })
                  yield { type: 'text-delta', index: 0, text: payload }
                  yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
                })()
              },
            }),
          }
        },
      },
    }
    const attached = await attachSupervisor({ ...counting, cwd, runId } as never)
    // Turn 1: probe fails (a.ts missing), so no evaluation runs.
    await attached.handler()
    assert.equal(evalCount, 0)
    // Appending WIP notes while probe still fails must NOT trigger evaluation.
    const notesPath = join(cwd, 'docs/guard', runId, 'tasks/T1/notes.md')
    await writeFile(notesPath, `${await readFile(notesPath, 'utf8')}WIP: still investigating\n`, 'utf8')
    await attached.handler()
    assert.equal(evalCount, 0)
  })
})

describe('goal-supervisor settle and resume', () => {
  test('settle writes run.json phase completed when every task is already DONE', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const tasksPath = join(cwd, 'docs/guard', runId, 'tasks.json')
    const before = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    // A ledger that is finished but whose run record was never advanced (the
    // batch is empty, so `settle` is the only place that can finish it).
    await writeFile(tasksPath, JSON.stringify({
      ...before,
      status: 'active',
      activeTaskIds: [],
      tasks: before.tasks.map(task => ({ ...task, status: 'DONE' })),
    }, null, 2), 'utf8')
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const meta = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'run.json'), 'utf8')) as { phase: string }
    assert.equal(meta.phase, 'completed', 'a finished ledger must not leave run.json phase stuck at running')
    const after = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.equal(after.status, 'completed')
  })

  test('resumeBlockedRun refuses a milestone-blocked all-DONE run with a structured code', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const store = new GuardStore(join(cwd, 'docs/guard', runId))
    const before = await store.readState()
    assert.ok(before !== null)
    await store.update({
      ...before,
      status: 'blocked',
      goalBlocked: '里程碑审阅未通过（第 1 轮）：见 review/round-1.md',
      tasks: before.tasks.map(task => ({ ...task, status: 'DONE' })),
    })
    const outcome = await resumeBlockedRun(store)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false ? outcome.code : '', 'milestone-pending')
    assert.match(outcome.ok === false ? outcome.reason : '', /里程碑审阅未通过/)
    const after = await store.readState()
    assert.equal(after?.status, 'blocked', 'the refused resume must not reopen the ledger')
    assert.ok(after?.goalBlocked !== undefined)
  })

  test('resumeBlockedRun still resumes a run that has a BLOCKED task', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const store = new GuardStore(join(cwd, 'docs/guard', runId))
    const before = await store.readState()
    assert.ok(before !== null)
    await store.update({
      ...before,
      status: 'blocked',
      goalBlocked: 'T1 已阻塞：评估器不可用',
      tasks: before.tasks.map(task => ({ ...task, status: 'BLOCKED' })),
    })
    const outcome = await resumeBlockedRun(store)
    assert.equal(outcome.ok, true)
    const after = await store.readState()
    assert.equal(after?.status, 'active')
    assert.equal(after?.tasks[0]?.status, 'IN_PROGRESS')
  })

  test('a pure status-blocked ledger (no goalBlocked, no BLOCKED row) is resumable', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const store = new GuardStore(join(cwd, 'docs/guard', runId))
    const before = await store.readState()
    assert.ok(before !== null)
    // The card treats `status: 'blocked'` as blocked and offers "continue"; the
    // backend used to answer `not-blocked` for exactly this ledger, so the button
    // was a guaranteed no-op.
    await store.update({
      ...before,
      status: 'blocked',
      goalBlocked: undefined,
      goalBlockKind: undefined,
      tasks: before.tasks.map(task => ({ ...task, status: 'TODO' })),
      activeTaskIds: [],
    })
    const state = await store.readState()
    assert.ok(state !== null)
    assert.deepEqual(canResume(state), { ok: true })
    const outcome = await resumeBlockedRun(store)
    assert.equal(outcome.ok, true)
    const after = await store.readState()
    assert.equal(after?.status, 'active')
    assert.equal(after?.tasks[0]?.status, 'TODO', 'there was no BLOCKED row to reopen')
  })
})

describe('goal-supervisor witness image order', () => {
  test('ignored screenshots are offered to the witness newest-first, not alphabetically', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, '.gitignore'), 'shots/\n')
    await mkdir(join(cwd, 'shots'), { recursive: true })
    const now = Date.now()
    const files = Array.from({ length: 6 }, (_, index) => `shot-${index}.png`)
    for (const [index, name] of files.entries()) {
      const path = join(cwd, 'shots', name)
      await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, index]))
      const stamp = new Date(now - (files.length - index) * 60_000)
      await utimes(path, stamp, stamp)
    }
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 截图 | 截图已更新 | shots/**',
      scopes: { T1: ['shots/**'] },
      milestoneEvery: 100,
      visual: { enabled: true },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'shots/shot-5.png' }, enabled: true }],
    })).runId
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; images?: { path: string }[] })
    const witness = events.filter(event => event.type === 'visual.witness').at(-1)
    assert.ok(witness !== undefined, 'the witness ran for the screenshots')
    const images = (witness.images ?? []).map(image => image.path)
    assert.equal(images.length, 5, 'the witness reads at most five images')
    assert.equal(images[0], 'shots/shot-5.png', 'the newest screenshot is offered first')
    assert.ok(!images.includes('shots/shot-0.png'), 'the oldest alphabetical screenshot must not crowd out the newest')
  })

  test('git-visible screenshots are offered newest-first too, not in git-status order', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 截图 | 截图已更新 | shots/**',
      scopes: { T1: ['shots/**'] },
      milestoneEvery: 100,
      visual: { enabled: true },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'shots/shot-5.png' }, enabled: true }],
    })).runId
    // Written AFTER prepare: a pre-existing dirty file would be excluded from
    // this task's changed set by the baseline.
    await mkdir(join(cwd, 'shots'), { recursive: true })
    const now = Date.now()
    const files = Array.from({ length: 6 }, (_, index) => `shot-${index}.png`)
    for (const [index, name] of files.entries()) {
      const path = join(cwd, 'shots', name)
      await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, index]))
      const stamp = new Date(now - (files.length - index) * 60_000)
      await utimes(path, stamp, stamp)
    }
    const attached = await attachSupervisor({ ...deps(cwd, runId, {}), cwd, runId } as never)
    await attached.handler()
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; images?: { path: string }[] })
    const witness = events.filter(event => event.type === 'visual.witness').at(-1)
    assert.ok(witness !== undefined, 'the witness ran for the git-visible screenshots')
    const images = (witness.images ?? []).map(image => image.path)
    assert.equal(images.length, 5, 'the witness reads at most five images')
    assert.equal(images[0], 'shots/shot-5.png', 'the newest git-visible screenshot is offered first')
    assert.ok(!images.includes('shots/shot-0.png'), 'the oldest git-visible screenshot must not crowd out the newest')
  })

  test('imageCandidates keeps git-visible changes ahead of the ignored recency order', () => {
    assert.deepEqual(
      imageCandidates(['src/a.png', 'README.md'], [{ path: 'shots/new.png' }, { path: 'shots/old.png' }]),
      ['src/a.png', 'shots/new.png', 'shots/old.png'],
    )
    assert.deepEqual(imageCandidates(['a.ts'], []), [])
  })
})

describe('goal-supervisor milestone gate', () => {
  /** A run whose first milestone review fails while later tasks are still open. */
  async function milestoneBlockedRun(reviewers: readonly ('pass' | 'fail')[]): Promise<{
    readonly cwd: string
    readonly runId: string
    readonly store: GuardStore
  }> {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过\nT2 | 二 | 通过',
      milestoneEvery: 1,
      scopes: { T1: ['a.ts'], T2: ['b.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'a')
    const attached = await attachSupervisor({ ...deps(cwd, runId, { reviewers }), cwd, runId } as never)
    await attached.handler()
    return { cwd, runId, store: new GuardStore(join(cwd, 'docs/guard', runId)) }
  }

  test('a mid-run milestone failure records its source and cannot be continued past the gate', async () => {
    const { store, runId } = await milestoneBlockedRun(['fail'])
    const blocked = await store.readState()
    assert.equal(blocked?.status, 'blocked')
    assert.equal(blocked?.goalBlockKind, 'milestone', 'the block carries its source, not just prose')
    assert.match(blocked?.goalBlocked ?? '', /里程碑审阅未通过/)
    // T2 is still TODO. The old all-DONE guard let `guard.continue` clear this
    // block and run on, silently skipping the failed review.
    assert.equal(blocked?.tasks[1]?.status, 'TODO')

    const outcome = await resumeBlockedRun(store)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false ? outcome.code : '', 'milestone-pending')
    const after = await store.readState()
    assert.equal(after?.status, 'blocked', 'the refused resume leaves the ledger blocked')
    assert.ok(after?.goalBlocked !== undefined)
    // The run id is exercised so a future refactor cannot stop reading it.
    assert.equal(after?.runId, runId)
  })

  test('a legacy mid-run milestone block (prose only, no goalBlockKind) is still refused', async () => {
    const { cwd, runId } = await milestoneBlockedRun(['pass'])
    const store = new GuardStore(join(cwd, 'docs/guard', runId))
    const before = await store.readState()
    assert.ok(before !== null)
    // A ledger written before `goalBlockKind` existed: one task DONE, one TODO,
    // a run-level block whose reason is the only evidence of a failed review.
    await store.update({
      ...before,
      status: 'blocked',
      goalBlocked: '里程碑审阅未通过（第 1 轮）：见 review/round-1.md',
      tasks: before.tasks.map((task, index) => ({ ...task, status: index === 0 ? 'DONE' : 'TODO' })),
    })
    const outcome = await resumeBlockedRun(store)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false ? outcome.code : '', 'milestone-pending')
  })

  test('a parallel BLOCKED sibling cannot carry a milestone block past the gate', async () => {
    const { cwd, runId } = await milestoneBlockedRun(['pass'])
    const store = new GuardStore(join(cwd, 'docs/guard', runId))
    const before = await store.readState()
    assert.ok(before !== null)
    // A parallel batch: T1 blocked while sibling T2 finished and a later review
    // failed. The block's PROSE deliberately avoids the legacy Chinese phrase —
    // only `goalBlockKind` classifies it, and the old gate skipped its check
    // whenever any BLOCKED row existed.
    const milestone = 'milestone review failed (round 1): see review/round-1.md'
    await store.update({
      ...before,
      status: 'blocked',
      goalBlocked: milestone,
      goalBlockKind: 'milestone',
      tasks: [
        {
          ...before.tasks[0]!,
          status: 'BLOCKED',
          blocked: { reason: '评估器不可用', next: '继续', remainingCandidates: [], at: 1 },
        },
        { ...before.tasks[1]!, status: 'DONE' },
      ],
      activeTaskIds: [],
    })
    const tasksPath = join(cwd, 'docs/guard', runId, 'tasks.json')
    const eventsPath = join(cwd, 'docs/guard', runId, 'state.jsonl')
    const ledgerBefore = await readFile(tasksPath, 'utf8')
    const eventsBefore = await readFile(eventsPath, 'utf8')
    const fixture = await store.readState()
    assert.ok(fixture !== null)
    assert.deepEqual(canResume(fixture), {
      ok: false,
      code: 'milestone-pending',
      reason: '里程碑审阅未通过：请先回退并重开相关任务修复缺陷，不能直接继续',
    })
    // The BLOCKED sibling is exactly what the old gate treated as "resumable":
    // it cleared the milestone flag and reopened T1 without the review passing.
    const outcome = await resumeBlockedRun(store)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false ? outcome.code : '', 'milestone-pending')
    assert.equal(await readFile(tasksPath, 'utf8'), ledgerBefore, 'the refused resume is not a side effect')
    assert.equal(await readFile(eventsPath, 'utf8'), eventsBefore, 'no run.resumed event is written')
    const after = await store.readState()
    assert.equal(after?.status, 'blocked')
    assert.equal(after?.goalBlockKind, 'milestone')
    assert.equal(after?.tasks[0]?.status, 'BLOCKED', 'the sibling is not reopened past the gate')
  })

  test('resuming a run-level unrunnable block clears the kind so it does not linger', async () => {
    const { cwd, runId } = await milestoneBlockedRun(['pass'])
    const store = new GuardStore(join(cwd, 'docs/guard', runId))
    const before = await store.readState()
    assert.ok(before !== null)
    await store.update({
      ...before,
      status: 'blocked',
      goalBlocked: '没有可执行的任务',
      goalBlockKind: 'unrunnable',
      tasks: before.tasks.map(task => ({ ...task, status: 'TODO' })),
    })
    const outcome = await resumeBlockedRun(store)
    assert.equal(outcome.ok, true)
    assert.equal((await store.readState())?.goalBlockKind, undefined, 'the resume flag does not survive recovery')
  })
})

describe('goal-supervisor runtime config merge', () => {
  function runtimeState(over: Partial<GuardState> = {}): GuardState {
    return {
      version: 1, runId: 'r1', goal: 'g', acceptance: 'a', discipline: 'd', goalHash: 'h',
      tasks: [], activeTaskIds: [], parallel: 1, enforcement: 'warn-only', worktree: { enabled: false },
      milestoneEvery: 3, status: 'active', createdAt: 1, updatedAt: 1, ...over,
    }
  }

  test('an audit snapshot never overwrites a concurrent runtime switch', () => {
    // The audit read this snapshot, then spent seconds on probes/evaluation.
    const stale = runtimeState({ status: 'blocked', updatedAt: 20 })
    // Meanwhile `guard.switch` wrote these six fields under the store lock.
    const current = runtimeState({
      evaluator: { provider: 'p-eval', model: 'm-eval' },
      evaluatorFallback: { provider: 'p-eval-fb', model: 'm-eval-fb' },
      executor: { provider: 'p-exec', model: 'm-exec' },
      executorFallback: { provider: 'p-exec-fb', model: 'm-exec-fb' },
      activeExecutor: { provider: 'p-live', model: 'm-live', reasoningEffort: 'high' },
      visual: { enabled: true },
      updatedAt: 30,
    })
    const merged = mergeRuntimeConfig(stale, current)
    assert.deepEqual(merged.evaluator, current.evaluator)
    assert.deepEqual(merged.evaluatorFallback, current.evaluatorFallback)
    assert.deepEqual(merged.executor, current.executor)
    assert.deepEqual(merged.executorFallback, current.executorFallback)
    assert.deepEqual(merged.activeExecutor, current.activeExecutor)
    assert.deepEqual(merged.visual, current.visual)
    // Everything else is what this audit computed.
    assert.equal(merged.status, 'blocked')
    assert.equal(merged.updatedAt, 20)
  })

  test('a pass write merges the runtime fields of the ledger it found under the lock', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')
    const real = new GuardStore(join(cwd, 'docs/guard', runId))
    // The audit read its snapshot, then a `guard.switch` lands while probes and
    // the evaluator run. The locked write must merge the CURRENT route fields
    // instead of writing the stale snapshot back over them.
    const racing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'mutate') {
          return async (apply: (state: GuardState) => unknown): Promise<GuardState | null> => {
            const current = await target.readState()
            if (current === null) return null
            const switched: GuardState = {
              ...current,
              evaluator: { provider: 'p-live', model: 'm-live' },
              updatedAt: Date.now(),
            }
            await target.update(switched)
            const applied = apply(switched) as
              | GuardState
              | { readonly state: GuardState; readonly events?: readonly never[] }
              | null
            if (applied === null) return switched
            const next = 'state' in applied ? applied.state : applied
            await target.update(next, 'state' in applied ? applied.events ?? [] : [])
            return next
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    }) as unknown as GuardStore

    const outcome = await auditTask({ ...deps(cwd, runId, {}), cwd, runId, store: racing }, 'T1')
    assert.ok(outcome !== null, 'the pass write completed')
    const after = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.deepEqual(after.evaluator, { provider: 'p-live', model: 'm-live' },
      'the concurrent switch survives the audit write')
    assert.equal(after.tasks[0]?.status, 'DONE')
  })

  test('a vanished ledger aborts the pass write before any commit or tag', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')
    const real = new GuardStore(join(cwd, 'docs/guard', runId))
    let completed = 0
    // The ledger is deleted between the audit's read and its write: `mutate`
    // answers null, which must abort the audit instead of pretending the
    // computed DONE was committed.
    const vanishing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'mutate') return async () => null
        return Reflect.get(target, prop, receiver) as unknown
      },
    }) as unknown as GuardStore

    const outcome = await auditTask({ ...deps(cwd, runId, () => { completed += 1 }), cwd, runId, store: vanishing }, 'T1')
    assert.equal(outcome, null, 'the audit reports the missing ledger instead of a state')
    assert.equal(completed, 0, 'the host goal is not completed')
    const log = await run('git', ['log', '--oneline'], { cwd })
    assert.equal(log.stdout.trim().split('\n').length, 1, 'no task commit was created')
    const tags = await run('git', ['tag', '-l'], { cwd })
    assert.equal(tags.stdout.trim(), '', 'no checkpoint tag was created')
    const after = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.notEqual(after.tasks[0]?.status, 'DONE', 'the on-disk ledger is untouched')
  })
})

// Round-14 P2-1: a vanished ledger must propagate as "no result" through the
// WHOLE audit turn, and a host-side block is a consequence of a persisted block,
// never a side effect that runs before the write.
describe('goal-supervisor audit turn and null ledgers', () => {
  test('auditTurn returns null when a task audit loses the ledger instead of settling a stale snapshot', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')
    const real = new GuardStore(join(cwd, 'docs/guard', runId))
    let completed = 0
    let blocked = 0
    // Every write is lost (the ledger vanished between the audit's read and its
    // write). `auditTask` correctly answers null — `auditTurn` must pass that on
    // instead of settling the pre-audit snapshot and reporting success.
    const vanishing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'mutate') return async () => null
        return Reflect.get(target, prop, receiver) as unknown
      },
    }) as unknown as GuardStore

    const outcome = await auditTurn({
      ...deps(cwd, runId, { complete: () => { completed += 1 }, block: () => { blocked += 1 } }),
      cwd,
      runId,
      store: vanishing,
    })
    assert.equal(outcome, null, 'a vanished ledger is not a successfully settled turn')
    assert.equal(completed, 0, 'the host goal is not completed from a stale snapshot')
    assert.equal(blocked, 0)
  })

  test('a ledger that vanishes before the blocked write must not stop the host goal', async () => {
    const cwd = await repo()
    const runId = await prepared(cwd)
    const real = new GuardStore(join(cwd, 'docs/guard', runId))
    const stored = await real.readState()
    assert.ok(stored !== null)
    // No runnable task, so `settle` wants to stop the run and write a blocked
    // ledger. The block flag is still cleared: this is an ordinary stall.
    await real.update({
      ...stored,
      status: 'active',
      goalBlocked: undefined,
      goalBlockKind: undefined,
      activeTaskIds: [],
      tasks: stored.tasks.map(task => ({
        ...task,
        status: 'BLOCKED',
        blocked: { reason: '卡住', next: '回退', remainingCandidates: [], at: 1 },
      })),
    })
    let reads = 0
    // The audit reads its one snapshot, then the ledger disappears before the
    // blocked write can land (another process, or a revert of a commit carrying
    // tasks.json).
    const vanishing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'readState') {
          return async () => {
            const state = await target.readState()
            if (++reads === 1) await rm(target.tasksPath)
            return state
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    }) as unknown as GuardStore

    let blocked = 0
    const outcome = await auditTurn({
      ...deps(cwd, runId, { block: () => { blocked += 1 } }),
      cwd,
      runId,
      store: vanishing,
    })
    assert.equal(outcome, null, 'the missing ledger is reported, not a settled state')
    assert.equal(blocked, 0, 'the host goal is not stopped when its block cannot be persisted')
  })

  test('a milestone block that cannot be persisted does not stop the host goal', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 一 | 通过\nT2 | 二 | 通过',
      milestoneEvery: 1,
      scopes: { T1: ['a.ts'], T2: ['b.ts'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'a')
    const real = new GuardStore(join(cwd, 'docs/guard', runId))
    // `review.milestone` is appended immediately before the blocked ledger
    // write. Dropping the ledger there makes that write answer null: the host
    // goal must then stay untouched, because nothing records the block.
    const vanishing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'appendEvents') {
          return async (events: readonly { type?: string }[]) => {
            await target.appendEvents(events as never)
            if (events.some(event => event.type === 'review.milestone')) await rm(target.tasksPath)
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    }) as unknown as GuardStore

    let blocked = 0
    const outcome = await auditTurn({
      ...deps(cwd, runId, { reviewers: ['fail'], block: () => { blocked += 1 } }),
      cwd,
      runId,
      store: vanishing,
    })
    assert.equal(outcome, null, 'a failed review whose ledger write vanished is not an audit result')
    assert.equal(blocked, 0, 'the host goal is not stopped by an unrecorded milestone failure')
  })
})

describe('visual evidence requirement', () => {
  const taskWith = (acceptance: string[]): Parameters<typeof needsVisualEvidence>[0] => ({
    id: 'T1', title: '任务', status: 'IN_PROGRESS', scope: [], dependsOn: [], acceptance,
    probes: [], requiredProbes: [], probeResults: {}, evidence: [], attempts: [],
    scopeApprovedCount: 0, baselineDirty: {},
  })

  test('only visual acceptance lines make a task require a witness', () => {
    assert.equal(needsVisualEvidence(taskWith(['文件存在', '单测通过'])), false)
    assert.equal(needsVisualEvidence(taskWith(['截图里没有穿模'])), true)
    assert.equal(needsVisualEvidence(taskWith(['有头 UAT 通过'])), true)
    assert.equal(needsVisualEvidence(taskWith(['render matches the mockup'])), true)
    // `mock` inside a unit-test line is not a screenshot requirement: the old
    // substring rule vetoed every "mock 数据" acceptance and made the task
    // impossible to pass.
    assert.equal(needsVisualEvidence(taskWith(['用 mock 数据跑单测'])), false)
  })

  test('a disabled witness never vetoes a model pass, even when acceptance names UAT/render', async () => {
    const cwd = await repo()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd',
      tasks: 'T1 | 渲染验收 | UAT 通过且 render 与设计稿一致',
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'ok')
    const attached = await attachSupervisor({ ...deps(cwd, runId), cwd, runId } as never)
    await attached.handler()
    const ledger = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    // Visual evidence is opt-in per run. When it is off, `runVisualWitness`
    // returns undefined — that is "nothing was promised", not "the promised
    // evidence is missing", so a pass must stand.
    assert.equal(ledger.tasks[0]?.status, 'DONE')
    assert.equal(ledger.status, 'completed')
  })
})


// A supervised run must survive thousands of rounds without a human, and must
// NOT burn them on a task that produces nothing. These tests pin both halves.
describe('goal-supervisor long-run budget and idle convergence', () => {
  test('a heavy-only task is not re-probed while nothing changes, and idle audits block instead of spinning', async () => {
    const cwd = await repo()
    const runId = await preparedHeavy(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')
    const store = new GuardStore(join(cwd, 'docs/guard', runId))
    const d = { ...deps(cwd, runId, { evaluate: 'fail' }), cwd, runId, store }

    await auditTask(d, 'T1')
    for (let i = 0; i < IDLE_STALL_LIMIT; i += 1) await auditTask(d, 'T1')

    const after = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(after.tasks[0]?.status, 'BLOCKED', 'the idle task blocks instead of spinning forever')
    assert.match(after.tasks[0]?.blocked?.reason ?? '', /完成声明/, 'the block names the missing declaration')
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as { type: string })
    assert.equal(events.filter(event => event.type === 'probe.run').length, 1,
      'the heavy probe ran exactly once: an unchanged task is never re-probed')
  })

  test('a scope change resets the idle streak and re-runs the heavy probe', async () => {
    const cwd = await repo()
    const runId = await preparedHeavy(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')
    const store = new GuardStore(join(cwd, 'docs/guard', runId))
    const d = { ...deps(cwd, runId, { evaluate: 'fail' }), cwd, runId, store }

    await auditTask(d, 'T1')
    await auditTask(d, 'T1')
    await auditTask(d, 'T1')
    const stalled = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(stalled.tasks[0]?.idleStreak, 2, 'two idle audits accumulated')

    await writeFile(join(cwd, 'a.ts'), 'changed')
    await auditTask(d, 'T1')
    const after = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(after.tasks[0]?.idleStreak, undefined, 'real work clears the streak')
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as { type: string })
    assert.equal(events.filter(event => event.type === 'probe.run').length, 2, 'the moved scope re-probes')
  })

  test('a progressing run rolls the host goal round budget forward', async () => {
    const cwd = await repo()
    const runId = await preparedTwo(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')
    const api = deps(cwd, runId, {
      goal: { phase: 'active', activation: 'armed', roundsStarted: 1800, maxGoalRounds: 2000 },
    })
    const store = new GuardStore(join(cwd, 'docs/guard', runId))
    const d = { ...api, cwd, runId, store }

    await auditTurn(d)

    assert.equal(api.views.goalEdits.length, 1, 'the low budget is extended once')
    assert.equal(api.views.goalEdits[0]?.maxGoalRounds, 3000, 'the next cap is the roll-over target')
    const events = (await readFile(join(cwd, 'docs/guard', runId, 'state.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as { type: string; from?: number; to?: number })
    const extended = events.find(event => event.type === 'goal.extended')
    assert.ok(extended !== undefined, 'the roll-over is auditable in the event log')
    assert.equal(extended?.from, 2000)
    assert.equal(extended?.to, 3000)
  })

  test('an idle-stalled run never earns a budget extension', async () => {
    const cwd = await repo()
    const runId = await preparedHeavy(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')
    const api = deps(cwd, runId, {
      evaluate: 'fail',
      goal: { phase: 'active', activation: 'armed', roundsStarted: 1900, maxGoalRounds: 2000 },
    })
    const store = new GuardStore(join(cwd, 'docs/guard', runId))
    const d = { ...api, cwd, runId, store }

    await auditTurn(d)
    // The first audit really worked (it evaluated the task), so it may extend.
    // What must never extend is the turn that follows it with nothing to do.
    api.views.goalEdits.length = 0
    await auditTurn(d)

    const after = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(after.tasks[0]?.idleStreak, 1, 'the second turn is the idle one')
    assert.equal(api.views.goalEdits.length, 0, 'spinning must not buy more rounds')
  })
})
