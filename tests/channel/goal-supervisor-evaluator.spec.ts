import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { evaluateTask, type EvalCandidate } from '../../src/host/goal-supervisor/evaluator'
import { GUARD_SCHEMA_VERSION, type GuardState, type GuardTask } from '../../src/host/goal-supervisor/schema'

function task(overrides: Partial<GuardTask> = {}): GuardTask {
  return {
    id: 'T1', title: '落盘', status: 'IN_PROGRESS', scope: ['src/**'], dependsOn: [],
    acceptance: ['文件存在'], probes: ['P1'], requiredProbes: ['P1'],
    probeResults: { P1: { result: 'pass', at: 1 } }, evidence: [], attempts: [],
    scopeApprovedCount: 0, baselineDirty: {}, ...overrides,
  }
}

function state(overrides: Partial<GuardState> = {}): GuardState {
  return {
    version: GUARD_SCHEMA_VERSION, runId: '20261124-demo', goal: '目标', acceptance: '验收',
    discipline: '纪律', goalHash: 'hash-1', tasks: [task()], activeTaskIds: ['T1'], parallel: 1,
    enforcement: 'warn-only', worktree: { enabled: false }, milestoneEvery: 3, status: 'active',
    createdAt: 1, updatedAt: 1, ...overrides,
  }
}

const candidate: EvalCandidate = { summary: 'done', tools: ['subagent'], writePaths: ['src/a.ts'], subagents: 1 }

function ctxWith(payload: string) {
  return {
    get(name: string) {
      if (name !== 'llm') return undefined
      return {
        prepareCall: async () => ({
          config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 2500 },
          stream: () => (async function* () {
            yield { type: 'text-delta', index: 0, text: payload }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
          })(),
        }),
      }
    },
  }
}

const agent = { model: { current: () => ({ provider: 'p', model: 'm' }) } }

describe('goal-supervisor evaluator', () => {
  test('parses a pass verdict and records the model and usage', async () => {
    const payload = JSON.stringify({
      goal_hash: 'hash-1', verdict: 'pass',
      criteria: [{ id: 'e1', status: 'met', why: 'probe P1 passed' }],
      violations: [], missing: [], correction: '', next_action: 'continue',
    })
    const result = await evaluateTask(ctxWith(payload) as never, agent, state(), task(), candidate)
    assert.equal(result.verdict, 'pass')
    assert.equal(result.model, 'p/m')
    assert.equal(result.criteria[0]?.status, 'met')
  })

  test('unparseable output is insufficient, never pass', async () => {
    const result = await evaluateTask(ctxWith('not json') as never, agent, state(), task(), candidate)
    assert.equal(result.verdict, 'insufficient')
  })

  test('a goal hash mismatch stops the call', async () => {
    const payload = JSON.stringify({ goal_hash: 'other', verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue' })
    const result = await evaluateTask(ctxWith(payload) as never, agent, state(), task(), candidate)
    assert.equal(result.verdict, 'insufficient')
    assert.match(result.correction, /目标/)
  })

  test('a missing model is insufficient', async () => {
    const result = await evaluateTask({ get: () => undefined } as never, agent, state(), task(), candidate)
    assert.equal(result.verdict, 'insufficient')
    assert.equal(result.unavailable, true)
    assert.match(result.reason ?? '', /prepareCall/)
  })

  test('selects the lowest supported reasoning effort via prepareCall configure', async () => {
    const seen: { reasoningEffort?: string }[] = []
    const payload = JSON.stringify({
      goal_hash: 'hash-1', verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue',
    })
    const llmCtx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async (
            config: Record<string, unknown>,
            _signal?: AbortSignal,
            configure?: (controls: Record<string, unknown>, model: Record<string, unknown>) => Record<string, unknown>,
          ) => {
            const controls = configure?.(
              { maxTokens: config.maxTokens, temperature: config.temperature },
              { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
            ) ?? config
            seen.push({ reasoningEffort: controls.reasoningEffort as string | undefined })
            return {
              config: { provider: 'p', model: 'm', ...controls },
              stream: () => (async function* () {
                yield { type: 'text-delta', index: 0, text: payload }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
              })(),
            }
          },
        }
      },
    }
    const result = await evaluateTask(llmCtx as never, agent, state(), task(), candidate)
    assert.equal(result.verdict, 'pass')
    assert.equal(seen[0]?.reasoningEffort, 'low')
  })

  test('unparseable output keeps model, latencyMs, and unavailable flag', async () => {
    const result = await evaluateTask(ctxWith('not json') as never, agent, state(), task(), candidate)
    assert.equal(result.verdict, 'insufficient')
    assert.equal(result.unavailable, true)
    assert.equal(result.model, 'p/m')
    assert.ok(result.latencyMs >= 0)
    assert.match(result.reason ?? '', /不可解析/)
  })

  test('transport failure preserves thrown error message and model', async () => {
    const failingCtx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async () => { throw new Error('upstream 503 service overloaded') },
        }
      },
    }
    const result = await evaluateTask(failingCtx as never, agent, state(), task(), candidate)
    assert.equal(result.verdict, 'insufficient')
    assert.equal(result.unavailable, true)
    assert.equal(result.model, 'p/m')
    assert.match(result.reason ?? '', /upstream 503 service overloaded/)
  })

  test('terminal finish error chunk reports the real error instead of unparseable output', async () => {
    const finishErrCtx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async () => ({
            config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 4000 },
            stream: () => (async function* () {
              yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMITED', message: 'rate limit exceeded' } } }
            })(),
          }),
        }
      },
    }
    const result = await evaluateTask(finishErrCtx as never, agent, state(), task(), candidate)
    assert.equal(result.verdict, 'insufficient')
    assert.equal(result.unavailable, true)
    assert.equal(result.model, 'p/m')
    assert.match(result.reason ?? '', /rate limit exceeded/)
  })

  test('distinguishes missing provider vs missing model', async () => {
    const noProvider = await evaluateTask(ctxWith('{}') as never, { model: { current: () => ({ model: 'm' }) } }, state(), task(), candidate)
    assert.equal(noProvider.unavailable, true)
    assert.match(noProvider.reason ?? '', /provider/)
    const noModel = await evaluateTask(ctxWith('{}') as never, { model: { current: () => ({ provider: 'p' }) } }, state(), task(), candidate)
    assert.equal(noModel.unavailable, true)
    assert.match(noModel.reason ?? '', /model/)
  })

  test('goal hash mismatch is an integrity anomaly, not an unavailable outage', async () => {
    const payload = JSON.stringify({ goal_hash: 'wrong-hash', verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue' })
    const result = await evaluateTask(ctxWith(payload) as never, agent, state(), task(), candidate)
    assert.equal(result.verdict, 'insufficient')
    assert.equal(result.unavailable, false)
    assert.equal(result.goalHashMismatch, true)
    assert.equal(result.model, 'p/m')
    assert.match(result.reason ?? '', /目标 hash 不匹配/)
  })

  test('derives observable fail reason from violations or unmet criteria when missing is empty', async () => {
    const payload = JSON.stringify({
      goal_hash: 'hash-1', verdict: 'fail',
      criteria: [{ id: 'c1', status: 'unmet', why: 'missing multiply export' }],
      violations: [{ type: 'discipline', why: 'main session ran bash' }],
      missing: [], correction: '', next_action: 'fix',
    })
    const result = await evaluateTask(ctxWith(payload) as never, agent, state(), task(), candidate)
    assert.equal(result.verdict, 'fail')
    assert.equal(result.unavailable, false)
    assert.match(result.reason ?? '', /main session ran bash/)
  })

  test('includes deterministic probes, diff excerpt, and notes in the evaluator prompt', async () => {
    let capturedPrompt = ''
    const payload = JSON.stringify({
      goal_hash: 'hash-1', verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue',
    })
    const captureCtx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async () => ({
            config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 4000 },
            stream: (options: { messages?: readonly { content?: readonly { text?: string }[] }[] }) => {
              capturedPrompt = options.messages?.[0]?.content?.[0]?.text ?? ''
              return (async function* () {
                yield { type: 'text-delta', index: 0, text: payload }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
              })()
            },
          }),
        }
      },
    }
    const richCandidate: EvalCandidate = {
      ...candidate,
      probes: [{ id: 'C1', weight: 'heavy', spec: 'command: grep -q multiply src/math.ts', result: 'pass', detail: 'exit 0' }],
      changedPaths: ['src/math.ts'],
      diffExcerpt: '+export function multiply(a: number, b: number) { return a * b }',
      notesExcerpt: '## 完成声明\n已新增 multiply',
    }
    const result = await evaluateTask(captureCtx as never, agent, state(), task(), richCandidate)
    assert.equal(result.verdict, 'pass')
    assert.match(capturedPrompt, /grep -q multiply src\/math\.ts/)
    assert.match(capturedPrompt, /export function multiply/)
    assert.match(capturedPrompt, /已新增 multiply/)
  })
})
