import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import { markFirstMessageDelivered, prepareGuardRun } from '../../src/host/goal-supervisor/create'
import { GuardStore } from '../../src/host/goal-supervisor/store'
import { SAFE_RUN_ID } from '../../src/host/goal-supervisor/run-id'
import type { GuardState, RunMeta, TaskProbeFile } from '../../src/host/goal-supervisor/schema'

const run = promisify(execFile)

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guard-create-'))
  roots.push(root)
  return root
}

const card = {
  goal: '把目标漂移修好',
  acceptance: '所有任务 DONE',
  discipline: '主会话只规划/分派/审查',
  tasks: 'T1 | 状态落盘 | 文件存在;测试通过\nT2 | 创建流程 | 目录骨架存在',
} as const

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

describe('goal-supervisor run creation', () => {
  test('writes the ledger, the rendered page, the skeleton and the run meta', async () => {
    const cwd = await workspace()
    const prepared = await prepareGuardRun(cwd, card)

    assert.match(prepared.runId, /^\d{8}-把目标漂移修好$/)
    assert.equal(prepared.root, join(cwd, 'docs', 'guard', prepared.runId))
    assert.ok(prepared.files.includes('tasks.json'))
    assert.ok(prepared.files.includes('TASKS.md'))
    assert.ok(prepared.files.includes('tasks/T1/notes.md'))
    assert.ok(prepared.files.includes('probes/T2.json'))

    const state = await readJson<GuardState>(join(prepared.root, 'tasks.json'))
    assert.equal(state.runId, prepared.runId)
    assert.equal(state.status, 'active')
    assert.equal(state.parallel, 1)
    assert.equal(state.enforcement, 'warn-only')
    assert.equal(state.tasks.length, 2)
    assert.equal(state.tasks[0]?.status, 'TODO')
    assert.deepEqual(state.tasks[0]?.acceptance, ['文件存在', '测试通过'])

    const meta = await readJson<RunMeta>(join(prepared.root, 'run.json'))
    // `ready`, not `creating`: prepare either finishes or throws, so a run on
    // disk is complete and only waits for its session.
    assert.equal(meta.phase, 'ready')
    assert.equal(meta.setup.goal, false)
    assert.equal(meta.mirror.mode, 'auto')

    const rendered = await readFile(join(prepared.root, 'TASKS.md'), 'utf8')
    assert.match(rendered, /## T1 · 状态落盘/)
    assert.match(rendered, /- 状态：TODO/)

    const notes = await readFile(join(prepared.root, 'tasks', 'T1', 'notes.md'), 'utf8')
    assert.match(notes, /# T1 · 状态落盘/)
    assert.match(notes, /- 验收：\n  - 文件存在/)

    const probes = await readJson<TaskProbeFile>(join(prepared.root, 'probes', 'T1.json'))
    assert.equal(probes.taskId, 'T1')
    assert.deepEqual(probes.probes, [])

    assert.match(await readFile(join(prepared.root, 'logs', '.gitignore'), 'utf8'), /^\*$/m)
    assert.ok((await stat(join(prepared.root, 'review'))).isDirectory())
    assert.ok((await stat(join(prepared.root, 'final-regression'))).isDirectory())

    const events = (await readFile(join(prepared.root, 'state.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(events.length, 1)
    assert.equal((JSON.parse(events[0] ?? '{}') as { type: string }).type, 'run.created')
  })

  test('clamps parallel and honours scope from the table and the map', async () => {
    const cwd = await workspace()
    const prepared = await prepareGuardRun(cwd, {
      ...card,
      parallel: 99,
      tasks: 'T1 | 一条 | 通过 | src/a.ts, src/b.ts',
      scopes: { T1: ['src/c.ts', 'src/a.ts'] },
    })
    const state = await readJson<GuardState>(join(prepared.root, 'tasks.json'))
    assert.equal(state.parallel, 10)
    assert.deepEqual(state.tasks[0]?.scope, ['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })

  test('creates an isolated worktree when requested', async () => {
    const cwd = await workspace()
    await run('git', ['init', '-q'], { cwd })
    await run('git', ['config', 'user.email', 'g@test'], { cwd })
    await run('git', ['config', 'user.name', 'g'], { cwd })
    await writeFile(join(cwd, 'README.md'), 'base')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })

    const prepared = await prepareGuardRun(cwd, { ...card, worktree: true })
    assert.ok(prepared.worktreePath !== undefined)
    assert.ok(prepared.root.startsWith(prepared.worktreePath ?? ''))
    const state = await readJson<GuardState>(join(prepared.root, 'tasks.json'))
    assert.equal(state.worktree.enabled, true)
    assert.equal(state.worktree.branch, `guard/${prepared.runId}`)
    const list = await run('git', ['worktree', 'list'], { cwd })
    assert.match(list.stdout, /\.guard\/worktrees/)
    const exclude = await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8')
    assert.match(exclude, /\.guard\//)
  })

  test('rejects a malformed task table without creating a run', async () => {
    const cwd = await workspace()
    await assert.rejects(() => prepareGuardRun(cwd, { ...card, tasks: 'not a task line' }), /task table/)
    await assert.rejects(() => prepareGuardRun(cwd, { ...card, goal: '   ' }), /goal/)
  })

  test('suffixes a colliding run id', async () => {
    const cwd = await workspace()
    const first = await prepareGuardRun(cwd, card)
    const second = await prepareGuardRun(cwd, card)
    assert.notEqual(first.runId, second.runId)
    assert.match(second.runId, /-2$/)
  })

  test('allows an explicit run id to be retried while creating, but not while running', async () => {
    const cwd = await workspace()
    const prepared = await prepareGuardRun(cwd, { ...card, runId: '20261124-retry' })
    const again = await prepareGuardRun(cwd, { ...card, runId: '20261124-retry' })
    assert.equal(again.runId, prepared.runId)

    const metaPath = join(prepared.root, 'run.json')
    const meta = await readJson<RunMeta>(metaPath)
    await import('node:fs/promises').then(fs => fs.writeFile(metaPath, JSON.stringify({ ...meta, phase: 'running' }), 'utf8'))
    await assert.rejects(() => prepareGuardRun(cwd, { ...card, runId: '20261124-retry' }), /already exists/)
  })

  test('retrying an explicit run id rewrites the ledger from the latest card', async () => {
    const cwd = await workspace()
    const first = await prepareGuardRun(cwd, { ...card, runId: '20261124-rewrite' })
    const rewritten = await prepareGuardRun(cwd, {
      ...card, runId: '20261124-rewrite',
      tasks: 'T9 | 新的任务表 | 通过',
    })
    assert.equal(rewritten.runId, first.runId)
    const state = await readJson<GuardState>(join(rewritten.root, 'tasks.json'))
    assert.deepEqual(state.tasks.map(task => task.id), ['T9'])
    const notes = await readFile(join(rewritten.root, 'tasks', 'T9', 'notes.md'), 'utf8')
    assert.match(notes, /# T9 · 新的任务表/)
  })

  test('parses the optional dependsOn column and rejects unknown or self dependencies', async () => {
    const cwd = await workspace()
    const prepared = await prepareGuardRun(cwd, {
      ...card,
      tasks: 'T1 | 一 | 通过\nT2 | 二 | 通过 | src/b.ts | T1',
    })
    const state = await readJson<GuardState>(join(prepared.root, 'tasks.json'))
    assert.deepEqual(state.tasks[1]?.dependsOn, ['T1'])
    assert.deepEqual(state.tasks[1]?.scope, ['src/b.ts'])
    await assert.rejects(() => prepareGuardRun(cwd, {
      ...card, runId: 'dep-unknown', tasks: 'T1 | 一 | 通过 | | T9',
    }), /task table/)
    await assert.rejects(() => prepareGuardRun(cwd, {
      ...card, runId: 'dep-self', tasks: 'T1 | 一 | 通过 | | T1',
    }), /task table/)
  })

  test('rejects an unsafe explicit run id', async () => {
    const cwd = await workspace()
    await assert.rejects(() => prepareGuardRun(cwd, { ...card, runId: 'bad:name' }), /run id/)
  })

  test('a worktree run never collides with, or overwrites, an existing worktree run', async () => {
    const cwd = await workspace()
    await run('git', ['init', '-q'], { cwd })
    await run('git', ['config', 'user.email', 'g@test'], { cwd })
    await run('git', ['config', 'user.name', 'g'], { cwd })
    await writeFile(join(cwd, 'README.md'), 'base')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })

    const first = await prepareGuardRun(cwd, { ...card, worktree: true })
    // A second prepare with the same goal must get a different run id: the
    // collision scan has to see the worktree directory, not only docs/guard.
    const second = await prepareGuardRun(cwd, { ...card, worktree: true })
    assert.notEqual(second.runId, first.runId)
    assert.notEqual(second.root, first.root)

    // And an explicit id that is already mounted is refused, worktree or not.
    const meta = await readJson<RunMeta>(join(first.root, 'run.json'))
    await writeFile(join(first.root, 'run.json'), JSON.stringify({ ...meta, phase: 'running', sessionId: 's' }), 'utf8')
    await assert.rejects(() => prepareGuardRun(cwd, { ...card, worktree: true, runId: first.runId }), /already exists/)
  })

  test('the initial notes skeleton is excluded from the completion offset', async () => {
    const cwd = await workspace()
    const prepared = await prepareGuardRun(cwd, card)
    const state = await readJson<GuardState>(join(prepared.root, 'tasks.json'))
    const notes = await readFile(join(prepared.root, 'tasks', 'T1', 'notes.md'), 'utf8')
    assert.equal(state.tasks[0]?.lastEvalOffset, notes.length)
    assert.ok(notes.includes('## 完成声明'), 'the guidance stays in the skeleton')
  })

  test('a probe that names an unknown task refuses the run instead of being dropped', async () => {
    const cwd = await workspace()
    await assert.rejects(() => prepareGuardRun(cwd, {
      ...card,
      tasks: 'T1 | 落盘 | 文件存在',
      probes: [{ id: 'C1', taskId: 'T9', weight: 'heavy', spec: { kind: 'command', cmd: 'true', args: [] }, enabled: true }],
    }), /unknown task/)
  })

  test('rewriting a prepared run drops artifacts for tasks the new card removed', async () => {
    const cwd = await workspace()
    const first = await prepareGuardRun(cwd, { ...card, runId: '20261124-prune' })
    const tasksPath = join(first.root, 'tasks.json')
    assert.ok((await stat(join(first.root, 'tasks', 'T2'))).isDirectory())
    await prepareGuardRun(cwd, { ...card, runId: '20261124-prune', tasks: 'T1 | 状态落盘 | 文件存在' })
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    assert.deepEqual(state.tasks.map(task => task.id), ['T1'])
    await assert.rejects(() => stat(join(first.root, 'tasks', 'T2')), /ENOENT/)
    await assert.rejects(() => stat(join(first.root, 'probes', 'T2.json')), /ENOENT/)
    assert.ok((await stat(join(first.root, 'tasks', 'T1'))).isDirectory())
  })

  test('the inline scope column is validated like the programmatic map', async () => {
    const cwd = await workspace()
    await assert.rejects(() => prepareGuardRun(cwd, {
      ...card, runId: 'scope-traversal', tasks: 'T1 | 一条 | 通过 | ../outside.ts',
    }), /task table/)
    await assert.rejects(() => prepareGuardRun(cwd, {
      ...card, runId: 'scope-absolute', tasks: 'T1 | 一条 | 通过 | /etc/passwd',
    }), /task table/)
    // `**` and a top-level wildcard both grant the whole workspace and would
    // bypass every later scope check.
    for (const [runId, glob] of [['scope-broad', '**'], ['scope-star', '*/**'], ['scope-star2', '*/*']]) {
      await assert.rejects(() => prepareGuardRun(cwd, {
        ...card, runId, tasks: `T1 | 一条 | 通过 | ${glob}`,
      }), /task table/)
    }
    // A normal directory glob is still accepted.
    const ok = await prepareGuardRun(cwd, {
      ...card, runId: 'scope-ok', tasks: 'T1 | 一条 | 通过 | src/**',
    })
    const state = await readJson<GuardState>(join(ok.root, 'tasks.json'))
    assert.deepEqual(state.tasks[0]?.scope, ['src/**'])
  })

  test('a run id keeps non-CJK letters so the channel accepts its own ids', async () => {
    const cwd = await workspace()
    // `café`, kana and Hangul all survive `sanitizeRefSegment`; the channel's
    // pattern must accept exactly what this module can mint.
    for (const topic of ['café 重构', 'テスト実行', 'über fix']) {
      const prepared = await prepareGuardRun(cwd, { ...card, goal: topic, tasks: 'T1 | 一条 | 通过' })
      assert.equal(SAFE_RUN_ID.test(prepared.runId), true, `${prepared.runId} must pass the shared pattern`)
      assert.equal(prepared.runId.startsWith('-'), false, 'a run id never looks like a flag')
    }
  })

  test('a dependency cycle is refused instead of deadlocking the run', async () => {
    const cwd = await workspace()
    await assert.rejects(() => prepareGuardRun(cwd, {
      ...card, runId: 'cycle',
      tasks: 'T1 | 一 | 通过 | | T2\nT2 | 二 | 通过 | | T1',
    }), /task table/)
  })
})

  test('markFirstMessageDelivered flips setup.firstMessage once and is idempotent', async () => {
    const cwd = await workspace()
    const prepared = await prepareGuardRun(cwd, card)
    const metaPath = join(prepared.root, 'run.json')
    const before = await readJson<RunMeta>(metaPath)
    assert.equal(before.setup.firstMessage, false)

    await markFirstMessageDelivered(cwd, prepared.runId)
    const after = await readJson<RunMeta>(metaPath)
    assert.equal(after.setup.firstMessage, true, 'the card can now tell an armed run from a stalled one')

    // A second call is a no-op (and must not rewrite the phase).
    const stamp = after.updatedAt
    await markFirstMessageDelivered(cwd, prepared.runId)
    assert.equal((await readJson<RunMeta>(metaPath)).updatedAt, stamp)

    // A missing run is not an error: the caller's fire-and-forget path must not
    // fail a session start.
    await markFirstMessageDelivered(cwd, 'no-such-run')
  })

// Round-9 fix: the first-message marker must be merged into the LATEST meta, or
// the first turn's mirror sync erases it (and the mirror identity with it).
describe('goal-supervisor first message marker', () => {
  test('does not erase a concurrent mirror update', async () => {
    const cwd = await workspace()
    const preparedRun = await prepareGuardRun(cwd, card)
    const store = new GuardStore(preparedRun.root)
    await Promise.all([
      markFirstMessageDelivered(cwd, preparedRun.runId),
      store.updateMeta(current => ({
        ...current,
        mirror: { ...current.mirror, provider: 'github', host: 'github.com' },
        updatedAt: 9,
      })),
    ])
    const merged = await readJson<RunMeta>(join(preparedRun.root, 'run.json'))
    assert.equal(merged.setup.firstMessage, true)
    assert.equal(merged.mirror.provider, 'github')
    assert.equal(merged.mirror.host, 'github.com')
  })
})
