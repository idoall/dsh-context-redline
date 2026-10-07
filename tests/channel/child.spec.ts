// M5 的写入点（`child.plan` / `child.start`）—— CHANNEL lane。
//
// 这个文件存在的理由（`AGENTS.md` §1 的硬约束）：**开子会话是全插件唯一的写入点**。
// 所以这里逐个钉住：
//   ① 轮次没闭合 / 会话不在本进程 / 首条任务是空的 ⟹ **一次 `startContinuable` 都不许调**；
//   ② 成功路径的那一次调用里，**人写的话 + 逐字带入的改后正文**都在 prompt 里；
//   ③ 全程 `Session.append` **零调用**、日志 offset **不动**（保存永远是临时的）；
//   ④ 这台运行时没有子会话服务时，如实拒绝（`redline/no-subagents`），不装作能开。

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { originsFileName, parseOrigins, serializeOrigins } from '../../src/shared/redline-origins'
import { parseDrafts } from '../../src/shared/redline-drafts'

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

let nullableAgentFor = ''

async function boot(options: { withSubagents?: boolean, withTeams?: 'off' | 'spawn', maxMembers?: unknown } = {}): Promise<ChildOps> {
  const { withSubagents = true, withTeams = 'off', maxMembers } = options
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
    get(id: string) {
      return id === nullableAgentFor ? undefined : fakeAgent
    },
  })
  if (withTeams === 'spawn') {
    ctx.provide('agentTeams', {
      // M5-13：真实服务的 config 是 TS-private 的普通属性（`this.config`）⟹ 防御性读它，
      // 这里用 options 模拟"配了 / 没配 / 配了垃圾"三种情形。
      config: maxMembers === undefined ? undefined : { maxMembers },
      async spawnTeammate(caller: unknown, request: Record<string, unknown>) {
        spawnCalls.push({ caller, request })
        return { member: { id: 'member-1', name: '上下文批改 · test', role: 'teammate', phase: 'active' } }
      },
    })
  }
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
    logOffset: () => session.seq, starts, agent: fakeAgent, spawnCalls,
    setLog: (next) => { log = next },
    logEntries: () => log,
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

describe('M5-01 优先路径：有官方团队服务就建官方成员（不行才兜底裸子会话）', () => {
  test('官方服务在 → 调 spawnTeammate（request 形状按安装树），且**不走**兜底那条路', async () => {
    const ops = await boot({ withTeams: 'spawn' })
    await saveEdit(ops, 1301, EDITED)
    const value = (await call(ops, { op: 'child.start', sessionId: ops.sessionId, humanTask: '按改好的上下文继续' })).value as Record<string, unknown>
    assert.equal(value.via, 'official-member', '界面据此如实标注走的是哪条路')
    assert.equal(ops.spawnCalls.length, 1, '官方被调一次')
    assert.equal(ops.starts.length, 0, '不许同时走两条路')
    const { caller, request } = ops.spawnCalls[0]
    assert.equal(caller, ops.agent, 'caller 是那个活 Agent')
    assert.equal(request.context, 'fork')
    assert.equal(request.provider, 'fork')
    assert.ok(Array.isArray(request.prompt) && (request.prompt as unknown[]).length === 1)
    assert.ok((request.prompt as { text: string }[])[0].text.includes(EDITED), '改后正文逐字进去')
    assert.ok(request.signal instanceof AbortSignal, 'signal 必填')
    assert.equal(request.description, '按改好的上下文继续', 'description 用的是人写的第一句话本身，不替用户概括')
    // 真机约束：官方要求成员名 lower-kebab-case、≤64 字、不能是 lead。中文名会被拒（2026-10-07 实测）。
    assert.match(String(request.name), /^[a-z0-9]+(-[a-z0-9]+)*$/, '成员名必须是 lower-kebab-case')
    assert.ok(String(request.name).length <= 64)
    assert.notEqual(request.name, 'lead')
    assert.equal(value.memberName, request.name, '返回里带上同一个成员名，界面与台账能对上')
  })

  test('官方服务不在 → 走兜底，并如实标成 bare-child', async () => {
    const ops = await boot({ withTeams: 'off' })
    const value = (await call(ops, { op: 'child.start', sessionId: ops.sessionId, humanTask: '继续' })).value as Record<string, unknown>
    assert.equal(value.via, 'bare-child')
    assert.equal(ops.starts.length, 1)
    assert.equal(ops.spawnCalls.length, 0)
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

  const startOnce = async (ops: ChildOps, humanTask: string): Promise<void> => {
    const reply = await call(ops, { op: 'child.start', sessionId: ops.sessionId, humanTask })
    assert.equal((reply as { ok: boolean }).ok, true)
  }

  test('官方路开了子会话 ⟹ 记下 member.id 与 via=official-member；读 op 能读回', async () => {
    const ops = await boot({ withTeams: 'spawn' })
    await startOnce(ops, '把测试补上')
    const parsed = parseOrigins(readFileSync(ledgerPath(ops), 'utf8'), ops.sessionId)
    assert.equal(parsed.ok, true)
    if (parsed.ok) {
      assert.equal(parsed.records.length, 1)
      assert.equal(parsed.records[0].childId, 'member-1', '官方成员的 id 就是子会话 id（TeamMemberView.id 类型是 SessionId）')
      assert.equal(parsed.records[0].via, 'official-member')
    }
    const read = await call(ops, { op: 'child.origins', sessionId: ops.sessionId })
    assert.equal(read.ok, true)
    assert.equal((read.value as { records: { childId: string }[] }).records[0].childId, 'member-1')
    assert.equal(ops.sessionWrites.length, 0, '台账只写我们自己的目录，会话零写入')
  })

  test('兜底路开了子会话 ⟹ 记下 childSessionId 与 via=bare-child', async () => {
    const ops = await boot({ withTeams: 'off' })
    await startOnce(ops, '把测试补上')
    const parsed = parseOrigins(readFileSync(ledgerPath(ops), 'utf8'), ops.sessionId)
    assert.equal(parsed.ok, true)
    if (parsed.ok) {
      assert.equal(parsed.records[0].childId, 'child-session-1')
      assert.equal(parsed.records[0].via, 'bare-child')
    }
    assert.equal(ops.sessionWrites.length, 0)
  })

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

describe('草稿不进种子（M5-23）：它唯一的出口是新会话的第一句话', () => {
  test('保存与开子会话都不碰父会话日志；草稿文件始终是唯一一份副本', async () => {
    const ops = await boot()
    const before = ops.logOffset()
    const logBefore = JSON.stringify(ops.logEntries())

    await saveEdit(ops, 1301, EDITED)
    // ① 保存只写我们自己的目录：日志 offset 与**内容**都不动
    assert.equal(ops.logOffset(), before, '保存不动日志')
    assert.equal(JSON.stringify(ops.logEntries()), logBefore, '保存不往日志里写任何东西')
    assert.deepEqual(ops.sessionWrites, [], '没有任何一次 Session.append')

    // ② 草稿文件落在我们自己的数据目录，而且是唯一一份副本
    const draftPath = join(ops.home, REDLINE_DATA_DIR_NAME, draftFileName(ops.sessionId))
    assert.equal(existsSync(draftPath), true, '草稿在我们自己的目录里')
    const parsed = parseDrafts(readFileSync(draftPath, 'utf8'), ops.sessionId)
    assert.equal(parsed.ok, true)
    if (parsed.ok) assert.equal(parsed.table[1301].text, EDITED, '文件里就是改后的正文')

    await call(ops, { op: 'child.start', sessionId: ops.sessionId, humanTask: '把测试补上' })

    // ③ fork 的种子取自**父会话日志**（docs/01 F50）⟹ 日志没变，种子就不可能带着草稿
    assert.equal(JSON.stringify(ops.logEntries()), logBefore, '开子会话也不写日志')
    assert.equal(ops.logOffset(), before, 'offset 还是不动')
    assert.deepEqual(ops.sessionWrites, [], '全程零 append')
    assert.equal(existsSync(draftPath), true, '开完之后草稿还在（临时保存，没被搬走）')

    // ④ 它唯一的出口 = 新会话的第一句话，且人写的那句在最前面（不生成任何新内容）
    const request = ops.starts[0].request as { prompt: { text: string }[] }
    assert.ok(request.prompt[0].text.startsWith('把测试补上'), '人写的第一句在最前面')
    assert.ok(request.prompt[0].text.includes(EDITED), '改后正文逐字跟在后面')
  })
})

describe('起点口径（M5-27 / A25 / A26）：传给平台的参数里**没有任何切点参数**', () => {
  // 平台事实（docs/01 F38）：fork 的种子**恒为**"父会话当前最后一个 turn/end 及其之前"，
  // startContinuable / spawnTeammate **没有任何参数**能指定更早的切点 ⟹ 界面不许承诺"选起点"，
  // 传给平台的形状也不许夹带 seed / cutSeq / recordId（A25/A26 锁死"没夹带"）。
  const BANNED = ['seed', 'cutSeq', 'recordId', 'atSeq', 'from', 'cut', 'startSeq', 'snapshotId']

  test('官方路：request 的键就是那六个，一个切点参数都没有', async () => {
    const ops = await boot({ withTeams: 'spawn' })
    await saveEdit(ops, 1301, EDITED)
    await call(ops, { op: 'child.start', sessionId: ops.sessionId, humanTask: '接着干' })
    const keys = Object.keys(ops.spawnCalls[0].request)
    assert.deepEqual([...keys].sort(), ['context', 'description', 'name', 'prompt', 'provider', 'signal'])
    for (const banned of BANNED) assert.equal(keys.includes(banned), false, banned + ' 不许出现（平台没有这个参数）')
  })

  test('兜底路：外壳四个键、request 只有 parent / prompt', async () => {
    const ops = await boot({ withTeams: 'off' })
    await saveEdit(ops, 1301, EDITED)
    await call(ops, { op: 'child.start', sessionId: ops.sessionId, humanTask: '接着干' })
    const argument = ops.starts[0]
    assert.deepEqual(Object.keys(argument).sort(), ['label', 'provider', 'request', 'signal'])
    assert.deepEqual(Object.keys(argument.request as Record<string, unknown>).sort(), ['parent', 'prompt'])
    for (const banned of BANNED) assert.equal(Object.keys(argument).includes(banned), false, banned)
  })

  test('确认框第一项说的是"平台算的起点"，不许提"你选的那条记录"', async () => {
    const ops = await boot()
    const plan = value(await call(ops, { op: 'child.plan', sessionId: ops.sessionId, humanTask: '接着干' })) as { items: { label: string, text: string }[] }
    const first = plan.items[0]
    assert.equal(first.label, '从哪儿开始')
    assert.ok(first.text.includes('平台'), '必须说清是平台算的')
    assert.ok(first.text.includes('最后聊完'), '必须说清从哪一轮开始')
    for (const word of ['记录', '凭证', '冻结', '快照']) assert.equal(first.text.includes(word), false, word + ' 不许出现（冻结/记录整套已删，docs/11 D10）')
  })
})
