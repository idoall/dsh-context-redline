// The three Goal Supervisor channel ops (`guard.prepare` / `guard.supervisor` /
// `guard.rollback`) — the boundary between the dialog and the host.
//
// What this file pins, and why each is worth a test:
//   - a prepare writes the ledger and answers a run id (the dialog's step two);
//   - a malformed prepare (no tasks, an unknown probe task, an unsafe scope) is
//     refused instead of writing half a run directory;
//   - the summary is read-only and answers `null` for a session without a run;
//   - a rollback requires an explicit confirm, refuses while a turn is open, and
//     resumes the host goal so the reopened task can actually run.

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, inject, name } from '../../src/host/index'
import { REDLINE_ERROR } from '../../src/shared/redline-errors'
import { rememberSupervisorRun } from '../../src/host/goal-supervisor/status'
import { REDLINE_CHANNEL_ROUTE } from '../../src/shared/redline-route'
import { REDLINE_DATA_DIR_NAME } from '../../src/shared/redline-paths'
import type { RunMeta } from '../../src/host/goal-supervisor/schema'

type RouteFetch = (request: Request) => Promise<Response>
interface CapturedRoute { path: string, methods: readonly string[], fetch: RouteFetch }

const plugin = { name, inject, apply } as never
const homes: string[] = []
const workspaces: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface GoalsCalls {
  resume: number
  create: number
  block: number
  complete: number
}

interface Ops {
  call: (body: Record<string, unknown>) => Promise<Record<string, unknown>>
  cwd: string
  /** The fake harness home; the plugin data directory lives under it. */
  home: string
  sessionId: string
  goals: GoalsCalls
  /** Switch the session's turn boundary (an open turn refuses writes). */
  setTurnOpen: (open: boolean) => void
  /** Drop the agent from the registry, as a closed tab would. */
  setAgentLive: (live: boolean) => void
  cleanup: () => void | Promise<void>
}

/** Boot the real entry with a fake `agents` face over one real session. */
async function boot(): Promise<Ops> {
  const home = mkdtempSync(join(tmpdir(), 'redline-sup-'))
  homes.push(home)
  const cwd = mkdtempSync(join(tmpdir(), 'redline-sup-ws-'))
  workspaces.push(cwd)

  let turnOpen = false
  const goals: GoalsCalls = { resume: 0, create: 0, block: 0, complete: 0 }
  const routes: CapturedRoute[] = []
  const ctx = new Context()
  ctx.provide('connection', {
    fetch: {
      register(route: CapturedRoute) {
        routes.push(route)
        return () => {}
      },
    },
  })
  ctx.provide('dshHomePath', (...segments: string[]) => join(home, ...segments))
  ctx.provide('sessionQuery', {
    async listEvents() {
      return turnOpen ? [{ type: 'turn/start' }] : [{ type: 'turn/start' }, { type: 'turn/end' }]
    },
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  // The source session must carry a workspace cwd: `guard.prepare` resolves the
  // run directory from it.
  const session = ctx.sessions.create(undefined, { meta: { cwd } })
  const sessionId = session.id as unknown as string

  const agent = {
    id: sessionId,
    session,
    ctx,
    options: { provider: 'provider-a', model: 'model-a' },
  }
  let agentLive = true
  ctx.provide('agents', { get: (id: string) => (agentLive && id === sessionId ? agent : undefined) })
  ctx.provide('agentPresets', { presetForSession: () => 'standard' })
  ctx.provide('workspaceRegistry', {
    async resolveByPath(path: string) { return { id: 'ws-1', path } },
    async create(path: string) { return { id: 'ws-1', path } },
  })
  // The real GoalService compares the agent BY REFERENCE (`ctx.agents.get(id)
  // !== agent` → GOAL_AGENT_NOT_LIVE), so every fake call asserts that too: a
  // shallow copy would pass a looser fake and fail on a real host.
  const assertLive = (passed: unknown): void => {
    if (passed !== agent) {
      throw Object.assign(new Error('agent is not live in this registry'), { code: 'GOAL_AGENT_NOT_LIVE' })
    }
  }
  ctx.provide('goals', {
    get: (passed: unknown) => { assertLive(passed); return undefined },
    create: (passed: unknown) => { assertLive(passed); goals.create += 1 },
    resume: (passed: unknown) => { assertLive(passed); goals.resume += 1 },
    block: (_passed: unknown) => { goals.block += 1 },
    complete: () => { goals.complete += 1 },
  })
  await ctx.plugin(plugin, {} as never)
  const channel = routes.find(route => route.path === REDLINE_CHANNEL_ROUTE)
  assert.ok(channel !== undefined, 'the channel registered')

  return {
    cwd,
    home,
    sessionId,
    goals,
    setTurnOpen: (open: boolean) => { turnOpen = open },
    setAgentLive: (live: boolean) => { agentLive = live },
    async call(body) {
      const response = await channel.fetch(new Request(`http://dsh.test${REDLINE_CHANNEL_ROUTE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }))
      assert.equal(response.status, 200)
      return await response.json() as Record<string, unknown>
    },
    // The cordis context outlives the test process; nothing to tear down beyond
    // the temp directories the harness already removes.
    cleanup: () => {},
  }
}

function value(reply: Record<string, unknown>): Record<string, unknown> {
  assert.equal(reply.ok, true, JSON.stringify(reply))
  return reply.value as Record<string, unknown>
}

const CARD = {
  task: '把目标漂移修好',
  goal: '把目标漂移修好',
  acceptance: '所有任务 DONE',
  discipline: '主会话只规划/分派/审查',
}

function prepareBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...CARD, tasks: 'T1 | 落盘 | 文件存在 | src/**', ...over }
}

describe('guard.prepare', () => {
  test('writes the run directory and answers the run id', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      assert.equal(typeof prepared.runId, 'string')
      assert.ok(String(prepared.runId).length > 0)
      assert.ok(Array.isArray(prepared.files))
      const tasks = JSON.parse(readFileSync(join(String(prepared.root), 'tasks.json'), 'utf8')) as {
        tasks: { id: string, scope: string[], lastEvalOffset?: number }[]
      }
      assert.deepEqual(tasks.tasks.map(task => task.id), ['T1'])
      assert.deepEqual(tasks.tasks[0]?.scope, ['src/**'])
      assert.equal(typeof tasks.tasks[0]?.lastEvalOffset, 'number', 'the skeleton is excluded from the offset')
      const meta = JSON.parse(readFileSync(join(String(prepared.root), 'run.json'), 'utf8')) as RunMeta
      assert.equal(meta.phase, 'ready')
    } finally {
      ops.cleanup()
    }
  })

  test('refuses an empty task table and an unknown probe task', async () => {
    const ops = await boot()
    try {
      const empty = await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody({ tasks: '   ' }) })
      assert.equal(empty.ok, false)
      assert.equal((empty.error as { code: string }).code, REDLINE_ERROR.badRequest)

      const unknownProbe = await ops.call({
        op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody(),
        probes: [{ id: 'C1', taskId: 'T9', weight: 'heavy', spec: { kind: 'command', cmd: 'true', args: [] }, enabled: true }],
      })
      assert.equal(unknownProbe.ok, false, 'a probe for a task the table does not define is refused, not dropped')
      assert.match((unknownProbe.error as { message: string }).message, /unknown task/)
    } finally {
      ops.cleanup()
    }
  })

  test('refuses an unsafe scope map and a malformed probe', async () => {
    const ops = await boot()
    try {
      for (const scopes of [{ T1: ['../outside.ts'] }, { T1: ['/etc/passwd'] }, { T1: ['**'] }, { T1: 'src/a.ts' }]) {
        const reply = await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody({ scopes }) })
        assert.equal(reply.ok, false, `scope ${JSON.stringify(scopes)} must be refused`)
      }
      const badProbe = await ops.call({
        op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody(),
        probes: [{ id: '../../evil', taskId: 'T1', weight: 'heavy', spec: { kind: 'command', cmd: 'true', args: [] } }],
      })
      assert.equal(badProbe.ok, false, 'a probe id becomes a file name and must be a safe segment')
    } finally {
      ops.cleanup()
    }
  })

  test('refuses a supervisor run and a legacy goal guard on the same session', async () => {
    const ops = await boot()
    try {
      const reply = await ops.call({
        op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody(), runId: 'r1',
        guard: { tasks: 'T1 | 落盘 | 文件存在' },
      })
      assert.equal(reply.ok, false)
      assert.match((reply.error as { message: string }).message, /cannot both be attached/)
    } finally {
      ops.cleanup()
    }
  })
})

describe('guard.supervisor', () => {
  test('answers null for a session without a run, then the summary once mounted', async () => {
    const ops = await boot()
    try {
      const none = await ops.call({ op: 'guard.supervisor', sessionId: ops.sessionId })
      assert.equal(none.ok, true)
      assert.equal(none.value, null)

      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const meta = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8')) as RunMeta
      writeFileSync(join(root, 'run.json'), JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }), 'utf8')
      const tasks = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')) as { tasks: { status: string }[] }
      tasks.tasks[0]!.status = 'BLOCKED'
      writeFileSync(join(root, 'tasks.json'), JSON.stringify(tasks), 'utf8')

      const summary = value(await ops.call({ op: 'guard.supervisor', sessionId: ops.sessionId }))
      assert.equal(summary.runId, prepared.runId)
      assert.equal(summary.status, 'active')
      assert.equal(summary.total, 1)
      assert.equal(summary.done, 0)
      assert.deepEqual((summary.tasks as { status: string }[])[0]?.status, 'BLOCKED')
    } finally {
      ops.cleanup()
    }
  })
})

describe('guard.rollback', () => {
  test('requires an explicit confirm and an existing checkpoint', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const meta = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8')) as RunMeta
      writeFileSync(join(root, 'run.json'), JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }), 'utf8')

      const noConfirm = await ops.call({ op: 'guard.rollback', sessionId: ops.sessionId, runId: prepared.runId })
      assert.equal(noConfirm.ok, false, 'a bare call never rolls back')

      const nothing = await ops.call({ op: 'guard.rollback', sessionId: ops.sessionId, runId: prepared.runId, confirm: 'rollback' })
      assert.equal(nothing.ok, false)
      assert.match((nothing.error as { message: string }).message, /nothing to roll back/)
    } finally {
      ops.cleanup()
    }
  })

  test('refuses while a turn is open', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const meta = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8')) as RunMeta
      writeFileSync(join(root, 'run.json'), JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }), 'utf8')
      ops.setTurnOpen(true)
      const reply = await ops.call({ op: 'guard.rollback', sessionId: ops.sessionId, runId: prepared.runId, confirm: 'rollback' })
      assert.equal(reply.ok, false)
      assert.equal((reply.error as { code: string }).code, REDLINE_ERROR.turnOpen)
    } finally {
      ops.cleanup()
    }
  })

  test('rejects a run id that is not a safe path segment', async () => {
    const ops = await boot()
    try {
      const reply = await ops.call({ op: 'guard.rollback', sessionId: ops.sessionId, runId: '../../etc', confirm: 'rollback' })
      assert.equal(reply.ok, false)
      assert.equal((reply.error as { code: string }).code, REDLINE_ERROR.badRequest)
    } finally {
      ops.cleanup()
    }
  })

  test('two concurrent rollbacks are serialized by the session lock', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const meta = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8')) as RunMeta
      writeFileSync(join(root, 'run.json'), JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }), 'utf8')
      const tasksPath = join(root, 'tasks.json')
      const state = JSON.parse(readFileSync(tasksPath, 'utf8')) as { tasks: Record<string, unknown>[] }
      state.tasks[0] = {
        ...state.tasks[0],
        status: 'BLOCKED',
        blocked: { reason: '卡住', next: '回退', remainingCandidates: [], at: 1 },
      }
      writeFileSync(tasksPath, JSON.stringify(state), 'utf8')

      // Two tabs (or a double submit) hit the same destructive op at once. The
      // second must read the ledger the first one wrote, not the same BLOCKED row.
      const [first, second] = await Promise.all([
        ops.call({ op: 'guard.rollback', sessionId: ops.sessionId, runId: prepared.runId, confirm: 'rollback' }),
        ops.call({ op: 'guard.rollback', sessionId: ops.sessionId, runId: prepared.runId, confirm: 'rollback' }),
      ])
      assert.equal([first, second].filter(reply => reply.ok === true).length, 1, 'exactly one rollback wins')
      const refused = [first, second].find(reply => reply.ok === false)
      assert.ok(refused !== undefined)
      assert.match((refused.error as { message: string }).message, /nothing to roll back/)
    } finally {
      ops.cleanup()
    }
  })

  test('resumes the host goal so the reopened task can run', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const meta = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8')) as RunMeta
      writeFileSync(join(root, 'run.json'), JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }), 'utf8')
      const tasksPath = join(root, 'tasks.json')
      const state = JSON.parse(readFileSync(tasksPath, 'utf8')) as { tasks: Record<string, unknown>[] }
      state.tasks[0] = {
        ...state.tasks[0],
        status: 'BLOCKED',
        blocked: { reason: '卡住', next: '回退', remainingCandidates: [], at: 1 },
      }
      writeFileSync(tasksPath, JSON.stringify(state), 'utf8')

      const reply = await ops.call({ op: 'guard.rollback', sessionId: ops.sessionId, runId: prepared.runId, confirm: 'rollback' })
      const summary = value(reply)
      assert.equal(summary.status, 'active')
      const after = JSON.parse(readFileSync(tasksPath, 'utf8')) as { tasks: { status: string, blocked?: unknown }[] }
      assert.equal(after.tasks[0]?.status, 'TODO')
      assert.equal(after.tasks[0]?.blocked, undefined)
      // No goal existed for this fake agent, so the run is re-armed by creating one.
      assert.ok(ops.goals.create + ops.goals.resume > 0, 'the host goal is brought back in line with the ledger')
      // … and the failed resume must NOT have flipped the run to `setup-failed`.
      const metaAfter = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8')) as RunMeta
      assert.equal(metaAfter.phase, 'running', 'a reference-lost agent must not mark the mount failed')
      const events = readFileSync(join(root, 'state.jsonl'), 'utf8')
      assert.ok(!events.includes('"setup.failed"'), 'no setup.failed event is written by a rollback')
    } finally {
      ops.cleanup()
    }
  })
})

describe('guard ops namespace', () => {
  test('the data directory stays inside the harness home', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      assert.ok(String(prepared.root).startsWith(ops.cwd), 'the run lives in the workspace, not in the plugin home')
      assert.ok(!String(prepared.root).includes(REDLINE_DATA_DIR_NAME))
    } finally {
      ops.cleanup()
    }
  })
})

// Round-9 P2-4: `guard.prepare` runs under the session write queue, so a double
// click cannot prepare the same run id twice from the same stale snapshot. The
// observable is the epoch bump (read → increment → write) in `run.json`.
describe('guard.prepare serialization', () => {
  test('two concurrent prepares of one run id are serialized', async () => {
    const ops = await boot()
    try {
      const body = { op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody(), runId: '20261125-race' }
      const [first, second] = await Promise.all([ops.call(body), ops.call(body)])
      const prepared = value(first)
      assert.equal(value(second).runId, '20261125-race')
      const meta = JSON.parse(readFileSync(join(String(prepared.root), 'run.json'), 'utf8')) as RunMeta
      assert.equal(meta.epoch, 2, 'the second prepare saw the first one and bumped the epoch')
      const state = JSON.parse(readFileSync(join(String(prepared.root), 'tasks.json'), 'utf8')) as { tasks: { id: string }[] }
      assert.deepEqual(state.tasks.map(task => task.id), ['T1'])
      const leftovers = readdirSync(String(prepared.root)).filter(name => name.endsWith('.tmp'))
      assert.deepEqual(leftovers, [], 'atomic writes leave no temp files behind')
    } finally {
      ops.cleanup()
    }
  })
})

// Round-9 P1-2: the channel is one of the scope producers; it must store the
// same normalized form the matcher compares against, or an auto-approved scope
// never matches the worktree path git reports.
describe('guard.prepare scope normalization', () => {
  test('normalizes the scope map before it reaches the ledger', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({
        op: 'guard.prepare',
        sessionId: ops.sessionId,
        ...prepareBody({
          tasks: 'T1 | 落盘 | 文件存在',
          scopes: { T1: ['././src/a.ts', 'src\\b.ts'] },
        }),
      }))
      const state = JSON.parse(readFileSync(join(String(prepared.root), 'tasks.json'), 'utf8')) as {
        tasks: { scope: string[] }[]
      }
      assert.deepEqual(state.tasks[0]?.scope, ['src/a.ts', 'src/b.ts'])
    } finally {
      ops.cleanup()
    }
  })
})

describe('guard.supervisor when the session is not loaded', () => {
  test('a remembered mount still renders, marked read-only, instead of vanishing', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const runId = String(prepared.runId)
      // Bind the run to this session the way a mount does, then remember where
      // it lives — this is exactly what attachSupervisor writes on success.
      const metaPath = join(root, 'run.json')
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as RunMeta
      writeFileSync(metaPath, JSON.stringify({ ...meta, phase: 'running', sessionId: ops.sessionId }), 'utf8')
      await rememberSupervisorRun(join(ops.home, REDLINE_DATA_DIR_NAME, 'supervisor'), {
        sessionId: ops.sessionId, cwd: ops.cwd, runId,
      })

      // The agent is gone: `agents.get` no longer resolves it. Before the fix the
      // op answered notLive and the panel silently dropped the whole card.
      ops.setAgentLive(false)
      const summary = value(await ops.call({ op: 'guard.supervisor', sessionId: ops.sessionId }))
      assert.equal(summary.runId, runId)
      assert.equal(summary.agentLive, false)
      assert.equal(summary.total, 1)

      // A session that never had a run still answers notLive: the fallback must
      // not invent a card for every ordinary conversation.
      ops.setAgentLive(true)
      const other = await ops.call({ op: 'guard.supervisor', sessionId: 'session-never-had-a-run' })
      assert.equal(other.ok, false)
    } finally {
      ops.cleanup()
    }
  })
})
