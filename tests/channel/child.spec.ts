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
import { mkdir, writeFile } from 'node:fs/promises'
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
import { originsFileName, serializeOrigins } from '../../src/shared/redline-origins'

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
  spawnCalls: { caller: unknown, request: Record<string, unknown> }[]
  /** 假的活 Agent：`request.parent` 该收到它。 */
  agent: unknown
  setLog: (next: { type: string }[]) => void
  /** 日志**内容**（不只 offset）：M5-23 要证明种子来源里一个字都没有。 */
  logEntries: () => readonly { type: string }[]
}

async function boot(options: {
  withSubagents?: boolean
  withTeams?: 'off' | 'spawn' | 'throw' | 'undefined-result'
  maxMembers?: unknown
  bareResult?: unknown
  bareThrows?: boolean
} = {}): Promise<ChildOps> {
  const { withSubagents = true, withTeams = 'off', maxMembers, bareResult = { childSessionId: 'child-session-1' }, bareThrows = false } = options
  const home = mkdtempSync(join(tmpdir(), 'redline-child-'))
  homes.push(home)
  const routes: CapturedRoute[] = []
  const sessionWrites: string[] = []
  const starts: Record<string, unknown>[] = []
  /** 每次 child.start 调官方 spawnTeammate 时收到的 (caller, request)。 */
  const spawnCalls: { caller: unknown, request: Record<string, unknown> }[] = []
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
    get() { return fakeAgent },
  })
  if (withTeams !== 'off') {
    ctx.provide('agentTeams', {
      // M5-13：真实服务的 config 是 TS-private 的普通属性（`this.config`）⟹ 防御性读它，
      // 这里用 options 模拟"配了 / 没配 / 配了垃圾"三种情形。
      config: maxMembers === undefined ? undefined : { maxMembers },
      async spawnTeammate(caller: unknown, request: Record<string, unknown>) {
        spawnCalls.push({ caller, request })
        if (withTeams === 'throw') throw new Error('official team temporarily unavailable')
        if (withTeams === 'undefined-result') return undefined
        return { member: { id: 'member-1', name: '上下文批改 · test', role: 'teammate', phase: 'active' } }
      },
    })
  }
  if (withSubagents) {
    ctx.provide('subagents', {
      async startContinuable(argument: Record<string, unknown>) {
        starts.push(argument)
        if (bareThrows) throw new Error('bare child unavailable')
        return bareResult
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
    logOffset: () => session.seq, starts, agent: fakeAgent, spawnCalls,
    setLog: (next) => { log = next },
    logEntries: () => log,
  }
}

async function call(ops: ChildOps, body: unknown): Promise<Record<string, unknown>> {
  // Existing success-path specs exercise the UI contract: a start follows its plan
  // and therefore carries plan.draftRevision. Deliberate stale/missing cases call
  // the captured route directly below.
  let sent = body
  if (body !== null && typeof body === 'object' && (body as { op?: unknown }).op === 'child.start'
    && (body as { draftRevision?: unknown }).draftRevision === undefined) {
    const start = body as { sessionId: string, humanTask: string }
    const planned = await call(ops, { op: 'child.plan', sessionId: start.sessionId, humanTask: start.humanTask })
    sent = { ...start, op: 'child.start', draftRevision: (planned.value as { draftRevision: string }).draftRevision }
  }
  const response = await ops.channel.fetch(new Request(`http://dsh.test${REDLINE_CHANNEL_ROUTE}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sent),
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

describe('legacy child.start is retired', () => {
  test('a stale client is refused and no fork provider is called', async () => {
    const ops = await boot({ withSubagents: true, withTeams: 'spawn' })
    const reply = await call(ops, { op: 'child.start', sessionId: ops.sessionId, humanTask: '继续' })
    assert.equal(code(reply), REDLINE_ERROR.unknownOp)
    assert.equal(ops.starts.length, 0)
    assert.equal(ops.spawnCalls.length, 0)
    assert.deepEqual(ops.sessionWrites, [])
  })
})

describe('child.capacity：这台机器允许几个成员（M5-13 的分母）', () => {
  test('没有官方团队服务 → 如实说"上限不知道"（绝不编 8 / 16）', async () => {
    const ops = await boot({ withTeams: 'off' })
    assert.deepEqual(await call(ops, { op: 'child.capacity' }), { ok: true, value: { known: false, max: null } })
  })

  test('服务在且配了 maxMembers（本机 8）→ 读出那个数', async () => {
    const ops = await boot({ withTeams: 'spawn', maxMembers: 8 })
    assert.deepEqual(await call(ops, { op: 'child.capacity' }), { ok: true, value: { known: true, max: 8 } })
  })

  test('读不到 / 读到垃圾 → 一律"不知道"，且这个 op 不做任何写入', async () => {
    for (const bad of [undefined, 0, -1, 3.5, '8', null, NaN]) {
      const ops = await boot({ withTeams: 'spawn', maxMembers: bad })
      assert.deepEqual(await call(ops, { op: 'child.capacity' }), { ok: true, value: { known: false, max: null } }, 'maxMembers=' + String(bad))
      assert.equal(ops.sessionWrites.length, 0, '只读 op')
    }
  })
})

describe('child.origins：我们自己那本"来源台账"（M5-12）', () => {
  const ledgerPath = (ops: ChildOps): string => join(ops.home, REDLINE_DATA_DIR_NAME, originsFileName(ops.sessionId))

  test('没在这条会话里开过 ⟹ 空台账（不是"读不出来"）', async () => {
    const ops = await boot()
    assert.deepEqual(await call(ops, { op: 'child.origins', sessionId: ops.sessionId }), { ok: true, value: { records: [] } })
  })

  test('台账读不出来 ⟹ records:null + 稳定错误码（**不许**说成"没记录"）', async () => {
    const ops = await boot()
    const file = ledgerPath(ops)
    await mkdir(join(ops.home, REDLINE_DATA_DIR_NAME), { recursive: true })
    await writeFile(file, '{ 这不是 JSON', 'utf8')
    const reply = await call(ops, { op: 'child.origins', sessionId: ops.sessionId })
    assert.deepEqual(reply, { ok: true, value: { records: null, error: REDLINE_ERROR.originCorrupt } })
    // 串档（台账写着别的会话）也算读不出来
    await writeFile(file, serializeOrigins('session-someone-else', []), 'utf8')
    const crossed = await call(ops, { op: 'child.origins', sessionId: ops.sessionId })
    assert.deepEqual(crossed, { ok: true, value: { records: null, error: REDLINE_ERROR.originCorrupt } })
    // 版本不认识 ⟹ 另一个码（界面话术不同）
    await writeFile(file, JSON.stringify({ schemaVersion: 99, sessionId: ops.sessionId, records: [] }), 'utf8')
    const old = await call(ops, { op: 'child.origins', sessionId: ops.sessionId })
    assert.deepEqual(old, { ok: true, value: { records: null, error: REDLINE_ERROR.originSchema } })
  })
})

describe('draft.exclude：本地删除，以及它怎么进新会话', () => {
  test('删除后：plan 的 carriedSeqs 不含它、excludedSeqs 含它，首条任务里它彻底不出现', async () => {
    const ops = await boot()
    await saveEdit(ops, 1301, EDITED)
    const marked = await call(ops, { op: 'draft.exclude', sessionId: ops.sessionId, seq: 1301, excluded: true })
    assert.equal(marked.ok, true, JSON.stringify(marked))
    const plan = value(await call(ops, { op: 'child.plan', sessionId: ops.sessionId, humanTask: '继续' })) as {
      carriedSeqs: number[], excludedSeqs: number[], prompt: string,
    }
    assert.deepEqual(plan.carriedSeqs, [], '被删的那条不再作为"改好的正文"带过去')
    assert.deepEqual(plan.excludedSeqs, [1301], '确认框仍要按它说"删了几条、不会带过去"')
    assert.equal(plan.prompt, '继续', '首条任务只剩人写那句话 —— 被删的条目连编号都不出现')
    assert.equal(plan.prompt.includes('不要采用'), false, '作废声明整段作废（零历史不需要声明）')
    assert.equal(plan.prompt.includes('#1301'), false, '它连编号都不该出现')
  })

  test('取消标记 → 又回到"没有改动、也没有作废"', async () => {
    const ops = await boot()
    await call(ops, { op: 'draft.exclude', sessionId: ops.sessionId, seq: 1301, excluded: true })
    await call(ops, { op: 'draft.exclude', sessionId: ops.sessionId, seq: 1301, excluded: false })
    const plan = value(await call(ops, { op: 'child.plan', sessionId: ops.sessionId, humanTask: '继续' })) as { excludedSeqs: number[] }
    assert.deepEqual(plan.excludedSeqs, [])
  })

  // ⚠️ 2026-10-09 按 `docs/03` R4.8 重写：原标题断言"标记与编辑互斥（先标记再保存 ⟹ 标记没了；
  // 先保存再标记 ⟹ 改动没了）"——那条互斥规矩**已被 R4.8 硬要求 3 作废**。新合同是"两个字段
  // 独立存储"：编辑不解除删除；已删除的条目**不投递**（正文仍留着）；取消删除后改稿原样回来
  // 并重新参与投递。这一条也是"改了一条 → 删除 → 取消删除"这条真实链路的端到端护栏。
  test('删除与编辑不再互斥：编辑不解除删除、已删除的不投递、取消删除后改稿回来并重新投递', async () => {
    const ops = await boot()
    await call(ops, { op: 'draft.exclude', sessionId: ops.sessionId, seq: 1301, excluded: true })
    await saveEdit(ops, 1301, EDITED)
    let plan = value(await call(ops, { op: 'child.plan', sessionId: ops.sessionId, humanTask: '继续' })) as { carriedSeqs: number[], excludedSeqs: number[] }
    assert.deepEqual(plan.excludedSeqs, [1301], '编辑不许解除删除标记（互斥已作废）')
    assert.deepEqual(plan.carriedSeqs, [], '已删除的那条不参与投递，哪怕它带着改稿')

    await call(ops, { op: 'draft.exclude', sessionId: ops.sessionId, seq: 1301, excluded: false })
    plan = value(await call(ops, { op: 'child.plan', sessionId: ops.sessionId, humanTask: '继续' })) as { carriedSeqs: number[], excludedSeqs: number[] }
    assert.deepEqual(plan.excludedSeqs, [], '取消删除后不再是删除态')
    assert.deepEqual(plan.carriedSeqs, [1301], '取消删除后改稿原样回来并重新参与投递')
  })

  test('标记也要走同一道门：会话零写入 + 轮次未闭合拒绝', async () => {
    const ops = await boot()
    const before = ops.logOffset()
    await call(ops, { op: 'draft.exclude', sessionId: ops.sessionId, seq: 1301, excluded: true })
    assert.deepEqual(ops.sessionWrites, [], '标记只写本地，不碰会话')
    assert.equal(ops.logOffset(), before, '日志 offset 不动')

    ops.setLog([{ type: 'turn/start' }])
    const refused = await call(ops, { op: 'draft.exclude', sessionId: ops.sessionId, seq: 1301, excluded: true })
    assert.equal(code(refused), REDLINE_ERROR.turnOpen, '轮次未闭合时拒绝')
    ops.setLog([{ type: 'turn/start' }, { type: 'turn/end' }])
  })
})
