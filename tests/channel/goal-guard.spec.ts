import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import {
  attachGoalGuard,
  createGuardState,
  guardHashOf,
  guardStateOf,
  loadGuardState,
  readPlanPreview,
  parseGuardTasks,
  saveGuardState,
} from '../../src/host/goal-guard'

const tempDirs: string[] = []
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'redline-guard-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function fakeCtx(home: string) {
  return {
    get(name: string) {
      if (name === 'dshHomePath') return () => home
      return undefined
    },
  }
}

describe('goal guard core (0.9.0)', () => {
  test('parses one task per line and rejects malformed or duplicate ids', () => {
    const tasks = parseGuardTasks('T1 | M0 skeleton | offline build; typecheck\nT2 | M1 scene | 60fps')
    assert.ok(tasks !== null)
    assert.equal(tasks.length, 2)
    assert.equal(tasks[0]?.id, 'T1')
    assert.deepEqual(tasks[0]?.acceptance, ['offline build', 'typecheck'])
    assert.equal(parseGuardTasks('T1 no pipe'), null)
    assert.equal(parseGuardTasks('T1 | a | x\nT1 | b | y'), null)
    assert.equal(parseGuardTasks(''), null)
  })

  test('reads a plan preview and folds its hash into the goal hash', async () => {
    const home = await tempHome()
    const planPath = join(home, 'plan.md')
    await (await import('node:fs/promises')).writeFile(planPath, '# Plan\n\n## M0\n- one\n## M1\n- two\n', 'utf8')
    const preview = await readPlanPreview(home, 'plan.md')
    assert.ok(preview !== null)
    assert.equal(preview.lines, 7)
    assert.deepEqual(preview.headings, ['# Plan', '## M0', '## M1'])
    const base = { goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | one | e1', planPath, planHash: preview.hash }
    assert.notEqual(guardHashOf(base), guardHashOf({ ...base, planHash: 'other' }))
  })

  test('the goal hash is canonical and changes when the frozen card changes', () => {
    const seed = { goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | one | e1' }
    assert.equal(guardHashOf(seed), guardHashOf({ ...seed }))
    assert.notEqual(guardHashOf(seed), guardHashOf({ ...seed, goal: 'changed' }))
    assert.notEqual(guardHashOf(seed), guardHashOf({ ...seed, tasks: 'T2 | two | e2' }))
  })

  test('0.9.0 defaults to OBSERVE: an omitted dryRun never blocks by accident', async () => {
    const home = await tempHome()
    const ctx = fakeCtx(home) as never
    const state = await createGuardState(ctx, 'session-guard-observe', {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | one | e1',
    })
    assert.equal(state?.dryRun, true, 'the shipped default is observe-only')
    const explicit = guardStateOf('session-guard-strict', {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | one | e1', dryRun: false,
    }, parseGuardTasks('T1 | one | e1') ?? [])
    assert.equal(explicit.dryRun, false, 'the blocking door stays explicit for a later version')
  })

  test('persists and reloads the frozen task ledger', async () => {
    const home = await tempHome()
    const ctx = fakeCtx(home) as never
    const state = await createGuardState(ctx, 'session-guard-1', {
      goal: 'finish the plan', acceptance: 'all milestones', discipline: 'no direct writes',
      tasks: 'T1 | first | evidence one\nT2 | second | evidence two',
    })
    assert.ok(state !== null)
    assert.equal(state.tasks.length, 2)
    const loaded = await loadGuardState(ctx, 'session-guard-1')
    assert.equal(loaded?.goal, state.goal)
    loaded!.current = 1
    await saveGuardState(ctx, loaded!)
    assert.equal((await loadGuardState(ctx, 'session-guard-1'))?.current, 1)
    assert.equal(await loadGuardState(ctx, 'missing-session'), null)
  })


  test('dry-run records but never blocks tools or steers', async () => {
    const home = await tempHome()
    const ctx = fakeCtx(home) as never
    await createGuardState(ctx, 'session-guard-dry', {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | one | e1', dryRun: true,
    })
    let guardFn: ((exec: Record<string, unknown>) => string | undefined) | undefined
    let stopping: (() => void | Promise<void>) | undefined
    const steers: string[] = []
    const agent = { id: 'session-guard-dry', steer: (message: { content: { text: string }[] }) => { steers.push(message.content[0]!.text) } }
    const agentCtx = {
      get(name: string) {
        if (name === 'systemPrompt') return { context: () => {} }
        if (name === 'tools') return { guard: (fn: (exec: Record<string, unknown>) => string | undefined) => { guardFn = fn } }
        return undefined
      },
      on(name: string, fn: () => void | Promise<void>) { if (name === 'agent/turn-stopping') stopping = fn },
    }
    await attachGoalGuard(ctx, agentCtx as never, agent as never, 'session-guard-dry')
    assert.equal(guardFn?.({ agent, name: 'write' }), undefined)
    assert.equal(guardFn?.({ agent, name: 'update_goal', arguments: { action: 'complete' } }), undefined)
    await stopping?.()
    assert.deepEqual(steers, [])
  })
  test('the evaluator is ONE independent call and its verdict lands in the ledger', async () => {
    const home = await tempHome()
    const events = [
      { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'I finished task one' }] } } },
      { seq: 2, type: 'tool/call', data: { name: 'subagent' } },
    ]
    let seenConfig: Record<string, unknown> | undefined
    let seenOptions: Record<string, unknown> | undefined
    const ctx = {
      get(name: string) {
        if (name === 'dshHomePath') return () => home
        if (name === 'sessionQuery') return { readSession: async () => ({ events }) }
        if (name === 'llm') {
          return {
            prepareCall: async (config: Record<string, unknown>) => {
              seenConfig = config
              return {
                config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 2500 },
                stream: (options: Record<string, unknown>) => {
                  seenOptions = options
                  return (async function* () {
                    const payload = JSON.stringify({
                      goal_hash: (await loadGuardState(ctx as never, 'session-guard-eval'))?.goalHash,
                      verdict: 'pass',
                      criteria: [{ id: 'e1', status: 'met', why: 'shipped' }],
                      violations: [],
                      missing: [],
                      correction: '',
                      next_action: 'continue',
                    })
                    yield { type: 'text-delta', index: 0, text: payload }
                    yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
                  })()
                },
              }
            },
          }
        }
        return undefined
      },
    }
    await createGuardState(ctx as never, 'session-guard-eval', {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | one | e1',
    })
    const before = await loadGuardState(ctx as never, 'session-guard-eval')
    const seeds: string[] = []
    const agent = { id: 'session-guard-eval', model: { current: () => ({ provider: 'p', model: 'm' }) }, steer: () => { seeds.push('steer') } }
    let stopping: (() => void | Promise<void>) | undefined
    const agentCtx = {
      get(name: string) {
        if (name === 'systemPrompt') return { context: () => {} }
        return undefined
      },
      on(name: string, fn: () => void | Promise<void>) { if (name === 'agent/turn-stopping') stopping = fn },
    }
    await attachGoalGuard(ctx as never, agentCtx as never, agent as never, 'session-guard-eval')
    await stopping?.()

    assert.deepEqual(seenConfig, { provider: 'p', model: 'm', maxTokens: 2500, temperature: 0 }, 'one prepared call with fixed controls')
    assert.match(String(seenOptions?.system), /独立目标审计员/, 'the evaluator is told to audit, not to obey')
    const message = (seenOptions?.messages as { content: { text: string }[] }[])[0]
    assert.match(String(message?.content[0]?.text), new RegExp(String(before?.goalHash)), 'the frozen goal hash rides the prompt')
    const after = await loadGuardState(ctx as never, 'session-guard-eval')
    assert.equal(after?.verdict, 'pass')
    assert.equal(after?.lastEval?.model, 'p/m')
    assert.deepEqual(seeds, [], 'observe-only: no steering')
  })

  test('observe mode evaluates even when the main session wrote its own records', async () => {
    const home = await tempHome()
    const events = [
      { seq: 1, type: 'tool/call', data: { name: 'write', arguments: '{"file_path":"/w/reports/review/T1.md"}' } },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'wrote the review record' }] } } },
      { seq: 3, type: 'tool/call', data: { name: 'subagent' } },
    ]
    let seenOptions: Record<string, unknown> | undefined
    const ctx = {
      get(name: string) {
        if (name === 'dshHomePath') return () => home
        if (name === 'sessionQuery') return { readSession: async () => ({ events }) }
        if (name === 'llm') {
          return {
            prepareCall: async () => ({
              config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 2500 },
              stream: (options: Record<string, unknown>) => {
                seenOptions = options
                return (async function* () {
                  const state = await loadGuardState(ctx as never, 'session-guard-observe-writes')
                  const payload = JSON.stringify({
                    goal_hash: state?.goalHash, verdict: 'pass',
                    criteria: [{ id: 'e1', status: 'met', why: 'review record written' }],
                    violations: [], missing: [], correction: '', next_action: 'continue',
                  })
                  yield { type: 'text-delta', index: 0, text: payload }
                  yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
                })()
              },
            }),
          }
        }
        return undefined
      },
    }
    await createGuardState(ctx as never, 'session-guard-observe-writes', {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | one | e1\nT2 | two | e2',
    })
    let stopping: (() => void | Promise<void>) | undefined
    const agent = { id: 'session-guard-observe-writes', model: { current: () => ({ provider: 'p', model: 'm' }) }, steer: () => {} }
    const agentCtx = {
      get(name: string) { if (name === 'systemPrompt') return { context: () => {} }; return undefined },
      on(name: string, fn: () => void | Promise<void>) { if (name === 'agent/turn-stopping') stopping = fn },
    }
    await attachGoalGuard(ctx as never, agentCtx as never, agent as never, 'session-guard-observe-writes')
    await stopping?.()

    const after = await loadGuardState(ctx as never, 'session-guard-observe-writes')
    assert.equal(after?.verdict, 'pass', 'the evaluator judged the writes acceptable')
    assert.equal(after?.current, 1, 'a pass advances the ledger instead of pinning it')
    assert.equal(after?.tasks[0]?.status, 'passed')
    assert.equal(after?.lastEval?.model, 'p/m')
    assert.equal(after?.lastAudit?.ran, true)
    const prompt = String((seenOptions?.messages as { content: { text: string }[] }[])[0]?.content[0]?.text)
    assert.match(prompt, /reports\/review\/T1\.md/, 'the evaluator receives the write PATHS, not just a count')
  })

  test('the short anchor is injected at the head and the tail of every prompt', async () => {
    const home = await tempHome()
    const ctx = fakeCtx(home) as never
    await createGuardState(ctx, 'session-guard-anchor', {
      goal: 'ship the thing', acceptance: 'it works', discipline: 'stay in scope', tasks: 'T1 | one | e1',
    })
    const registrations: { name: string, order: number, text: string }[] = []
    const agentCtx = {
      get(name: string) {
        if (name === 'systemPrompt') {
          return {
            context(input: { name: string, order: number, text: () => string }) {
              registrations.push({ name: input.name, order: input.order, text: input.text() })
            },
          }
        }
        return undefined
      },
      on() {},
    }
    await attachGoalGuard(ctx, agentCtx as never, { id: 'session-guard-anchor' } as never, 'session-guard-anchor')
    const names = registrations.map(item => item.name)
    assert.deepEqual(names, ['redline:goal-guard', 'redline:goal-guard-head', 'redline:goal-guard-tail'])
    const head = registrations[1]
    const tail = registrations[2]
    assert.equal(head.order, 90)
    assert.equal(tail.order, 900)
    for (const anchor of [head, tail]) {
      assert.match(anchor.text, /目标守卫 · 锚点/)
      assert.match(anchor.text, /当前任务：T1 \| one/)
      assert.match(anchor.text, /硬规则：/)
      assert.match(anchor.text, /停止条件：/)
      assert.ok(anchor.text.length < 1200, 'the anchor stays short on purpose')
    }
  })

  test('attaches only to the guarded agent and denies direct writes and premature completion', async () => {
    const home = await tempHome()
    const ctx = fakeCtx(home) as never
    // The blocking door is explicit (0.9.0 ships observe-only), so this test
    // must ask for it rather than inherit a default.
    await createGuardState(ctx, 'session-guard-2', {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | one | e1', dryRun: false,
    })
    let contextText = ''
    let guardFn: ((exec: Record<string, unknown>) => string | undefined) | undefined
    let stopping: (() => void | Promise<void>) | undefined
    const steers: string[] = []
    const agentCtx = {
      get(name: string) {
        if (name === 'systemPrompt') return { context: (input: { text: () => string }) => { contextText = input.text() } }
        if (name === 'tools') return { guard: (fn: (exec: Record<string, unknown>) => string | undefined) => { guardFn = fn } }
        return undefined
      },
      on(name: string, fn: () => void | Promise<void>) {
        if (name === 'agent/turn-stopping') stopping = fn
      },
    }
    const agent = { id: 'session-guard-2', steer: (message: { content: { text: string }[] }) => { steers.push(message.content[0]!.text) } }
    await attachGoalGuard(ctx, agentCtx as never, agent as never, 'session-guard-2')

    assert.match(contextText, /T1 \| one/)
    assert.match(String(guardFn?.({ agent, name: 'write' })), /主会话不直接开发/)
    assert.equal(guardFn?.({ agent: { id: 'other' }, name: 'write' }), undefined)
    assert.match(String(guardFn?.({ agent, name: 'update_goal', arguments: { action: 'complete' } })), /不能标记目标完成/)
    assert.equal(guardFn?.({ agent: { id: 'other' }, name: 'update_goal', arguments: { action: 'complete' } }), undefined)

    await stopping?.()
    assert.equal(steers.length, 1)
    assert.match(steers[0]!, /没有可审计产出/)
  })
})
