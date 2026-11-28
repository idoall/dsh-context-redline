import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import { evaluateProgress, evaluateTask, type EvalCandidate } from '../../src/host/goal-supervisor/evaluator'
import { MILESTONE_TIMEOUT_MS, reviewMilestone } from '../../src/host/goal-supervisor/milestone'
import { GuardStore } from '../../src/host/goal-supervisor/store'
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

  test('an empty model reply is reported with the EMPTY_RESPONSE code, not as an unparseable result', async () => {
    // The exact shape the antigravity bridge produced in a real run: a normal
    // stop with zero content blocks. DSH already classifies it; the plugin used
    // to collapse it into "unparseable", which hid the real cause.
    const emptyCtx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async () => ({
            config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 4000 },
            stream: () => (async function* () {
              yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'provider returned no content blocks' } } }
            })(),
          }),
        }
      },
    }
    const result = await evaluateTask(emptyCtx as never, agent, state(), task(), candidate)
    assert.equal(result.verdict, 'insufficient')
    assert.equal(result.unavailable, true)
    assert.match(result.reason ?? '', /EMPTY_RESPONSE/)
    assert.match(result.reason ?? '', /未返回任何文本/)
  })

  test('a primary judge that returns no text is replaced by the configured fallback route', async () => {
    const ok = JSON.stringify({
      goal_hash: 'hash-1', verdict: 'pass',
      criteria: [{ id: 'e1', status: 'met', why: 'probe P1 passed' }],
      violations: [], missing: [], correction: '', next_action: 'continue',
    })
    const calls: string[] = []
    const fallbackCtx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async (config: Record<string, unknown>) => {
            const model = String(config.model)
            calls.push(model)
            return {
              config: { provider: 'p', model, temperature: 0, maxTokens: 4000 },
              stream: () => (async function* () {
                if (model === 'primary') {
                  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'no content' } } }
                  return
                }
                yield { type: 'text-delta', index: 0, text: ok }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: ok } }
              })(),
            }
          },
        }
      },
    }
    const ledger = state({
      evaluator: { provider: 'p', model: 'primary' },
      evaluatorFallback: { provider: 'p2', model: 'fallback' },
    })
    const result = await evaluateTask(fallbackCtx as never, agent, ledger, task(), candidate)
    assert.equal(result.verdict, 'pass')
    assert.equal(result.model, 'p2/fallback', 'the verdict names the model that actually judged')
    assert.deepEqual(result.fallbacks, [{ from: 'p/primary', to: 'p2/fallback', code: 'EMPTY_RESPONSE' }])
    // The primary route keeps its two attempts before the fallback is tried.
    assert.deepEqual(calls, ['primary', 'primary', 'fallback'])
  })

  test('an exhausted quota stays visible instead of silently switching within one provider', async () => {
    let calls = 0
    const quotaCtx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async () => {
            calls += 1
            return {
              config: { provider: 'p', model: 'primary', temperature: 0, maxTokens: 4000 },
              stream: () => (async function* () {
                yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'balance exhausted' } } }
              })(),
            }
          },
        }
      },
    }
    const ledger = state({
      evaluator: { provider: 'p', model: 'primary' },
      evaluatorFallback: { provider: 'p', model: 'same-provider-backup' },
    })
    const result = await evaluateTask(quotaCtx as never, agent, ledger, task(), candidate)
    assert.equal(result.unavailable, true)
    assert.match(result.reason ?? '', /QUOTA/)
    assert.equal(result.fallbacks, undefined)
    // A quota/auth failure cannot be fixed by retrying the same route, so the
    // judge asks once and reports instead of burning a second call.
    assert.equal(calls, 1, 'a definitive failure is not retried on the same route')
  })

  test('a primary and a fallback route that both fail still report the switch', async () => {
    const calls: string[] = []
    const failingCtx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async (config: Record<string, unknown>) => {
            const model = String(config.model)
            calls.push(model)
            return {
              config: { provider: 'p', model, temperature: 0, maxTokens: 4000 },
              stream: () => (async function* () {
                yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'no content' } } }
              })(),
            }
          },
        }
      },
    }
    const ledger = state({
      evaluator: { provider: 'p', model: 'primary' },
      evaluatorFallback: { provider: 'p2', model: 'fallback' },
    })
    const result = await evaluateTask(failingCtx as never, agent, ledger, task(), candidate)
    assert.equal(result.verdict, 'insufficient')
    assert.equal(result.unavailable, true)
    // Once the fallback ALSO failed, `loop.ts` never learned the judge had been
    // switched, so `eval.fallback` was silently dropped from the audit trail.
    assert.deepEqual(result.fallbacks, [{ from: 'p/primary', to: 'p2/fallback', code: 'EMPTY_RESPONSE' }])
    assert.deepEqual(calls, ['primary', 'primary', 'fallback', 'fallback'])
  })

  test('a failure message that already names its code is not labelled twice', async () => {
    const labelledCtx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async () => ({
            config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 4000 },
            stream: () => (async function* () {
              yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: '鉴权失败（AUTH）' } } }
            })(),
          }),
        }
      },
    }
    const result = await evaluateTask(labelledCtx as never, agent, state(), task(), candidate)
    assert.equal(result.unavailable, true)
    const occurrences = (result.reason ?? '').split('AUTH').length - 1
    assert.equal(occurrences, 1, `the code appears exactly once: ${JSON.stringify(result.reason)}`)
  })

  test('the prompt carries the visual witness, including an unavailable one', async () => {
    const payload = JSON.stringify({
      goal_hash: 'hash-1', verdict: 'insufficient', criteria: [], violations: [], missing: ['no proof'],
      correction: '', next_action: 'retry',
    })
    const prompts: string[] = []
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async () => ({
            config: { provider: 'p', model: 'm' },
            stream: () => (async function* () {
              yield { type: 'text-delta', index: 0, text: payload }
              yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
            })(),
          }),
        }
      },
    }
    const realCtx = {
      get(name: string) {
        const base = ctx.get(name) as { prepareCall?: unknown } | undefined
        if (base === undefined) return undefined
        return {
          prepareCall: async (...args: unknown[]) => {
            const prepared = await (base.prepareCall as (...a: unknown[]) => Promise<{ config: Record<string, unknown>, stream: (o: Record<string, unknown>) => AsyncIterable<unknown> }>)(...args)
            return {
              ...prepared,
              stream: (options: Record<string, unknown>) => {
                const messages = options.messages as { content?: { text?: string }[] }[] | undefined
                prompts.push(messages?.flatMap(message => message.content?.map(part => part.text ?? '') ?? []).join('\n') ?? '')
                return prepared.stream(options)
              },
            }
          },
        }
      },
    }
    await evaluateTask(realCtx as never, agent, state(), task(), {
      ...candidate,
      visualWitness: { result: 'unavailable', reason: '本任务没有截图', images: [] },
    })
    assert.ok(prompts.length > 0)
    assert.match(prompts[0] ?? '', /visual_witness/)
    assert.match(prompts[0] ?? '', /本任务没有截图/)
    // The SYSTEM text names CANDIDATE.visual_witness, so the field must live on
    // the candidate object — a top-level field is invisible to that instruction.
    const parsed = JSON.parse(prompts[0] ?? '') as {
      visual_witness?: unknown
      candidate?: { visual_witness?: { result?: string } }
    }
    assert.equal(parsed.visual_witness, undefined, 'the witness is not a top-level field')
    assert.equal(parsed.candidate?.visual_witness?.result, 'unavailable')
  })

  test('the prompt omits the visual witness entirely when the run never enabled it', async () => {
    const payload = JSON.stringify({
      goal_hash: 'hash-1', verdict: 'insufficient', criteria: [], violations: [], missing: ['no proof'],
      correction: '', next_action: 'retry',
    })
    const prompts: string[] = []
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async () => ({
            config: { provider: 'p', model: 'm' },
            stream: (options: { messages?: { content?: { text?: string }[] }[] }) => {
              prompts.push(options.messages?.flatMap(message => message.content?.map(part => part.text ?? '') ?? []).join('\n') ?? '')
              return (async function* () {
                yield { type: 'text-delta', index: 0, text: payload }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
              })()
            },
          }),
        }
      },
    }
    await evaluateTask(ctx as never, agent, state(), task(), candidate)
    assert.ok(prompts.length > 0)
    const parsed = JSON.parse(prompts[0] ?? '') as {
      visual_witness?: unknown
      candidate?: Record<string, unknown>
    }
    // A null top-level field was both duplicated and invisible to the prompt's
    // own instruction; when there is no witness the key must simply be absent.
    assert.equal('visual_witness' in parsed, false)
    assert.equal('visual_witness' in (parsed.candidate ?? {}), false)
  })

  test('an empty reply is EMPTY_RESPONSE and moves to the fallback route', async () => {
    const ok = JSON.stringify({
      goal_hash: 'hash-1', verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue',
    })
    const calls: string[] = []
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async (config: Record<string, unknown>) => {
            const model = String(config.model)
            calls.push(model)
            return {
              config: { provider: 'p', model },
              stream: () => (async function* () {
                if (model === 'primary') {
                  // A normal stop with no content block at all.
                  yield { type: 'finish', reason: { kind: 'stop' } }
                  return
                }
                yield { type: 'text-delta', index: 0, text: ok }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: ok } }
              })(),
            }
          },
        }
      },
    }
    const ledger = state({
      evaluator: { provider: 'p', model: 'primary' },
      evaluatorFallback: { provider: 'p', model: 'fallback' },
    })
    const result = await evaluateTask(ctx as never, agent, ledger, task(), candidate)
    assert.equal(result.verdict, 'pass')
    assert.equal(result.model, 'p/fallback')
    assert.deepEqual(result.fallbacks, [{ from: 'p/primary', to: 'p/fallback', code: 'EMPTY_RESPONSE' }])
  })

  test('a verdict truncated twice is MAX_TOKENS, not unparseable, and switches routes', async () => {
    const ok = JSON.stringify({
      goal_hash: 'hash-1', verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue',
    })
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async (config: Record<string, unknown>) => {
            const model = String(config.model)
            return {
              config: { provider: 'p', model },
              stream: () => (async function* () {
                if (model === 'primary') {
                  yield { type: 'finish', reason: { kind: 'max-tokens' } }
                  return
                }
                yield { type: 'text-delta', index: 0, text: ok }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: ok } }
              })(),
            }
          },
        }
      },
    }
    const ledger = state({
      evaluator: { provider: 'p', model: 'primary' },
      evaluatorFallback: { provider: 'p', model: 'fallback' },
    })
    const result = await evaluateTask(ctx as never, agent, ledger, task(), candidate)
    assert.equal(result.verdict, 'pass')
    assert.deepEqual(result.fallbacks, [{ from: 'p/primary', to: 'p/fallback', code: 'MAX_TOKENS' }])
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

  test('uses state.evaluator route for evaluateTask, evaluateProgress, and reviewMilestone when configured', async () => {
    const called: { provider?: unknown; model?: unknown }[] = []
    const payload = JSON.stringify({
      goal_hash: 'hash-1', verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue',
    })
    const progressPayload = JSON.stringify({ verdict: 'advancing', reason: 'narrowed failure' })
    const reviewPayload = JSON.stringify({ verdict: 'pass', reasons: ['ok'], defects: [] })
    let responseBody = payload
    const routeCtx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async (config: Record<string, unknown>) => {
            called.push({ provider: config.provider, model: config.model })
            return {
              config,
              stream: () => (async function* () {
                yield { type: 'text-delta', index: 0, text: responseBody }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: responseBody } }
              })(),
            }
          },
        }
      },
    }
    const configuredState = state({ evaluator: { provider: 'second-opinion', model: 'auditor-v2' } } as Partial<GuardState>)
    const evalResult = await evaluateTask(routeCtx as never, agent, configuredState, task(), candidate)
    assert.equal(evalResult.verdict, 'pass')
    assert.equal(evalResult.model, 'second-opinion/auditor-v2')

    responseBody = progressPayload
    const progressResult = await evaluateProgress(routeCtx as never, agent, configuredState, task(), [])
    assert.equal(progressResult.verdict, 'advancing')
    assert.equal(progressResult.model, 'second-opinion/auditor-v2')

    responseBody = reviewPayload
    const reviewResult = await reviewMilestone(
      routeCtx as never,
      agent,
      configuredState,
      [task()],
      1,
      new GuardStore('/nonexistent-milestone-root'),
    )
    assert.equal(reviewResult?.verdict, 'pass')
    assert.equal(reviewResult?.model, 'second-opinion/auditor-v2')

    assert.equal(called.length, 5, '1 task eval + 1 progress eval + 3 milestone reviewers')
    for (const call of called) {
      assert.deepEqual(call, { provider: 'second-opinion', model: 'auditor-v2' })
    }
  })

  test('honours an explicit evaluator reasoningEffort instead of forcing the lowest effort', async () => {
    const seenEfforts: (string | undefined)[] = []
    const payload = JSON.stringify({
      goal_hash: state().goalHash, verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue',
    })
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async (
            cfg: Record<string, unknown>,
            _signal?: AbortSignal,
            configure?: (controls: Record<string, unknown>, model: Record<string, unknown>) => Record<string, unknown>,
          ) => {
            const configured = configure?.({ temperature: 0 }, { reasoning: { efforts: [{ id: 'low' }, { id: 'max' }] } })
            seenEfforts.push(configured?.reasoningEffort as string | undefined)
            return {
              config: cfg,
              stream: () => (async function* () {
                yield { type: 'text-delta', index: 0, text: payload }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
              })(),
            }
          },
        }
      },
    }
    const agent = { model: { current: () => ({ provider: 'main-p', model: 'main-m' }) } }
    const withMax = state({ evaluator: { provider: 'p', model: 'm', reasoningEffort: 'max' } } as Partial<GuardState>)
    const res1 = await evaluateTask(ctx as never, agent, withMax, task(), candidate)
    assert.equal(res1.verdict, 'pass')
    const withoutExplicit = state({ evaluator: { provider: 'p', model: 'm' } } as Partial<GuardState>)
    const res2 = await evaluateTask(ctx as never, agent, withoutExplicit, task(), candidate)
    assert.equal(res2.verdict, 'pass')
    assert.deepEqual(seenEfforts, ['max', 'low'])
  })

  test('retries once after a transport failure instead of reporting an evaluator outage', async () => {
    const payload = JSON.stringify({
      goal_hash: state().goalHash, verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue',
    })
    let calls = 0
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async () => ({
            config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 2500 },
            stream: () => (async function* () {
              calls += 1
              if (calls === 1) throw new Error('socket hang up')
              yield { type: 'text-delta', index: 0, text: payload }
              yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
            })(),
          }),
        }
      },
    }
    const result = await evaluateTask(ctx as never, agent, state(), task(), candidate)
    assert.equal(calls, 2, 'one transient failure must be retried, not folded into "unavailable"')
    assert.equal(result.verdict, 'pass')
  })

  test('reports the timeout budget instead of echoing the transport abort', async () => {
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async () => ({
            config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 2500 },
            stream: (input: { signal: AbortSignal }) => (async function* () {
              await new Promise((_resolve, reject) => {
                input.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
              })
            })(),
          }),
        }
      },
    }
    const result = await evaluateTask(ctx as never, agent, state(), task(), candidate, { timeoutMs: 20 })
    assert.equal(result.verdict, 'insufficient')
    assert.equal(result.unavailable, true)
    assert.match(result.reason ?? '', /调用超时/)
    assert.match(result.reason ?? '', /20ms/)
    assert.ok(!(result.reason ?? '').includes('Request was aborted'), `timeout must not look like a transport abort: ${result.reason}`)
  })

  test('a retry after a timeout gets its own budget instead of failing on the first signal', async () => {
    const payload = JSON.stringify({
      goal_hash: state().goalHash, verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue',
    })
    let calls = 0
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async () => ({
            config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 2500 },
            stream: (input: { signal: AbortSignal }) => (async function* () {
              calls += 1
              if (calls === 1) {
                await new Promise((_resolve, reject) => {
                  input.signal.addEventListener('abort', () => reject(new Error('Request was aborted')))
                })
              }
              yield { type: 'text-delta', index: 0, text: payload }
              yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
            })(),
          }),
        }
      },
    }
    const result = await evaluateTask(ctx as never, agent, state(), task(), candidate, { timeoutMs: 20 })
    assert.equal(calls, 2, 'the second attempt must not inherit the first attempt\'s aborted signal')
    assert.equal(result.verdict, 'pass')
  })

  test('progress evaluation also names a timeout instead of a bare abort', async () => {
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async () => ({
            config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 800 },
            stream: (input: { signal: AbortSignal }) => (async function* () {
              await new Promise((_resolve, reject) => {
                input.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
              })
            })(),
          }),
        }
      },
    }
    const result = await evaluateProgress(ctx as never, agent, state(), task(), [], { timeoutMs: 20 })
    assert.equal(result.verdict, 'unknown')
    assert.match(result.reason, /调用超时/)
  })

  test('milestone review uses a 60s default budget, retries transient failures, and writes a diagnostic report on reviewer timeout', async () => {
    assert.equal(MILESTONE_TIMEOUT_MS, 60_000, 'milestone reviewers share the 60s evaluator budget')

    const root = await mkdtemp(join(tmpdir(), 'guard-milestone-'))
    try {
      const store = new GuardStore(root)
      // 1) Transient failure on reviewer 2 recovers on retry and produces a pass.
      const seenByReviewer = new Map<string, number>()
      const retryCtx = {
        get(name: string) {
          if (name !== 'llm') return undefined
          return {
            prepareCall: async () => ({
              config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 2500 },
              stream: (options: { system?: string }) => (async function* () {
                const who = options.system ?? ''
                const count = (seenByReviewer.get(who) ?? 0) + 1
                seenByReviewer.set(who, count)
                if (who.includes('第 2 位') && count === 1) {
                  yield { type: 'text-delta', index: 0, text: '先说几句非 JSON' }
                  yield { type: 'block-end', index: 0, block: { type: 'text', text: '先说几句非 JSON' } }
                  return
                }
                const ok = JSON.stringify({ verdict: 'pass', reasons: ['ok'], defects: [] })
                yield { type: 'text-delta', index: 0, text: ok }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: ok } }
              })(),
            }),
          }
        },
      }
      const recovered = await reviewMilestone(retryCtx as never, agent, state(), [task()], 1, store, { timeoutMs: 25 })
      assert.equal(recovered?.verdict, 'pass')
      assert.equal(recovered?.reason, undefined)

      // 2) Persistent timeout on reviewer 3 still writes review/round-2.md with the exact timeout cause
      //    and keeps the other two reviewers' verdicts instead of returning null and leaving review/ empty.
      let reviewer3Attempts = 0
      const timeoutCtx = {
        get(name: string) {
          if (name !== 'llm') return undefined
          return {
            prepareCall: async () => ({
              config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 2500 },
              stream: (options: { system?: string; signal: AbortSignal }) => (async function* () {
                if ((options.system ?? '').includes('第 3 位')) {
                  reviewer3Attempts += 1
                  await new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
                  })
                }
                const ok = JSON.stringify({ verdict: 'pass', reasons: ['ok'], defects: [] })
                yield { type: 'text-delta', index: 0, text: ok }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: ok } }
              })(),
            }),
          }
        },
      }
      const partial = await reviewMilestone(timeoutCtx as never, agent, state(), [task()], 2, store, { timeoutMs: 25 })
      assert.ok(partial !== null, 'a reviewer timeout must produce a diagnostic report, not null')
      assert.equal(partial.verdict, 'insufficient')
      assert.equal(reviewer3Attempts, 2, 'a timed-out reviewer gets one fresh retry')
      assert.match(partial.reason ?? '', /调用超时（25ms）/)
      assert.equal(partial.reviewers[0]?.verdict, 'pass')
      assert.equal(partial.reviewers[1]?.verdict, 'pass')
      assert.equal(partial.reviewers[2]?.verdict, 'insufficient')
      const report = await readFile(join(root, 'review', 'round-2.md'), 'utf8')
      assert.match(report, /审阅者 1 · pass/)
      assert.match(report, /审阅者 3 · insufficient/)
      assert.match(report, /调用超时（25ms）/)

      // 3) Split verdict where the adjudicator itself times out records the adjudicator failure instead of hiding it.
      const splitAdjTimeoutCtx = {
        get(name: string) {
          if (name !== 'llm') return undefined
          return {
            prepareCall: async () => ({
              config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 2500 },
              stream: (options: { system?: string; signal: AbortSignal }) => (async function* () {
                const sys = options.system ?? ''
                if (sys.includes('裁决者')) {
                  await new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
                  })
                }
                const verdict = sys.includes('第 2 位') ? 'fail' : 'pass'
                const body = JSON.stringify({ verdict, reasons: [verdict === 'fail' ? '缺证据' : 'ok'], defects: [] })
                yield { type: 'text-delta', index: 0, text: body }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
              })(),
            }),
          }
        },
      }
      const adjFail = await reviewMilestone(splitAdjTimeoutCtx as never, agent, state(), [task()], 3, store, { timeoutMs: 25 })
      assert.ok(adjFail !== null)
      assert.equal(adjFail.verdict, 'insufficient')
      assert.match(adjFail.adjudicator?.why ?? '', /裁决失败：调用超时（25ms）/)
      assert.match(adjFail.reason ?? '', /裁决失败：调用超时（25ms）/)
      const round3 = await readFile(join(root, 'review', 'round-3.md'), 'utf8')
      assert.match(round3, /## 裁决/)
      assert.match(round3, /裁决失败：调用超时（25ms）/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // `AbortSignal.timeout()` rejects a hanging provider with a DOMException whose
  // `code` is the NUMBER 23, so the old `typeof code === 'string'` classifier read
  // every deadline as "no code" and never tried the configured fallback.
  test('an AbortSignal timeout is TIMEOUT, so the evaluator fallback is tried', async () => {
    const ok = JSON.stringify({
      goal_hash: 'hash-1', verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue',
    })
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async (config: Record<string, unknown>) => ({
            config: { provider: String(config.provider), model: String(config.model) },
            stream: (options: { signal: AbortSignal }) => (async function* () {
              if (config.model === 'primary') {
                await new Promise((_resolve, reject) => {
                  options.signal.addEventListener('abort', () => reject(options.signal.reason))
                })
                return
              }
              yield { type: 'text-delta', index: 0, text: ok }
              yield { type: 'block-end', index: 0, block: { type: 'text', text: ok } }
            })(),
          }),
        }
      },
    }
    const ledger = state({
      evaluator: { provider: 'p', model: 'primary' },
      evaluatorFallback: { provider: 'p2', model: 'fallback' },
    })
    const result = await evaluateTask(ctx as never, agent, ledger, task(), candidate, { timeoutMs: 20 })
    assert.equal(result.verdict, 'pass')
    assert.equal(result.model, 'p2/fallback')
    assert.deepEqual(result.fallbacks, [{ from: 'p/primary', to: 'p2/fallback', code: 'TIMEOUT' }])
  })

  test('a timed-out progress evaluation is TIMEOUT, so the progress fallback is tried', async () => {
    const ok = JSON.stringify({ verdict: 'advancing', reason: 'narrowed the failure' })
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async (config: Record<string, unknown>) => ({
            config: { provider: String(config.provider), model: String(config.model) },
            stream: (options: { signal: AbortSignal }) => (async function* () {
              if (config.model === 'primary') {
                await new Promise((_resolve, reject) => {
                  options.signal.addEventListener('abort', () => reject(options.signal.reason))
                })
                return
              }
              yield { type: 'text-delta', index: 0, text: ok }
              yield { type: 'block-end', index: 0, block: { type: 'text', text: ok } }
            })(),
          }),
        }
      },
    }
    const result = await evaluateProgress(ctx as never, agent, state({
      evaluator: { provider: 'p', model: 'primary' },
      evaluatorFallback: { provider: 'p2', model: 'fallback' },
    }), task(), [], { timeoutMs: 20 })
    assert.equal(result.verdict, 'advancing')
    assert.equal(result.model, 'p2/fallback')
    // The caller records this as an `eval.fallback` ledger event; without it the
    // verdict looks as if the primary judge produced it.
    assert.deepEqual(result.fallbacks, [{ from: 'p/primary', to: 'p2/fallback', code: 'TIMEOUT' }])
  })

  test('a truncated progress evaluation reports MAX_TOKENS instead of retrying with a made-up budget', async () => {
    const budgets: (number | undefined)[] = []
    let calls = 0
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async (config: Record<string, unknown>) => {
            budgets.push(config.maxTokens === undefined ? undefined : Number(config.maxTokens))
            return {
              config: { provider: 'p', model: 'm', temperature: 0 },
              stream: () => (async function* () {
                calls += 1
                yield { type: 'finish', reason: { kind: 'max-tokens' } }
              })(),
            }
          },
        }
      },
    }
    const result = await evaluateProgress(ctx as never, agent, state(), task(), [])
    // The judge uses the model's own output budget (a normal-conversation call),
    // so a truncation is the model's ceiling: report it, never invent a budget.
    assert.equal(result.verdict, 'unknown')
    assert.match(result.reason ?? '', /MAX_TOKENS/)
    assert.deepEqual(budgets, [undefined], 'no explicit maxTokens is requested')
    assert.equal(calls, 1, 'a truncation is not retried on the same route')
  })

  test('fallback labels carry the reasoning level, so a same-model downgrade is visible', async () => {
    const ok = JSON.stringify({
      goal_hash: 'hash-1', verdict: 'pass', criteria: [], violations: [], missing: [], correction: '', next_action: 'continue',
    })
    let calls = 0
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async (config: Record<string, unknown>) => {
            calls += 1
            const call = calls
            return {
              config: { provider: String(config.provider), model: String(config.model) },
              stream: () => (async function* () {
                if (call < 3) {
                  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'no content' } } }
                  return
                }
                yield { type: 'text-delta', index: 0, text: ok }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: ok } }
              })(),
            }
          },
        }
      },
    }
    const ledger = state({
      evaluator: { provider: 'p', model: 'm', reasoningEffort: 'low' },
      evaluatorFallback: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    })
    const result = await evaluateTask(ctx as never, agent, ledger, task(), candidate)
    assert.equal(result.verdict, 'pass')
    assert.deepEqual(result.fallbacks, [{ from: 'p/m (low)', to: 'p/m (high)', code: 'EMPTY_RESPONSE' }])
  })

  test('a milestone batch with mixed failure codes still switches to the fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'guard-milestone-mixed-'))
    try {
      const store = new GuardStore(root)
      const seen = { reviewers: 0 }
      const ctx = {
        get(name: string) {
          if (name !== 'llm') return undefined
          return {
            prepareCall: async (config: Record<string, unknown>) => ({
              config: { provider: String(config.provider), model: String(config.model), temperature: 0, maxTokens: 2500 },
              stream: (options: { system?: string }) => (async function* () {
                const system = options.system ?? ''
                const primary = config.model === 'primary'
                seen.reviewers += 1
                if (primary && system.includes('第 1 位')) {
                  // A definitive route failure listed FIRST: reading only the
                  // first coded failure made the whole fallback decision 'report'
                  // even though reviewer 3 failed for a switchable reason.
                  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } }
                  return
                }
                if (primary && system.includes('第 3 位')) {
                  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'no text' } } }
                  return
                }
                const payload = JSON.stringify({ verdict: 'pass', reasons: ['ok'], defects: [] })
                yield { type: 'text-delta', index: 0, text: payload }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
              })(),
            }),
          }
        },
      }
      const review = await reviewMilestone(ctx as never, agent, state({
        evaluator: { provider: 'p', model: 'primary' },
        evaluatorFallback: { provider: 'p2', model: 'fallback' },
      }), [task()], 1, store, { timeoutMs: 50 })
      assert.ok(review !== null)
      assert.equal(review.verdict, 'pass', 'the fallback route answered the unproven batch')
      assert.equal(review.model, 'p2/fallback')
      assert.deepEqual(review.fallbacks, [{ from: 'p/primary', to: 'p2/fallback', code: 'EMPTY_RESPONSE' }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a final evaluator failure names the route with its reasoning level', async () => {
    const ctx = {
      get(name: string) {
        if (name !== 'llm') return undefined
        return {
          prepareCall: async () => ({
            config: { provider: 'p', model: 'm' },
            stream: () => (async function* () {
              yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'balance exhausted' } } }
            })(),
          }),
        }
      },
    }
    const result = await evaluateTask(ctx as never, agent, state({
      evaluator: { provider: 'p', model: 'm', reasoningEffort: 'low' },
    }), task(), candidate)
    assert.equal(result.unavailable, true)
    assert.equal(result.model, 'p/m (low)')
  })

  test('an adjudicator failure does not repeat a code its message already carries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'guard-milestone-dup-'))
    try {
      const store = new GuardStore(root)
      const ctx = {
        get(name: string) {
          if (name !== 'llm') return undefined
          return {
            prepareCall: async () => ({
              config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 2500 },
              stream: (options: { system?: string }) => (async function* () {
                const system = options.system ?? ''
                if (system.includes('裁决者')) {
                  // The message already carries the provider-neutral code; the
                  // renderer used to append it a second time.
                  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: '模型未返回任何文本（EMPTY_RESPONSE）' } } }
                  return
                }
                const verdict = system.includes('第 2 位') ? 'fail' : 'pass'
                const body = JSON.stringify({ verdict, reasons: ['r'], defects: [] })
                yield { type: 'text-delta', index: 0, text: body }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
              })(),
            }),
          }
        },
      }
      const review = await reviewMilestone(ctx as never, agent, state(), [task()], 1, store, { timeoutMs: 200 })
      assert.ok(review !== null)
      assert.equal(review.verdict, 'insufficient')
      const why = review.adjudicator?.why ?? ''
      assert.match(why, /^裁决失败：/)
      assert.equal((why.match(/EMPTY_RESPONSE/g) ?? []).length, 1, `the code appears exactly once: ${why}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a reviewer timeout is TIMEOUT, so the milestone fallback route is tried', async () => {
    const root = await mkdtemp(join(tmpdir(), 'guard-milestone-timeout-'))
    try {
      const store = new GuardStore(root)
      const ok = JSON.stringify({ verdict: 'pass', reasons: ['ok'], defects: [] })
      const ctx = {
        get(name: string) {
          if (name !== 'llm') return undefined
          return {
            prepareCall: async (config: Record<string, unknown>) => ({
              config: { provider: String(config.provider), model: String(config.model), temperature: 0, maxTokens: Number(config.maxTokens) },
              stream: (options: { signal: AbortSignal }) => (async function* () {
                if (config.model === 'primary') {
                  await new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(options.signal.reason))
                  })
                  return
                }
                yield { type: 'text-delta', index: 0, text: ok }
                yield { type: 'block-end', index: 0, block: { type: 'text', text: ok } }
              })(),
            }),
          }
        },
      }
      const review = await reviewMilestone(ctx as never, agent, state({
        evaluator: { provider: 'p', model: 'primary' },
        evaluatorFallback: { provider: 'p2', model: 'fallback' },
      }), [task()], 1, store, { timeoutMs: 20 })
      assert.ok(review !== null)
      assert.equal(review.verdict, 'pass')
      assert.equal(review.model, 'p2/fallback')
      assert.deepEqual(review.fallbacks, [{ from: 'p/primary', to: 'p2/fallback', code: 'TIMEOUT' }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
