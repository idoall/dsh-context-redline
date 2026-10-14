import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createRedlineSessionControl, type CarrierSessionControlContext, type CarrierSessionRequest } from '../../src/host/redline-session-control'

const request = (patch: Partial<CarrierSessionRequest> = {}): CarrierSessionRequest => ({
  carrierId: 'carrier-fixed-id',
  cwd: '/workspace/project',
  agentPreset: 'coding',
  agentOptions: { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' },
  workspaceId: 'workspace-1',
  title: '↳ main1234 · continue the task',
  promptRequestId: 'prompt-request-1',
  promptText: 'VERBATIM migrated context',
  ...patch,
})

interface Harness {
  ctx: CarrierSessionControlContext
  agent: {
    id: string
    session: { id: string }
    options: { provider: string; model: string; reasoningEffort: string }
    ctx: { preset: string }
    inbox: { nextTurn: unknown[]; nextStep: unknown[] }
    followup(message: unknown): void
  }
  calls: {
    creates: Record<string, unknown>[]
    resumes: Record<string, unknown>[]
    mounts: { receiver: unknown; agentCtx: unknown; preset: string }[]
    attaches: string[]
    renames: { session: unknown; title: string }[]
    followups: unknown[]
    flushes: unknown[]
    reads: string[]
  }
  setRead: (read: (id: string) => Promise<unknown>) => void
}

function notFound(): Error & { code: string } {
  return Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
}

function harness(options: { live?: boolean; persisted?: boolean; titleResult?: unknown } = {}): Harness {
  const calls = { creates: [] as Record<string, unknown>[], resumes: [] as Record<string, unknown>[], mounts: [] as { receiver: unknown; agentCtx: unknown; preset: string }[], attaches: [] as string[], renames: [] as { session: unknown; title: string }[], followups: [] as unknown[], flushes: [] as unknown[], reads: [] as string[] }
  const agent = {
    id: 'carrier-fixed-id',
    session: { id: 'carrier-fixed-id' },
    options: { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' },
    ctx: { preset: 'coding' },
    inbox: { nextTurn: [] as unknown[], nextStep: [] as unknown[] },
    followup(message: unknown) { calls.followups.push(message); agent.inbox.nextTurn.push(message) },
  }
  const handle = { agent, async dispose() {} }
  let live = options.live === true
  const persistedEvents: unknown[] = []
  let read = async (_id: string): Promise<unknown> => {
    if (options.persisted === true || live) return { session: { id: agent.id }, events: structuredClone(persistedEvents) }
    throw notFound()
  }
  const presets = {
    async mount(agentCtx: unknown, preset: string) {
      calls.mounts.push({ receiver: this, agentCtx, preset })
      return { id: preset }
    },
    composedPreset(agentCtx: unknown) {
      return (agentCtx as { preset?: string }).preset ?? 'coding'
    },
  }
  const ctx: CarrierSessionControlContext = {
    agents: {
      get(id: string) { return live && id === agent.id ? agent : undefined },
      async create(options: Record<string, unknown>) {
        calls.creates.push(options)
        await (options.setup as (agentCtx: unknown, child: unknown) => unknown)({ scope: 'created' }, agent)
        live = true
        return handle
      },
      async resume(options: Record<string, unknown>) {
        calls.resumes.push(options)
        await (options.setup as (agentCtx: unknown, child: unknown) => unknown)({ scope: 'resumed' }, agent)
        live = true
        return handle
      },
    },
    agentPresets: presets,
    sessionQuery: {
      async readSession(id: string) { calls.reads.push(id); return await read(id) },
    },
    workspaceRegistry: {
      get() {
        return { async attachSession(id: string) { calls.attaches.push(id) } }
      },
    },
    sessionTitle: {
      rename(session: unknown, title: string) {
        calls.renames.push({ session, title })
        return options.titleResult
      },
    },
    sessions: {
      async flush(session: unknown) {
        calls.flushes.push(session)
        for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
          if (!persistedEvents.some((event) => sourceOf((event as { data?: { message?: unknown } }).data?.message)?.rpcId === sourceOf(message)?.rpcId)) {
            persistedEvents.push({ type: 'user/message', data: { message } })
          }
        }
        return true
      },
    },
  }
  return { ctx, agent, calls, setRead(next) { read = next } }
}

function sourceOf(value: unknown): { kind?: unknown; rpcId?: unknown } | undefined {
  return (value as { source?: { kind?: unknown; rpcId?: unknown } }).source
}

describe('redline carrier session control', () => {
  test('reuses a live agent without create or resume', async () => {
    const h = harness({ live: true })
    const result = await createRedlineSessionControl(h.ctx).start(request())
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'live')
    assert.equal(h.calls.creates.length, 0)
    assert.equal(h.calls.resumes.length, 0)
    assert.equal(h.calls.followups.length, 1)
  })

  test('creates an absent root using the exact fixed-id options and mounts the preset with its receiver', async () => {
    const h = harness()
    const control = createRedlineSessionControl(h.ctx)
    const input = request()
    const result = await control.start(input)
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'created')
    assert.equal(h.calls.creates.length, 1)
    const create = h.calls.creates[0]!
    assert.deepEqual(Object.keys(create).sort(), ['agentOptions', 'meta', 'sessionId', 'setup'])
    assert.equal(create.sessionId, input.carrierId)
    assert.deepEqual(create.meta, { cwd: input.cwd, agentPreset: input.agentPreset })
    assert.equal(create.agentOptions, input.agentOptions, 'pass the exact confirmed options object')
    assert.equal(h.calls.mounts.length, 1)
    assert.equal(h.calls.mounts[0]!.receiver, h.ctx.agentPresets)
    assert.equal(h.calls.mounts[0]!.preset, input.agentPreset)
    assert.ok(control.handles.has(input.carrierId), 'retain the owned AgentHandle')
  })

  test('resumes a persisted cold session rather than creating another one', async () => {
    const h = harness({ persisted: true })
    const input = request()
    const result = await createRedlineSessionControl(h.ctx).start(input)
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'resumed')
    assert.equal(h.calls.creates.length, 0)
    assert.equal(h.calls.resumes.length, 1)
    assert.deepEqual(Object.keys(h.calls.resumes[0]!).sort(), ['agentOptions', 'resumeSessionId', 'setup'])
    assert.equal(h.calls.resumes[0]!.resumeSessionId, input.carrierId)
    assert.equal(h.calls.resumes[0]!.agentOptions, input.agentOptions)
  })

  test('treats every read failure except SESSION_QUERY_SESSION_NOT_FOUND as unknown and stops', async () => {
    const h = harness()
    h.setRead(async () => { throw Object.assign(new Error('permission denied'), { code: 'SESSION_QUERY_PERSISTENCE_FAILED' }) })
    const result = await createRedlineSessionControl(h.ctx).start(request())
    assert.deepEqual(result, { ok: false, state: 'unknown', cause: 'SESSION_QUERY_PERSISTENCE_FAILED' })
    assert.equal(h.calls.creates.length, 0)
    assert.equal(h.calls.resumes.length, 0)
    assert.equal(h.calls.attaches.length, 0)
    assert.equal(h.calls.followups.length, 0)
  })

  test('a live fixed-id agent with different actual config is held before followup', async () => {
    const h = harness({ live: true })
    h.agent.options.model = 'other-model'
    const result = await createRedlineSessionControl(h.ctx).start(request())
    assert.deepEqual(result, { ok: false, state: 'unknown', cause: 'carrier-config-mismatch' })
    assert.equal(h.calls.followups.length, 0)
  })

  test('attaches to the workspace and starts title rename without waiting for it', async () => {
    const never = new Promise<never>(() => {})
    const h = harness({ live: true, titleResult: never })
    const result = await Promise.race([
      createRedlineSessionControl(h.ctx).start(request()),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 50)),
    ])
    assert.notEqual(result, 'timed-out')
    if (result !== 'timed-out' && result.ok) assert.equal(result.titleStatus, 'failed', 'Promise return violates the sync title contract')
    assert.deepEqual(h.calls.attaches, ['carrier-fixed-id'])
    assert.deepEqual(h.calls.renames, [{ session: h.agent.session, title: '↳ main1234 · continue the task' }])
  })

  test('serializes concurrent calls for one carrier and emits exactly one followup for the same request id', async () => {
    const h = harness({ live: true })
    const original = h.agent.followup.bind(h.agent)
    h.agent.followup = (message: unknown) => {
      original(message)
    }
    const control = createRedlineSessionControl(h.ctx)
    const [left, right] = await Promise.all([control.start(request()), control.start(request())])
    assert.equal(h.calls.followups.length, 1)
    assert.equal(left.ok, true)
    assert.equal(right.ok, true)
    if (!left.ok || !right.ok) assert.fail('both concurrent calls must succeed')
    assert.deepEqual([left.delivery, right.delivery].sort(), ['already-present', 'sent'])
    assert.deepEqual(sourceOf(h.calls.followups[0]), { kind: 'user', rpcId: 'prompt-request-1' })
  })

  test('same request id with different persisted bytes is a conflict and is never accepted or resent', async () => {
    const h = harness({ persisted: true })
    h.setRead(async () => ({
      session: { id: 'carrier-fixed-id' },
      events: [{ type: 'user/message', data: { role: 'user', id: 'message-1', content: [{ type: 'text', text: 'old' }], source: { kind: 'user', rpcId: 'prompt-request-1' } } }],
    }))
    const result = await createRedlineSessionControl(h.ctx).start(request())
    assert.deepEqual(result, { ok: false, state: 'unknown', cause: 'prompt-request-id-content-conflict' })
    assert.equal(h.calls.followups.length, 0)
  })

  test('recognizes only exact frozen bytes in a persisted cold log', async () => {
    const h = harness({ persisted: true })
    h.setRead(async () => ({
      session: { id: 'carrier-fixed-id' },
      events: [{ type: 'user/message', data: { role: 'user', id: 'message-1', content: [{ type: 'text', text: 'VERBATIM migrated context' }], source: { kind: 'user', rpcId: 'prompt-request-1' } } }],
    }))
    const result = await createRedlineSessionControl(h.ctx).start(request())
    assert.equal(result.ok, true)
    if (!result.ok) assert.fail('expected exact persisted message')
    assert.equal(result.delivery, 'already-present')
    assert.equal(h.calls.followups.length, 0)
  })

  test('a historical inbox insertion removed before entry does not suppress the only send', async () => {
    const h = harness({ persisted: true })
    const old = { role: 'user', id: 'old-message', content: [{ type: 'text', text: 'VERBATIM migrated context' }], source: { kind: 'user', rpcId: 'prompt-request-1' } }
    let reads = 0
    h.setRead(async () => {
      reads += 1
      return reads === 1
        ? { session: { id: 'carrier-fixed-id' }, events: [
          { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [old] } },
          { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
        ] }
        : { session: { id: 'carrier-fixed-id' }, events: [{ type: 'user/message', data: { message: h.calls.followups[0] } }] }
    })
    const result = await createRedlineSessionControl(h.ctx).start(request())
    assert.equal(result.ok, true)
    assert.equal(h.calls.followups.length, 1, 'removed historical inbox input is absent, so the fixed-id send occurs')
  })

  test('a canceled inbox splice does not remain falsely active in cold dedupe', async () => {
    const h = harness({ persisted: true })
    const old = { role: 'user', id: 'old-message', content: [{ type: 'text', text: 'VERBATIM migrated context' }], source: { kind: 'user', rpcId: 'prompt-request-1' } }
    let reads = 0
    h.setRead(async () => {
      reads += 1
      return reads === 1
        ? { session: { id: 'carrier-fixed-id' }, events: [
          { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [old] } },
          { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } },
        ] }
        : { session: { id: 'carrier-fixed-id' }, events: [{ type: 'user/message', data: { message: h.calls.followups[0] } }] }
    })
    const result = await createRedlineSessionControl(h.ctx).start(request())
    assert.equal(result.ok, true)
    assert.equal(h.calls.followups.length, 1)
  })

  test('after followup requires flush and exact cold persistence rather than trusting live inbox', async () => {
    const h = harness({ live: true })
    const order: string[] = []
    h.ctx.sessions.flush = async () => { order.push('flush'); return true }
    h.setRead(async () => { order.push('cold-read'); return { session: { id: 'carrier-fixed-id' }, events: [] } })
    const result = await createRedlineSessionControl(h.ctx).start(request())
    assert.deepEqual(result, { ok: false, state: 'unknown', cause: 'prompt-not-persisted' })
    assert.deepEqual(order, ['cold-read', 'flush', 'cold-read'])
    assert.equal(h.calls.reads.length, 2)
  })
})
