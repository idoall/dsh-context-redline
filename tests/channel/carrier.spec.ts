import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
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
  readonly workspaceCreates: { readonly path: string; readonly name?: string }[]
  /** Every Host directory move a worktree run performed, in call order. */
  readonly workingDirectorySets: { readonly agent: unknown; readonly path: string }[]
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
const exec = promisify(execFile)

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

async function boot(
  workspacePath = WORKSPACE_PATH,
  sourceCwd = workspacePath,
  withWorkingDirectory = true,
): Promise<CarrierOps> {
  const home = mkdtempSync(join(tmpdir(), 'redline-carrier-route-'))
  homes.push(home)
  const ctx = new Context()
  const routes: CapturedRoute[] = []
  const creates: Record<string, unknown>[] = []
  const resumes: Record<string, unknown>[] = []
  const mounts: { receiver: unknown; agentCtx: unknown; preset: string }[] = []
  const attachments: string[] = []
  const workspaceCreates: { readonly path: string; readonly name?: string }[] = []
  const workingDirectorySets: { readonly agent: unknown; readonly path: string }[] = []
  let workingDirectoryCurrent: string | undefined
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
    session: { id: sourceSession.id, header: { cwd: sourceCwd, agentPreset: 'preset-exact' } },
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
      return path === workspacePath ? { id: 'workspace-exact', path } : undefined
    },
    get(id: string) {
      if (id !== 'workspace-exact') return undefined
      return {
        path: workspacePath,
        async attachSession(sessionId: string) { attachments.push(sessionId) },
      }
    },
    async create(path: string, name?: string) {
      workspaceCreates.push({ path, ...(name === undefined ? {} : { name }) })
      return { id: `workspace-extra-${workspaceCreates.length}`, path }
    },
  })
  // Mounted by `dsh-base`; a worktree run enters its checkout through it instead
  // of pointing the session header (and its sidebar group) at the run directory.
  if (withWorkingDirectory) {
    ctx.provide('workingDirectory', {
      get() { return workingDirectoryCurrent },
      async set(agent: unknown, path: string) {
        workingDirectorySets.push({ agent, path })
        workingDirectoryCurrent = path
        return path
      },
    })
  }
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
      await (setup as (agentCtx: unknown, agent: unknown) => Promise<void>)({ scope: 'carrier-created', systemPrompt }, agent)
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
    workspaceCreates,
    workingDirectorySets,
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
    assert.equal(preview.title, '把设置页改成深色模式')
    // The dialog shows this read-only: probes and relative paths resolve here.
    assert.equal(preview.cwd, WORKSPACE_PATH)
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
    assert.equal(started.title, '把设置页改成深色模式')
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

  test('勾选 worktree 运行时在 .guard/worktrees 建隔离检出，规范化路径且绝不注册新的 DSH 工作区', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'redline-anchor-worktree-'))
    homes.push(repo)
    await exec('git', ['init', '-q'], { cwd: repo })
    await exec('git', ['config', 'user.email', 'g@test'], { cwd: repo })
    await exec('git', ['config', 'user.name', 'g'], { cwd: repo })
    writeFileSync(join(repo, 'README.md'), 'base')
    await exec('git', ['add', '.'], { cwd: repo })
    await exec('git', ['commit', '-qm', 'base'], { cwd: repo })

    const ops = await boot(repo)
    const prepared = value(await call(ops, {
      op: 'guard.prepare',
      sessionId: ops.sessionId,
      ...ANCHOR,
      tasks: 'T1 | 改设置页 | 文件存在 | src/**',
      worktree: true,
    }))
    const runId = String(prepared.runId)
    const worktree = String(prepared.worktreePath)
    assert.equal(worktree, join(repo, '.guard', 'worktrees', runId))
    // The user's own checkout keeps its branch.
    assert.equal((await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })).stdout.trim(), 'main')

    const preview = value(await call(ops, { op: 'anchor.plan', sessionId: ops.sessionId, ...ANCHOR }))
    // Explicit valid guardWorktreePath (even with trailing slash / dot segment) is normalized to the canonical worktree path.
    const explicit = value(await call(ops, {
      op: 'anchor.start',
      sessionId: ops.sessionId,
      operationId: 'anchor-op-worktree-explicit',
      ...ANCHOR,
      guardRunId: runId,
      guardWorktreePath: `${worktree}/./`,
      snapshotFingerprint: preview.snapshotFingerprint,
      requestFingerprint: preview.requestFingerprint,
    }))
    assert.equal(ops.workspaceCreates.length, 0, 'must never register a second DSH workspace')
    assert.equal(ops.creates.length, 1)
    // The header keeps the source project, so DSH groups the session under it…
    assert.equal((ops.creates[0]?.meta as { cwd?: string }).cwd, repo)
    // …and the run checkout is entered through the Host directory move.
    assert.deepEqual(ops.workingDirectorySets.map(set => set.path), [worktree])
    // The session is accounted by its project workspace, never left ungrouped.
    assert.deepEqual(ops.attachments, [String(explicit.sessionId)])

    // Omitting guardWorktreePath still resolves to the worktree when only the worktree ledger exists.
    const preparedFallback = value(await call(ops, {
      op: 'guard.prepare',
      sessionId: ops.sessionId,
      ...ANCHOR,
      tasks: 'T1 | 改设置页 | 文件存在 | src/**',
      worktree: true,
    }))
    const fallbackRunId = String(preparedFallback.runId)
    const fallbackWorktree = String(preparedFallback.worktreePath)
    value(await call(ops, {
      op: 'anchor.start',
      sessionId: ops.sessionId,
      operationId: 'anchor-op-worktree-fallback',
      ...ANCHOR,
      guardRunId: fallbackRunId,
      snapshotFingerprint: preview.snapshotFingerprint,
      requestFingerprint: preview.requestFingerprint,
    }))
    assert.equal((ops.creates[1]?.meta as { cwd?: string }).cwd, repo)
    assert.deepEqual(ops.workingDirectorySets.map(set => set.path), [worktree, fallbackWorktree])
    assert.equal(ops.attachments.length, 2)

    // If a stale worktree ledger AND a main-workspace ledger exist for the same runId, omitting guardWorktreePath must refuse instead of silently hijacking.
    mkdirSync(join(repo, 'docs', 'guard', fallbackRunId), { recursive: true })
    const ambiguous = await call(ops, {
      op: 'anchor.start',
      sessionId: ops.sessionId,
      operationId: 'anchor-op-ambiguous',
      ...ANCHOR,
      guardRunId: fallbackRunId,
      snapshotFingerprint: preview.snapshotFingerprint,
      requestFingerprint: preview.requestFingerprint,
    })
    assert.equal(ambiguous.ok, false)
    assert.equal((ambiguous.error as { code: string }).code, REDLINE_ERROR.badRequest)

    // A stray directory under .guard/worktrees/<id> without .git must not be treated as a worktree.
    const brokenRunId = '20261127-no-git'
    mkdirSync(join(repo, '.guard', 'worktrees', brokenRunId, 'docs', 'guard', brokenRunId), { recursive: true })
    const noGit = await call(ops, {
      op: 'anchor.start',
      sessionId: ops.sessionId,
      operationId: 'anchor-op-no-git',
      ...ANCHOR,
      guardRunId: brokenRunId,
      snapshotFingerprint: preview.snapshotFingerprint,
      requestFingerprint: preview.requestFingerprint,
    })
    assert.equal(noGit.ok, false)
    assert.equal(ops.creates.length, 2)

    const refused = await call(ops, {
      op: 'anchor.start',
      sessionId: ops.sessionId,
      operationId: 'anchor-op-bad-wt',
      ...ANCHOR,
      guardRunId: runId,
      guardWorktreePath: join(repo, '.guard', 'worktrees', 'someone-else'),
      snapshotFingerprint: preview.snapshotFingerprint,
      requestFingerprint: preview.requestFingerprint,
    })
    assert.equal(refused.ok, false)
    assert.equal((refused.error as { code: string }).code, REDLINE_ERROR.badRequest)
    assert.equal(ops.workspaceCreates.length, 0)
  })

  test('anchor.start refuses a run already owned by another session and never rewrites its ledger', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'redline-anchor-owned-'))
    homes.push(repo)
    const ops = await boot(repo)
    const prepared = value(await call(ops, {
      op: 'guard.prepare',
      sessionId: ops.sessionId,
      ...ANCHOR,
      tasks: 'T1 | 改设置页 | 文件存在 | src/**',
    }))
    const root = String(prepared.root)
    const metaPath = join(root, 'run.json')
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
    // Another session mounted this run: its ledger already has an executor
    // freeze that a new start must not overwrite.
    writeFileSync(metaPath, JSON.stringify({ ...meta, phase: 'running', sessionId: 'session-other' }), 'utf8')
    const preview = value(await call(ops, { op: 'anchor.plan', sessionId: ops.sessionId, ...ANCHOR }))
    const refused = await call(ops, {
      op: 'anchor.start',
      sessionId: ops.sessionId,
      operationId: 'anchor-op-owned',
      ...ANCHOR,
      guardRunId: String(prepared.runId),
      snapshotFingerprint: preview.snapshotFingerprint,
      requestFingerprint: preview.requestFingerprint,
    })
    assert.equal(refused.ok, false)
    assert.equal(code(refused), REDLINE_ERROR.badRequest)
    assert.match(((refused.error as { message?: string }).message ?? ''), /already mounted/)
    assert.equal(ops.creates.length, 0, 'no session is created for a run it cannot own')
    const ledger = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')) as { activeExecutor?: unknown }
    assert.equal(ledger.activeExecutor, undefined, 'the refused start must not rewrite the ledger')
  })

  test('anchor.start refuses a run whose phase is no longer startable', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'redline-anchor-phase-'))
    homes.push(repo)
    const ops = await boot(repo)
    const prepared = value(await call(ops, {
      op: 'guard.prepare',
      sessionId: ops.sessionId,
      ...ANCHOR,
      tasks: 'T1 | 改设置页 | 文件存在 | src/**',
    }))
    const root = String(prepared.root)
    const metaPath = join(root, 'run.json')
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
    // A finished/aborted run with no bound session is not a fresh ledger.
    writeFileSync(metaPath, JSON.stringify({ ...meta, phase: 'completed' }), 'utf8')
    const preview = value(await call(ops, { op: 'anchor.plan', sessionId: ops.sessionId, ...ANCHOR }))
    const refused = await call(ops, {
      op: 'anchor.start',
      sessionId: ops.sessionId,
      operationId: 'anchor-op-finished',
      ...ANCHOR,
      guardRunId: String(prepared.runId),
      snapshotFingerprint: preview.snapshotFingerprint,
      requestFingerprint: preview.requestFingerprint,
    })
    assert.equal(refused.ok, false)
    assert.equal(code(refused), REDLINE_ERROR.badRequest)
    assert.match(((refused.error as { message?: string }).message ?? ''), /not startable/)
    assert.equal(ops.creates.length, 0)
    const ledger = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')) as { activeExecutor?: unknown }
    assert.equal(ledger.activeExecutor, undefined)
  })

  test('缺少 workingDirectory 服务时，worktree 运行在建会话前就失败，不留下未归组的孤儿会话', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'redline-no-workdir-'))
    homes.push(repo)
    await exec('git', ['init', '-q'], { cwd: repo })
    await exec('git', ['config', 'user.email', 'g@test'], { cwd: repo })
    await exec('git', ['config', 'user.name', 'g'], { cwd: repo })
    writeFileSync(join(repo, 'README.md'), 'base')
    await exec('git', ['add', '.'], { cwd: repo })
    await exec('git', ['commit', '-qm', 'base'], { cwd: repo })

    const ops = await boot(repo, repo, false)
    const prepared = value(await call(ops, {
      op: 'guard.prepare',
      sessionId: ops.sessionId,
      ...ANCHOR,
      tasks: 'T1 | 改设置页 | 文件存在 | src/**',
      worktree: true,
    }))
    const preview = value(await call(ops, { op: 'anchor.plan', sessionId: ops.sessionId, ...ANCHOR }))
    const refused = await call(ops, {
      op: 'anchor.start',
      sessionId: ops.sessionId,
      operationId: 'anchor-op-no-workdir',
      ...ANCHOR,
      guardRunId: String(prepared.runId),
      guardWorktreePath: String(prepared.worktreePath),
      snapshotFingerprint: preview.snapshotFingerprint,
      requestFingerprint: preview.requestFingerprint,
    })
    assert.equal(refused.ok, false)
    assert.equal((refused.error as { code: string }).code, REDLINE_ERROR.internal)
    assert.match((refused.error as { message: string }).message, /working-directory-unavailable/)
    assert.equal(ops.creates.length, 0, 'nothing is created when the run checkout cannot be entered')
    assert.deepEqual(ops.attachments, [])
    // The route is frozen BEFORE the session exists: recording it afterwards
    // raced the first turn's audit, which could write the ledger back without it.
    const ledgerPath = join(String(prepared.worktreePath), 'docs', 'guard', String(prepared.runId), 'tasks.json')
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { activeExecutor?: { provider: string, model: string, reasoningEffort?: string } }
    assert.deepEqual(ledger.activeExecutor, {
      provider: 'provider-exact', model: 'model-exact', reasoningEffort: 'high',
    })
  })

  test('从无工作区归属的 worktree 会话发起新对话时，给出明确可操作提示而不是内部报错', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'redline-ungrouped-wt-'))
    homes.push(repo)
    const wtCwd = join(repo, '.guard', 'worktrees', '20261127-demo')
    mkdirSync(wtCwd, { recursive: true })
    const ops = await boot(repo, wtCwd)

    const anchorReply = await call(ops, { op: 'anchor.plan', sessionId: ops.sessionId, ...ANCHOR })
    assert.equal(anchorReply.ok, false)
    assert.equal((anchorReply.error as { code: string }).code, REDLINE_ERROR.badRequest)
    assert.match((anchorReply.error as { message: string }).message, /worktree/i)

    const carrierReply = await call(ops, { op: 'carrier.plan', sessionId: ops.sessionId, humanTask: '继续收尾' })
    assert.equal(carrierReply.ok, false)
    assert.equal((carrierReply.error as { code: string }).code, REDLINE_ERROR.badRequest)
    assert.match((carrierReply.error as { message: string }).message, /worktree/i)
  })
})
