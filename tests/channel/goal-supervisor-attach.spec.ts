import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import { prepareGuardRun } from '../../src/host/goal-supervisor/create'
import {
  armSupervisorGoal, attachSupervisor, attachedSupervisorFor, forgetSupervisor, forgetSessionAttachments,
  resumeSupervisorGoal,
  SUPERVISOR_ANCHOR_HEAD, SUPERVISOR_ANCHOR_TAIL, watchGoalSupervisors,
} from '../../src/host/goal-supervisor/attach'
import { RUNTIME_ANCHOR_NAME } from '../../src/shared/redline-carrier'
import type { GuardState, RunMeta } from '../../src/host/goal-supervisor/schema'

const git = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  for (const sessionId of ['session-supervisor', 's', 'session-cold', 'session-reopen', 'session-mirror']) {
    forgetSessionAttachments(sessionId)
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guard-attach-'))
  roots.push(root)
  return root
}

async function prepared(cwd: string): Promise<string> {
  const run = await prepareGuardRun(cwd, {
    goal: '把目标漂移修好',
    acceptance: '所有任务 DONE',
    discipline: '主会话只规划/分派/审查',
    tasks: 'T1 | 状态落盘 | 文件存在',
    probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
  })
  return run.runId
}

describe('goal-supervisor attach', () => {
  test('registers head and tail anchors, arms the goal after mount and audits light probes', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')

    const contexts: { name: string; order: number; text: () => string }[] = []
    const handlers: Record<string, () => void | Promise<void>> = {}
    let created: { objective: string } | undefined
    const ctx = {
      get(name: string) {
        if (name !== 'goals') return undefined
        return {
          get: () => undefined,
          create: (_agent: unknown, request: { objective: string }) => { created = request },
        }
      },
    }
    const agentCtx = {
      get(name: string) {
        if (name !== 'systemPrompt') return undefined
        return {
          context: (input: { name: string; order: number; text: () => string }) => { contexts.push(input) },
        }
      },
      on(name: string, handler: () => void | Promise<void>) { handlers[name] = handler },
    }

    const attached = await attachSupervisor({
      ctx: ctx as never,
      agentCtx: agentCtx as never,
      agent: { id: 'session-supervisor' } as never,
      runId,
      cwd,
    })

    assert.deepEqual(contexts.map(item => item.name), [SUPERVISOR_ANCHOR_HEAD, SUPERVISOR_ANCHOR_TAIL])
    assert.deepEqual(contexts.map(item => item.order), [90, 900])
    assert.match(contexts[0]!.text(), /目标守卫 · 锚点/)
    // The injected anchor must name the directory the probes run in: the model
    // otherwise has to reverse-engineer it from the ledger and burns the turn.
    assert.ok(
      contexts[0]!.text().includes(`运行目录：${cwd}`),
      `anchor must name the run directory: ${contexts[0]!.text()}`,
    )
    // Attaching never touches the goal service: `setup` runs before the agent is live.
    // (Snapshotted, because `assert.equal` narrows the live variable.)
    const createdBeforeArm = created as { objective: string } | undefined
    assert.equal(createdBeforeArm, undefined)

    const beforeArm = JSON.parse(await readFile(join(cwd, 'docs', 'guard', runId, 'run.json'), 'utf8')) as RunMeta
    assert.equal(beforeArm.sessionId, 'session-supervisor')
    assert.equal(beforeArm.setup.goal, false)
    assert.equal(beforeArm.setup.anchors, true)

    // Arming after the agent entered the registry is what creates the goal.
    const armed = await armSupervisorGoal({ ctx: ctx as never, agent: { id: 'session-supervisor' } as never, cwd, runId })
    assert.equal(armed, true)
    const createdAfterArm = created as { objective: string } | undefined
    assert.ok(createdAfterArm?.objective.includes('把目标漂移修好'))

    const meta = JSON.parse(await readFile(join(cwd, 'docs', 'guard', runId, 'run.json'), 'utf8')) as RunMeta
    assert.equal(meta.phase, 'running')
    assert.equal(meta.setup.goal, true)

    assert.equal(typeof handlers['agent/turn-stopping'], 'function')
    await attached.handler()

    const state = JSON.parse(await readFile(join(cwd, 'docs', 'guard', runId, 'tasks.json'), 'utf8')) as GuardState
    assert.deepEqual(state.activeTaskIds, ['T1'])
    assert.equal(state.tasks[0]?.status, 'IN_PROGRESS')
    assert.equal(state.tasks[0]?.probeResults.P1?.result, 'pass')

    const events = (await readFile(join(cwd, 'docs', 'guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
    assert.ok(events.some(line => (JSON.parse(line) as { type: string }).type === 'probe.run'))
  })

  test('enforce mode denies writes outside the task scope and all shell commands', async () => {
    const cwd = await workspace()
    const runId = await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 落盘 | 文件存在',
      enforcement: 'enforce',
      scopes: { T1: ['src/**'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    }).then(result => result.runId)
    let guardFn: ((exec: Record<string, unknown>) => string | undefined) | undefined
    const agentCtx = {
      get(name: string) {
        if (name === 'systemPrompt') return undefined
        if (name === 'tools') return { guard: (fn: typeof guardFn) => { guardFn = fn } }
        return undefined
      },
      on() {},
    }
    await attachSupervisor({ ctx: { get: () => undefined } as never, agentCtx: agentCtx as never, agent: { id: 's' } as never, runId, cwd })
    assert.ok(guardFn !== undefined)
    const inside = guardFn?.({ name: 'write', arguments: { file_path: 'src/a.ts' } })
    assert.equal(inside, undefined)
    const outside = guardFn?.({ name: 'write', arguments: { file_path: 'docs/x.md' } })
    assert.match(outside ?? '', /scope/)
    const guardPath = guardFn?.({ name: 'write', arguments: { file_path: `docs/guard/${runId}/tasks/T1/notes.md` } })
    assert.equal(guardPath, undefined)
    assert.match(guardFn?.({ name: 'bash', arguments: { command: 'rm -rf /' } }) ?? '', /子会话/)
    assert.match(guardFn?.({ name: 'update_goal', arguments: { action: 'complete' } }) ?? '', /不能标记目标完成/)
  })

  test('enforce mode allows only notes, review and request files inside the run directory', async () => {
    const cwd = await workspace()
    const runId = await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 落盘 | 文件存在',
      enforcement: 'enforce',
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    }).then(result => result.runId)
    let guardFn: ((exec: Record<string, unknown>) => string | undefined) | undefined
    const agentCtx = {
      get(name: string) {
        if (name === 'tools') return { guard: (fn: typeof guardFn) => { guardFn = fn } }
        return undefined
      },
      on() {},
    }
    await attachSupervisor({ ctx: { get: () => undefined } as never, agentCtx: agentCtx as never, agent: { id: 's' } as never, runId, cwd })
    const deny = (filePath: string): string | undefined => guardFn?.({ name: 'write', arguments: { file_path: filePath } })
    // The three legal record files stay allowed.
    assert.equal(deny(`docs/guard/${runId}/tasks/T1/notes.md`), undefined)
    assert.equal(deny(`docs/guard/${runId}/review/round-1.md`), undefined)
    assert.equal(deny(`docs/guard/${runId}/requests/scope-T1-1.json`), undefined)
    // Everything else inside the run directory is the plugin's own ledger.
    assert.match(deny(`docs/guard/${runId}/tasks.json`) ?? '', /只允许写/)
    assert.match(deny(`docs/guard/${runId}/run.json`) ?? '', /只允许写/)
    assert.match(deny(`docs/guard/${runId}/state.jsonl`) ?? '', /只允许写/)
    assert.match(deny(`docs/guard/${runId}/probes/T1.json`) ?? '', /只允许写/)
    // Path traversal never becomes a write.
    assert.match(deny('../outside.ts') ?? '', /工作区内/)
    assert.match(deny('/etc/passwd') ?? '', /工作区内/)
  })

  test('denies create_goal, apply_patch and stringified arguments are understood', async () => {
    const cwd = await workspace()
    const runId = await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 落盘 | 文件存在',
      enforcement: 'enforce',
      scopes: { T1: ['src/**'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    }).then(result => result.runId)
    let guardFn: ((exec: Record<string, unknown>) => string | undefined) | undefined
    const agentCtx = {
      get(name: string) {
        if (name === 'tools') return { guard: (fn: typeof guardFn) => { guardFn = fn } }
        return undefined
      },
      on() {},
    }
    await attachSupervisor({ ctx: { get: () => undefined } as never, agentCtx: agentCtx as never, agent: { id: 's' } as never, runId, cwd })
    assert.match(guardFn?.({ name: 'create_goal', arguments: { objective: '别的目标' } }) ?? '', /不要另建 goal/)
    assert.match(guardFn?.({ name: 'apply_patch', arguments: { input: '*** Begin Patch' } }) ?? '', /严格模式/)
    assert.match(guardFn?.({ name: 'str_replace_editor', arguments: {} }) ?? '', /严格模式/)
    assert.match(guardFn?.({ name: 'pwsh', arguments: { command: 'ls' } }) ?? '', /严格模式/)
    // A JSON-string argument object must be parsed, not silently treated as empty.
    assert.match(guardFn?.({ name: 'write', arguments: JSON.stringify({ file_path: 'docs/x.md' }) }) ?? '', /scope/)
    assert.equal(guardFn?.({ name: 'write', arguments: JSON.stringify({ file_path: 'src/a.ts' }) }), undefined)
    // A guard is scoped to its own session even if another agent's call reaches it.
    assert.equal(guardFn?.({ name: 'bash', arguments: {}, agent: { id: 'other-session' } }), undefined)
  })

  test('armSupervisorGoal records setup-failed when the goal service refuses', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    const ctx = {
      get(name: string) {
        if (name !== 'goals') return undefined
        return {
          get: () => undefined,
          create: () => { throw new Error('GOAL_AGENT_NOT_LIVE: not live in this registry') },
        }
      },
    }
    const armed = await armSupervisorGoal({ ctx: ctx as never, agent: { id: 's' } as never, cwd, runId })
    assert.equal(armed, false)
    const meta = JSON.parse(await readFile(join(cwd, 'docs', 'guard', runId, 'run.json'), 'utf8')) as RunMeta
    assert.equal(meta.phase, 'setup-failed')
    assert.equal(meta.setup.failedStep, 'goal')
    assert.match(meta.setup.errorMessage ?? '', /GOAL_AGENT_NOT_LIVE/)
    const events = (await readFile(join(cwd, 'docs', 'guard', runId, 'state.jsonl'), 'utf8')).trim().split('\n')
    assert.ok(events.some(line => (JSON.parse(line) as { type: string }).type === 'setup.failed'))
  })

  test('a cold start re-attaches anchors and the audit from run.json', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')
    // First mount in "this process": registers the session id in run.json.
    await attachSupervisor({
      ctx: { get: () => undefined } as never,
      agentCtx: { get: () => undefined, on() {} } as never,
      agent: { id: 'session-cold' } as never,
      runId,
      cwd,
    })
    forgetSupervisor('session-cold', cwd, runId)

    const contexts: string[] = []
    const texts: Record<string, string> = {}
    const handlers: Record<string, () => void | Promise<void>> = {}
    const listeners: ((payload: { agent: unknown }) => void | Promise<void>)[] = []
    const agent = {
      id: 'session-cold',
      session: { header: { cwd } },
      ctx: {
        get(name: string) {
          if (name !== 'systemPrompt') return undefined
          return {
            context: (input: { name: string; text: string | (() => string) }) => {
              contexts.push(input.name)
              texts[input.name] = typeof input.text === 'function' ? input.text() : input.text
            },
          }
        },
        on(name: string, handler: () => void | Promise<void>) { handlers[name] = handler },
      },
    }
    const ctx = {
      get: () => undefined,
      on(name: string, handler: (payload: { agent: unknown }) => void | Promise<void>) {
        if (name === 'agent/created') listeners.push(handler)
      },
    }
    watchGoalSupervisors(ctx as never)
    assert.equal(listeners.length, 1)
    await listeners[0]!({ agent })
    assert.deepEqual(contexts, [SUPERVISOR_ANCHOR_HEAD, SUPERVISOR_ANCHOR_TAIL, RUNTIME_ANCHOR_NAME])
    // A cold start must give the model the same frozen card, not only the
    // supervisor's short head/tail rendering.
    assert.match(texts[RUNTIME_ANCHOR_NAME] ?? '', /^目标：/)
    assert.match(texts[RUNTIME_ANCHOR_NAME] ?? '', /验收：/)
    assert.match(texts[RUNTIME_ANCHOR_NAME] ?? '', /纪律：/)
    assert.equal(typeof handlers['agent/turn-stopping'], 'function')
  })

  test('a cold start re-attaches a worktree run through the effective directory', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    // Move the run into its isolated checkout: the header keeps the project,
    // which no longer holds the ledger at all.
    const worktree = join(cwd, '.guard', 'worktrees', runId)
    await mkdir(join(worktree, 'docs', 'guard'), { recursive: true })
    await rename(join(cwd, 'docs', 'guard', runId), join(worktree, 'docs', 'guard', runId))
    await writeFile(join(worktree, 'a.ts'), 'ok')
    // `run.json.sessionId` is what binds a re-opened session to its run.
    const metaPath = join(worktree, 'docs', 'guard', runId, 'run.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as RunMeta
    await writeFile(metaPath, JSON.stringify({ ...meta, sessionId: 'session-cold-worktree' }, null, 2), 'utf8')

    const contexts: string[] = []
    const handlers: Record<string, () => void | Promise<void>> = {}
    const listeners: ((payload: { agent: unknown }) => void | Promise<void>)[] = []
    const agent = {
      id: 'session-cold-worktree',
      session: { header: { cwd } },
      ctx: {
        get(name: string) {
          if (name !== 'systemPrompt') return undefined
          return { context: (input: { name: string }) => { contexts.push(input.name) } }
        },
        on(name: string, handler: () => void | Promise<void>) { handlers[name] = handler },
      },
    }
    const ctx = {
      // The Host moved this session into the checkout after it was created.
      get(name: string) {
        return name === 'workingDirectory' ? { get: () => worktree } : undefined
      },
      on(name: string, handler: (payload: { agent: unknown }) => void | Promise<void>) {
        if (name === 'agent/created') listeners.push(handler)
      },
    }
    watchGoalSupervisors(ctx as never)
    await listeners[0]!({ agent })
    assert.deepEqual(contexts, [SUPERVISOR_ANCHOR_HEAD, SUPERVISOR_ANCHOR_TAIL, RUNTIME_ANCHOR_NAME], 'the ledger is found in the checkout')
    assert.equal(typeof handlers['agent/turn-stopping'], 'function')
  })

  test('a cold start defers arming the goal past the serial agent/created dispatch', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    // `run.json.sessionId` is what binds a re-opened session to its run.
    const metaPath = join(cwd, 'docs', 'guard', runId, 'run.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as RunMeta
    await writeFile(metaPath, JSON.stringify({ ...meta, sessionId: 'session-cold-arm' }, null, 2), 'utf8')

    let created = 0
    const listeners: ((payload: { agent: unknown }) => void | Promise<void>)[] = []
    const agent = {
      id: 'session-cold-arm',
      session: { header: { cwd } },
      // No systemPrompt/tools faces: the mount degrades but still arms the goal.
      ctx: { get: () => undefined, on: () => {} },
    }
    const ctx = {
      get(name: string) {
        if (name === 'goals') {
          return { get: () => undefined, create: () => { created += 1 } }
        }
        // The registry must hand back the SAME object, or the deferred arm
        // correctly decides this is no longer the live agent.
        if (name === 'agents') return { get: () => agent }
        return undefined
      },
      on(name: string, handler: (payload: { agent: unknown }) => void | Promise<void>) {
        if (name === 'agent/created') listeners.push(handler)
      },
    }
    watchGoalSupervisors(ctx as never)
    await listeners[0]!({ agent })
    assert.equal(created, 0, 'GoalService disarms inside the dispatch; arming must not race it')
    for (let tick = 0; tick < 100 && created === 0; tick += 1) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
    }
    assert.equal(created, 1, 'the deferred arm creates the goal once the dispatch is over')
  })

  test('refuses to attach to a run that was never prepared', async () => {
    const cwd = await workspace()
    await assert.rejects(() => attachSupervisor({
      ctx: { get: () => undefined } as never,
      agentCtx: {} as never,
      agent: { id: 's' } as never,
      runId: 'missing',
      cwd,
    }), /missing/)
  })

  test('disposing a session frees its attachment so a re-opened one re-mounts', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    await writeFile(join(cwd, 'a.ts'), 'ok')
    const listeners: Record<string, ((payload: { agent: unknown }) => void | Promise<void>)[]> = {}
    const ctx = {
      get: () => undefined,
      on(name: string, handler: (payload: { agent: unknown }) => void | Promise<void>) {
        listeners[name] = [...(listeners[name] ?? []), handler]
      },
    }
    watchGoalSupervisors(ctx as never)
    const first = {
      id: 'session-reopen',
      session: { header: { cwd } },
      ctx: { get: () => undefined, on: () => {} },
    }
    // The run must remember this session before the watcher can find it.
    await attachSupervisor({ ctx: ctx as never, agentCtx: first.ctx as never, agent: first as never, runId, cwd })
    assert.ok(attachedSupervisorFor('session-reopen', runId) !== undefined)
    // The session is unloaded: the slot must be released …
    listeners['agent/disposed'][0]!({ agent: first })
    assert.equal(attachedSupervisorFor('session-reopen', runId), undefined)
    // … and a re-opened session (a DIFFERENT object, same id) mounts again.
    let remounted = 0
    const second = {
      id: 'session-reopen',
      session: { header: { cwd } },
      ctx: {
        get(name: string) {
          if (name === 'systemPrompt') return { context: () => { remounted += 1 } }
          return undefined
        },
        on: () => {},
      },
    }
    await listeners['agent/created'][0]!({ agent: second })
    assert.ok(remounted >= 2, 'head and tail anchors are registered again')
  })

  test('re-attaching keeps the durable mirror issue identity', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    const metaPath = join(cwd, 'docs', 'guard', runId, 'run.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as RunMeta
    await writeFile(metaPath, JSON.stringify({
      ...meta,
      mirror: { mode: 'auto', provider: 'gitlab', host: 'lionm4', issueNumber: 42, issueUrl: 'http://lionm4/ai/app/-/work_items/42' },
    }, null, 2), 'utf8')
    await attachSupervisor({
      ctx: { get: () => undefined } as never,
      agentCtx: { get: () => undefined, on() {} } as never,
      agent: { id: 'session-mirror' } as never,
      runId,
      cwd,
    })
    const after = JSON.parse(await readFile(metaPath, 'utf8')) as RunMeta
    assert.equal(after.mirror.issueNumber, 42, 're-attaching must not forget the issue')
    assert.equal(after.mirror.issueUrl, 'http://lionm4/ai/app/-/work_items/42')
  })

  test('resumeSupervisorGoal resumes a blocked goal and recreates a completed one', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    const makeCtx = (view: Record<string, unknown> | undefined) => {
      const calls = { resume: 0, create: 0 }
      return {
        calls,
        ctx: {
          get(name: string) {
            if (name !== 'goals') return undefined
            return {
              get: () => view,
              resume: () => { calls.resume += 1 },
              create: () => { calls.create += 1 },
            }
          },
        },
      }
    }
    // A blocked goal is resumed, not recreated.
    const blocked = makeCtx({ id: 'goal-1', revision: 2, phase: 'blocked', activation: 'disarmed' })
    assert.equal(await resumeSupervisorGoal({ ctx: blocked.ctx as never, agent: { id: 's' } as never, cwd, runId }), true)
    assert.deepEqual(blocked.calls, { resume: 1, create: 0 })
    // A completed goal cannot be resumed; `create` replaces it.
    const complete = makeCtx({ id: 'goal-1', revision: 3, phase: 'complete', activation: 'disarmed' })
    await resumeSupervisorGoal({ ctx: complete.ctx as never, agent: { id: 's2' } as never, cwd, runId })
    assert.deepEqual(complete.calls, { resume: 0, create: 1 })
    // An armed active goal needs nothing.
    const armed = makeCtx({ id: 'goal-1', revision: 4, phase: 'active', activation: 'armed' })
    assert.equal(await resumeSupervisorGoal({ ctx: armed.ctx as never, agent: { id: 's3' } as never, cwd, runId }), true)
    assert.deepEqual(armed.calls, { resume: 0, create: 0 })
  })

  test('resumeSupervisorGoal refuses a ledger the milestone gate still blocks', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      status: 'blocked',
      goalBlocked: '里程碑审阅未通过（第 1 轮）：见 review/round-1.md',
      goalBlockKind: 'milestone',
    }, null, 2), 'utf8')

    const calls = { resume: 0, create: 0 }
    const ctx = {
      get: (name: string) => (name === 'goals'
        ? {
          get: () => ({ id: 'goal-1', revision: 2, phase: 'blocked', activation: 'disarmed' }),
          resume: () => { calls.resume += 1 },
          create: () => { calls.create += 1 },
        }
        : undefined),
    }
    assert.equal(await resumeSupervisorGoal({ ctx: ctx as never, agent: { id: 's' } as never, cwd, runId }), false)
    // Waking this goal drove turns that `auditTurn` refuses to supervise; a
    // fresh `create` would hide the deliberate gate the same way.
    assert.deepEqual(calls, { resume: 0, create: 0 }, 'a gate the ledger keeps closed is not reopened')
  })

  test('armSupervisorGoal refuses a run that is not active', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...state,
      status: 'completed',
      tasks: state.tasks.map(task => ({ ...task, status: 'DONE' })),
    }, null, 2), 'utf8')

    const calls = { create: 0 }
    const ctx = {
      get: (name: string) => (name === 'goals'
        ? { get: () => undefined, create: () => { calls.create += 1 } }
        : undefined),
    }
    const armed = await armSupervisorGoal({ ctx: ctx as never, agent: { id: 's' } as never, cwd, runId })
    assert.equal(armed, false)
    assert.equal(calls.create, 0, 'opening a finished run must not arm a goal nothing will complete')
  })

  test('a goalBlocked run does not arm a new goal on cold start', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const stored = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({
      ...stored,
      status: 'active',
      goalBlocked: 'scope 外改动',
      tasks: stored.tasks.map(task => ({ ...task, status: 'BLOCKED', blocked: { reason: 'x', next: 'y', remainingCandidates: [], at: 1 } })),
    }, null, 2), 'utf8')

    const calls = { create: 0 }
    const ctx = { get: (name: string) => (name === 'goals' ? { get: () => undefined, create: () => { calls.create += 1 } } : undefined) }
    const armed = await armSupervisorGoal({ ctx: ctx as never, agent: { id: 's' } as never, cwd, runId })
    assert.equal(armed, false, 'a stopped run stays stopped')
    assert.equal(calls.create, 0)
  })

  test('a successful mount clears a stale setup error', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    const metaPath = join(cwd, 'docs', 'guard', runId, 'run.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as RunMeta
    await writeFile(metaPath, JSON.stringify({
      ...meta,
      phase: 'setup-failed',
      setup: { ...meta.setup, goal: false, failedStep: 'goal', errorMessage: 'provider down' },
    }, null, 2), 'utf8')

    const ctx = { get: (name: string) => (name === 'goals' ? { get: () => undefined, create: () => {} } : undefined) }
    await armSupervisorGoal({ ctx: ctx as never, agent: { id: 's' } as never, cwd, runId })
    const after = JSON.parse(await readFile(metaPath, 'utf8')) as RunMeta
    assert.equal(after.phase, 'running')
    assert.equal(after.setup.failedStep, undefined, 'the old failure is not carried forward')
    assert.equal(after.setup.errorMessage, undefined)
  })
})

describe('goal-supervisor enforce path checks', () => {
  async function guarded(): Promise<{ cwd: string; runId: string; check: (exec: Record<string, unknown>) => string | undefined }> {
    const cwd = await workspace()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 落盘 | 文件存在 | src/**',
      enforcement: 'enforce',
      scopes: { T1: ['src/**'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    })).runId
    let guardFn: ((exec: Record<string, unknown>) => string | undefined) | undefined
    const agentCtx = {
      get(name: string) {
        if (name === 'tools') return { guard: (fn: typeof guardFn) => { guardFn = fn } }
        return undefined
      },
      on() {},
    }
    const attached = await attachSupervisor({
      ctx: { get: () => undefined } as never, agentCtx: agentCtx as never, agent: { id: 's' } as never, runId, cwd,
    })
    return { cwd, runId, check: (exec) => attached.checkTool(exec) }
  }

  test('a write to a brand-new nested file is not false-rejected by realpath', async () => {
    const { cwd, check } = await guarded()
    // Neither `src/`, nor `src/new/`, nor the file exist: the nearest existing
    // ancestor is the workspace root and the rest must be appended.
    assert.equal(check({ name: 'write', arguments: { file_path: 'src/new/deep/file.ts' } }), undefined)
    assert.equal(check({ name: 'write', arguments: { file_path: './src/a.ts' } }), undefined)
    assert.equal(check({ name: 'write', arguments: { file_path: join(cwd, 'src', 'a.ts') } }), undefined, 'an absolute in-workspace path is accepted')
    assert.match(check({ name: 'write', arguments: { file_path: 'docs/outside.md' } }) ?? '', /scope/)
  })

  test('update_goal cannot mark the run blocked or edited by itself', async () => {
    const { check } = await guarded()
    assert.match(check({ name: 'update_goal', arguments: { action: 'blocked' } }) ?? '', /只有督导循环/)
    assert.match(check({ name: 'update_goal', arguments: { action: 'edit' } }) ?? '', /用户确认/)
    // A model-initiated pause silently stops the host goal while the ledger stays
    // `active`: only the human may pause from the host UI.
    assert.match(check({ name: 'update_goal', arguments: { action: 'pause' } }) ?? '', /暂停/)
    assert.equal(check({ name: 'update_goal', arguments: { action: 'resume' } }), undefined)
  })

  test('a dangling symlink inside the scope is refused instead of followed', async () => {
    const { cwd, check } = await guarded()
    await mkdir(join(cwd, 'src'), { recursive: true })
    // `realpathSync` fails for a dangling link exactly as for a missing file; the
    // old fallback then rebuilt the literal name and let `write` create the
    // target OUTSIDE the workspace through O_CREAT.
    await symlink('../escaped-target.txt', join(cwd, 'src', 'escape.txt'))
    const denial = check({ name: 'write', arguments: { file_path: 'src/escape.txt' } })
    assert.ok(denial !== undefined, 'writing through a dangling symlink must be refused')
    assert.match(String(denial), /工作区/)
  })

})

// Round-10 P0-1: on macOS's case-insensitive APFS `docs/GUARD/<runId>/tasks.json`
// is the SAME file as `docs/guard/<runId>/tasks.json`, but `realpathSync` echoes
// the caller's spelling while the guard comparison is case-sensitive. A scope of
// `docs/**` then let the model overwrite the plugin's own ledger.
describe('goal-supervisor case-insensitive guard paths', () => {
  async function docsScoped(): Promise<{ cwd: string; runId: string; check: (exec: Record<string, unknown>) => string | undefined }> {
    const cwd = await workspace()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 落盘 | 文件存在 | docs/**',
      enforcement: 'enforce',
      scopes: { T1: ['docs/**'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true }],
    })).runId
    const attached = await attachSupervisor({
      ctx: { get: () => undefined } as never,
      agentCtx: { get: () => undefined, on() {} } as never,
      agent: { id: 's' } as never,
      runId,
      cwd,
    })
    return { cwd, runId, check: (exec) => attached.checkTool(exec) }
  }

  test('an uppercase guard directory cannot overwrite the ledger', async () => {
    const { runId, check } = await docsScoped()
    for (const filePath of [
      `docs/GUARD/${runId}/tasks.json`,
      `docs/Guard/${runId}/run.json`,
      `docs/GUARD/${runId}/state.jsonl`,
      `docs/guard/${runId.toUpperCase()}/tasks.json`,
    ]) {
      assert.ok(
        check({ name: 'write', arguments: { file_path: filePath } }) !== undefined,
        `${filePath} must be refused, not read as ordinary docs work`,
      )
    }
    // The three legal record files keep working through their real spelling.
    assert.equal(check({ name: 'write', arguments: { file_path: `docs/guard/${runId}/tasks/T1/notes.md` } }), undefined)
  })

  test('a not-yet-created file under the uppercase guard path is refused too', async () => {
    const { runId, check } = await docsScoped()
    // Nothing named `evil.json` exists yet: the guard comparison must be
    // case-insensitive on the path itself, not only on what realpath returns.
    assert.ok(check({ name: 'write', arguments: { file_path: `docs/GUARD/${runId}/tasks/T1/evil.json` } }) !== undefined)
  })
})

// Round-9 fixes: a cold start must re-arm a goal the host disarmed, a dangling
// symlink must not carry a write outside the workspace, and a workspace reached
// through a symlink must accept the canonical absolute path its tools report.
describe('goal-supervisor arming and path hardening', () => {
  test('armSupervisorGoal re-arms a goal that the cold start disarmed', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    let resumeCalls = 0
    let createCalls = 0
    let activation = 'disarmed'
    const ctx = {
      get(name: string) {
        if (name !== 'goals') return undefined
        return {
          get: () => ({ id: 'goal-1', revision: 2, phase: 'active', activation }),
          create: () => { createCalls += 1; activation = 'armed' },
          resume: () => { resumeCalls += 1; activation = 'armed' },
        }
      },
    }
    const armed = await armSupervisorGoal({ ctx: ctx as never, agent: { id: 's' } as never, cwd, runId })
    assert.equal(armed, true)
    assert.equal(resumeCalls, 1, 'a disarmed goal is resumed, not merely declared armed')
    assert.equal(createCalls, 0, 'an existing goal is never replaced')
    assert.equal(activation, 'armed')
    const meta = JSON.parse(await readFile(join(cwd, 'docs', 'guard', runId, 'run.json'), 'utf8')) as RunMeta
    assert.equal(meta.setup.goal, true)
    assert.equal(meta.phase, 'running')
  })

  test('a paused goal is not auto-resumed on cold start', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    let resumeCalls = 0
    const ctx = {
      get(name: string) {
        if (name !== 'goals') return undefined
        return {
          get: () => ({ id: 'goal-1', revision: 2, phase: 'paused', activation: 'paused' }),
          create: () => { throw new Error('must not create') },
          resume: () => { resumeCalls += 1 },
        }
      },
    }
    const armed = await armSupervisorGoal({ ctx: ctx as never, agent: { id: 's' } as never, cwd, runId })
    assert.equal(armed, true)
    assert.equal(resumeCalls, 0, 'a human pause is respected')
  })

  test('a resume that the goal service refuses is recorded, not reported as armed', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    const ctx = {
      get(name: string) {
        if (name !== 'goals') return undefined
        return {
          get: () => ({ id: 'goal-1', revision: 2, phase: 'active', activation: 'disarmed' }),
          create: () => { throw new Error('must not create') },
          resume: () => { throw new Error('round budget exhausted') },
        }
      },
    }
    const armed = await armSupervisorGoal({ ctx: ctx as never, agent: { id: 's' } as never, cwd, runId })
    assert.equal(armed, false)
    const meta = JSON.parse(await readFile(join(cwd, 'docs', 'guard', runId, 'run.json'), 'utf8')) as RunMeta
    assert.equal(meta.phase, 'setup-failed')
    assert.equal(meta.setup.failedStep, 'goal')
    assert.match(meta.setup.errorMessage ?? '', /round budget/)
  })

  test('a workspace reached through a symlink accepts the canonical absolute path', async () => {
    const real = await workspace()
    const holder = await workspace()
    const alias = join(holder, 'ws-link')
    await symlink(real, alias)
    const runId = (await prepareGuardRun(alias, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 落盘 | 文件存在 | src/**',
      enforcement: 'enforce',
      scopes: { T1: ['src/**'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    })).runId
    const attached = await attachSupervisor({
      ctx: { get: () => undefined } as never,
      agentCtx: { get: () => undefined, on() {} } as never,
      agent: { id: 's' } as never,
      runId,
      cwd: alias,
    })
    const canonical = realpathSync(alias)
    assert.notEqual(canonical, alias, 'the fixture really is reached through a symlink')
    assert.equal(
      attached.checkTool({ name: 'write', arguments: { file_path: join(canonical, 'src', 'a.ts') } }),
      undefined,
      'the canonical absolute path of the same workspace is inside it',
    )
  })
})

// Round-9 P2-4: a `gh`/`glab` that never answers must degrade the mirror to
// local-only within the mount budget, never hold the serial `agent/created`
// dispatch (and every later session) hostage.
describe('goal-supervisor mirror probe budget', () => {
  test('a hung remote probe degrades to mirror off within its budget', async () => {
    const cwd = await workspace()
    await git('git', ['init', '-q'], { cwd })
    await git('git', ['remote', 'add', 'origin', 'https://github.com/acme/repo.git'], { cwd })
    const bin = join(cwd, 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'gh'), '#!/bin/sh\nsleep 1\n')
    await chmod(join(bin, 'gh'), 0o755)
    const previous = process.env.PATH
    process.env.PATH = `${bin}:${previous ?? ''}`
    try {
      const runId = await prepared(cwd)
      const started = Date.now()
      await attachSupervisor({
        ctx: { get: () => undefined } as never,
        agentCtx: { get: () => undefined, on() {} } as never,
        agent: { id: 's' } as never,
        runId,
        cwd,
        mirrorProbeMs: 50,
      })
      const elapsed = Date.now() - started
      const meta = JSON.parse(await readFile(join(cwd, 'docs', 'guard', runId, 'run.json'), 'utf8')) as RunMeta
      assert.equal(meta.mirror.mode, 'off')
      assert.match(meta.mirror.reason ?? '', /timed out/)
      assert.ok(elapsed < 2000, `the mount degraded instead of waiting for the CLI (${elapsed}ms)`)
    } finally {
      process.env.PATH = previous
    }
  })

  test('a successful re-probe clears the stale timeout reason', async () => {
    const cwd = await workspace()
    await git('git', ['init', '-q'], { cwd })
    await git('git', ['remote', 'add', 'origin', 'https://github.com/acme/repo.git'], { cwd })
    const bin = join(cwd, 'bin')
    await mkdir(bin, { recursive: true })
    // `auth status` succeeds on the retry (the probe only shells out to `gh`).
    await writeFile(join(bin, 'gh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(bin, 'gh'), 0o755)
    const previous = process.env.PATH
    process.env.PATH = `${bin}:${previous ?? ''}`
    try {
      const runId = await prepared(cwd)
      const metaPath = join(cwd, 'docs', 'guard', runId, 'run.json')
      const before = JSON.parse(await readFile(metaPath, 'utf8')) as RunMeta
      // The previous cold start timed out and degraded to local-only.
      await writeFile(metaPath, JSON.stringify({
        ...before,
        mirror: { mode: 'off', reason: 'remote probe timed out' },
      }, null, 2), 'utf8')

      await attachSupervisor({
        ctx: { get: () => undefined } as never,
        agentCtx: { get: () => undefined, on() {} } as never,
        agent: { id: 's' } as never,
        runId,
        cwd,
      })
      const after = JSON.parse(await readFile(metaPath, 'utf8')) as RunMeta
      assert.equal(after.mirror.mode, 'auto', 'the retry restored the remote mirror')
      assert.equal(after.mirror.reason, undefined, 'the stale timeout text is not kept forever')
    } finally {
      process.env.PATH = previous
    }
  })
})

describe('goal-supervisor single-turn boundary and pre-step audit', () => {
  test('blocks dispatching a new subagent once the current task wrote a completion claim, and pre-step audits it automatically', async () => {
    const cwd = await workspace()
    const runId = (await prepareGuardRun(cwd, {
      goal: '把目标漂移修好',
      acceptance: '所有任务 DONE',
      discipline: '主会话只规划/分派/审查',
      tasks: 'T1 | 第一步 | 文件存在 | a.ts\nT2 | 第二步 | 文件存在 | b.ts',
      probes: [
        { id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'a.ts' }, enabled: true },
        { id: 'P2', taskId: 'T2', weight: 'light', spec: { kind: 'file_exists', path: 'b.ts' }, enabled: true },
      ],
    })).runId
    await writeFile(join(cwd, 'a.ts'), 'done\n')

    const hooks = new Map<string, ((...args: unknown[]) => unknown)[]>()
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async () => ({
            config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 4000 },
            stream: () => (async function* () {
              const current = JSON.parse(await readFile(join(cwd, 'docs/guard', runId, 'tasks.json'), 'utf8')) as GuardState
              const payload = JSON.stringify({
                goal_hash: current.goalHash, verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue',
              })
              yield { type: 'text-delta', index: 0, text: payload }
              yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
            })(),
          }),
        }
      },
    }
    const attached = await attachSupervisor({
      ctx: ctx as never,
      agentCtx: {
        get: () => undefined,
        on(event: string, fn: (...args: unknown[]) => unknown) {
          const list = hooks.get(event) ?? []
          list.push(fn)
          hooks.set(event, list)
        },
      } as never,
      agent: { id: 's', options: { provider: 'p', model: 'm' } } as never,
      runId,
      cwd,
    })

    // Before T1 declares completion, subagent is allowed and pre-step is a no-op.
    assert.equal(attached.checkTool({ name: 'subagent', arguments: { name: 'm0' } }), undefined)
    const preSteps = hooks.get('agent/pre-step') ?? []
    assert.equal(preSteps.length, 1, 'attaches a pre-step listener')
    let nextCalls = 0
    const nextResult = await preSteps[0]!({}, async () => { nextCalls += 1; return { kind: 'enter', messages: [] } })
    assert.equal(nextCalls, 1)
    assert.deepEqual(nextResult, { kind: 'enter', messages: [] })
    assert.equal(attached.state.tasks[0]?.status, 'TODO', 'pre-step must not audit before a completion claim exists')

    // Once T1 appends "## 完成声明", dispatching another subagent in the same turn is refused.
    const notesPath = join(cwd, 'docs', 'guard', runId, 'tasks', 'T1', 'notes.md')
    await writeFile(notesPath, `${await readFile(notesPath, 'utf8')}\n## 完成声明\nT1 完成\n`)
    const denied = attached.checkTool({ name: 'subagent', arguments: { name: 'm1' } })
    assert.match(denied ?? '', /完成声明/)
    assert.equal(attached.checkTool({ name: 'read', arguments: { file_path: 'a.ts' } }), undefined, 'non-subagent tools remain allowed')

    // When the next step enters agent/pre-step, the supervisor audits T1 immediately and advances to T2.
    await preSteps[0]!({}, async () => { nextCalls += 1; return { kind: 'enter', messages: [] } })
    assert.equal(nextCalls, 2)
    assert.equal(attached.state.tasks[0]?.status, 'DONE')
    // Now current task is T2 (which has no completion claim yet), so dispatching T2's subagent succeeds.
    assert.equal(attached.checkTool({ name: 'subagent', arguments: { name: 'm1' } }), undefined)
  })

  test('re-attaching a completed run preserves run.json phase as completed', async () => {
    const cwd = await workspace()
    const runId = (await prepareGuardRun(cwd, {
      goal: '目标', acceptance: '验收', discipline: '纪律', tasks: 'T1 | 一 | 通过 | a.ts',
    })).runId
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    const metaPath = join(cwd, 'docs', 'guard', runId, 'run.json')
    const state = JSON.parse(await readFile(tasksPath, 'utf8')) as Record<string, unknown>
    await writeFile(tasksPath, JSON.stringify({ ...state, status: 'completed', activeTaskIds: [] }, null, 2), 'utf8')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    await writeFile(metaPath, JSON.stringify({ ...meta, phase: 'completed', sessionId: 's-done' }, null, 2), 'utf8')

    await attachSupervisor({
      ctx: { get: () => undefined },
      agentCtx: { get: () => ({ context: () => undefined }), on: () => undefined } as never,
      agent: { id: 's-done' },
      runId,
      cwd,
    })
    const after = JSON.parse(await readFile(metaPath, 'utf8')) as { phase: string }
    assert.equal(after.phase, 'completed', 'cold-start re-attach must not regress a completed run to running')
  })

  test('enforce mode stands down once the run completes, stays active while blocked, and re-engages if reopened', async () => {
    const cwd = await workspace()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 落盘 | 文件存在',
      enforcement: 'enforce',
      scopes: { T1: ['src/**'] },
      probes: [{ id: 'P1', taskId: 'T1', weight: 'light', spec: { kind: 'file_exists', path: 'src/a.ts' }, enabled: true }],
    })).runId
    const tasksPath = join(cwd, 'docs', 'guard', runId, 'tasks.json')
    let guardFn: ((exec: Record<string, unknown>) => string | undefined) | undefined
    const attached = await attachSupervisor({
      ctx: { get: () => undefined } as never,
      agentCtx: {
        get(name: string) {
          return name === 'tools' ? { guard: (fn: typeof guardFn) => { guardFn = fn } } : undefined
        },
        on() {},
      } as never,
      agent: { id: 's' } as never,
      runId,
      cwd,
    })

    // While active, out-of-scope edits, shell commands, and new goals are denied.
    assert.match(guardFn?.({ name: 'edit', arguments: { file_path: 'tmp/README.md' } }) ?? '', /scope/)
    assert.match(guardFn?.({ name: 'bash', arguments: { command: 'ls' } }) ?? '', /子会话/)
    assert.match(guardFn?.({ name: 'create_goal', arguments: { objective: 'next' } }) ?? '', /不要另建 goal/)

    // While blocked, enforce must NOT stand down.
    const raw = JSON.parse(await readFile(tasksPath, 'utf8')) as GuardState
    await writeFile(tasksPath, JSON.stringify({ ...raw, status: 'blocked', activeTaskIds: [] }, null, 2), 'utf8')
    await attached.refresh()
    assert.match(guardFn?.({ name: 'edit', arguments: { file_path: 'tmp/README.md' } }) ?? '', /scope/)
    assert.match(guardFn?.({ name: 'bash', arguments: { command: 'ls' } }) ?? '', /子会话/)
    assert.match(guardFn?.({ name: 'update_goal', arguments: { action: 'complete' } }) ?? '', /不能标记目标完成/)

    // Once completed, the supervised run is done and the session is usable again.
    await writeFile(tasksPath, JSON.stringify({
      ...raw,
      status: 'completed',
      activeTaskIds: [],
      tasks: raw.tasks.map(task => ({ ...task, status: 'DONE' })),
    }, null, 2), 'utf8')
    await attached.refresh()
    assert.equal(guardFn?.({ name: 'edit', arguments: { file_path: 'tmp/README.md' } }), undefined)
    assert.equal(guardFn?.({ name: 'write', arguments: { file_path: 'docs/x.md' } }), undefined)
    assert.equal(guardFn?.({ name: 'bash', arguments: { command: 'ls' } }), undefined)
    assert.equal(guardFn?.({ name: 'create_goal', arguments: { objective: 'follow-up' } }), undefined)

    // If a human rolls back / reopens the run, refresh() must re-engage the guard.
    await writeFile(tasksPath, JSON.stringify({ ...raw, status: 'active', activeTaskIds: ['T1'] }, null, 2), 'utf8')
    await attached.refresh()
    assert.match(guardFn?.({ name: 'edit', arguments: { file_path: 'tmp/README.md' } }) ?? '', /scope/)
    assert.match(guardFn?.({ name: 'bash', arguments: { command: 'ls' } }) ?? '', /子会话/)
  })
})

// A long run must not die on the host's default 256-round cap, and the denial
// that stops `update_goal(complete)` must name the one file that unblocks it.
describe('goal-supervisor long-run goal budget', () => {
  test('armSupervisorGoal arms the host goal with a multi-thousand round budget', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    let created: { objective: string; maxGoalRounds?: number } | undefined
    const ctx = {
      get: (name: string) => (name === 'goals'
        ? {
          get: () => undefined,
          create: (_agent: unknown, request: { objective: string; maxGoalRounds?: number }) => { created = request },
        }
        : undefined),
    }
    assert.equal(await armSupervisorGoal({ ctx: ctx as never, agent: { id: 's' } as never, cwd, runId }), true)
    assert.ok((created?.maxGoalRounds ?? 0) >= 2000, `armed with a long-run budget, got ${String(created?.maxGoalRounds)}`)
  })

  test('resumeSupervisorGoal raises an exhausted round cap before resuming', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    const calls: { edit?: number; resumeRevision?: number } = {}
    const ctx = {
      get: (name: string) => (name === 'goals'
        ? {
          get: () => ({
            id: 'goal-1', revision: 3, phase: 'blocked', activation: 'disarmed',
            roundsStarted: 256, maxGoalRounds: 256, blockedReason: { code: 'round-limit', message: 'exhausted' },
          }),
          edit: (_agent: unknown, _ref: unknown, request: { maxGoalRounds?: number }) => {
            calls.edit = request.maxGoalRounds
            return { id: 'goal-1', revision: 4, phase: 'blocked', activation: 'disarmed', roundsStarted: 256, maxGoalRounds: request.maxGoalRounds }
          },
          resume: (_agent: unknown, ref: { revision: number }) => { calls.resumeRevision = ref.revision },
        }
        : undefined),
    }
    assert.equal(await resumeSupervisorGoal({ ctx: ctx as never, agent: { id: 's' } as never, cwd, runId }), true)
    assert.equal(calls.edit, 2000, 'an exhausted 256 cap rolls up to the long-run base')
    assert.equal(calls.resumeRevision, 4, 'resume must use the revision edit returned')
  })

  test('the complete denial names the notes file that unblocks the task', async () => {
    const cwd = await workspace()
    const runId = await prepared(cwd)
    let guardFn: ((exec: Record<string, unknown>) => string | undefined) | undefined
    const agentCtx = {
      get(name: string) {
        if (name === 'tools') return { guard: (fn: typeof guardFn) => { guardFn = fn } }
        return undefined
      },
      on() {},
    }
    await attachSupervisor({ ctx: { get: () => undefined } as never, agentCtx: agentCtx as never, agent: { id: 's' } as never, runId, cwd })
    const denial = guardFn?.({ name: 'update_goal', arguments: { action: 'complete' } }) ?? ''
    assert.match(denial, /不能标记目标完成/)
    assert.ok(denial.includes(`docs/guard/${runId}/tasks/T1/notes.md`), denial)
    assert.match(denial, /完成声明/)
  })
})
