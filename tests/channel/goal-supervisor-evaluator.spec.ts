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
  })
})
