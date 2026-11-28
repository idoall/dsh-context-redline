import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import { markFirstMessageDelivered, prepareGuardRun } from '../../src/host/goal-supervisor/create'
import { excludeRunWorktreeRoot } from '../../src/host/goal-supervisor/git'
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

  test('creates an isolated worktree under .guard/worktrees and ignores it locally', async () => {
    const cwd = await workspace()
    await run('git', ['init', '-q'], { cwd })
    await run('git', ['config', 'user.email', 'g@test'], { cwd })
    await run('git', ['config', 'user.name', 'g'], { cwd })
    await writeFile(join(cwd, 'README.md'), 'base')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    // The main checkout keeps its branch and its uncommitted work.
    await writeFile(join(cwd, 'README.md'), 'dirty-before-run')

    const prepared = await prepareGuardRun(cwd, { ...card, worktree: true })
    const worktree = prepared.worktreePath ?? ''
    assert.equal(worktree, join(cwd, '.guard', 'worktrees', prepared.runId))
    assert.equal(prepared.root, join(worktree, 'docs', 'guard', prepared.runId))
    const state = await readJson<GuardState>(join(prepared.root, 'tasks.json'))
    assert.equal(state.worktree.enabled, true)
    assert.equal(state.worktree.branch, `guard/${prepared.runId}`)
    assert.equal(state.worktree.path, worktree)

    // The main checkout never moves, never loses its dirty file, and never gets an empty docs/guard dir.
    assert.equal((await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim(), 'main')
    assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), 'dirty-before-run')
    await assert.rejects(() => stat(join(cwd, 'docs', 'guard')))

    // The worktree is a real checkout on its own branch ...
    assert.equal((await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree })).stdout.trim(), `guard/${prepared.runId}`)
    assert.match((await run('git', ['worktree', 'list'], { cwd })).stdout, /\.guard\/worktrees/)

    // ... and git ignores it, so it can never be committed with the project.
    assert.match(await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8'), /^\.guard\/$/m)
    // Resolving (instead of throwing) is the assertion: `check-ignore` exits 0
    // only for a path git really ignores.
    await run('git', ['check-ignore', '-q', '.guard/worktrees/x'], { cwd })
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

  test('rejects an unsafe explicit run id without creating docs/guard', async () => {
    const cwd = await workspace()
    await assert.rejects(() => prepareGuardRun(cwd, { ...card, runId: 'bad:name' }), /run id/)
    await assert.rejects(() => stat(join(cwd, 'docs', 'guard')))
  })

  test('a worktree-isolated run never collides with, overwrites, or switches checkout mode on retries', async () => {
    const cwd = await workspace()
    await run('git', ['init', '-q'], { cwd })
    await run('git', ['config', 'user.email', 'g@test'], { cwd })
    await run('git', ['config', 'user.name', 'g'], { cwd })
    await writeFile(join(cwd, 'README.md'), 'base')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })

    const first = await prepareGuardRun(cwd, { ...card, worktree: true })
    // A second prepare with the same goal must get a different run id and branch.
    const second = await prepareGuardRun(cwd, { ...card, worktree: true })
    assert.notEqual(second.runId, first.runId)
    assert.notEqual(second.root, first.root)
    assert.notEqual(second.worktreePath, first.worktreePath)
    // Minting a second run never switches the main checkout away.
    assert.equal((await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim(), 'main')

    // An explicit id that is already mounted is refused BEFORE touching git branch.
    const meta = await readJson<RunMeta>(join(first.root, 'run.json'))
    await writeFile(join(first.root, 'run.json'), JSON.stringify({ ...meta, phase: 'running', sessionId: 's' }), 'utf8')
    await assert.rejects(() => prepareGuardRun(cwd, { ...card, worktree: true, runId: first.runId }), /already exists/)
    assert.equal((await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim(), 'main')

    // Retrying a still-ready explicit run reuses the same worktree instead of adding another.
    const retried = await prepareGuardRun(cwd, { ...card, worktree: true, runId: second.runId, tasks: 'T9 | 改表 | 通过' })
    assert.equal(retried.runId, second.runId)
    assert.equal(retried.worktreePath, second.worktreePath)
    const mounted = (await run('git', ['worktree', 'list'], { cwd })).stdout.split('\n').filter(line => line.includes('.guard/worktrees/'))
    assert.equal(mounted.length, 2)

    // Switching checkout mode (worktree <-> main) with the same runId is refused so dual ledgers never form.
    await assert.rejects(() => prepareGuardRun(cwd, { ...card, worktree: false, runId: second.runId }), /already exists/)
    const mainRun = await prepareGuardRun(cwd, { ...card, worktree: false, runId: '20261127-main-only' })
    assert.equal(mainRun.worktreePath, undefined)
    await assert.rejects(() => prepareGuardRun(cwd, { ...card, worktree: true, runId: '20261127-main-only' }), /already exists/)

    // A leftover branch with no mounted worktree must be refused instead of silently checking out an old commit.
    await run('git', ['branch', 'guard/20261127-stale-branch'], { cwd })
    await assert.rejects(
      () => prepareGuardRun(cwd, { ...card, worktree: true, runId: '20261127-stale-branch' }),
      /branch already exists/,
    )
  })

  test('excludeRunWorktreeRoot creates a missing .git/info directory and surfaces write failures', async () => {
    const cwd = await workspace()
    await run('git', ['init', '-q'], { cwd })
    await rm(join(cwd, '.git', 'info'), { recursive: true, force: true })

    await excludeRunWorktreeRoot(cwd, '.guard')
    const content = await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8')
    assert.match(content, /^\.guard\/$/m)

    // Calling again is idempotent (no duplicate lines).
    await excludeRunWorktreeRoot(cwd, '.guard')
    const again = await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8')
    assert.equal(again.split(/\r?\n/).filter(line => line.trim() === '.guard/').length, 1)

    // When info/exclude cannot be written, the failure must not be swallowed silently.
    const excludeFile = join(cwd, '.git', 'info', 'exclude')
    await writeFile(excludeFile, '# empty\n', 'utf8')
    await chmod(excludeFile, 0o444)
    try {
      await assert.rejects(() => excludeRunWorktreeRoot(cwd, '.guard'))
    } finally {
      await chmod(excludeFile, 0o644)
    }
  })

  test('the initial notes skeleton is excluded from the completion offset', async () => {
    const cwd = await workspace()
    const prepared = await prepareGuardRun(cwd, card)
    const state = await readJson<GuardState>(join(prepared.root, 'tasks.json'))
    const notes = await readFile(join(prepared.root, 'tasks', 'T1', 'notes.md'), 'utf8')
    assert.equal(state.tasks[0]?.lastEvalOffset, notes.length)
    assert.ok(notes.includes('## 完成声明'), 'the guidance stays in the skeleton')
    assert.match(notes, /主会话审查/)
    assert.match(notes, /禁止让子会话代写/)
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

  test('a probe that a shell would interpret is refused, with the offending token named', async () => {
    const cwd = await workspace()
    const probe = (args: readonly string[]) => ({
      id: 'C1', taskId: 'T1', weight: 'heavy' as const,
      spec: { kind: 'command' as const, cmd: 'grep', args }, enabled: true,
    })
    // The exact mistake a human makes: quoting a multi-word pattern.
    await assert.rejects(() => prepareGuardRun(cwd, {
      ...card, runId: 'probe-quoted', tasks: 'T1 | 一条 | 通过',
      probes: [probe(['-q', '"export', 'function', 'multiply"', 'src/a.ts'])],
    }), /needs a shell/)
    // Redirection and a bare pipe are the same misunderstanding.
    for (const args of [['-q', 'x', 'src/a.ts', '>', 'out.txt'], ['-q', 'x', 'src/a.ts', '|', 'wc', '-l']]) {
      await assert.rejects(() => prepareGuardRun(cwd, {
        ...card, runId: `probe-shell-${args.length}`, tasks: 'T1 | 一条 | 通过', probes: [probe(args)],
      }), /needs a shell/)
    }
    // Quotes INSIDE an argument are program input (`node -e 'console.error("x")'`
    // is valid JS), and a pipe inside one token is regex alternation. Both stay
    // legal — only an edge or odd-count quote means a shell was expected.
    const inline = await prepareGuardRun(cwd, {
      ...card, runId: 'probe-inline-quotes', tasks: 'T1 | 一条 | 通过',
      probes: [{
        id: 'C2', taskId: 'T1', weight: 'light' as const, enabled: true,
        spec: { kind: 'command' as const, cmd: process.execPath, args: ['-e', 'console.error("boom"); process.exit(3)'] },
      }],
    })
    assert.ok(inline.runId !== '')
    // A pipe INSIDE one token is a regex alternation, not a pipeline: still fine.
    const ok = await prepareGuardRun(cwd, {
      ...card, runId: 'probe-regex', tasks: 'T1 | 一条 | 通过',
      probes: [probe(['-Eq', 'add|multiply', 'src/a.ts'])],
    })
    const state = await readJson<GuardState>(join(ok.root, 'probes', 'T1.json'))
    assert.deepEqual(
      (state as unknown as { probes: { spec: { args: string[] } }[] }).probes[0]?.spec.args,
      ['-Eq', 'add|multiply', 'src/a.ts'],
    )
  })

  test('persists a dedicated evaluator model in tasks.json and TASKS.md and rejects empty routes', async () => {
    const cwd = await workspace()
    const ok = await prepareGuardRun(cwd, {
      ...card, runId: 'eval-route', tasks: 'T1 | 一条 | 通过 | src/a.ts',
      evaluator: { provider: ' anthropic ', model: ' claude-sonnet ', reasoningEffort: ' max ' },
    })
    const state = await readJson<GuardState>(join(ok.root, 'tasks.json'))
    assert.deepEqual(state.evaluator, { provider: 'anthropic', model: 'claude-sonnet', reasoningEffort: 'max' })
    const rendered = await readFile(join(ok.root, 'TASKS.md'), 'utf8')
    assert.match(rendered, /评估模型：`anthropic\/claude-sonnet`（推理：`max`）/)

    await assert.rejects(() => prepareGuardRun(cwd, {
      ...card, runId: 'eval-bad', tasks: 'T1 | 一条 | 通过 | src/a.ts',
      evaluator: { provider: '  ', model: 'claude-sonnet' },
    }), /evaluator model is invalid/)
  })

  test('chains sequential dependsOn by default when parallel=1 and no row specifies column 5, and renders dependencies', async () => {
    const cwd = await workspace()
    const seq = await prepareGuardRun(cwd, {
      ...card, runId: 'seq-default-deps',
      tasks: 'T1 | 一 | 通过 | src/a.ts\nT2 | 二 | 通过 | src/b.ts\nT3 | 三 | 通过 | src/c.ts',
    })
    const seqState = await readJson<GuardState>(join(seq.root, 'tasks.json'))
    assert.deepEqual(seqState.tasks.map(task => task.dependsOn), [[], ['T1'], ['T2']])
    const rendered = await readFile(join(seq.root, 'TASKS.md'), 'utf8')
    assert.match(rendered, /- 依赖：T1/)
    assert.match(rendered, /- 依赖：T2/)
    const notes = await readFile(join(seq.root, 'tasks', 'T1', 'notes.md'), 'utf8')
    assert.match(notes, /立刻结束当前回合/)

    // Negative 1: parallel > 1 must NOT auto-chain dependencies.
    const par = await prepareGuardRun(cwd, {
      ...card, runId: 'par-no-auto-deps', parallel: 2,
      tasks: 'T1 | 一 | 通过 | src/a.ts\nT2 | 二 | 通过 | src/b.ts',
    })
    const parState = await readJson<GuardState>(join(par.root, 'tasks.json'))
    assert.deepEqual(parState.tasks.map(task => task.dependsOn), [[], []])

    // Negative 2: an explicit column 5 (including `-` for no dependency) is respected verbatim.
    const explicit = await prepareGuardRun(cwd, {
      ...card, runId: 'explicit-deps',
      tasks: 'T1 | 一 | 通过 | src/a.ts | -\nT2 | 二 | 通过 | src/b.ts | -\nT3 | 三 | 通过 | src/c.ts | T1',
    })
    const expState = await readJson<GuardState>(join(explicit.root, 'tasks.json'))
    assert.deepEqual(expState.tasks.map(task => task.dependsOn), [[], [], ['T1']])

    // Accepts common "no dependency" sentinels (em-dash / 无依赖 / backticks / ideographic comma in scope)
    // and reports specific line/field reasons on invalid scope or unknown dependency.
    const tolerant = await prepareGuardRun(cwd, {
      ...card, runId: 'tolerant-table',
      tasks: 'T1 | 一 | 通过 | `src/a.ts`、`src/b.ts` | —\nT2 | 二 | 通过 | `src/c.ts` | 无依赖',
    })
    const tolState = await readJson<GuardState>(join(tolerant.root, 'tasks.json'))
    assert.deepEqual(tolState.tasks[0]?.scope, ['src/a.ts', 'src/b.ts'])
    assert.deepEqual(tolState.tasks.map(task => task.dependsOn), [[], []])

    await assert.rejects(() => prepareGuardRun(cwd, {
      ...card, runId: 'detail-dep', tasks: 'T1 | 一 | 通过 | src/a.ts | T0',
    }), /task table is invalid:.*第 1 行.*T0/)
    await assert.rejects(() => prepareGuardRun(cwd, {
      ...card, runId: 'detail-scope', tasks: 'T1 | 一 | 通过 | /abs/path',
    }), /task table is invalid:.*第 1 行.*\/abs\/path/)
  })

  test('a quoted pipe inside an acceptance cell is not a column separator', async () => {
    const cwd = await workspace()
    const prepared = await prepareGuardRun(cwd, {
      ...card, runId: 'quoted-pipe',
      tasks: 'T4 | P1: playbook 枚举 + walk-forward 闸 | go test ./internal/... -run "Playbook|WalkForward" -count=1 退出 0 | internal/service/,internal/domain/\n'
        + 'T5 | 收口 | `grep -q "a|b"` 退出 0 | docs/',
    })
    const state = await readJson<GuardState>(join(prepared.root, 'tasks.json'))
    const t4 = state.tasks[0]
    assert.deepEqual(t4?.acceptance, ['go test ./internal/... -run "Playbook|WalkForward" -count=1 退出 0'])
    // Trailing slashes normalize away; nothing lands in the dependency column.
    assert.deepEqual(t4?.scope, ['internal/service', 'internal/domain'])
    assert.deepEqual(t4?.dependsOn, [])
    const t5 = state.tasks[1]
    assert.deepEqual(t5?.scope, ['docs'])
    assert.match(t5?.acceptance[0] ?? '', /grep -q "a\|b"/)
  })
})
