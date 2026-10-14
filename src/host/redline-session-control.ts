/** Public-service bridge for ordinary zero-history root carrier sessions. */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export interface CarrierAgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
}

interface CarrierUserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly unknown[]
  readonly source: { readonly kind: string; readonly rpcId?: string }
}

export interface CarrierAgent {
  readonly id: string
  readonly session: { readonly id: string }
  readonly options?: CarrierAgentOptions
  readonly ctx?: unknown
  readonly inbox: { readonly nextTurn: readonly unknown[]; readonly nextStep: readonly unknown[] }
  followup(message: unknown): void
  whenIdle?(): Promise<void>
}

interface CarrierAgentHandle { readonly agent: CarrierAgent; dispose(): Promise<void> }

export interface CarrierSessionControlContext {
  readonly agents: {
    get(id: string): CarrierAgent | undefined
    create(options: Record<string, unknown>): Promise<CarrierAgentHandle>
    resume(options: Record<string, unknown>): Promise<CarrierAgentHandle>
  }
  readonly agentPresets: {
    mount(agentCtx: unknown, preset: string): Promise<unknown>
    resolve?(preset: string): Promise<{ readonly broken?: string }>
    composedPreset?(agentCtx: unknown): string | undefined
  }
  readonly sessionQuery: { readSession(id: string): Promise<unknown> }
  readonly workspaceRegistry: { get(id: string): { readonly path?: string; attachSession(id: string): Promise<void> } | undefined }
  readonly sessionTitle: { rename(session: unknown, title: string): unknown }
  readonly sessions: { flush(session: unknown): Promise<boolean> }
}

export interface CarrierSessionRequest {
  readonly carrierId: string
  readonly cwd: string
  readonly agentPreset: string
  readonly agentOptions: CarrierAgentOptions
  readonly workspaceId: string
  readonly title: string
  readonly promptRequestId: string
  readonly promptText: string
}

export interface CarrierReturnRequest {
  readonly sessionId: string
  readonly agentPreset: string
  readonly agentOptions: CarrierAgentOptions
  readonly requestId: string
  readonly text: string
}

export type CarrierDeliveryResult =
  | { readonly ok: true; readonly delivery: 'sent' | 'already-present'; readonly messageId: string; readonly flushed: boolean }
  | { readonly ok: false; readonly state: 'unknown'; readonly cause: string }

export type CarrierStartResult =
  | {
    readonly ok: true
    readonly mode: 'live' | 'created' | 'resumed'
    readonly delivery: 'sent' | 'already-present'
    readonly messageId: string
    readonly flushed: boolean
    readonly titleStatus: 'succeeded' | 'failed'
  }
  | { readonly ok: false; readonly state: 'unknown'; readonly cause: string }

function codeOf(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function messageIdOf(value: unknown): string | undefined {
  return value !== null && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
    ? (value as { id: string }).id
    : undefined
}

function rpcIdOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const source = (value as { source?: unknown }).source
  return source !== null && typeof source === 'object' && typeof (source as { rpcId?: unknown }).rpcId === 'string'
    ? (source as { rpcId: string }).rpcId
    : undefined
}

function logMessages(snapshot: unknown): unknown[] {
  if (snapshot === null || typeof snapshot !== 'object') return []
  const events = (snapshot as { events?: unknown }).events
  if (!Array.isArray(events)) return []
  const entered: unknown[] = []
  const inbox: Record<'next-turn' | 'next-step', unknown[]> = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const bag = event as { type?: unknown; data?: unknown }
    const data = bag.data
    if (data === null || typeof data !== 'object') continue
    const record = data as Record<string, unknown>
    if (bag.type === 'user/message') entered.push(record.message ?? data)
    if (bag.type === 'agent/inbox/spliced') {
      const target = record.target === 'next-turn' || record.target === 'next-step' ? record.target : null
      if (target === null) continue
      const queue = inbox[target]
      const start = typeof record.start === 'number' && Number.isSafeInteger(record.start) ? record.start : queue.length
      const removedCount = typeof record.removedCount === 'number' && Number.isSafeInteger(record.removedCount) ? record.removedCount : 0
      const inserted: unknown[] = Array.isArray(record.inserted) ? record.inserted as unknown[] : []
      queue.splice(start, removedCount, ...inserted)
    }
  }
  return [...entered, ...inbox['next-step'], ...inbox['next-turn']]
}

type MessageMatch = { readonly kind: 'absent' } | { readonly kind: 'exact'; readonly id: string } | { readonly kind: 'conflict' }

function exactUserText(message: unknown, expectedText: string): boolean {
  if (message === null || typeof message !== 'object') return false
  const bag = message as { role?: unknown; content?: unknown }
  if (bag.role !== 'user' || !Array.isArray(bag.content) || bag.content.length !== 1) return false
  const content = bag.content as unknown[]
  const block = content[0]
  return block !== null && typeof block === 'object'
    && (block as { type?: unknown }).type === 'text'
    && (block as { text?: unknown }).text === expectedText
}

function classifyMessages(messages: readonly unknown[], requestId: string, expectedText: string): MessageMatch {
  let exactId: string | undefined
  for (const message of messages) {
    if (rpcIdOf(message) !== requestId) continue
    const id = messageIdOf(message)
    if (id === undefined || !exactUserText(message, expectedText)) return { kind: 'conflict' }
    exactId = id
  }
  return exactId === undefined ? { kind: 'absent' } : { kind: 'exact', id: exactId }
}

function coldMatch(snapshot: unknown, requestId: string, expectedText: string): MessageMatch {
  return classifyMessages(logMessages(snapshot), requestId, expectedText)
}

function inboxMatch(agent: CarrierAgent, requestId: string, expectedText: string): MessageMatch {
  return classifyMessages([...agent.inbox.nextStep, ...agent.inbox.nextTurn], requestId, expectedText)
}

function failureCause(error: unknown): string {
  return codeOf(error) ?? (error instanceof Error ? error.message : String(error))
}

/** One controller owns live handles and per-carrier critical sections. */
export function createRedlineSessionControl(ctx: CarrierSessionControlContext) {
  const handles = new Map<string, CarrierAgentHandle>()
  const locks = new Map<string, Promise<void>>()

  const locked = async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    const previous = locks.get(id) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    locks.set(id, tail)
    await previous
    try { return await operation() } finally {
      release()
      if (locks.get(id) === tail) locks.delete(id)
    }
  }

  const start = async (request: CarrierSessionRequest): Promise<CarrierStartResult> => await locked(request.carrierId, async () => {
    let agent = ctx.agents.get(SessionId(request.carrierId))
    let mode: 'live' | 'created' | 'resumed' = 'live'
    let presenceSnapshot: unknown

    if (agent === undefined) {
      try {
        presenceSnapshot = await ctx.sessionQuery.readSession(SessionId(request.carrierId))
        mode = 'resumed'
      } catch (error) {
        if (codeOf(error) !== 'SESSION_QUERY_SESSION_NOT_FOUND') {
          return { ok: false, state: 'unknown', cause: failureCause(error) }
        }
        mode = 'created'
      }

      if (ctx.agentPresets.resolve !== undefined) {
        const preset = await ctx.agentPresets.resolve(request.agentPreset)
        if (preset.broken !== undefined) return { ok: false, state: 'unknown', cause: `preset-broken:${preset.broken}` }
      }
      const setup = async (agentCtx: unknown): Promise<void> => {
        await ctx.agentPresets.mount(agentCtx, request.agentPreset)
      }
      const handle = mode === 'created'
        ? await ctx.agents.create({
          sessionId: SessionId(request.carrierId),
          meta: { cwd: request.cwd, agentPreset: request.agentPreset },
          agentOptions: request.agentOptions,
          setup,
        })
        : await ctx.agents.resume({
          resumeSessionId: SessionId(request.carrierId),
          agentOptions: request.agentOptions,
          setup,
        })
      handles.set(request.carrierId, handle)
      agent = handle.agent
    }

    const actual = agent.options
    if (actual === undefined || actual.provider !== request.agentOptions.provider || actual.model !== request.agentOptions.model
      || actual.reasoningEffort !== request.agentOptions.reasoningEffort
      || (request.agentOptions.maxTokens !== undefined && actual.maxTokens !== request.agentOptions.maxTokens)) {
      return { ok: false, state: 'unknown', cause: 'carrier-config-mismatch' }
    }
    if (ctx.agentPresets.composedPreset !== undefined && agent.ctx !== undefined
      && ctx.agentPresets.composedPreset(agent.ctx) !== request.agentPreset) {
      return { ok: false, state: 'unknown', cause: 'carrier-preset-mismatch' }
    }

    const workspace = ctx.workspaceRegistry.get(request.workspaceId)
    if (workspace === undefined) return { ok: false, state: 'unknown', cause: 'workspace-not-found' }
    if (workspace.path !== undefined && workspace.path !== request.cwd) {
      return { ok: false, state: 'unknown', cause: 'workspace-path-mismatch' }
    }
    try { await workspace.attachSession(SessionId(request.carrierId)) } catch (error) {
      return { ok: false, state: 'unknown', cause: `workspace-attach-failed:${request.carrierId}:${failureCause(error)}` }
    }

    let titleStatus: 'succeeded' | 'failed' = 'succeeded'
    try {
      const returned = ctx.sessionTitle.rename(agent.session, request.title)
      // Public 0.2.1 contract is synchronous. A Promise means a nonconforming adapter; do not claim success.
      if (returned instanceof Promise) { titleStatus = 'failed'; void returned.catch(() => undefined) }
    } catch { titleStatus = 'failed' }

    const before = presenceSnapshot ?? await ctx.sessionQuery.readSession(SessionId(request.carrierId))
    const persisted = coldMatch(before, request.promptRequestId, request.promptText)
    if (persisted.kind === 'conflict') return { ok: false, state: 'unknown', cause: 'prompt-request-id-content-conflict' }
    if (persisted.kind === 'exact') {
      return { ok: true, mode, delivery: 'already-present', messageId: persisted.id, flushed: false, titleStatus }
    }
    const queued = inboxMatch(agent, request.promptRequestId, request.promptText)
    if (queued.kind === 'conflict') return { ok: false, state: 'unknown', cause: 'prompt-request-id-content-conflict' }
    if (queued.kind === 'exact') {
      const flushed = await ctx.sessions.flush(agent.session)
      if (!flushed) return { ok: false, state: 'unknown', cause: 'prompt-flush-unconfirmed' }
      const after = await ctx.sessionQuery.readSession(SessionId(request.carrierId))
      const cold = coldMatch(after, request.promptRequestId, request.promptText)
      if (cold.kind !== 'exact') return { ok: false, state: 'unknown', cause: cold.kind === 'conflict' ? 'prompt-request-id-content-conflict' : 'prompt-not-persisted' }
      return { ok: true, mode, delivery: 'already-present', messageId: cold.id, flushed: true, titleStatus }
    }

    const message = createUserMessage({
      content: [{ type: 'text', text: request.promptText }],
      source: { kind: 'user', rpcId: request.promptRequestId } as never,
    }) as unknown as CarrierUserMessage
    agent.followup(message)
    const flushed = await ctx.sessions.flush(agent.session)
    if (!flushed) return { ok: false, state: 'unknown', cause: 'prompt-flush-unconfirmed' }
    const after = await ctx.sessionQuery.readSession(SessionId(request.carrierId))
    const cold = coldMatch(after, request.promptRequestId, request.promptText)
    if (cold.kind !== 'exact') return { ok: false, state: 'unknown', cause: cold.kind === 'conflict' ? 'prompt-request-id-content-conflict' : 'prompt-not-persisted' }
    return { ok: true, mode, delivery: 'sent', messageId: cold.id, flushed, titleStatus }
  })

  const deliverToSession = async (request: CarrierReturnRequest): Promise<CarrierDeliveryResult> =>
    await locked(`return:${request.sessionId}`, async () => {
      let agent = ctx.agents.get(SessionId(request.sessionId))
      let before: unknown
      if (agent === undefined) {
        try { before = await ctx.sessionQuery.readSession(SessionId(request.sessionId)) } catch (error) {
          return { ok: false, state: 'unknown', cause: failureCause(error) }
        }
        const setup = async (agentCtx: unknown): Promise<void> => {
          await ctx.agentPresets.mount(agentCtx, request.agentPreset)
        }
        const handle = await ctx.agents.resume({
          resumeSessionId: SessionId(request.sessionId),
          agentOptions: request.agentOptions,
          setup,
        })
        handles.set(request.sessionId, handle)
        agent = handle.agent
      }
      before ??= await ctx.sessionQuery.readSession(SessionId(request.sessionId))
      const persisted = coldMatch(before, request.requestId, request.text)
      if (persisted.kind === 'conflict') return { ok: false, state: 'unknown', cause: 'return-request-id-content-conflict' }
      if (persisted.kind === 'exact') return { ok: true, delivery: 'already-present', messageId: persisted.id, flushed: false }
      const queued = inboxMatch(agent, request.requestId, request.text)
      if (queued.kind === 'conflict') return { ok: false, state: 'unknown', cause: 'return-request-id-content-conflict' }
      if (queued.kind === 'exact') {
        const flushed = await ctx.sessions.flush(agent.session)
        if (!flushed) return { ok: false, state: 'unknown', cause: 'return-flush-unconfirmed' }
        const after = await ctx.sessionQuery.readSession(SessionId(request.sessionId))
        const cold = coldMatch(after, request.requestId, request.text)
        if (cold.kind !== 'exact') return { ok: false, state: 'unknown', cause: cold.kind === 'conflict' ? 'return-request-id-content-conflict' : 'return-not-persisted' }
        return { ok: true, delivery: 'already-present', messageId: cold.id, flushed: true }
      }
      const message = createUserMessage({
        content: [{ type: 'text', text: request.text }],
        source: { kind: 'user', rpcId: request.requestId } as never,
      }) as unknown as CarrierUserMessage
      agent.followup(message)
      const flushed = await ctx.sessions.flush(agent.session)
      if (!flushed) return { ok: false, state: 'unknown', cause: 'return-flush-unconfirmed' }
      const after = await ctx.sessionQuery.readSession(SessionId(request.sessionId))
      const cold = coldMatch(after, request.requestId, request.text)
      if (cold.kind !== 'exact') return { ok: false, state: 'unknown', cause: cold.kind === 'conflict' ? 'return-request-id-content-conflict' : 'return-not-persisted' }
      return { ok: true, delivery: 'sent', messageId: cold.id, flushed }
    })

  const dispose = async (): Promise<void> => {
    const active = [...handles.values()]
    handles.clear()
    await Promise.allSettled(active.map(async (handle) => { await handle.dispose() }))
  }

  return { start, deliverToSession, dispose, handles }
}

const serviceControls = new WeakMap<object, ReturnType<typeof createRedlineSessionControl>>()

function service(ctx: Context, name: string): unknown {
  return (ctx as unknown as { get(key: string): unknown }).get(name)
}

/** Adapter for a real Cordis context. It does no one-time service caching. */
export function contextCarrierServices(ctx: Context): CarrierSessionControlContext {
  const agents = service(ctx, 'agents')
  const agentPresets = service(ctx, 'agentPresets')
  const sessionQuery = service(ctx, 'sessionQuery')
  const workspaceRegistry = service(ctx, 'workspaceRegistry')
  const sessionTitle = service(ctx, 'sessionTitle')
  const sessions = service(ctx, 'sessions')
  if (agents === undefined || agentPresets === undefined || sessionQuery === undefined
    || workspaceRegistry === undefined || sessionTitle === undefined || sessions === undefined) {
    throw new Error('carrier services are not composed')
  }
  return {
    agents: agents as CarrierSessionControlContext['agents'],
    agentPresets: agentPresets as CarrierSessionControlContext['agentPresets'],
    sessionQuery: sessionQuery as CarrierSessionControlContext['sessionQuery'],
    workspaceRegistry: workspaceRegistry as CarrierSessionControlContext['workspaceRegistry'],
    sessionTitle: sessionTitle as CarrierSessionControlContext['sessionTitle'],
    sessions: sessions as CarrierSessionControlContext['sessions'],
  }
}

/** One controller per shared AgentRegistry so route and recovery child contexts share locks and AgentHandle ownership. */
export function redlineSessionControlFor(ctx: Context) {
  const services = contextCarrierServices(ctx)
  const key = services.agents as object
  const existing = serviceControls.get(key)
  if (existing !== undefined) return existing
  const control = createRedlineSessionControl(services)
  serviceControls.set(key, control)
  return control
}
