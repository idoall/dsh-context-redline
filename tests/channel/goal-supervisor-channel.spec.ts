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
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  edit: number
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
  /** Simulate the Host directory move a supervisor worktree run performs. */
  setWorkingDirectory: (directory: string | undefined) => void
  /** Model selections the plugin asked the agent to apply. */
  readonly selections: Record<string, unknown>[]
  /** How many turn-state reads the channel performed (a deterministic fence). */
  turnReads: () => number
  /** Hold `slow-provider` resolution until `open()`; `entered` fires on arrival. */
  armSlowModelGate: () => { entered: Promise<void>, open: () => void }
  /** Register a second live session sharing this workspace. */
  addAgent: (id: string) => void
  /** Change the source session's live model selection (the visual witness inherits it). */
  setSessionModel: (provider: string, model: string) => void
  /** Make the host goal service refuse a create, as a cap/round limit would. */
  setGoalCreateFails: (fails: boolean) => void
  /** The live goal `goals.get` reports (`undefined` = no goal mounted). */
  setGoalView: (view: Record<string, unknown> | undefined) => void
  cleanup: () => void | Promise<void>
}

/** Boot the real entry with a fake `agents` face over one real session. */
async function boot(): Promise<Ops> {
  const home = mkdtempSync(join(tmpdir(), 'redline-sup-'))
  homes.push(home)
  const cwd = mkdtempSync(join(tmpdir(), 'redline-sup-ws-'))
  workspaces.push(cwd)

  let turnOpen = false
  let turnReads = 0
  let slowGate: { entered: () => void, wait: Promise<void> } | null = null
  const goals: GoalsCalls = { resume: 0, create: 0, block: 0, complete: 0, edit: 0 }
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
      turnReads += 1
      return turnOpen ? [{ type: 'turn/start' }] : [{ type: 'turn/start' }, { type: 'turn/end' }]
    },
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  // The source session must carry a workspace cwd: `guard.prepare` resolves the
  // run directory from it.
  const session = ctx.sessions.create(undefined, { meta: { cwd } })
  const sessionId = session.id as unknown as string

  const selections: Record<string, unknown>[] = []
  let sessionProvider = 'provider-a'
  let sessionModel = 'model-a'
  const agent = {
    id: sessionId,
    session,
    ctx,
    options: { get provider() { return sessionProvider }, get model() { return sessionModel } },
    model: {
      current: () => ({ provider: sessionProvider, model: sessionModel }),
      select: (selection: Record<string, unknown>) => { selections.push(selection) },
    },
  }
  let agentLive = true
  let workingDirectoryCurrent: string | undefined
  const extraAgents = new Map<string, typeof agent>()
  ctx.provide('agents', {
    get: (id: string) => (agentLive && id === sessionId ? agent : extraAgents.get(id)),
  })
  ctx.provide('llm', {
    async resolveModelInfo(provider: string, model: string) {
      if (provider === 'missing-provider') throw new Error(`model not found: ${provider}/${model}`)
      // A gated route: it holds one `guard.switch` inside the session lock until
      // the test releases it, so a second op can be queued deterministically.
      if (provider === 'slow-provider') {
        const gate = slowGate
        slowGate = null
        if (gate !== null) {
          gate.entered()
          await gate.wait
        }
      }
      // Advertise two levels so effort validation is exercised for real.
      return {
        provider,
        model,
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
        inputModalities: provider === 'text-only' ? ['text'] : ['text', 'image'],
      }
    },
  })
  ctx.provide('agentPresets', { presetForSession: () => 'standard' })
  // Mounted by `dsh-base`. A worktree run moves here; the header keeps the project.
  ctx.provide('workingDirectory', { get: () => workingDirectoryCurrent })
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
  let goalCreateFails = false
  let goalView: Record<string, unknown> | undefined
  ctx.provide('goals', {
    get: (passed: unknown) => { assertLive(passed); return goalView },
    create: (passed: unknown) => {
      assertLive(passed)
      goals.create += 1
      if (goalCreateFails) throw Object.assign(new Error('goal round cap reached'), { code: 'GOAL_ROUND_LIMIT' })
    },
    resume: (passed: unknown) => { assertLive(passed); goals.resume += 1 },
    edit: (passed: unknown, ref: { revision?: number } | undefined, request: Record<string, unknown>) => {
      assertLive(passed)
      goals.edit += 1
      return { id: 'goal-1', revision: (ref?.revision ?? 1) + 1, phase: 'blocked', activation: 'disarmed', roundsStarted: 256, maxGoalRounds: request.maxGoalRounds }
    },
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
    setWorkingDirectory: (directory: string | undefined) => { workingDirectoryCurrent = directory },
    setSessionModel: (provider: string, model: string) => { sessionProvider = provider; sessionModel = model },
    setGoalCreateFails: (fails: boolean) => { goalCreateFails = fails },
    setGoalView: (view: Record<string, unknown> | undefined) => { goalView = view },
    selections,
    turnReads: () => turnReads,
    armSlowModelGate() {
      let release: () => void = () => {}
      let entered: () => void = () => {}
      const wait = new Promise<void>((resolve) => { release = resolve })
      const reached = new Promise<void>((resolve) => { entered = resolve })
      slowGate = { entered, wait }
      return { entered: reached, open: () => { release() } }
    },
    addAgent(id: string) {
      const extraSession = ctx.sessions.create(id as never, { meta: { cwd } })
      extraAgents.set(id, {
        id,
        session: extraSession,
        ctx,
        options: { provider: 'provider-a', model: 'model-a' },
        model: {
          current: () => ({ provider: 'provider-a', model: 'model-a' }),
          select: (selection: Record<string, unknown>) => { selections.push(selection) },
        },
      })
    },
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

/** Poll a fence without fixed-duration sleeps; only timers interleave the I/O. */
async function until(predicate: () => boolean, label: string, attempts = 200): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Write a connected run record and one BLOCKED task into the prepared ledger. */
function blockPreparedRun(root: string, sessionId: string): { readonly tasksPath: string } {
  const metaPath = join(root, 'run.json')
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
  writeFileSync(metaPath, JSON.stringify({ ...meta, sessionId, phase: 'running' }, null, 2), 'utf8')
  const tasksPath = join(root, 'tasks.json')
  const raw = JSON.parse(readFileSync(tasksPath, 'utf8')) as { tasks: Record<string, unknown>[] } & Record<string, unknown>
  writeFileSync(tasksPath, JSON.stringify({
    ...raw,
    status: 'blocked',
    goalBlocked: 'T1 已阻塞：评估器连续 3 次不可用',
    tasks: raw.tasks.map(task => ({
      ...task,
      status: 'BLOCKED',
      blocked: { reason: '评估器连续 3 次不可用', next: '继续重试', remainingCandidates: [], at: 1 },
    })),
  }, null, 2), 'utf8')
  return { tasksPath }
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

  test('persists a dedicated evaluator model, exposes it on guard.supervisor, and rejects malformed routes', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({
        op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody(),
        evaluator: { provider: 'openai', model: 'gpt-5-mini' },
      }))
      const root = String(prepared.root)
      const state = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')) as {
        evaluator?: { provider: string; model: string }
      }
      assert.deepEqual(state.evaluator, { provider: 'openai', model: 'gpt-5-mini' })
      const md = readFileSync(join(root, 'TASKS.md'), 'utf8')
      assert.match(md, /openai\/gpt-5-mini/)

      const meta = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8')) as RunMeta
      writeFileSync(join(root, 'run.json'), JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }), 'utf8')
      const summary = value(await ops.call({ op: 'guard.supervisor', sessionId: ops.sessionId }))
      assert.equal(summary.evaluatorModel, 'openai/gpt-5-mini')

      for (const bad of [{ provider: '', model: 'm' }, { provider: 'p', model: '' }, 'p/m', null]) {
        const reply = await ops.call({
          op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody(), evaluator: bad,
        })
        assert.equal(reply.ok, false, `malformed evaluator ${JSON.stringify(bad)} must be refused`)
      }

      const unavailable = await ops.call({
        op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody(),
        evaluator: { provider: 'missing-provider', model: 'ghost-model' },
      })
      assert.equal(unavailable.ok, false, 'unavailable evaluator model must be refused before creating a run')
      assert.equal((unavailable.error as { code: string }).code, REDLINE_ERROR.badRequest)
      assert.match((unavailable.error as { message: string }).message, /evaluator model is unavailable/)

      // Legacy Goal Guard ops are retired and must answer unknownOp.
      for (const retired of ['guard.status', 'guard.pause', 'guard.resume']) {
        const reply = await ops.call({ op: retired, sessionId: ops.sessionId })
        assert.equal(reply.ok, false)
        assert.equal((reply.error as { code: string }).code, REDLINE_ERROR.unknownOp)
      }
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

describe('a supervisor worktree run', () => {
  test('reads its ledger through the effective directory, not the header project', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const runId = String(prepared.runId)
      const root = String(prepared.root)
      const meta = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8')) as RunMeta
      writeFileSync(join(root, 'run.json'), JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }), 'utf8')
      // Move the run out of the project and into its isolated checkout, exactly
      // as `worktree: true` lays it out.
      const worktree = join(ops.cwd, '.guard', 'worktrees', runId)
      mkdirSync(join(worktree, 'docs', 'guard'), { recursive: true })
      renameSync(join(ops.cwd, 'docs', 'guard', runId), join(worktree, 'docs', 'guard', runId))

      // The header still names the project, where no run exists any more.
      assert.equal(value(await ops.call({ op: 'guard.supervisor', sessionId: ops.sessionId })), null)

      ops.setWorkingDirectory(worktree)
      const summary = value(await ops.call({ op: 'guard.supervisor', sessionId: ops.sessionId }))
      assert.equal(summary.runId, runId)

      // Rollback resolves the same ledger: the run exists but has no checkpoint,
      // which is an actionable reason, not "run is missing".
      const rolled = await ops.call({ op: 'guard.rollback', sessionId: ops.sessionId, runId, confirm: 'rollback' })
      assert.equal(rolled.ok, false)
      assert.match((rolled.error as { message: string }).message, /nothing to roll back/)
    } finally {
      ops.cleanup()
    }
  })
})

describe('guard.repo', () => {
  test('reports the branch, the default branch and a GitLab remote without writing anything', async () => {
    const ops = await boot()
    try {
      const init = (args: string[]) => execFileSync('git', args, { cwd: ops.cwd })
      init(['init', '-q'])
      init(['config', 'user.email', 'g@test'])
      init(['config', 'user.name', 'g'])
      init(['remote', 'add', 'origin', 'ssh://git@gitlab.example.com:30006/ai/demo.git'])
      writeFileSync(join(ops.cwd, 'a.ts'), 'x')
      init(['add', '.'])
      init(['commit', '-qm', 'base'])
      init(['branch', '-M', 'main'])
      init(['checkout', '-qb', 'dev'])

      const facts = value(await ops.call({ op: 'guard.repo', sessionId: ops.sessionId }))
      assert.equal(facts.isGit, true)
      assert.equal(facts.branch, 'dev')
      assert.equal(facts.defaultBranch, 'main')
      assert.equal(facts.remoteKind, 'gitlab')
      assert.equal(facts.remoteHost, 'gitlab.example.com')
    } finally {
      ops.cleanup()
    }
  })

  test('answers isGit: false for a directory that is not a repository', async () => {
    const ops = await boot()
    try {
      const facts = value(await ops.call({ op: 'guard.repo', sessionId: ops.sessionId }))
      assert.equal(facts.isGit, false)
      assert.equal(facts.branch, undefined)
      assert.equal(facts.defaultBranch, undefined)
      assert.equal(facts.remoteKind, undefined)
    } finally {
      ops.cleanup()
    }
  })
})

describe('guard.prepare visual witness validation', () => {
  test('refuses a witness route whose adapter declares text-only input', async () => {
    const ops = await boot()
    try {
      const refused = await ops.call({
        op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody(),
        evaluator: { provider: 'text-only', model: 'text-model' },
        visual: { enabled: true },
      })
      assert.equal(refused.ok, false)
      assert.match((refused.error as { message: string }).message, /does not declare image input/)
    } finally {
      ops.cleanup()
    }
  })

  test('validates the executor modality when the witness follows an unset evaluator', async () => {
    const ops = await boot()
    try {
      // No explicit visual route and no evaluator route: the witness inherits the
      // evaluator, which itself follows the executor. Validating only
      // `input.visual.route ?? input.evaluator` therefore missed the executor.
      const refused = await ops.call({
        op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody(),
        executor: { provider: 'text-only', model: 'text-model' },
        visual: { enabled: true },
      })
      assert.equal(refused.ok, false)
      assert.match((refused.error as { message: string }).message, /does not declare image input/)
    } finally {
      ops.cleanup()
    }
  })
})

describe('guard.continue', () => {
  test('clears the block without rolling the task back, and keeps its attempts', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const metaPath = join(root, 'run.json')
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
      writeFileSync(metaPath, JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }, null, 2), 'utf8')
      const tasksPath = join(root, 'tasks.json')
      const raw = JSON.parse(readFileSync(tasksPath, 'utf8')) as {
        tasks: Record<string, unknown>[]
      } & Record<string, unknown>
      // What an evaluator outage leaves behind: a BLOCKED row, a streak, a run-level block.
      writeFileSync(tasksPath, JSON.stringify({
        ...raw,
        status: 'blocked',
        goalBlocked: 'T1 已阻塞：评估器连续 3 次不可用：评估返回了不可解析的结果',
        tasks: raw.tasks.map(task => ({
          ...task,
          status: 'BLOCKED',
          evalUnavailableStreak: 3,
          blocked: { reason: '评估器连续 3 次不可用：评估返回了不可解析的结果', next: '检查模型配置后回退重试', remainingCandidates: [], at: 1 },
          attempts: [{ index: 1, at: 1, signature: 'sig', probeVector: { C1: 'pass' }, evidenceIds: [] }],
        })),
      }, null, 2), 'utf8')

      const resumed = value(await ops.call({ op: 'guard.continue', sessionId: ops.sessionId, runId: prepared.runId }))
      assert.equal(resumed.status, 'active')
      assert.equal(resumed.blockedReason, undefined)
      assert.equal(resumed.goalResumed, true, 'the response says whether the host goal was actually re-armed')
      assert.equal((resumed.tasks as { status: string }[])[0]?.status, 'IN_PROGRESS')

      const after = JSON.parse(readFileSync(tasksPath, 'utf8')) as {
        status: string
        goalBlocked?: string
        tasks: { status: string, evalUnavailableStreak?: number, attempts?: unknown[] }[]
      }
      assert.equal(after.status, 'active')
      assert.equal(after.goalBlocked, undefined)
      assert.equal(after.tasks[0]?.status, 'IN_PROGRESS')
      assert.equal(after.tasks[0]?.evalUnavailableStreak, undefined)
      assert.equal(after.tasks[0]?.attempts?.length, 1, 'resuming keeps the attempt history')
      const events = readFileSync(join(root, 'state.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string })
      assert.ok(events.some(event => event.type === 'run.resumed'))
      assert.ok(events.some(event => event.type === 'task.unblocked'))
    } finally {
      ops.cleanup()
    }
  })

  test('refuses to resume a run that is not blocked', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const refused = await ops.call({ op: 'guard.continue', sessionId: ops.sessionId, runId: prepared.runId })
      assert.equal(refused.ok, false)
      assert.match((refused.error as { message: string }).message, /没有被阻断/)
    } finally {
      ops.cleanup()
    }
  })

  test('refuses an all-DONE run held by a failed final milestone review', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const metaPath = join(root, 'run.json')
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
      writeFileSync(metaPath, JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }, null, 2), 'utf8')
      const tasksPath = join(root, 'tasks.json')
      const raw = JSON.parse(readFileSync(tasksPath, 'utf8')) as { tasks: Record<string, unknown>[] } & Record<string, unknown>
      // What `maybeMilestoneReview` leaves behind on a failed FINAL review: every
      // task DONE, a run-level goal block, and no BLOCKED task to point at.
      writeFileSync(tasksPath, JSON.stringify({
        ...raw,
        status: 'blocked',
        goalBlocked: '里程碑审阅未通过（第 1 轮）：见 review/round-1.md',
        tasks: raw.tasks.map(task => ({ ...task, status: 'DONE' })),
      }, null, 2), 'utf8')

      const refused = await ops.call({ op: 'guard.continue', sessionId: ops.sessionId, runId: prepared.runId })
      assert.equal(refused.ok, false, 'continuing here would complete the run without passing the review')
      assert.match((refused.error as { message: string }).message, /里程碑审阅未通过/)
      const after = JSON.parse(readFileSync(tasksPath, 'utf8')) as { status: string, goalBlocked?: string }
      assert.equal(after.status, 'blocked', 'the refused resume leaves the ledger untouched')
      assert.ok(after.goalBlocked !== undefined)
    } finally {
      ops.cleanup()
    }
  })

  test('re-checks the turn gate inside the session lock before resuming', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const { tasksPath } = blockPreparedRun(root, ops.sessionId)

      const gate = ops.armSlowModelGate()
      const holding = ops.call({
        op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId,
        role: 'evaluator', route: { provider: 'slow-provider', model: 'slow-model' },
      })
      await gate.entered
      const queued = ops.call({ op: 'guard.continue', sessionId: ops.sessionId, runId: prepared.runId })
      // The holding op read the turn twice (outer + in-lock); the queued one has
      // now passed its own outer gate and sits behind the session lock.
      await until(() => ops.turnReads() >= 3, 'the queued continue passed its outer turn gate')
      ops.setTurnOpen(true)
      gate.open()
      assert.equal((await holding).ok, true)
      const refused = await queued
      assert.equal(refused.ok, false)
      assert.equal((refused.error as { code: string }).code, REDLINE_ERROR.turnOpen)
      const after = JSON.parse(readFileSync(tasksPath, 'utf8')) as { status: string }
      assert.equal(after.status, 'blocked', 'the blocked ledger was not resumed under a live turn')
    } finally {
      ops.cleanup()
    }
  })
})

describe('guard.switch', () => {
  test('switches the evaluator route in the ledger and records the event', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const metaPath = join(root, 'run.json')
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
      writeFileSync(metaPath, JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }, null, 2), 'utf8')

      const switched = value(await ops.call({
        op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId,
        role: 'evaluator', route: { provider: 'provider-b', model: 'model-b', reasoningEffort: 'low' },
      }))
      assert.equal(switched.evaluatorModel, 'provider-b/model-b (low)')
      const after = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')) as { evaluator?: { provider: string; model: string; reasoningEffort?: string } }
      assert.deepEqual(after.evaluator, { provider: 'provider-b', model: 'model-b', reasoningEffort: 'low' })
      const events = readFileSync(join(root, 'state.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string })
      assert.ok(events.some(event => event.type === 'evaluator.switched'))
      assert.deepEqual(ops.selections, [], 'the evaluator switch must not touch the session model')
    } finally {
      ops.cleanup()
    }
  })

  test('switches the executor through the agent model face and records activeExecutor', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const metaPath = join(root, 'run.json')
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
      writeFileSync(metaPath, JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }, null, 2), 'utf8')

      value(await ops.call({
        op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId,
        role: 'executor', route: { provider: 'provider-b', model: 'model-b' },
      }))
      assert.deepEqual(ops.selections, [{ provider: 'provider-b', model: 'model-b' }])
      const after = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')) as { activeExecutor?: { provider: string }, executor?: { provider: string } }
      assert.deepEqual(after.activeExecutor, { provider: 'provider-b', model: 'model-b' })
      assert.equal(after.executor, undefined, 'the frozen executor stays absent when the dialog never recorded one')
    } finally {
      ops.cleanup()
    }
  })

  test('refuses a role it does not own and an unknown route', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const badRole = await ops.call({ op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId, role: 'reviewer' })
      assert.equal(badRole.ok, false)
      const badRoute = await ops.call({
        op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId,
        role: 'evaluator', route: { provider: 'missing-provider', model: 'ghost' },
      })
      assert.equal(badRoute.ok, false)
      assert.equal((badRoute.error as { code: string }).code, REDLINE_ERROR.badRequest)
    } finally {
      ops.cleanup()
    }
  })

  test('resume is ignored for a run that is not blocked, so a paused goal is not woken', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const metaPath = join(root, 'run.json')
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
      writeFileSync(metaPath, JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }, null, 2), 'utf8')

      const switched = value(await ops.call({
        op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId,
        role: 'evaluator', route: { provider: 'provider-b', model: 'model-b' }, resume: true,
      }))
      assert.equal(switched.evaluatorModel, 'provider-b/model-b', 'the route switch itself still happens')
      // The run is active, not blocked. Resuming whatever host goal exists here
      // would wake a goal the human paused by hand.
      assert.equal(ops.goals.create, 0, 'a model switch must not arm a goal')
      assert.equal(ops.goals.resume, 0, 'a model switch must not resume a manually paused goal')
    } finally {
      ops.cleanup()
    }
  })

  test('refuses a text-only judge while the visual witness follows that route', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({
        op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody(),
        evaluator: { provider: 'provider-a', model: 'model-a' },
        visual: { enabled: true },
      }))
      const root = String(prepared.root)
      const metaPath = join(root, 'run.json')
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
      writeFileSync(metaPath, JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }, null, 2), 'utf8')

      // The witness has no route of its own here, so it follows the evaluator.
      // A declared text-only adapter would silently replace the screenshots with
      // a placeholder, producing an imageless "observation" that could pass.
      const refused = await ops.call({
        op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId,
        role: 'evaluator', route: { provider: 'text-only', model: 'text-model' },
      })
      assert.equal(refused.ok, false)
      assert.equal((refused.error as { code: string }).code, REDLINE_ERROR.badRequest)
      assert.match((refused.error as { message: string }).message, /图片输入/)
      const after = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')) as { evaluator?: { provider: string } }
      assert.equal(after.evaluator?.provider, 'provider-a', 'the unusable judge route is never persisted')
    } finally {
      ops.cleanup()
    }
  })

  test('re-checks the turn gate inside the session lock before switching the session model', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const metaPath = join(root, 'run.json')
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
      writeFileSync(metaPath, JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }, null, 2), 'utf8')

      // A holds the session lock while its route is validated.
      const gate = ops.armSlowModelGate()
      const first = ops.call({
        op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId,
        role: 'evaluator', route: { provider: 'slow-provider', model: 'slow-model' },
      })
      await gate.entered
      // B passes the outer gate while the turn is still closed, then queues.
      const second = ops.call({
        op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId,
        role: 'executor', route: { provider: 'provider-b', model: 'model-b' },
      })
      await until(() => ops.turnReads() >= 3, 'the queued switch passed its outer turn gate')
      // A new turn opens while B is queued. Without an in-lock recheck B would
      // call agent.model.select during that live turn.
      ops.setTurnOpen(true)
      gate.open()
      const firstReply = await first
      const secondReply = await second
      assert.equal(firstReply.ok, true)
      assert.equal(secondReply.ok, false)
      assert.equal((secondReply.error as { code: string }).code, REDLINE_ERROR.turnOpen)
      assert.deepEqual(ops.selections, [], 'no session model is switched during an open turn')
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

  test('re-checks the turn gate inside the session lock before rolling back', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      blockPreparedRun(root, ops.sessionId)

      const gate = ops.armSlowModelGate()
      const holding = ops.call({
        op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId,
        role: 'evaluator', route: { provider: 'slow-provider', model: 'slow-model' },
      })
      await gate.entered
      const queued = ops.call({
        op: 'guard.rollback', sessionId: ops.sessionId, runId: prepared.runId, confirm: 'rollback',
      })
      await until(() => ops.turnReads() >= 3, 'the queued rollback passed its outer turn gate')
      ops.setTurnOpen(true)
      gate.open()
      assert.equal((await holding).ok, true)
      const refused = await queued
      assert.equal(refused.ok, false)
      assert.equal((refused.error as { code: string }).code, REDLINE_ERROR.turnOpen)
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
      assert.equal(summary.goalResumed, true, 'a rollback reports whether the host goal was actually re-armed')
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

const TWO_TASK_BODY = {
  ...CARD,
  tasks: 'T1 | 一 | 通过 | a.ts\nT2 | 二 | 通过 | b.ts',
  scopes: { T1: ['a.ts'], T2: ['b.ts'] },
}

/** What `maybeMilestoneReview` leaves behind when round 1 fails mid-run. */
function milestoneBlockRun(root: string, sessionId: string, withKind = true): {
  readonly tasksPath: string
  readonly ledger: string
} {
  const metaPath = join(root, 'run.json')
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
  writeFileSync(metaPath, JSON.stringify({ ...meta, sessionId, phase: 'running' }, null, 2), 'utf8')
  const tasksPath = join(root, 'tasks.json')
  const raw = JSON.parse(readFileSync(tasksPath, 'utf8')) as { tasks: Record<string, unknown>[] } & Record<string, unknown>
  // T1 landed, T2 is still TODO: only a FINAL failure leaves every task DONE,
  // and the old resume gate only looked at the all-DONE case.
  writeFileSync(tasksPath, JSON.stringify({
    ...raw,
    status: 'blocked',
    goalBlocked: '里程碑审阅未通过（第 1 轮）：见 review/round-1.md',
    ...(withKind ? { goalBlockKind: 'milestone' } : {}),
    tasks: raw.tasks.map((task, index) => ({ ...task, status: index === 0 ? 'DONE' : 'TODO' })),
  }, null, 2), 'utf8')
  return { tasksPath, ledger: readFileSync(tasksPath, 'utf8') }
}

/** What `maybeMilestoneReview` leaves behind in a parallel batch: one sibling
 *  BLOCKED while another finished and the review failed. Only `goalBlockKind`
 *  marks the gate — the prose is not the legacy Chinese sentence. */
function parallelMilestoneBlockRun(root: string, sessionId: string): {
  readonly tasksPath: string
  readonly ledger: string
} {
  const metaPath = join(root, 'run.json')
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
  writeFileSync(metaPath, JSON.stringify({ ...meta, sessionId, phase: 'running' }, null, 2), 'utf8')
  const tasksPath = join(root, 'tasks.json')
  const raw = JSON.parse(readFileSync(tasksPath, 'utf8')) as { tasks: Record<string, unknown>[] } & Record<string, unknown>
  writeFileSync(tasksPath, JSON.stringify({
    ...raw,
    status: 'blocked',
    goalBlocked: 'milestone review failed (round 1): see review/round-1.md',
    goalBlockKind: 'milestone',
    tasks: raw.tasks.map((task, index) => ({
      ...task,
      status: index === 0 ? 'BLOCKED' : 'DONE',
      ...(index === 0
        ? { blocked: { reason: '评估器不可用', next: '继续', remainingCandidates: [], at: 1 } }
        : {}),
    })),
    activeTaskIds: [],
  }, null, 2), 'utf8')
  return { tasksPath, ledger: readFileSync(tasksPath, 'utf8') }
}

describe('guard.continue milestone gate', () => {
  test('refuses to clear a mid-run milestone failure while later tasks are still open', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...TWO_TASK_BODY }))
      const root = String(prepared.root)
      const { tasksPath, ledger } = milestoneBlockRun(root, ops.sessionId)
      const refused = await ops.call({ op: 'guard.continue', sessionId: ops.sessionId, runId: prepared.runId })
      assert.equal(refused.ok, false, 'continuing would run the next task without the failed review passing')
      assert.match((refused.error as { message: string }).message, /里程碑审阅未通过/)
      assert.equal(readFileSync(tasksPath, 'utf8'), ledger, 'the refused resume leaves the ledger byte-for-byte untouched')
    } finally {
      ops.cleanup()
    }
  })

  test('a legacy milestone block without goalBlockKind is still refused', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...TWO_TASK_BODY }))
      const root = String(prepared.root)
      milestoneBlockRun(root, ops.sessionId, false)
      const refused = await ops.call({ op: 'guard.continue', sessionId: ops.sessionId, runId: prepared.runId })
      assert.equal(refused.ok, false)
      assert.match((refused.error as { message: string }).message, /里程碑审阅未通过/)
    } finally {
      ops.cleanup()
    }
  })

  test('a parallel BLOCKED sibling does not make a milestone block resumable', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...TWO_TASK_BODY }))
      const root = String(prepared.root)
      const { tasksPath, ledger } = parallelMilestoneBlockRun(root, ops.sessionId)
      const refused = await ops.call({ op: 'guard.continue', sessionId: ops.sessionId, runId: prepared.runId })
      assert.equal(refused.ok, false, 'continuing would reopen T1 and skip the failed review')
      assert.match((refused.error as { message: string }).message, /里程碑审阅未通过/)
      assert.equal(readFileSync(tasksPath, 'utf8'), ledger, 'the refused continue is not a side effect')
    } finally {
      ops.cleanup()
    }
  })
})

describe('guard.switch resume preflight', () => {
  test('a milestone-blocked run refuses the switch before any side effect', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...TWO_TASK_BODY }))
      const root = String(prepared.root)
      const { tasksPath, ledger } = milestoneBlockRun(root, ops.sessionId)
      const eventsBefore = readFileSync(join(root, 'state.jsonl'), 'utf8')
      const refused = await ops.call({
        op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId,
        role: 'executor', route: { provider: 'provider-b', model: 'model-b' }, resume: true,
      })
      assert.equal(refused.ok, false)
      assert.match((refused.error as { message: string }).message, /里程碑审阅未通过/)
      // Zero side effects: the model was not selected, the ledger and the event
      // log were not touched, and no goal was armed.
      assert.deepEqual(ops.selections, [], 'the session model must not be switched')
      assert.equal(readFileSync(tasksPath, 'utf8'), ledger, 'the persisted route is unchanged')
      assert.equal(readFileSync(join(root, 'state.jsonl'), 'utf8'), eventsBefore)
      assert.equal(ops.goals.create + ops.goals.resume, 0)
    } finally {
      ops.cleanup()
    }
  })

  test('the same switch without resume still records the route', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...TWO_TASK_BODY }))
      const root = String(prepared.root)
      milestoneBlockRun(root, ops.sessionId)
      const switched = value(await ops.call({
        op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId,
        role: 'evaluator', route: { provider: 'provider-b', model: 'model-b' },
      }))
      assert.equal(switched.evaluatorModel, 'provider-b/model-b')
      assert.equal(switched.status, 'blocked', 'the block itself is untouched without resume')
    } finally {
      ops.cleanup()
    }
  })

  test('a parallel BLOCKED sibling cannot carry a resume switch past the gate', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...TWO_TASK_BODY }))
      const root = String(prepared.root)
      const { tasksPath, ledger } = parallelMilestoneBlockRun(root, ops.sessionId)
      const eventsBefore = readFileSync(join(root, 'state.jsonl'), 'utf8')
      const refused = await ops.call({
        op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId,
        role: 'executor', route: { provider: 'provider-b', model: 'model-b' }, resume: true,
      })
      assert.equal(refused.ok, false)
      assert.match((refused.error as { message: string }).message, /里程碑审阅未通过/)
      // Zero side effects: the sibling being BLOCKED used to be enough for the
      // preflight to pass, after which the switch selected the session model and
      // cleared the milestone flag.
      assert.deepEqual(ops.selections, [], 'the session model must not be switched')
      assert.equal(readFileSync(tasksPath, 'utf8'), ledger, 'the persisted route is unchanged')
      assert.equal(readFileSync(join(root, 'state.jsonl'), 'utf8'), eventsBefore)
      assert.equal(ops.goals.create + ops.goals.resume, 0)
    } finally {
      ops.cleanup()
    }
  })

  test('a resume refused after a concurrent milestone block is reported, not hidden', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...TWO_TASK_BODY }))
      const root = String(prepared.root)
      const metaPath = join(root, 'run.json')
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
      writeFileSync(metaPath, JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }, null, 2), 'utf8')
      // The preflight reads an unblocked ledger, then the route resolution is
      // held open long enough for an audit to land a failing milestone review.
      const gate = ops.armSlowModelGate()
      const switching = ops.call({
        op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId,
        role: 'evaluator', route: { provider: 'slow-provider', model: 'slow-model' }, resume: true,
      })
      await gate.entered
      const tasksPath = join(root, 'tasks.json')
      const raw = JSON.parse(readFileSync(tasksPath, 'utf8')) as { tasks: Record<string, unknown>[] } & Record<string, unknown>
      writeFileSync(tasksPath, JSON.stringify({
        ...raw,
        status: 'blocked',
        goalBlocked: '里程碑审阅未通过（第 1 轮）：见 review/round-1.md',
        goalBlockKind: 'milestone',
        tasks: raw.tasks.map(task => ({ ...task, status: 'DONE' })),
      }, null, 2), 'utf8')
      gate.open()
      const summary = value(await switching)
      // The route switch DID commit; the reply must say the resume half was
      // refused instead of reporting the whole switch as failed or silent.
      assert.match(String(summary.resumeRefused), /里程碑审阅未通过/)
      assert.equal(summary.goalResumed, undefined, 'the host goal was never woken')
      assert.equal(ops.goals.create + ops.goals.resume, 0)
      const after = JSON.parse(readFileSync(tasksPath, 'utf8')) as {
        status: string
        goalBlockKind?: string
        evaluator?: { provider: string }
      }
      assert.equal(after.status, 'blocked', 'the refused resume did not reopen the ledger')
      assert.equal(after.goalBlockKind, 'milestone')
      assert.equal(after.evaluator?.provider, 'slow-provider', 'the committed route survives the refusal')
    } finally {
      ops.cleanup()
    }
  })
})

describe('guard run metadata presence', () => {
  test('a missing run.json is an explicit error, not a pass', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      rmSync(join(root, 'run.json'))
      const tasksPath = join(root, 'tasks.json')
      const ledger = readFileSync(tasksPath, 'utf8')
      for (const body of [
        { op: 'guard.continue', runId: prepared.runId },
        { op: 'guard.switch', runId: prepared.runId, role: 'evaluator', route: { provider: 'provider-b', model: 'model-b' } },
        { op: 'guard.rollback', runId: prepared.runId, confirm: 'rollback' },
      ]) {
        const refused = await ops.call({ ...body, sessionId: ops.sessionId })
        assert.equal(refused.ok, false, `${body.op} must not proceed without a run record`)
        assert.equal((refused.error as { code: string }).code, REDLINE_ERROR.badRequest)
        assert.match((refused.error as { message: string }).message, /运行记录缺失|run\.json/)
      }
      assert.equal(readFileSync(tasksPath, 'utf8'), ledger, 'no ledger write without a run record')
      assert.deepEqual(ops.selections, [])
    } finally {
      ops.cleanup()
    }
  })
})

describe('guard.prepare witness modality from the session model', () => {
  test('validates the session model when the witness follows the unset evaluator', async () => {
    const ops = await boot()
    try {
      // The witness follows the evaluator; the evaluator follows the session
      // model. Validating only the dialog's explicit routes missed this arm.
      ops.setSessionModel('text-only', 'text-model')
      const refused = await ops.call({
        op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody(), visual: { enabled: true },
      })
      assert.equal(refused.ok, false)
      assert.match((refused.error as { message: string }).message, /does not declare image input/)
    } finally {
      ops.cleanup()
    }
  })

  test('a text-only executor switch is refused while the witness follows it', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({
        op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody(), visual: { enabled: true },
      }))
      const root = String(prepared.root)
      const metaPath = join(root, 'run.json')
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
      writeFileSync(metaPath, JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }, null, 2), 'utf8')
      const refused = await ops.call({
        op: 'guard.switch', sessionId: ops.sessionId, runId: prepared.runId,
        role: 'executor', route: { provider: 'text-only', model: 'text-model' },
      })
      assert.equal(refused.ok, false)
      assert.equal((refused.error as { code: string }).code, REDLINE_ERROR.badRequest)
      assert.match((refused.error as { message: string }).message, /图片输入/)
      assert.deepEqual(ops.selections, [], 'the unusable executor route is never selected')
    } finally {
      ops.cleanup()
    }
  })
})

describe('guard.rollback goal resume reporting', () => {
  test('a rollback whose host goal cannot be re-armed reports goalResumed: false', async () => {
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

      // The host refuses to arm a new goal (e.g. it already hit its round cap).
      ops.setGoalCreateFails(true)
      const summary = value(await ops.call({
        op: 'guard.rollback', sessionId: ops.sessionId, runId: prepared.runId, confirm: 'rollback',
      }))
      // The ledger did reopen; telling the card "in progress" with a dead goal
      // would hide the fact that nothing drives the next turn.
      assert.equal(summary.status, 'active')
      assert.equal(summary.goalResumed, false)
      const after = JSON.parse(readFileSync(tasksPath, 'utf8')) as { tasks: { status: string }[] }
      assert.equal(after.tasks[0]?.status, 'TODO')
    } finally {
      ops.cleanup()
    }
  })

  // A sibling-only rollback keeps the milestone gate: `rollbackRun` leaves the
  // ledger `blocked` + `goalBlocked` + `goalBlockKind: 'milestone'`. Waking the
  // host goal anyway drove turns that `auditTurn` refuses to supervise (it
  // returns the blocked state without auditing), and replying
  // `goalResumed:false` invented a failure where the gate is deliberate.
  test('a milestone-gated sibling rollback leaves the goal stopped and reports no resume', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const { tasksPath } = blockPreparedRun(root, ops.sessionId)
      const state = JSON.parse(readFileSync(tasksPath, 'utf8')) as Record<string, unknown> & { tasks: Record<string, unknown>[] }
      // The BLOCKED task is a sibling of the DONE task the review rejected:
      // reopening it must not clear the run-level milestone gate.
      writeFileSync(tasksPath, JSON.stringify({
        ...state,
        goalBlocked: 'milestone review failed (round 1): see review/round-1.md',
        goalBlockKind: 'milestone',
      }, null, 2), 'utf8')
      // A live blocked goal is exactly what a blind `goals.resume` would wake.
      ops.setGoalView({ id: 'goal-1', revision: 2, phase: 'blocked', activation: 'disarmed' })

      const summary = value(await ops.call({
        op: 'guard.rollback', sessionId: ops.sessionId, runId: prepared.runId, confirm: 'rollback',
      }))
      assert.equal(summary.status, 'blocked', 'the milestone gate survives the sibling rollback')
      assert.equal('goalResumed' in summary, false, 'a deliberately closed gate is not a failed resume')
      assert.equal(ops.goals.resume, 0, 'the host goal is not woken past the gate')
      assert.equal(ops.goals.create, 0)
      const after = JSON.parse(readFileSync(tasksPath, 'utf8')) as {
        status: string
        goalBlocked?: string
        goalBlockKind?: string
        tasks: { id: string, status: string }[]
      }
      assert.equal(after.status, 'blocked')
      assert.equal(after.goalBlockKind, 'milestone')
      assert.equal(after.tasks[0]?.status, 'TODO', 'the BLOCKED sibling was still reopened')
    } finally {
      ops.cleanup()
    }
  })

  // The ordinary rollback does reopen the ledger (`active`, no goalBlocked), so
  // the host goal must be resumed and the reply must say so.
  test('a rollback that clears the block resumes the goal and reports goalResumed: true', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const { tasksPath } = blockPreparedRun(String(prepared.root), ops.sessionId)
      ops.setGoalView({ id: 'goal-1', revision: 2, phase: 'blocked', activation: 'disarmed' })

      const summary = value(await ops.call({
        op: 'guard.rollback', sessionId: ops.sessionId, runId: prepared.runId, confirm: 'rollback',
      }))
      assert.equal(summary.status, 'active')
      assert.equal(summary.goalResumed, true)
      assert.equal(ops.goals.resume, 1)
      const after = JSON.parse(readFileSync(tasksPath, 'utf8')) as { status: string, goalBlocked?: string, tasks: { status: string }[] }
      assert.equal(after.status, 'active')
      assert.equal(after.goalBlocked, undefined)
      assert.equal(after.tasks[0]?.status, 'TODO')
    } finally {
      ops.cleanup()
    }
  })
})

describe('guard ownership', () => {
  test('refuses a run record that belongs to another session', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const { tasksPath } = blockPreparedRun(root, ops.sessionId)
      const before = readFileSync(tasksPath, 'utf8')
      ops.addAgent('session-elsewhere')

      const calls = [
        { op: 'guard.continue', runId: prepared.runId },
        { op: 'guard.switch', runId: prepared.runId, role: 'evaluator', route: { provider: 'provider-b', model: 'model-b' } },
        { op: 'guard.rollback', runId: prepared.runId, confirm: 'rollback' },
      ]
      for (const body of calls) {
        const refused = await ops.call({ ...body, sessionId: 'session-elsewhere' })
        assert.equal(refused.ok, false, `${body.op} must not touch another session's run`)
        assert.equal((refused.error as { code: string }).code, REDLINE_ERROR.badRequest)
        assert.match((refused.error as { message: string }).message, /归属/)
      }
      assert.equal(readFileSync(tasksPath, 'utf8'), before, 'the foreign ledger is byte-for-byte untouched')
      assert.deepEqual(ops.selections, [], 'the foreign session model was never switched')
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

// The ledger and the host goal can disagree. The card and 继续 must see the
// host truth instead of a `tasks.json` that still says `active`.
describe('guard host goal alignment', () => {
  test('guard.supervisor reports the live host goal', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const metaPath = join(root, 'run.json')
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
      writeFileSync(metaPath, JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }, null, 2), 'utf8')
      ops.setGoalView({
        id: 'goal-1', revision: 3, phase: 'blocked', activation: 'disarmed',
        roundsStarted: 256, maxGoalRounds: 256,
        blockedReason: { code: 'round-limit', message: 'Goal reached its configured limit of 256 rounds.' },
      })
      const summary = value(await ops.call({ op: 'guard.supervisor', sessionId: ops.sessionId, runId: prepared.runId }))
      const hostGoal = summary.hostGoal as Record<string, unknown> | undefined
      assert.equal(hostGoal?.phase, 'blocked')
      assert.equal(hostGoal?.roundsStarted, 256)
      assert.equal(hostGoal?.blockedCode, 'round-limit')
    } finally {
      ops.cleanup()
    }
  })

  test('guard.continue re-arms a host goal that stopped while the ledger stayed active', async () => {
    const ops = await boot()
    try {
      const prepared = value(await ops.call({ op: 'guard.prepare', sessionId: ops.sessionId, ...prepareBody() }))
      const root = String(prepared.root)
      const metaPath = join(root, 'run.json')
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
      writeFileSync(metaPath, JSON.stringify({ ...meta, sessionId: ops.sessionId, phase: 'running' }, null, 2), 'utf8')
      ops.setGoalView({
        id: 'goal-1', revision: 3, phase: 'blocked', activation: 'disarmed',
        roundsStarted: 256, maxGoalRounds: 256,
        blockedReason: { code: 'round-limit', message: 'Goal reached its configured limit of 256 rounds.' },
      })

      const resumed = value(await ops.call({ op: 'guard.continue', sessionId: ops.sessionId, runId: prepared.runId }))
      assert.equal(resumed.goalResumed, true, 'the exhausted goal is re-armed, not merely reopened')
      assert.equal(ops.goals.edit, 1, 'the round cap is raised before resuming')
      assert.equal(ops.goals.resume, 1)
      const events = readFileSync(join(root, 'state.jsonl'), 'utf8').trim().split('\n')
        .map(line => JSON.parse(line) as { type: string, reason?: string })
      assert.ok(events.some(event => event.type === 'run.resumed' && (event.reason ?? '').includes('重新激活宿主目标')))
    } finally {
      ops.cleanup()
    }
  })
})
