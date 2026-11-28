import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import { runVisualWitness } from '../../src/host/goal-supervisor/visual'
import { GUARD_SCHEMA_VERSION, type GuardState, type GuardTask } from '../../src/host/goal-supervisor/schema'

function task(overrides: Partial<GuardTask> = {}): GuardTask {
  return {
    id: 'T1', title: '场景优化', status: 'IN_PROGRESS', scope: ['docs/**'], dependsOn: [],
    acceptance: ['截图里没有穿模'], probes: [], requiredProbes: [], probeResults: {},
    evidence: [], attempts: [], scopeApprovedCount: 0, baselineDirty: {}, ...overrides,
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

/** One tiny valid PNG (1×1) so the witness reads real bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const agent = { model: { current: () => ({ provider: 'p', model: 'm' }) } }

function storeFace(root: string) {
  return { evidencePath: (taskId: string, name: string) => join(root, 'tasks', taskId, 'evidence', name) }
}

describe('visual witness', () => {
  test('stays off unless the run enabled it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'visual-off-'))
    try {
      const witness = await runVisualWitness({
        ctx: { get: () => undefined },
        cwd: root, store: storeFace(root), state: state(), task: task(), paths: [], agent,
      })
      assert.equal(witness, undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reports unavailable (never pass) when the task changed no screenshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'visual-noshot-'))
    try {
      const witness = await runVisualWitness({
        ctx: { get: () => undefined },
        cwd: root, store: storeFace(root),
        state: state({ visual: { enabled: true } }), task: task(), paths: ['src/a.ts'], agent,
      })
      assert.equal(witness?.result, 'unavailable')
      assert.match(witness?.result === 'unavailable' ? witness.reason : '', /截图/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('drops images above the injectable byte budget instead of sending them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'visual-big-'))
    try {
      await mkdir(join(root, 'docs'), { recursive: true })
      // Small file, small injected ceiling: the cap is exercised for real instead
      // of relying on a 20 MB default that a mock-only witness never reached.
      await writeFile(join(root, 'docs', 'huge.png'), Buffer.alloc(2_048))
      let uploaded = 0
      let streamed = 0
      const witness = await runVisualWitness({
        ctx: {
          get(name: string) {
            if (name === 'attachments') return { saveImages: async () => { uploaded += 1; return [] } }
            if (name === 'llm') {
              return {
                prepareCall: async () => ({
                  config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 2500 },
                  stream: () => (async function* () { streamed += 1 })(),
                }),
              }
            }
            return undefined
          },
        },
        cwd: root, store: storeFace(root),
        state: state({ visual: { enabled: true } }), task: task(), paths: ['docs/huge.png'], agent,
        maxReadBytes: 1_024,
      })
      assert.equal(witness?.result, 'unavailable')
      assert.equal(witness?.images.length, 0, 'an over-budget screenshot is never hashed into the witness')
      assert.match(witness?.result === 'unavailable' ? witness.reason : '', /截图/)
      assert.equal(uploaded, 0, 'nothing is uploaded when the only screenshot is over the cap')
      assert.equal(streamed, 0, 'no model call is made without a usable screenshot')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('stores the observation as evidence and returns findings without a verdict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'visual-ok-'))
    try {
      await mkdir(join(root, 'docs'), { recursive: true })
      await writeFile(join(root, 'docs', 'shot.png'), PNG)
      const seen: { images: number } = { images: 0 }
      const witness = await runVisualWitness({
        ctx: {
          get(name: string) {
            if (name === 'attachments') {
              return {
                saveImages: async (inputs: readonly { data: Uint8Array }[]) => {
                  seen.images = inputs.length
                  return inputs.map((_, index) => ({ attachmentId: `att-${index}` }))
                },
              }
            }
            if (name === 'llm') {
              return {
                prepareCall: async () => ({
                  config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 2500 },
                  stream: () => (async function* () {
                    const body = JSON.stringify({
                      findings: [{ criterion: '截图里没有穿模', severity: 'warn', what: '左肩与衣摆交界处有明显穿插', where: '中央人物左肩' }],
                      summary: '整体干净，只有一处穿插',
                    })
                    yield { type: 'text-delta', index: 0, text: body }
                    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
                  })(),
                }),
              }
            }
            return undefined
          },
        },
        cwd: root, store: storeFace(root),
        state: state({ visual: { enabled: true } }), task: task(), paths: ['docs/shot.png'], agent,
      })
      assert.equal(seen.images, 1)
      assert.equal(witness?.result, 'ok')
      if (witness?.result !== 'ok') throw new Error('expected an ok witness')
      assert.equal(witness.findings.length, 1)
      assert.equal(witness.findings[0]?.severity, 'warn')
      assert.match(witness.images[0]?.sha256 ?? '', /^[0-9a-f]{64}$/)
      // The verdict is the text judge's job; the witness artifact carries observations only.
      assert.equal(witness.artifact === undefined, false)
      const artifact = JSON.parse(await readFile(join(root, 'tasks', 'T1', 'evidence', String(witness.artifact)), 'utf8')) as { findings: unknown[] }
      assert.equal(artifact.findings.length, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('an empty witness reply is unavailable, not an empty pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'visual-empty-'))
    try {
      await mkdir(join(root, 'docs'), { recursive: true })
      await writeFile(join(root, 'docs', 'shot.png'), PNG)
      const witness = await runVisualWitness({
        ctx: {
          get(name: string) {
            if (name === 'attachments') return { saveImages: async () => [{ attachmentId: 'a' }] }
            if (name === 'llm') {
              return {
                prepareCall: async () => ({
                  config: { provider: 'p', model: 'm', temperature: 0, maxTokens: 2500 },
                  stream: () => (async function* () {
                    // A normal stop with zero content blocks: the witness labels
                    // it EMPTY_RESPONSE itself, which used to double-print.
                    yield { type: 'finish', reason: { kind: 'stop' } }
                  })(),
                }),
              }
            }
            return undefined
          },
        },
        cwd: root, store: storeFace(root),
        state: state({ visual: { enabled: true } }), task: task(), paths: ['docs/shot.png'], agent,
        timeoutMs: 200,
      })
      assert.equal(witness?.result, 'unavailable')
      assert.match(witness?.result === 'unavailable' ? witness.reason : '', /EMPTY_RESPONSE/)
      // The label used to be concatenated in front of a detail that already was
      // that label, rendering the same sentence twice.
      const reason = witness?.result === 'unavailable' ? witness.reason : ''
      assert.equal((reason.match(/模型未返回任何文本/g) ?? []).length, 1, `the reason is not duplicated: ${reason}`)
      assert.equal((reason.match(/EMPTY_RESPONSE/g) ?? []).length, 1, `the code is not duplicated: ${reason}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a truncated witness reply is reported as MAX_TOKENS without inventing a budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'visual-maxtokens-'))
    try {
      await mkdir(join(root, 'docs'), { recursive: true })
      await writeFile(join(root, 'docs', 'shot.png'), PNG)
      const budgets: (number | undefined)[] = []
      let calls = 0
      const witness = await runVisualWitness({
        ctx: {
          get(name: string) {
            if (name === 'attachments') return { saveImages: async () => [{ attachmentId: 'a' }] }
            if (name === 'llm') {
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
            }
            return undefined
          },
        },
        cwd: root, store: storeFace(root),
        state: state({ visual: { enabled: true } }), task: task(), paths: ['docs/shot.png'], agent,
        timeoutMs: 200,
      })
      assert.equal(witness?.result, 'unavailable')
      assert.match(witness?.reason ?? '', /MAX_TOKENS/)
      assert.deepEqual(budgets, [undefined], 'no explicit maxTokens is requested')
      assert.equal(calls, 1, 'a truncation is not retried on the same route')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a timed-out vision route is TIMEOUT, so the visual fallback is tried', async () => {
    const root = await mkdtemp(join(tmpdir(), 'visual-timeout-'))
    try {
      await mkdir(join(root, 'docs'), { recursive: true })
      await writeFile(join(root, 'docs', 'shot.png'), PNG)
      const witness = await runVisualWitness({
        ctx: {
          get(name: string) {
            if (name === 'attachments') return { saveImages: async () => [{ attachmentId: 'a' }] }
            if (name === 'llm') {
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
                    const body = JSON.stringify({
                      findings: [{ criterion: '截图里没有穿模', severity: 'info', what: '画面干净' }],
                      summary: 'ok',
                    })
                    yield { type: 'text-delta', index: 0, text: body }
                    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
                  })(),
                }),
              }
            }
            return undefined
          },
        },
        cwd: root, store: storeFace(root),
        state: state({
          visual: {
            enabled: true,
            route: { provider: 'p', model: 'primary' },
            fallback: { provider: 'p2', model: 'fallback' },
          },
        }),
        task: task(), paths: ['docs/shot.png'], agent, timeoutMs: 20,
      })
      assert.equal(witness?.result, 'ok')
      assert.equal(witness?.result === 'ok' ? witness.model : '', 'p2/fallback')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a real adapter abort (failure.code UNKNOWN) is still TIMEOUT, so the fallback runs', async () => {
    // `LlmRuntime.adapterStream()` ends an aborted call with
    // `finish.reason.failure.code = 'UNKNOWN' | 'ABORTED'` — non-empty, so reading
    // the finish code first hid the deadline and left the fallback unused.
    const root = await mkdtemp(join(tmpdir(), 'visual-aborted-'))
    try {
      await mkdir(join(root, 'docs'), { recursive: true })
      await writeFile(join(root, 'docs', 'shot.png'), PNG)
      const witness = await runVisualWitness({
        ctx: {
          get(name: string) {
            if (name === 'attachments') return { saveImages: async () => [{ attachmentId: 'a' }] }
            if (name === 'llm') {
              return {
                prepareCall: async (config: Record<string, unknown>) => ({
                  config: { provider: String(config.provider), model: String(config.model), temperature: 0, maxTokens: Number(config.maxTokens) },
                  inputModalities: ['text', 'image'],
                  stream: (options: { signal: AbortSignal }) => (async function* () {
                    if (config.model === 'primary') {
                      await new Promise<void>((resolve) => {
                        if (options.signal.aborted) { resolve(); return }
                        options.signal.addEventListener('abort', () => resolve(), { once: true })
                      })
                      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'UNKNOWN', message: 'The operation was aborted.' } } }
                      return
                    }
                    const body = JSON.stringify({
                      findings: [{ criterion: '截图里没有穿模', severity: 'info', what: '画面干净' }],
                      summary: 'ok',
                    })
                    yield { type: 'text-delta', index: 0, text: body }
                    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
                  })(),
                }),
              }
            }
            return undefined
          },
        },
        cwd: root, store: storeFace(root),
        state: state({
          visual: {
            enabled: true,
            route: { provider: 'p', model: 'primary' },
            fallback: { provider: 'p2', model: 'fallback' },
          },
        }),
        task: task(), paths: ['docs/shot.png'], agent, timeoutMs: 20,
      })
      assert.equal(witness?.result, 'ok', `the fallback route answered: ${witness?.result === 'unavailable' ? witness.reason : ''}`)
      assert.equal(witness?.result === 'ok' ? witness.model : '', 'p2/fallback')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a route whose adapter declares text-only input is never dispatched, and the fallback is tried', async () => {
    const root = await mkdtemp(join(tmpdir(), 'visual-textonly-'))
    try {
      await mkdir(join(root, 'docs'), { recursive: true })
      await writeFile(join(root, 'docs', 'shot.png'), PNG)
      const streamed: string[] = []
      const witness = await runVisualWitness({
        ctx: {
          get(name: string) {
            if (name === 'attachments') return { saveImages: async () => [{ attachmentId: 'a' }] }
            if (name === 'llm') {
              return {
                prepareCall: async (config: Record<string, unknown>) => ({
                  config: { provider: String(config.provider), model: String(config.model), temperature: 0, maxTokens: Number(config.maxTokens) },
                  // The real adapter does not throw UNSUPPORTED_CONTENT here: it
                  // replaces the image block with a text placeholder and answers
                  // anyway, which used to look like a normal witness pass.
                  inputModalities: config.model === 'primary' ? ['text'] : ['text', 'image'],
                  stream: () => (async function* () {
                    streamed.push(String(config.model))
                    const body = JSON.stringify({ findings: [], summary: 'ok' })
                    yield { type: 'text-delta', index: 0, text: body }
                    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
                  })(),
                }),
              }
            }
            return undefined
          },
        },
        cwd: root, store: storeFace(root),
        state: state({
          visual: {
            enabled: true,
            route: { provider: 'p', model: 'primary' },
            fallback: { provider: 'p2', model: 'fallback' },
          },
        }),
        task: task(), paths: ['docs/shot.png'], agent,
      })
      assert.deepEqual(streamed, ['fallback'], 'the text-only primary is never dispatched')
      assert.equal(witness?.result, 'ok')
      assert.equal(witness?.result === 'ok' ? witness.model : '', 'p2/fallback')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a text-only route with no fallback is unavailable with an explicit modality reason', async () => {
    const root = await mkdtemp(join(tmpdir(), 'visual-textonly-solo-'))
    try {
      await mkdir(join(root, 'docs'), { recursive: true })
      await writeFile(join(root, 'docs', 'shot.png'), PNG)
      let streamed = 0
      const witness = await runVisualWitness({
        ctx: {
          get(name: string) {
            if (name === 'attachments') return { saveImages: async () => [{ attachmentId: 'a' }] }
            if (name === 'llm') {
              return {
                prepareCall: async (config: Record<string, unknown>) => ({
                  config: { provider: String(config.provider), model: String(config.model), temperature: 0, maxTokens: Number(config.maxTokens) },
                  inputModalities: ['text'],
                  stream: () => (async function* () { streamed += 1 })(),
                }),
              }
            }
            return undefined
          },
        },
        cwd: root, store: storeFace(root),
        state: state({ visual: { enabled: true, route: { provider: 'p', model: 'primary' } } }),
        task: task(), paths: ['docs/shot.png'], agent,
      })
      assert.equal(streamed, 0, 'a model that never declared image input is not called')
      assert.equal(witness?.result, 'unavailable')
      assert.match(witness?.result === 'unavailable' ? witness.reason : '', /未声明图片输入/)
      assert.equal(witness?.images.length, 1, 'the image is still recorded as evidence identity')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
