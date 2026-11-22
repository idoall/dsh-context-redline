import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, inject, name } from '../../src/host/index'
import { REDLINE_ERROR } from '../../src/shared/redline-errors'
import { REDLINE_CHANNEL_ROUTE } from '../../src/shared/redline-route'

interface CapturedRoute {
  readonly path: string
  readonly methods: readonly string[]
  fetch(request: Request): Promise<Response>
}

interface SurfaceEvent {
  readonly seq: number
  readonly type: string
  readonly data: Record<string, unknown>
}

interface CarrierAgent {
  readonly id: string
  readonly session: { readonly id: string }
  readonly options: Record<string, unknown>
  readonly ctx: { readonly preset: string }
  readonly inbox: { readonly nextTurn: unknown[]; readonly nextStep: unknown[] }
  followup(message: unknown): void
}

interface CarrierOps {
  readonly ctx: Context
  readonly channel: CapturedRoute
  readonly sessionId: string
  readonly creates: Record<string, unknown>[]
  readonly resumes: Record<string, unknown>[]
  readonly mounts: { receiver: unknown; agentCtx: unknown; preset: string }[]
  readonly attachments: string[]
  readonly followups: unknown[]
  readonly flushes: unknown[]
  readonly sourceAgent: {
    readonly options: Record<string, unknown>
    readonly session: { readonly id: string; readonly header: { readonly cwd: string; readonly agentPreset: string } }
  }
  setSurface(events: readonly SurfaceEvent[], capturedThroughSeq: number | null): void
  readonly runtimeContexts: Record<string, unknown>[]
}

const plugin = { name, inject, apply } as never
const homes: string[] = []

const ORIGINAL_USER = '用户原话：保留完整上下文。'
const ORIGINAL_ASSISTANT = '助手原话：逐字执行并报告结果。'
const EDITED_USER = '用户改稿：只带这一版。'
const WORKSPACE_PATH = '/workspace/carrier-route-spec'

function textOfMessage(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const first = content.at(0)
  return first !== null && typeof first === 'object' && typeof (first as { text?: unknown }).text === 'string'
    ? (first as { text: string }).text
    : undefined
}

function requestIdOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const source = (value as { source?: unknown }).source
  return source !== null && typeof source === 'object' && typeof (source as { rpcId?: unknown }).rpcId === 'string'
    ? (source as { rpcId: string }).rpcId
    : undefined
}

function messageIdOf(value: unknown): string | undefined {
  return value !== null && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
    ? (value as { id: string }).id
    : undefined
}

function sourceEvents(): SurfaceEvent[] {
  return [
    { seq: 11, type: 'user/message', data: { content: [{ type: 'text', text: ORIGINAL_USER }] } },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: ORIGINAL_ASSISTANT }] } } },
  ]
}

function notFound(): Error & { code: string } {
  return Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
}

async function boot(): Promise<CarrierOps> {
  const home = mkdtempSync(join(tmpdir(), 'redline-carrier-route-'))
  homes.push(home)
  const ctx = new Context()
  const routes: CapturedRoute[] = []
  const creates: Record<string, unknown>[] = []
  const resumes: Record<string, unknown>[] = []
  const mounts: { receiver: unknown; agentCtx: unknown; preset: string }[] = []
  const attachments: string[] = []
  const followups: unknown[] = []
  const flushes: unknown[] = []
  const carrierAgents = new Map<string, CarrierAgent>()
  const carrierLogs = new Map<string, unknown[]>()
  const runtimeContexts: Record<string, unknown>[] = []
  let surface: readonly SurfaceEvent[] = sourceEvents()
  let capturedThroughSeq: number | null = 12

  ctx.provide('connection', {
    fetch: { register(route: CapturedRoute) { routes.push(route); return () => {} } },
  })
  ctx.provide('dshHomePath', (...segments: string[]) => join(home, ...segments))

  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const sourceSession = ctx.sessions.create()
  const sourceAgent = {
    options: { provider: 'provider-exact', model: 'model-exact', reasoningEffort: 'high' },
    session: { id: sourceSession.id, header: { cwd: WORKSPACE_PATH, agentPreset: 'preset-exact' } },
  }

  ctx.provide('sessionQuery', {
    async listEvents(id: string) {
      if (id !== sourceSession.id) throw notFound()
      return [{ type: 'turn/start' }, { type: 'turn/end' }]
    },
    async readSurface(id: string) {
      if (id !== sourceSession.id) throw notFound()
      return {
        session: { id },
        inheritedEventCount: 0,
        capturedThroughSeq,
        events: structuredClone(surface),
      }
    },
    async readSession(id: string) {
      const events = carrierLogs.get(id)
      if (events === undefined) throw notFound()
      return { session: { id }, events: structuredClone(events) }
    },
    async readEvent(request: { sessionId: string; seq: number }) {
      const target = request.sessionId === sourceSession.id ? surface.find(event => event.seq === request.seq) : undefined
      return { session: { id: request.sessionId }, inheritedEventCount: 0, target, events: [], startSeq: request.seq, endSeq: request.seq }
    },
  })

  ctx.provide('llm', {
    listProviders() { return [{ id: 'provider-exact', name: 'Exact Provider' }, { id: 'provider-alt', name: 'Alternate Provider' }] },
    async listModels(provider: string) {
      return provider === 'provider-alt'
        ? [{ provider, id: 'model-alt', name: 'Alternate Model' }]
        : [{ provider, id: 'model-exact', name: 'Exact Model' }]
    },
    async resolveModelInfo(provider: string, model: string) {
      if (provider === 'provider-alt' && model === 'model-alt') {
        return { provider, id: model, name: 'Alternate Model', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }
      }
      if (provider === 'provider-exact' && model === 'model-exact') return { provider, id: model, name: 'Exact Model' }
      throw new Error('unknown model')
    },
  })

  ctx.provide('agentPresets', {
    async resolve(preset: string) { return { id: preset } },
    async mount(agentCtx: unknown, preset: string) {
      mounts.push({ receiver: this, agentCtx, preset })
      return { id: preset }
    },
    composedPreset(agentCtx: unknown) { return (agentCtx as { preset?: string }).preset },
  })
  ctx.provide('workspaceRegistry', {
    async resolveByPath(path: string) {
      return path === WORKSPACE_PATH ? { id: 'workspace-exact', path } : undefined
    },
    get(id: string) {
      if (id !== 'workspace-exact') return undefined
      return {
        path: WORKSPACE_PATH,
        async attachSession(sessionId: string) { attachments.push(sessionId) },
      }
    },
  })
  ctx.provide('sessionTitle', { rename() { return undefined } })
  const systemPrompt = { context(contribution: Record<string, unknown>) { runtimeContexts.push(contribution); return () => {} } }
  ctx.provide('systemPrompt', systemPrompt)
  ctx.provide('agents', {
    get(id: string) {
      if (id === sourceSession.id) return sourceAgent
      return carrierAgents.get(id)
    },
    async create(options: Record<string, unknown>) {
      creates.push(options)
      const id = String(options.sessionId)
      const meta = options.meta as { agentPreset?: unknown }
      const agent: CarrierAgent = {
        id,
        session: { id },
        options: options.agentOptions as Record<string, unknown>,
        ctx: { preset: String(meta.agentPreset) },
        inbox: { nextTurn: [], nextStep: [] },
        followup(message: unknown) {
          followups.push(message)
          agent.inbox.nextTurn.push(message)
          carrierLogs.get(id)?.push({ type: 'user/message', data: { message } })
        },
      }
      carrierLogs.set(id, [])
      const setup = options.setup
      assert.equal(typeof setup, 'function')
      await (setup as (agentCtx: unknown) => Promise<void>)({ scope: 'carrier-created', systemPrompt })
      carrierAgents.set(id, agent)
      return { agent, async dispose() {} }
    },
    async resume(options: Record<string, unknown>) {
      resumes.push(options)
      throw new Error('carrier route spec did not expect resume')
    },
  })

  const sessions = ctx.sessions as unknown as { flush(session: unknown): Promise<boolean> }
  sessions.flush = async (session: unknown) => { flushes.push(session); return true }

  await ctx.plugin(plugin, {} as never)
  const channel = routes.find(route => route.path === REDLINE_CHANNEL_ROUTE)
  assert.ok(channel !== undefined, 'the real host plugin registered its redline route')
  return {
    ctx,
    channel,
    sessionId: sourceSession.id,
    creates,
    resumes,
    mounts,
    attachments,
    followups,
    flushes,
    sourceAgent,
    runtimeContexts,
    setSurface(events, nextCapturedThroughSeq) {
      surface = structuredClone(events)
      capturedThroughSeq = nextCapturedThroughSeq
    },
  }
}

async function call(ops: CarrierOps, body: unknown): Promise<Record<string, unknown>> {
  const response = await ops.channel.fetch(new Request(`http://dsh.test${REDLINE_CHANNEL_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  assert.equal(response.status, 200)
  return await response.json() as Record<string, unknown>
}

function value(reply: Record<string, unknown>): Record<string, unknown> {
  assert.equal(reply.ok, true, JSON.stringify(reply))
  return reply.value as Record<string, unknown>
}

function code(reply: Record<string, unknown>): string {
  assert.equal(reply.ok, false, JSON.stringify(reply))
  return (reply.error as { code: string }).code
}

async function plan(ops: CarrierOps, humanTask = '继续完成当前任务', anchor?: string): Promise<Record<string, unknown>> {
  return value(await call(ops, { op: 'carrier.plan', sessionId: ops.sessionId, humanTask, ...(anchor === undefined ? {} : { anchor }) }))
}

async function saveUserEdit(ops: CarrierOps, text: string): Promise<void> {
  const reply = await call(ops, {
    op: 'draft.update',
    sessionId: ops.sessionId,
    seq: 11,
    edit: { text, reasoning: '', isError: false },
  })
  assert.equal(reply.ok, true, JSON.stringify(reply))
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('carrier.plan through the real host plugin route', () => {
  test('preview reads the current model selection, not stale startup options', async () => {
    const ops = await boot()
    Object.assign(ops.sourceAgent, { model: { current: () => ({ provider: 'provider-alt', model: 'model-alt' }) } })
    const preview = await plan(ops)
    assert.deepEqual(preview.config, { agentPreset: 'preset-exact', provider: 'provider-alt', model: 'model-alt' })
    assert.equal(ops.sourceAgent.options.reasoningEffort, 'high', 'source options are never mutated')
    assert.equal(ops.creates.length, 0)
  })

  test('preview uses the selected preset rather than the immutable creation header', async () => {
    const ops = await boot()
    Object.assign(ops.ctx.get('agentPresets') as object, { presetForSession: () => 'preset-selected' })
    const preview = await plan(ops)
    assert.equal((preview.config as { agentPreset: string }).agentPreset, 'preset-selected')
    assert.equal(ops.sourceAgent.session.header.agentPreset, 'preset-exact')
    assert.equal(ops.creates.length, 0)
  })

  test('an unresolved authoritative preset never revives the creation preset', async () => {
    const ops = await boot()
    Object.assign(ops.ctx.get('agentPresets') as object, { presetForSession: () => null })
    const response = await call(ops, { op: 'carrier.plan', sessionId: ops.sessionId, humanTask: 'check' })
    assert.equal(response.ok, false)
    assert.equal(ops.creates.length, 0)
  })

  test('an unavailable current selection does not fall back to stale options', async () => {
    const ops = await boot()
    Object.assign(ops.sourceAgent, { model: { current: () => undefined } })
    const response = await call(ops, { op: 'carrier.plan', sessionId: ops.sessionId, humanTask: 'check' })
    assert.equal(response.ok, false)
    assert.equal(ops.creates.length, 0)
  })

  test('returns one opaque confirmation token, exactly five items, and a full role-labelled prompt', async () => {
    const ops = await boot()
    const preview = await plan(ops)
    assert.equal((preview.items as unknown[]).length, 5)
    assert.equal(typeof preview.draftRevision, 'string')
    assert.ok(String(preview.draftRevision).length > 40, 'confirmation is an opaque nontrivial token')
    assert.equal(String(preview.draftRevision).includes('redline-op-'), false, 'wire token does not expose operation identity')
    const prompt = String(preview.prompt)
    assert.ok(prompt.includes(ORIGINAL_USER), 'full user text is present')
    assert.ok(prompt.includes(ORIGINAL_ASSISTANT), 'full assistant text is present')
    assert.ok(prompt.includes('原角色：user'), 'user role is preserved as an explicit source label')
    assert.ok(prompt.includes('原角色：assistant'), 'assistant role is preserved as an explicit source label')
    assert.deepEqual(preview.carriedSeqs, [11, 12])
    assert.equal(ops.creates.length, 0, 'preview is read-only')
  })

  test('an empty source session still plans a human-only zero-history carrier', async () => {
    const ops = await boot()
    ops.setSurface([], null)
    const preview = await plan(ops, '只执行这句任务')
    assert.equal(preview.prompt, '只执行这句任务')
    assert.deepEqual(preview.carriedSeqs, [])
  })

  test('lists selectable models and reasoning efforts without changing the source session', async () => {
    const ops = await boot()
    const reply = value(await call(ops, { op: 'carrier.models' }))
    assert.deepEqual(reply.models, [
      { provider: 'provider-exact', providerName: 'Exact Provider', model: 'model-exact', modelName: 'Exact Model', efforts: [] },
      { provider: 'provider-alt', providerName: 'Alternate Provider', model: 'model-alt', modelName: 'Alternate Model', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
    ])
    assert.equal(ops.creates.length, 0)
    assert.equal(ops.followups.length, 0)
  })

  test('a source message with text plus image keeps its text and clearly reports the omitted image', async () => {
    const ops = await boot()
    ops.setSurface([
      { seq: 21, type: 'user/message', data: { content: [
        { type: 'text', text: '保留这段图片说明' },
        { type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png', bytes: 12, width: 1, height: 1 } },
      ] } },
    ], 21)
    const preview = await plan(ops, '继续处理')
    assert.ok(String(preview.prompt).includes('保留这段图片说明'))
    assert.ok((preview.items as { label: string; text: string }[]).some(item => item.text.includes('图片 1 个未迁移')))
    assert.equal(ops.creates.length, 0)
  })

  test('a locally deleted row is completely absent from delivery text', async () => {
    const ops = await boot()
    const deleted = await call(ops, { op: 'draft.exclude', sessionId: ops.sessionId, seq: 11, excluded: true })
    assert.equal(deleted.ok, true, JSON.stringify(deleted))
    const preview = await plan(ops)
    const prompt = String(preview.prompt)
    assert.equal(prompt.includes(ORIGINAL_USER), false)
    assert.equal(prompt.includes('#11'), false)
    assert.equal(prompt.includes('不要采用'), false)
    assert.deepEqual(preview.excludedSeqs, [11])
    assert.deepEqual(preview.carriedSeqs, [12])
  })
})

describe('carrier.start through the real host plugin route', () => {
  test('creates the exact ordinary root, mounts its preset, attaches its workspace, and sends the frozen preview bytes', async () => {
    const ops = await boot()
    const preview = await plan(ops)
    const prompt = String(preview.prompt)
    const started = value(await call(ops, {
      op: 'carrier.start',
      sessionId: ops.sessionId,
      humanTask: '继续完成当前任务',
      confirmationToken: preview.draftRevision,
    }))

    assert.equal(ops.creates.length, 1)
    const create = ops.creates[0]!
    assert.deepEqual(Object.keys(create).sort(), ['agentOptions', 'meta', 'sessionId', 'setup'])
    for (const forbidden of ['parent', 'parentSession', 'seed', 'origin']) assert.equal(Object.hasOwn(create, forbidden), false, forbidden)
    assert.deepEqual(create.meta, { cwd: WORKSPACE_PATH, agentPreset: 'preset-exact' })
    assert.deepEqual(create.agentOptions, ops.sourceAgent.options)
    assert.equal(ops.resumes.length, 0)
    assert.equal(ops.mounts.length, 1)
    assert.equal(ops.mounts[0]!.preset, 'preset-exact')
    assert.deepEqual(ops.attachments, [started.carrierId])
    assert.equal(ops.followups.length, 1)
    assert.equal(textOfMessage(ops.followups[0]), prompt, 'delivered bytes equal the reviewed preview')
    assert.equal(started.prompt, prompt)
    assert.equal(started.via, 'ordinary-session')
    assert.equal(ops.flushes.length, 1)
  })

  test('freezes the edited final bytes and selected model only into the new session', async () => {
    const ops = await boot()
    const preview = await plan(ops, '原任务')
    const finalText = '用户直接编辑后的完整第一句话\n不再重新拼接'
    const started = value(await call(ops, {
      op: 'carrier.start', sessionId: ops.sessionId, humanTask: '原任务',
      confirmationToken: preview.draftRevision, finalText,
      config: { provider: 'provider-alt', model: 'model-alt', reasoningEffort: 'high' },
    }))
    assert.equal(started.prompt, finalText)
    assert.equal(textOfMessage(ops.followups[0]), finalText)
    assert.deepEqual(ops.creates[0]?.agentOptions, { provider: 'provider-alt', model: 'model-alt', reasoningEffort: 'high' })
    assert.deepEqual(ops.sourceAgent.options, { provider: 'provider-exact', model: 'model-exact', reasoningEffort: 'high' }, 'source session config is untouched')
  })

  test('a model-default reasoning selection freezes the adapter default before the root is created', async () => {
    const ops = await boot()
    const preview = await plan(ops, '默认推理档')
    await call(ops, {
      op: 'carrier.start', sessionId: ops.sessionId, humanTask: '默认推理档',
      confirmationToken: preview.draftRevision, finalText: '最终全文',
      config: { provider: 'provider-alt', model: 'model-alt' },
    })
    assert.deepEqual(ops.creates[0]?.agentOptions, { provider: 'provider-alt', model: 'model-alt', reasoningEffort: 'low' })
  })

  test('refuses an unavailable model or reasoning effort before creating a session', async () => {
    for (const config of [
      { provider: 'missing', model: 'missing' },
      { provider: 'provider-alt', model: 'model-alt', reasoningEffort: 'impossible' },
    ]) {
      const ops = await boot()
      const preview = await plan(ops, '配置拒绝')
      const reply = await call(ops, {
        op: 'carrier.start', sessionId: ops.sessionId, humanTask: '配置拒绝',
        confirmationToken: preview.draftRevision, finalText: '最终全文', config,
      })
      assert.equal(code(reply), REDLINE_ERROR.badRequest)
      assert.equal(ops.creates.length, 0)
      assert.equal(ops.followups.length, 0)
    }
  })

  test('changing either the draft or source surface after preview rejects the old token before creation', async () => {
    const draftOps = await boot()
    const draftPreview = await plan(draftOps)
    await saveUserEdit(draftOps, EDITED_USER)
    const staleDraft = await call(draftOps, {
      op: 'carrier.start', sessionId: draftOps.sessionId, humanTask: '继续完成当前任务', confirmationToken: draftPreview.draftRevision,
    })
    assert.equal(code(staleDraft), REDLINE_ERROR.draftsChanged)
    assert.equal(draftOps.creates.length, 0)

    const surfaceOps = await boot()
    const surfacePreview = await plan(surfaceOps)
    surfaceOps.setSurface([
      ...sourceEvents(),
      { seq: 13, type: 'user/message', data: { content: [{ type: 'text', text: '预览之后的新内容' }] } },
    ], 13)
    const staleSurface = await call(surfaceOps, {
      op: 'carrier.start', sessionId: surfaceOps.sessionId, humanTask: '继续完成当前任务', confirmationToken: surfacePreview.draftRevision,
    })
    assert.equal(code(staleSurface), REDLINE_ERROR.draftsChanged)
    assert.equal(surfaceOps.creates.length, 0)
  })

  test('the confirmation token binds the reviewed human task, including empty-task refusal', async () => {
    const ops = await boot()
    const preview = await plan(ops, '任务 A')
    const changed = await call(ops, {
      op: 'carrier.start', sessionId: ops.sessionId, humanTask: '任务 B', confirmationToken: preview.draftRevision,
    })
    assert.equal(code(changed), REDLINE_ERROR.draftsChanged)
    const empty = await call(ops, {
      op: 'carrier.start', sessionId: ops.sessionId, humanTask: '   ', confirmationToken: preview.draftRevision,
    })
    assert.equal(code(empty), REDLINE_ERROR.emptyTask)
    assert.equal(ops.creates.length, 0)
  })

  test('retrying the same opaque token creates once and follows up exactly once', async () => {
    const ops = await boot()
    const preview = await plan(ops)
    const request = {
      op: 'carrier.start',
      sessionId: ops.sessionId,
      humanTask: '继续完成当前任务',
      confirmationToken: preview.draftRevision,
    }
    const first = value(await call(ops, request))
    const second = value(await call(ops, request))
    assert.equal(first.carrierId, second.carrierId)
    assert.equal(ops.creates.length, 1)
    assert.equal(ops.resumes.length, 0)
    assert.equal(ops.followups.length, 1)
    assert.ok((requestIdOf(ops.followups[0])?.length ?? 0) > 0, 'the single followup carries its stable request id')
    assert.equal((first.started as { messageId: string }).messageId, (second.started as { messageId: string }).messageId)
    assert.ok(messageIdOf(ops.followups[0]) !== undefined)
  })
})

describe('首尾锚点（0.2.0）', () => {
  const ANCHOR = '必须用 TypeScript；不要改公开接口。'

  test('锚点同时出现在首条消息开头与迁移内容之后，并列入确认项', async () => {
    const ops = await boot()
    const preview = await plan(ops, '继续完成当前任务', ANCHOR)
    const prompt = String(preview.prompt)
    assert.ok(prompt.startsWith(`继续完成当前任务\n\n【锚点】\n${ANCHOR}\n\n`))
    assert.ok(prompt.endsWith(`【锚点重申】\n${ANCHOR}`))
    assert.equal(prompt.split(ANCHOR).length - 1, 2)
    const item = (preview.items as { label: string, text: string }[]).find(entry => entry.label === '锚点（首尾各一次）')
    assert.equal(item?.text, ANCHOR)
    assert.equal(ops.creates.length, 0, 'preview remains read-only')
  })

  test('锚点变化使旧确认失效，不误用旧令牌创建', async () => {
    const ops = await boot()
    const preview = await plan(ops, '原任务', '锚点 A')
    const refused = await call(ops, {
      op: 'carrier.start', sessionId: ops.sessionId, humanTask: '原任务', anchor: '锚点 B',
      confirmationToken: preview.draftRevision,
    })
    assert.equal(refused.ok, false)
    assert.equal((refused.error as { code: string }).code, 'redline/drafts-changed')
    assert.equal(ops.creates.length, 0)
    assert.equal(ops.followups.length, 0)
  })

  test('确认后按同一锚点冻结首尾字节', async () => {
    const ops = await boot()
    const preview = await plan(ops, '继续', ANCHOR)
    const started = value(await call(ops, {
      op: 'carrier.start', sessionId: ops.sessionId, humanTask: '继续', anchor: ANCHOR,
      confirmationToken: preview.draftRevision,
    }))
    const delivered = textOfMessage(ops.followups[0])
    assert.equal(delivered, String(preview.prompt))
    assert.ok(delivered?.endsWith(`【锚点重申】\n${ANCHOR}`))
    assert.equal(started.prompt, delivered)
  })
})

describe('运行时规则模式（0.3.0）', () => {
  const ANCHOR = '保持用户意图优先级；所有修改必须做过有头 UAT。'

  test('运行时模式不把锚点写进首条消息，确认项改为运行时规则', async () => {
    const ops = await boot()
    const preview = value(await call(ops, {
      op: 'carrier.plan', sessionId: ops.sessionId, humanTask: '继续完成当前任务',
      anchor: ANCHOR, anchorMode: 'runtime',
    }))
    const prompt = String(preview.prompt)
    assert.equal(prompt.includes(ANCHOR), false, 'runtime mode keeps the anchor out of the first message')
    const item = (preview.items as { label: string, text: string }[]).find(entry => entry.label === '运行时规则（每次请求前提供）')
    assert.equal(item?.text, ANCHOR)
    assert.equal(ops.creates.length, 0)
  })

  test('确认后把锚点注册到承载会话的运行时上下文，不注册到来源会话', async () => {
    const ops = await boot()
    const preview = value(await call(ops, {
      op: 'carrier.plan', sessionId: ops.sessionId, humanTask: '继续', anchor: ANCHOR, anchorMode: 'runtime',
    }))
    value(await call(ops, {
      op: 'carrier.start', sessionId: ops.sessionId, humanTask: '继续', anchor: ANCHOR,
      anchorMode: 'runtime', confirmationToken: preview.draftRevision,
    }))
    assert.deepEqual(ops.runtimeContexts, [{
      name: 'dsh-context-redline:anchor',
      order: 10000,
      text: ANCHOR,
      interpolate: false,
      required: true,
    }])
    assert.equal(ops.creates.length, 1)
  })

  test('改生效方式会使旧确认失效，消息模式仍保持首尾锚点', async () => {
    const ops = await boot()
    const preview = value(await call(ops, {
      op: 'carrier.plan', sessionId: ops.sessionId, humanTask: '继续', anchor: ANCHOR,
    }))
    const refused = await call(ops, {
      op: 'carrier.start', sessionId: ops.sessionId, humanTask: '继续', anchor: ANCHOR,
      anchorMode: 'runtime', confirmationToken: preview.draftRevision,
    })
    assert.equal(refused.ok, false)
    assert.equal((refused.error as { code: string }).code, 'redline/drafts-changed')
    assert.ok(String(preview.prompt).startsWith(`继续\n\n【锚点】\n${ANCHOR}`))
    assert.ok(String(preview.prompt).endsWith(`【锚点重申】\n${ANCHOR}`))
    assert.equal(ops.creates.length, 0)
  })

  test('运行时模式必须提供非空锚点', async () => {
    const ops = await boot()
    const refused = await call(ops, {
      op: 'carrier.plan', sessionId: ops.sessionId, humanTask: '继续', anchorMode: 'runtime',
    })
    assert.equal(refused.ok, false)
    assert.equal((refused.error as { code: string }).code, 'redline/bad-request')
  })
})

describe('锚定会话（0.4.0）', () => {
  const ANCHOR = {
    task: '把设置页改成深色模式，并补齐移动端断点。',
    goal: '把设置页改成深色模式',
    acceptance: '375/430 无横向溢出；深色对比度达标；有头 UAT 通过。',
    discipline: '出错时修正并复验，继续原目标；完成前不换目标。',
  }
  const SNAPSHOT = '目标：把设置页改成深色模式\n\n验收：375/430 无横向溢出；深色对比度达标；有头 UAT 通过。\n\n纪律：出错时修正并复验，继续原目标；完成前不换目标。'

  test('plan 只组合快照与配置，不建会话、不读上下文', async () => {
    const ops = await boot()
    const preview = value(await call(ops, { op: 'anchor.plan', sessionId: ops.sessionId, ...ANCHOR }))
    assert.equal(preview.snapshot, SNAPSHOT)
    assert.equal(preview.title, '新对话 · 把设置页改成深色模式')
    assert.ok(String(preview.snapshotFingerprint).length > 0)
    assert.ok(String(preview.requestFingerprint).length > 0)
    assert.equal(ops.creates.length, 0)
    assert.equal(ops.followups.length, 0)
  })

  test('start 建普通 root 会话：首条消息是任务，运行时快照是目标/验收/纪律，且没有回程', async () => {
    const ops = await boot()
    const preview = value(await call(ops, { op: 'anchor.plan', sessionId: ops.sessionId, ...ANCHOR }))
    const started = value(await call(ops, {
      op: 'anchor.start', sessionId: ops.sessionId, operationId: 'anchor-op-1', ...ANCHOR,
      snapshotFingerprint: preview.snapshotFingerprint, requestFingerprint: preview.requestFingerprint,
    }))
    assert.equal(ops.creates.length, 1)
    assert.equal(ops.followups.length, 1)
    assert.equal(textOfMessage(ops.followups[0]), ANCHOR.task)
    assert.deepEqual(ops.runtimeContexts, [{
      name: 'dsh-context-redline:anchor',
      order: 10000,
      text: SNAPSHOT,
      interpolate: false,
      required: true,
    }])
    assert.equal(started.title, '新对话 · 把设置页改成深色模式')
    assert.equal(String(started.sessionId).startsWith('session-anchor-'), true)
    assert.equal(ops.creates[0]?.agentOptions !== undefined, true)
  })

  test('同一 operationId 重试只建一次、只发一次', async () => {
    const ops = await boot()
    const preview = value(await call(ops, { op: 'anchor.plan', sessionId: ops.sessionId, ...ANCHOR }))
    const request = {
      op: 'anchor.start', sessionId: ops.sessionId, operationId: 'anchor-op-retry', ...ANCHOR,
      snapshotFingerprint: preview.snapshotFingerprint, requestFingerprint: preview.requestFingerprint,
    }
    const first = value(await call(ops, request))
    const second = value(await call(ops, request))
    assert.equal(first.sessionId, second.sessionId)
    assert.equal(ops.creates.length, 1)
    assert.equal(ops.followups.length, 1)
  })

  test('任一字段变化或成对指纹不符都要求重看，不创建', async () => {
    const ops = await boot()
    const preview = value(await call(ops, { op: 'anchor.plan', sessionId: ops.sessionId, ...ANCHOR }))
    const refused = await call(ops, {
      op: 'anchor.start', sessionId: ops.sessionId, operationId: 'anchor-op-changed',
      ...ANCHOR, goal: '换成另一个目标',
      snapshotFingerprint: preview.snapshotFingerprint, requestFingerprint: preview.requestFingerprint,
    })
    assert.equal(refused.ok, false)
    assert.equal((refused.error as { code: string }).code, 'redline/drafts-changed')
    assert.equal(ops.creates.length, 0)
    assert.equal(ops.followups.length, 0)
  })

  test('空的目标/验收/纪律直接拒绝', async () => {
    const ops = await boot()
    for (const key of ['goal', 'acceptance', 'discipline'] as const) {
      const refused = await call(ops, { op: 'anchor.plan', sessionId: ops.sessionId, ...ANCHOR, [key]: '   ' })
      assert.equal(refused.ok, false)
      assert.equal((refused.error as { code: string }).code, 'redline/bad-request')
    }
  })
})
