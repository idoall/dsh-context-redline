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
import { draftFileName, teamListErrorFileName } from '../../src/shared/redline-drafts'

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
  teamCalls: unknown[]
  spawnCalls: { caller: unknown, request: Record<string, unknown> }[]
  /** 假的活 Agent：`request.parent` 该收到它。 */
  agent: unknown
  setLog: (next: { type: string }[]) => void
}

let nullableAgentFor = ''

async function boot(options: { withSubagents?: boolean, withTeams?: 'ok' | 'throws' | 'off' | 'spawn' } = {}): Promise<ChildOps> {
  const { withSubagents = true, withTeams = 'off' } = options
  const home = mkdtempSync(join(tmpdir(), 'redline-child-'))
  homes.push(home)
  const routes: CapturedRoute[] = []
  const sessionWrites: string[] = []
  const starts: Record<string, unknown>[] = []
  /** 每次 team.list 调官方 listTasks 时收到的 caller。 */
  const teamCalls: unknown[] = []
  /** 每次 team.list 调官方 spawnTeammate 时收到的 (caller, request)。 */
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
  if (withTeams !== 'off') {
    ctx.provide('agentTeams', {
      listTasks(caller: unknown) {
        teamCalls.push(caller)
        if (withTeams === 'throws') throw new Error('caller is not a team member')
        return [{ id: 't-1', revision: 3, subject: '把测试补上', status: 'pending', ready: true, ownerName: '小王' }]
      },
      membership() { return { role: 'lead' } },
      ...(withTeams === 'spawn'
        ? {
            async spawnTeammate(caller: unknown, request: Record<string, unknown>) {
              spawnCalls.push({ caller, request })
              return { member: { id: 'member-1', name: '上下文批改 · test', role: 'teammate', phase: 'active' } }
            },
          }
        : {}),
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
    logOffset: () => session.seq, starts, agent: fakeAgent, teamCalls, spawnCalls,
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

describe('team.list：官方 Agent Teams 那份数据（M5-24 的契约：不提供就返回 null）', () => {
  test('没有 agentTeams 服务 → null（界面据此隐藏对接点，而不是显示空队伍）', async () => {
    const ops = await boot({ withTeams: 'off' })
    const reply = await call(ops, { op: 'team.list', sessionId: ops.sessionId })
    assert.equal(reply.ok, true, JSON.stringify(reply))
    assert.equal(reply.value, null, '不提供就是 null')
    assert.deepEqual(ops.sessionWrites, [], '只读：不写会话')
  })

  test('拿不到活 Agent（不是团队成员）→ null', async () => {
    const ops = await boot({ withTeams: 'ok' })
    nullableAgentFor = ops.sessionId
    try {
      const reply = await call(ops, { op: 'team.list', sessionId: ops.sessionId })
      assert.equal(reply.value, null)
      assert.equal(ops.teamCalls.length, 0, '连官方都不该去调')
    } finally { nullableAgentFor = '' }
  })

  test('服务在、caller 活着 → 官方的 tasks/membership 原样交回（我们不改写）', async () => {
    const ops = await boot({ withTeams: 'ok' })
    const value = (await call(ops, { op: 'team.list', sessionId: ops.sessionId })).value as Record<string, unknown>
    assert.equal((value.tasks as unknown[]).length, 1)
    assert.deepEqual(value.membership, { role: 'lead' })
    assert.equal(ops.teamCalls.length, 1, '官方被问了一次')
    assert.equal(ops.teamCalls[0], ops.agent, 'caller 就是那个活 Agent')
  })

  test('官方抛错（例如 caller 不是成员）→ null，不把异常抛给界面；**但原因必须留在我们自己的诊断文件里**', async () => {
    const ops = await boot({ withTeams: 'throws' })
    const reply = await call(ops, { op: 'team.list', sessionId: ops.sessionId })
    assert.equal(reply.ok, true, '通道永远不因为对方的错而炸')
    assert.equal(reply.value, null)
    // 2026-10-07 真机上 `ctx.logger.warn` 的输出在宿主日志里找不到 ⟹ 写进我们自己的数据目录，
    // 这样"官方为什么拒绝"永远有原文可查（返回值仍保持 null，契约不变）。
    const diag = join(ops.home, REDLINE_DATA_DIR_NAME, teamListErrorFileName(ops.sessionId))
    assert.ok(existsSync(diag), '诊断文件必须被写下：' + diag)
    assert.ok(readFileSync(diag, 'utf8').includes('caller is not a team member'), '原文要在里面')
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
