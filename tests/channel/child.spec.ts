// M5 的写入点（`child.plan` / `child.start`）—— CHANNEL lane。
//
// 这个文件存在的理由（`AGENTS.md` §1 的硬约束）：**开子会话是全插件唯一的写入点**。
// 所以这里逐个钉住：
//   ① 轮次没闭合 / 会话不在本进程 / 首条任务是空的 ⟹ **一次 `startContinuable` 都不许调**；
//   ② 成功路径的那一次调用里，**人写的话 + 逐字带入的改后正文**都在 prompt 里；
//   ③ 全程 `Session.append` **零调用**、日志 offset **不动**（保存永远是临时的）；
//   ④ 这台运行时没有子会话服务时，如实拒绝（`redline/no-subagents`），不装作能开。

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, inject, name } from '../../src/host/index'
import { REDLINE_ERROR } from '../../src/shared/redline-errors'
import { REDLINE_CHANNEL_ROUTE } from '../../src/shared/redline-route'
import { REDLINE_DATA_DIR_NAME } from '../../src/shared/redline-paths'
import { draftFileName } from '../../src/shared/redline-drafts'

type RouteFetch = (request: Request) => Promise<Response>
interface CapturedRoute { path: string, methods: readonly string[], fetch: RouteFetch }
const plugin = { name, inject, apply } as never

/** The verbatim body we edit and then carry into the child session. */
const EDITED = '改好的第一条：默认档位按轮次，并且每一行都要显示 #seq。\n\n改好的第二条：跑测试请贴原始输出。'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

interface ChildOps {
  ctx: Context
  channel: CapturedRoute
  home: string
  sessionId: string
  sessionWrites: string[]
  logOffset: () => number
  starts: Record<string, unknown>[]
  /** 假的活 Agent：`request.parent` 该收到它。 */
  agent: unknown
  setLog: (next: { type: string }[]) => void
}

let nullableAgentFor = ''

async function boot(options: { withSubagents?: boolean } = {}): Promise<ChildOps> {
  const { withSubagents = true } = options
  const home = mkdtempSync(join(tmpdir(), 'redline-child-'))
  homes.push(home)
  const routes: CapturedRoute[] = []
  const sessionWrites: string[] = []
  const starts: Record<string, unknown>[] = []
  const ctx = new Context()
  ctx.provide('connection', {
    fetch: { register(route: CapturedRoute) { routes.push(route); return () => {} } },
  })
  ctx.provide('dshHomePath', (...segments: string[]) => join(home, ...segments))
  // 真实的那个会话 id 在创建后才拿得到；读取面用它和幽灵 id 区分（这里只用得到前者）
  let readable = ''
  let log: { type: string }[] = [{ type: 'turn/start' }, { type: 'turn/end' }]
  const ROW_TEXT = '把默认档位改成按轮次，并且每一行都要显示 #seq。'
  ctx.provide('sessionQuery', {
    async listEvents(sessionId: string) {
      if (sessionId !== readable) throw new Error('session is not readable here')
      return log
    },
    // draft.update resolves the row first (host full text) - the read faces must exist.
    async readSurface(sessionId: string) {
      return {
        session: { id: sessionId },
        inheritedEventCount: 0,
        capturedThroughSeq: 1301,
        events: [{ type: 'user/message', seq: 1301, data: { content: [{ type: 'text', text: ROW_TEXT }] } }],
      }
    },
    async readEvent(request: { sessionId: string, seq: number }) {
      if (request.seq !== 1301) {
        return { session: { id: request.sessionId }, inheritedEventCount: 0, target: undefined, events: [], startSeq: 0, endSeq: 0 }
      }
      return {
        session: { id: request.sessionId },
        inheritedEventCount: 0,
        target: { type: 'user/message', seq: 1301, data: { content: [{ type: 'text', text: ROW_TEXT }] } },
        events: [], startSeq: 1301, endSeq: 1301,
      }
    },
  })
  // 真机的 `request.parent` 要的是**活的 Agent 对象**（真机纠正见 channel 里的注释）⟹ 这里给一个可辨认的替身。
  const fakeAgent = { header: { id: 'agent-stub' }, sessionId: 'will-be-replaced' }
  ctx.provide('agents', {
    get(id: string) {
      return id === nullableAgentFor ? undefined : fakeAgent
    },
  })
  if (withSubagents) {
    ctx.provide('subagents', {
      async startContinuable(argument: Record<string, unknown>) {
        starts.push(argument)
        return { childSessionId: 'child-session-1' }
      },
    })
  }
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const session = ctx.sessions.create()
  readable = session.id
  const originalAppend = session.append.bind(session)
  session.append = ((...args: unknown[]) => {
    sessionWrites.push(`append:${String(args[0])}`)
    return (originalAppend as unknown as (...a: unknown[]) => unknown)(...args)
  }) as unknown as typeof session.append
  await ctx.plugin(plugin, {} as never)
  const channel = routes.find(r => r.path === REDLINE_CHANNEL_ROUTE)
  assert.ok(channel !== undefined, 'the channel registered')
  return {
    ctx, channel, home, sessionId: session.id, sessionWrites,
    logOffset: () => session.seq, starts, agent: fakeAgent,
    setLog: (next) => { log = next },
  }
}

async function call(ops: ChildOps, body: unknown): Promise<Record<string, unknown>> {
  const response = await ops.channel.fetch(new Request(`http://dsh.test${REDLINE_CHANNEL_ROUTE}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  assert.equal(response.status, 200)
  return await response.json() as Record<string, unknown>
}
const value = (reply: Record<string, unknown>): Record<string, unknown> => {
  assert.equal(reply.ok, true, JSON.stringify(reply))
  return reply.value as Record<string, unknown>
}
const code = (reply: Record<string, unknown>): string => {
  assert.equal(reply.ok, false, JSON.stringify(reply))
  return (reply.error as { code: string }).code
}
const draftPath = (ops: ChildOps) => join(ops.home, REDLINE_DATA_DIR_NAME, draftFileName(ops.sessionId))

/** Save one local edit through the normal M2 route (so the draft really exists on disk). */
async function saveEdit(ops: ChildOps, seq: number, text: string): Promise<void> {
  const reply = await call(ops, { op: 'draft.update', sessionId: ops.sessionId, seq, edit: { text, reasoning: '', isError: false } })
  assert.equal(reply.ok, true, JSON.stringify(reply))
}

describe('child.plan：开子会话之前能问的全部事实（只读）', () => {
  test('首条任务是空的 → 返回"空着不能开"的拒绝，但 plan 本身不写任何东西', async () => {
    const ops = await boot()
    const plan = value(await call(ops, { op: 'child.plan', sessionId: ops.sessionId, humanTask: '   ' }))
    assert.equal(plan.prompt, null)
    const refusal = plan.refusal as { code: string, message: string }
    assert.equal(refusal.code, REDLINE_ERROR.emptyTask)
    assert.ok(refusal.message.includes('自己写'), refusal.message)
    assert.equal(ops.starts.length, 0, 'plan 绝不发起')
    assert.deepEqual(ops.sessionWrites, [], 'plan 不写会话')
    assert.equal(existsSync(draftPath(ops)), false, 'plan 也不写草稿')
  })

  test('确认框恰好五项；带上的改动逐字出现在组装好的首条任务里', async () => {
    const ops = await boot()
    await saveEdit(ops, 1301, EDITED)
    const plan = value(await call(ops, { op: 'child.plan', sessionId: ops.sessionId, humanTask: '按改好的上下文继续' }))
    assert.equal((plan.items as unknown[]).length, 5, '确认框五项')
    assert.deepEqual(plan.carriedSeqs, [1301])
    const prompt = plan.prompt as string
    assert.ok(prompt.startsWith('按改好的上下文继续'))
    assert.ok(prompt.includes(EDITED), '逐字带入（不截断、不摘要）')
    assert.equal(ops.starts.length, 0)
    assert.deepEqual(ops.sessionWrites, [])
  })
})

describe('child.start：全插件唯一的写入点', () => {
  test('轮次没闭合 → 拒绝，且一次 startContinuable 都不调', async () => {
    const ops = await boot()
    await saveEdit(ops, 1301, EDITED)
    ops.setLog([{ type: 'turn/start' }])
    const reply = await call(ops, { op: 'child.start', sessionId: ops.sessionId, humanTask: '继续' })
    assert.equal(code(reply), REDLINE_ERROR.turnOpen)
    assert.equal(ops.starts.length, 0)
    assert.deepEqual(ops.sessionWrites, [])
  })

  test('首条任务为空 → 拒绝（不产生任何 AI 生成内容）', async () => {
    const ops = await boot()
    const reply = await call(ops, { op: 'child.start', sessionId: ops.sessionId, humanTask: '' })
    assert.equal(code(reply), REDLINE_ERROR.emptyTask)
    assert.equal(ops.starts.length, 0)
  })

  test('会话不在本进程（拿不到活 Agent）→ not-live，且一次都不发起', async () => {
    const ops = await boot()
    nullableAgentFor = ops.sessionId
    try {
      const reply = await call(ops, { op: 'child.start', sessionId: ops.sessionId, humanTask: '继续' })
      assert.equal(code(reply), REDLINE_ERROR.notLive)
      assert.equal(ops.starts.length, 0, '一次都不许发起')
    } finally {
      nullableAgentFor = ''
    }
  })

  test('运行时没有子会话服务 → 如实拒绝，不装作能开', async () => {
    const ops = await boot({ withSubagents: false })
    const reply = await call(ops, { op: 'child.start', sessionId: ops.sessionId, humanTask: '继续' })
    assert.equal(code(reply), REDLINE_ERROR.noSubagents)
  })

  test('成功路径：调一次 startContinuable，prompt 里有人写的话 + 逐字带入的改后正文；会话零写入', async () => {
    const ops = await boot()
    await saveEdit(ops, 1301, EDITED)
    const before = ops.logOffset()
    const ok = value(await call(ops, { op: 'child.start', sessionId: ops.sessionId, humanTask: '按改好的上下文继续' }))
    assert.equal(ops.starts.length, 1, '只发一次')
    const argument = ops.starts[0]
    assert.equal(argument.provider, 'fork')
    assert.equal(typeof argument.label, 'string')
    const request = argument.request as { parent: unknown, prompt: { type: string, text: string }[] }
    assert.equal(request.parent, ops.agent, 'request.parent 必须是活的 Agent 对象（真机纠正）')
    assert.ok(Array.isArray(request.prompt), 'prompt 必须是 ContentBlock[]')
    assert.equal(request.prompt[0].type, 'text')
    assert.ok(request.prompt[0].text.includes('按改好的上下文继续'))
    assert.ok(request.prompt[0].text.includes(EDITED), '改后正文逐字进去')
    assert.ok(argument.signal instanceof AbortSignal, 'signal 必填（真机纠正）')
    assert.deepEqual(ok.carriedSeqs, [1301])
    assert.equal(ops.sessionWrites.length, 0, '会话一个字都没写')
    assert.equal(ops.logOffset(), before, '日志 offset 不动')
  })
})
