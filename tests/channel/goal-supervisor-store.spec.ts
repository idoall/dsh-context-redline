import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import {
  GUARD_SCHEMA_VERSION,
  type GuardEvent,
  type GuardState,
  type RunMeta,
} from '../../src/host/goal-supervisor/schema'
import { buildRunId, sanitizeRefSegment } from '../../src/host/goal-supervisor/run-id'
import { GuardStore, renderTasksMarkdown } from '../../src/host/goal-supervisor/store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function runRoot(): Promise<{ root: string; store: GuardStore }> {
  const root = await mkdtemp(join(tmpdir(), 'guard-store-'))
  roots.push(root)
  return { root, store: new GuardStore(root) }
}

function state(overrides: Partial<GuardState> = {}): GuardState {
  return {
    version: GUARD_SCHEMA_VERSION,
    runId: '20261124-demo',
    goal: 'ship it',
    acceptance: '所有任务 DONE',
    discipline: '主会话只规划/分派/审查',
    goalHash: 'hash-1',
    tasks: [{
      id: 'T1',
      title: '第一条',
      status: 'DONE',
      scope: ['src/a.ts'],
      dependsOn: [],
      acceptance: ['文件存在'],
      probes: ['P1'],
      requiredProbes: ['P1'],
      probeResults: { P1: { result: 'pass', at: 1 } },
      evidence: [],
      attempts: [],
      scopeApprovedCount: 0,
      baselineDirty: {},
    }],
    activeTaskIds: [],
    parallel: 1,
    enforcement: 'warn-only',
    worktree: { enabled: false },
    milestoneEvery: 3,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function event(at: number, taskId = 'T1'): GuardEvent {
  return { type: 'task.done', at, taskId, checkpointRef: `guard/${state().runId}/${taskId}` }
}

describe('goal-supervisor run ids', () => {
  test('keeps the date prefix and safe characters', () => {
    assert.equal(buildRunId(new Date(2026, 10, 24), '目标:漂移/修复?'), '20261124-目标-漂移-修复')
  })

  test('collapses unsafe runs and trims separators', () => {
    assert.equal(sanitizeRefSegment('  ..a??b  '), 'a-b')
    assert.equal(sanitizeRefSegment('foo.lock'), 'foo-lock')
    assert.equal(sanitizeRefSegment('---'), 'run')
  })

  test('truncates the topic and keeps the whole id within 50 characters', () => {
    const id = buildRunId(new Date(2026, 10, 24), '主题'.repeat(40))
    assert.ok(id.length <= 50, id)
    assert.ok(id.startsWith('20261124-'))
  })

  test('adds a numeric suffix on collision', () => {
    const taken = new Set(['20261124-demo'])
    assert.equal(buildRunId(new Date(2026, 10, 24), 'demo', taken), '20261124-demo-2')
  })
})

describe('goal-supervisor store', () => {
  test('commits state, events and the rendered page together', async () => {
    const { root, store } = await runRoot()
    await store.update(state(), [event(10)])

    const saved = JSON.parse(await readFile(join(root, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(saved.runId, '20261124-demo')
    assert.equal(saved.tasks[0]?.status, 'DONE')

    const events = (await readFile(join(root, 'state.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(events.length, 1)
    assert.equal((JSON.parse(events[0] ?? '{}') as GuardEvent).type, 'task.done')

    const rendered = await readFile(join(root, 'TASKS.md'), 'utf8')
    assert.match(rendered, /## T1 · 第一条/)
    assert.match(rendered, /- 状态：DONE/)
    assert.match(rendered, /进度：1\/1 已完成/)
  })

  test('is append-only across updates and leaves no temp files', async () => {
    const { root, store } = await runRoot()
    await store.update(state({ updatedAt: 1 }), [event(1)])
    await store.update(state({ updatedAt: 2 }), [event(2)])

    const events = (await readFile(join(root, 'state.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(events.length, 2)
    const leftovers = (await readdir(root)).filter(name => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  })

  test('serializes concurrent updates without corrupting the ledger', async () => {
    const { root, store } = await runRoot()
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.update(state({ updatedAt: index + 1 }), [event(index + 1)])))

    const saved = JSON.parse(await readFile(join(root, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(saved.updatedAt, 20)
    const events = (await readFile(join(root, 'state.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(events.length, 20)
    const leftovers = (await readdir(root)).filter(name => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  })

  test('returns null for a missing ledger and regenerates TASKS.md on cold start', async () => {
    const { root, store } = await runRoot()
    assert.equal(await store.readState(), null)

    await store.update(state())
    await rm(join(root, 'TASKS.md'))
    const refreshed = await store.refreshRendered()
    assert.equal(refreshed?.runId, '20261124-demo')
    assert.match(await readFile(join(root, 'TASKS.md'), 'utf8'), /T1 第一条|T1 · 第一条/)
  })

  test('renders deterministically without touching disk', () => {
    const first = renderTasksMarkdown(state())
    const second = renderTasksMarkdown(state())
    assert.equal(first, second)
    assert.ok(first.includes('## T1 · 第一条'))
  })

  test('writes probe definitions and run metadata', async () => {
    const { root, store } = await runRoot()
    await store.writeProbeFile('T1', {
      version: GUARD_SCHEMA_VERSION,
      taskId: 'T1',
      confirmedAt: 5,
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    })
    await store.writeMeta({
      version: GUARD_SCHEMA_VERSION,
      runId: '20261124-demo',
      epoch: 1,
      goalHash: 'hash-1',
      phase: 'ready',
      setup: { goal: true, anchors: true, guard: true, firstMessage: true },
      mirror: { mode: 'auto' },
      createdAt: 1,
      updatedAt: 1,
    })
    assert.equal((await store.readProbeFile('T1'))?.probes.length, 1)
    assert.equal((await store.readMeta())?.phase, 'ready')
    assert.equal(await store.readProbeFile('T2'), null)
    assert.ok(await readFile(join(root, 'probes', 'T1.json'), 'utf8'))
  })

  test('mutate commits the ledger and its events under one lock', async () => {
    const { root, store } = await runRoot()
    await store.update(state(), [event(1)])
    const next = await store.mutate(current => ({
      state: { ...current, status: 'paused' as const, updatedAt: 2 },
      events: [event(2)],
    }))
    assert.equal(next?.status, 'paused')
    const saved = JSON.parse(await readFile(join(root, 'tasks.json'), 'utf8')) as GuardState
    assert.equal(saved.status, 'paused')
    const events = (await readFile(join(root, 'state.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(events.length, 2, 'the callback-supplied events are appended by the same mutate')
    assert.equal((JSON.parse(events[1] ?? '{}') as GuardEvent).type, 'task.done')
    assert.match(await readFile(join(root, 'TASKS.md'), 'utf8'), /状态：paused/)
  })

  test('mutate short-circuits an unchanged ledger and a null answer without writing', async () => {
    const { root, store } = await runRoot()
    await store.update(state(), [event(1)])
    // A sentinel page proves no write happened: every real commit regenerates it.
    await writeFile(join(root, 'TASKS.md'), 'sentinel', 'utf8')
    const same = await store.mutate(current => current)
    assert.equal(same?.runId, '20261124-demo', 'an unchanged answer still reports the ledger')
    assert.equal(await readFile(join(root, 'TASKS.md'), 'utf8'), 'sentinel', 'no write when nothing changed')
    const none = await store.mutate(() => null)
    assert.equal(none?.runId, '20261124-demo', 'a null answer means "no write", not "ledger missing"')
    assert.equal(await readFile(join(root, 'TASKS.md'), 'utf8'), 'sentinel')
    const events = (await readFile(join(root, 'state.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(events.length, 1, 'a short-circuited mutate appends no events')
  })

  test('surfaces a corrupt ledger instead of pretending it is absent', async () => {
    const { root, store } = await runRoot()
    await writeFile(join(root, 'tasks.json'), '{ not json', 'utf8')
    await assert.rejects(() => store.readState())
  })
})

function meta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    version: GUARD_SCHEMA_VERSION,
    runId: '20261124-demo',
    epoch: 1,
    goalHash: 'hash-1',
    phase: 'ready',
    setup: { goal: false, anchors: false, guard: false, firstMessage: false },
    mirror: { mode: 'auto' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

// Round-9 fix: `run.json` had a read → await → write race. `syncMirror` read the
// meta once, spent seconds in the CLI, then wrote the stale snapshot back and
// erased the first-message marker (and the mirror provider/host).
describe('goal-supervisor run meta updates', () => {
  test('concurrent updates merge onto the latest meta instead of overwriting each other', async () => {
    const { store } = await runRoot()
    await store.writeMeta(meta())
    await Promise.all([
      store.updateMeta(current => ({
        ...current,
        mirror: { ...current.mirror, provider: 'github', host: 'github.com' },
        updatedAt: 2,
      })),
      store.updateMeta(current => ({
        ...current,
        setup: { ...current.setup, firstMessage: true },
        updatedAt: 3,
      })),
    ])
    const after = await store.readMeta()
    assert.equal(after?.mirror.provider, 'github', 'the mirror identity survives')
    assert.equal(after?.mirror.host, 'github.com')
    assert.equal(after?.setup.firstMessage, true, 'the first-message marker survives')
  })

  test('updateMeta reports a missing run and keeps a "no change" answer', async () => {
    const { store } = await runRoot()
    assert.equal(await store.updateMeta(current => current), null)
    await store.writeMeta(meta())
    const kept = await store.updateMeta(() => null)
    assert.equal(kept?.phase, 'ready')
    assert.equal((await store.readMeta())?.phase, 'ready')
  })

  test('TASKS.md names the isolated branch, because nothing merges it back', () => {
    const base = state()
    const isolated = renderTasksMarkdown({
      ...base,
      worktree: { enabled: true, path: '/repo/.guard/worktrees/r1', branch: 'guard/r1' },
    })
    assert.match(isolated, /隔离分支：`guard\/r1`/)
    assert.match(isolated, /不会自动合入/)
    // An ordinary in-place run must not grow a line about a branch it never had.
    const inPlace = renderTasksMarkdown({ ...base, worktree: { enabled: false } })
    assert.ok(!inPlace.includes('隔离分支'))
  })
})
