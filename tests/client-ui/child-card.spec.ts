// 第 5 张【子会话】卡（`docs/10` M3-16/M3-17，随 M5 落地）—— 真 React + jsdom 的自有门禁 lane。
//
// 锁四件事（`docs/03` R5.1 / R5.1.1 / R5.1.3）：
//   ① 卡片只有两块：开子会话 + 子会话索引；索引**不重画会话树**、不给跳转按钮；
//   ② 索引每行说清"这个状态意味着什么"（运行中只能看 / 空闲可进入 / 不在进程只能查看）；
//   ③ `开启子会话` 的门禁与 `保存` **完全一致**（父不 live / 轮次未闭合 → 禁用 + 一句话）；
//   ④ 确认框用**宿主自己的五项**（`child.plan`），第一句话由人写；空任务时按钮禁用并显示拒绝原因；
//      确认只调一次 `child.start`，取消什么都不发生。

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeChildCard, type ChildCardProps } from '../../src/client/components/childCard'
import { childRowsOf, type ChildRow } from '../../src/client/childSessions'
import { DICT_EN } from '../../src/client/i18n'
import { makeKit, mount, query, queryAll, text, type Mounted } from '../client/helpers/kit'

const kit = makeKit()
const Card = makeChildCard(kit)

const PLAN = {
  items: [
    { label: '从哪儿开始', text: '从最后聊完的那一轮开始。' },
    { label: '会带上的改动', text: '你改好的 1 条正文会逐字出现在新会话的第一句话里：#7879。' },
    { label: '第一句话（你来写）', text: '【探针】' },
    { label: '会带什么 / 不带什么', text: '带：历史 + 改动。不带：这边之后的轮次。' },
    { label: '取消', text: '取消就是什么都不发生。' },
  ],
  carriedSeqs: [7879],
  prompt: '【探针】\n\n以下是我在「上下文批改」里改好的上下文……',
  refusal: null,
}

function rows(): ChildRow[] {
  return childRowsOf([
    { id: '92414bcf-396a-4272-9ca1-4486700c6805', mode: 'continuable', label: '上下文批改 · 61dffc3d', createdAt: 0 },
    { id: '66da37b9-4bdb-4b9a-98a4-93c0c1747787', mode: 'one-shot', createdAt: 0 },
  ])
}

async function open(props: Partial<ChildCardProps> = {}): Promise<Mounted> {
  const full = {
    sessionId: 'session-parent',
    rows: rows(),
    live: true,
    turnOpen: false,
    carriedCount: 1,
    plan: () => Promise.resolve({ ok: true as const, value: PLAN }),
    start: () => Promise.resolve({ ok: true as const, value: { label: '上下文批改 · abcd1234', prompt: 'x', carriedSeqs: [7879], started: null } }),
    ...props,
  } as unknown as ChildCardProps
  return await mount(h(Card, full))
}

const spawnButton = (m: Mounted): HTMLButtonElement => query<HTMLButtonElement>(m.container, '[data-redline-spawn]')
const openDialog = async (m: Mounted): Promise<void> => {
  await act(async () => { spawnButton(m).click() })
  await act(async () => { await new Promise(r => setTimeout(r, 300)) })
}

describe('第 5 张卡：子会话索引（只读）', () => {
  test('两块都在：开子会话 + 子会话索引；索引按行列出 id/mode/状态，且**没有**跳转按钮', async () => {
    const m = await open()
    const blocks = queryAll(m.container, '[data-redline-block]').map(e => e.getAttribute('data-redline-block'))
    assert.deepEqual(blocks, ['spawn', 'children', 'team'], '三块：开子会话 + 子会话索引 + 官方团队（只读）；冻结/派活/压缩仍是后续阶段')
    const list = queryAll(m.container, '[data-redline-child]').map(e => e.getAttribute('data-redline-child'))
    assert.deepEqual(list, ['66da37b9-4bdb-4b9a-98a4-93c0c1747787', '92414bcf-396a-4272-9ca1-4486700c6805'], '最新的在前')
    const body = text(m.container)
    assert.ok(body.includes('c1747787') && body.includes('61dffc3d'), '短 id 直接显示')
    assert.ok(body.includes(DICT_EN['child.mode.one-shot']) && body.includes(DICT_EN['child.mode.continuable']))
    // 索引里**只有**开子会话那一个按钮（每行不给"打开"按钮 —— 跳转是后续阶段）
    assert.equal(queryAll(m.container, 'button').length, 1, '索引行本身不带动作')
    await m.unmount()
  })

  test('每一行都写明"这个状态意味着什么"（未探到状态时不冒充空闲）', async () => {
    const m = await open({
      rows: [
        { id: 'run-1', short: 'run-1', label: '', mode: 'continuable', createdAt: 0, live: true, open: true },
        { id: 'idle-2', short: 'idle-2', label: '', mode: 'continuable', createdAt: 0, live: true, open: false },
        { id: 'gone-3', short: 'gone-3', label: '', mode: 'one-shot', createdAt: 0, live: false, open: false },
        { id: 'unk-4', short: 'unk-4', label: '', mode: 'unknown', createdAt: 0, live: null, open: null },
      ],
    })
    const body = text(m.container)
    assert.ok(body.includes(DICT_EN['child.state.running']) && body.includes(DICT_EN['child.hint.running']))
    assert.ok(body.includes(DICT_EN['child.state.idle']) && body.includes(DICT_EN['child.hint.idle']))
    assert.ok(body.includes(DICT_EN['child.state.gone']) && body.includes(DICT_EN['child.hint.gone']))
    assert.ok(body.includes(DICT_EN['child.state.unknown']) && body.includes(DICT_EN['child.hint.unknown']))
    await m.unmount()
  })

  test('没有子会话时给一句话，不画空行', async () => {
    const m = await open({ rows: [] })
    assert.ok(text(m.container).includes(DICT_EN['child.empty']))
    assert.equal(queryAll(m.container, '[data-redline-child]').length, 0)
    await m.unmount()
  })
})

describe('第 5 张卡：开启子会话的门禁（与保存完全一致）', () => {
  for (const [label, live, turnOpen, key] of [
    ['父不在本进程', false, false, 'redline.blocked.notLive'],
    ['父轮次未闭合', true, true, 'redline.blocked.turnOpen'],
  ] as const) {
    test(`${label}：按钮禁用 + 写明原因，点了也不发请求`, async () => {
      let planned = 0
      const m = await open({ live, turnOpen, plan: () => { planned += 1; return Promise.resolve({ ok: true as const, value: PLAN }) } })
      const button = spawnButton(m)
      assert.equal(button.disabled, true, '先是禁用，而不是点了才失败')
      assert.ok(text(m.container).includes(DICT_EN[key]), '原因写在按钮旁边')
      await act(async () => { button.click() })
      assert.equal(planned, 0, '禁用状态下一次请求都不发')
      assert.equal(queryAll(m.container, '[data-redline-confirm]').length, 0, '也不弹确认框')
      await m.unmount()
    })
  }

  test('父可写时按钮可用，且不预先弹框', async () => {
    const m = await open()
    assert.equal(spawnButton(m).disabled, false)
    assert.equal(queryAll(m.container, '[data-redline-confirm]').length, 0)
    await m.unmount()
  })
})

describe('第 5 张卡：确认框（宿主的五项 + 第一句话由人写）', () => {
  test('打开确认框 → 调 child.plan，渲染五项与"会带上的改动"的 seq', async () => {
    const calls: string[] = []
    const m = await open({ plan: (task: string) => { calls.push(task); return Promise.resolve({ ok: true as const, value: PLAN }) } })
    await openDialog(m)
    assert.deepEqual(calls, [''], '第一次用空任务问一次（标签与拒绝都来自宿主）')
    const box = query(m.container, '[data-redline-confirm]')
    const body = text(box)
    for (const item of PLAN.items) assert.ok(body.includes(item.label), `五项里的「${item.label}」要在`)
    assert.ok(body.includes('#7879'), '带过去的改动 seq 明写')
    assert.equal(queryAll(box, '[data-redline-task]').length, 1, '第一句话由人写：有输入框')
    await m.unmount()
  })

  test('空任务：宿主拒绝 → 确认按钮禁用 + 显示那句拒绝（不是死按钮）', async () => {
    const refusal = { code: 'redline/empty-task', message: '第一句话必须你自己写' }
    const m = await open({ plan: () => Promise.resolve({ ok: true as const, value: { ...PLAN, prompt: null, refusal } }) })
    await openDialog(m)
    const box = query(m.container, '[data-redline-confirm]')
    assert.ok(text(box).includes(refusal.message), '拒绝原因原样显示')
    assert.equal(query(m.container, '[data-redline-confirm-ok]').hasAttribute('disabled'), true)
    await m.unmount()
  })

  test('写一句话后按钮可用；确认只调一次 child.start，成功后显示回执', async () => {
    const starts: string[] = []
    const m = await open({
      plan: () => Promise.resolve({ ok: true as const, value: PLAN }),
      start: (task: string) => { starts.push(task); return Promise.resolve({ ok: true as const, value: { via: 'official-member', label: '上下文批改 · abcd1234', prompt: 'p', carriedSeqs: [7879], started: null } }) },
    })
    await openDialog(m)
    const area = query<HTMLTextAreaElement>(m.container, '[data-redline-task]')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(area, '【探针】请只回答四个字：收到探针。')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 300)) })
    const ok = query<HTMLButtonElement>(m.container, '[data-redline-confirm-ok]')
    assert.equal(ok.disabled, false)
    await act(async () => { ok.click() })
    assert.deepEqual(starts, ['【探针】请只回答四个字：收到探针。'], '逐字把用户写的任务交给宿主')
    assert.ok(text(m.container).includes(DICT_EN['child.confirm.started'].replace('{label}', '上下文批改 · abcd1234')))
    // M5-02 的界面半边：走的是哪条路必须如实标出来（官方成员 vs 裸子会话，可管理性完全不同）。
    const via = query(m.container, '[data-redline-via]')
    assert.equal(via.getAttribute('data-redline-via'), 'official-member')
    assert.ok(text(via).includes(DICT_EN['child.via.official']))
    await m.unmount()
  })

  test('取消：什么都不发生（一次 start 都不发）', async () => {
    let started = 0
    const m = await open({ start: () => { started += 1; return Promise.resolve({ ok: true as const, value: { label: 'x', prompt: 'p', carriedSeqs: [], started: null } }) } })
    await openDialog(m)
    await act(async () => { (queryAll(m.container, '[data-redline-confirm] button')[2] as HTMLElement).click() })
    assert.equal(started, 0)
    assert.equal(queryAll(m.container, '[data-redline-confirm]').length, 0, '确认框收起')
    await m.unmount()
  })
})

describe('第 5 张卡：结果回流徽章（读父会话的结算通知）', () => {
  const pendingOf = (childId: string, state: 'unseen' | 'seen' | 'continued') => ([
    { notice: { seq: 42, childId, summary: 'Background subagent finished', at: 1_700_000_000_000 }, state },
  ])

  test('有通知的行显示「已结算 · 未确认」，卡片标题给出待确认计数', async () => {
    const m = await open({ pending: pendingOf('66da37b9-4bdb-4b9a-98a4-93c0c1747787', 'unseen') })
    const badge = query(m.container, '[data-redline-settled]')
    assert.equal(badge.getAttribute('data-redline-settled'), 'unseen')
    const body = text(badge)
    assert.ok(body.includes(DICT_EN['child.settled']), '先说"已结算"')
    assert.ok(body.includes(DICT_EN['child.settled.unseen']), '再说它现在的状态')
    assert.equal(query(m.container, '[data-redline-unseen]').getAttribute('data-redline-unseen'), '1')
    await m.unmount()
  })

  test('三态各自渲染，且**只有**未确认会被计数', async () => {
    const m = await open({
      rows: [
        { id: 'a', short: 'a', label: '', mode: 'continuable', createdAt: 0, live: false, open: false },
        { id: 'b', short: 'b', label: '', mode: 'continuable', createdAt: 0, live: false, open: false },
        { id: 'c', short: 'c', label: '', mode: 'continuable', createdAt: 0, live: false, open: false },
      ],
      pending: [
        { notice: { seq: 1, childId: 'a', summary: 'x', at: 0 }, state: 'unseen' },
        { notice: { seq: 2, childId: 'b', summary: 'y', at: 0 }, state: 'seen' },
        { notice: { seq: 3, childId: 'c', summary: 'z', at: 0 }, state: 'continued' },
      ],
    })
    assert.deepEqual(queryAll(m.container, '[data-redline-settled]').map(e => e.getAttribute('data-redline-settled')), ['unseen', 'seen', 'continued'])
    assert.equal(query(m.container, '[data-redline-unseen]').getAttribute('data-redline-unseen'), '1', '待确认只有那一条')
    await m.unmount()
  })

  test('没有通知就不长徽章（也不显示计数）', async () => {
    const m = await open()
    assert.equal(queryAll(m.container, '[data-redline-settled]').length, 0)
    assert.equal(queryAll(m.container, '[data-redline-unseen]').length, 0)
    await m.unmount()
  })

  test('通知里带的是别的子会话 ⟹ 不贴到这一行上', async () => {
    const m = await open({ pending: pendingOf('not-in-this-list', 'unseen') })
    assert.equal(queryAll(m.container, '[data-redline-settled]').length, 0, '按 childId 对上才贴')
    await m.unmount()
  })
})

describe('第 5 张卡：把通知标为已查看（写的是我们自己的表）', () => {
  const pendingOf = (state: 'unseen' | 'seen' | 'continued') => ([
    { notice: { seq: 42, childId: '66da37b9-4bdb-4b9a-98a4-93c0c1747787', summary: 'x', at: 0 }, state },
  ])

  test('未确认的行给「标为已查看」，按下时带 seq 与 seen=true', async () => {
    const calls: [number, boolean][] = []
    const m = await open({ pending: pendingOf('unseen'), onMarkSeen: (seq, seen) => { calls.push([seq, seen]) } })
    const button = query<HTMLButtonElement>(m.container, '[data-redline-seen]')
    assert.equal(button.getAttribute('data-redline-seen'), '42', '带的是通知的 seq')
    assert.equal(text(button), DICT_EN['child.seen.mark'])
    await act(async () => { button.click() })
    assert.deepEqual(calls, [[42, true]], '点一下就是把这一条标成已查看')
    await m.unmount()
  })

  test('已查看的行给「取消标记」，按下时带 seen=false', async () => {
    const calls: [number, boolean][] = []
    const m = await open({ pending: pendingOf('seen'), onMarkSeen: (seq, seen) => { calls.push([seq, seen]) } })
    const button = query<HTMLButtonElement>(m.container, '[data-redline-seen]')
    assert.equal(text(button), DICT_EN['child.seen.unmark'])
    await act(async () => { button.click() })
    assert.deepEqual(calls, [[42, false]])
    await m.unmount()
  })

  test('已接着做的通知不给标记按钮（父会话自己处理过了，标它没意义）', async () => {
    const m = await open({ pending: pendingOf('continued'), onMarkSeen: () => {} })
    assert.equal(queryAll(m.container, '[data-redline-seen]').length, 0)
    await m.unmount()
  })

  test('标记读写失败时把原因显示出来（不是静默）', async () => {
    const m = await open({ marksError: 'redline/seen-corrupt' })
    const alert = query(m.container, '[role="alert"]')
    assert.ok(text(alert).includes(DICT_EN['redline.err.seen-corrupt']), '人话原样显示')
    await m.unmount()
  })
})

describe('官方团队那块（M5-07 读半边）：只读、三件事都诚实', () => {
  test('投影读不到（null）→ 如实写「这台运行时没有这份数据」，不显示一个空队伍骗人', async () => {
    const m = await open({ team: null })
    const block = query(m.container, '[data-redline-block="team"]')
    assert.ok(text(block).includes(DICT_EN['team.none']))
    assert.equal(queryAll(m.container, '[data-redline-member]').length, 0)
    assert.equal(queryAll(m.container, '[data-redline-task]').length, 0)
    await m.unmount()
  })

  test('官方给了数据 → 名单与任务按行显示（身份/状态/负责人都是官方那份，不改写）', async () => {
    const m = await open({
      team: {
        members: [
          { id: 's-lead', name: '我', role: 'lead', phase: 'active', error: null },
          { id: 's-mate', name: '小王', role: 'teammate', phase: 'provisioning', error: '起不来' },
        ],
        tasks: [{ id: 't-1', revision: 2, subject: '把测试补上', status: 'pending', ownerName: '小王', ready: true }],
        failure: null,
      },
    })
    const block = query(m.container, '[data-redline-block="team"]')
    const body = text(block)
    assert.deepEqual(queryAll(m.container, '[data-redline-member]').map(e => e.getAttribute('data-redline-member')), ['s-lead', 's-mate'])
    assert.deepEqual(queryAll(m.container, '[data-redline-task]').map(e => e.getAttribute('data-redline-task')), ['t-1'])
    assert.ok(body.includes('我') && body.includes('小王'))
    assert.ok(body.includes(DICT_EN['team.role.lead']) && body.includes(DICT_EN['team.role.teammate']))
    assert.ok(body.includes(DICT_EN['team.phase.provisioning']))
    assert.ok(body.includes('把测试补上') && body.includes(DICT_EN['team.task.ready']))
    assert.ok(body.includes(DICT_EN['team.task.owner'].replace('{name}', '小王')), '负责人那句话原样来自官方')
    assert.ok(body.includes('起不来'), '成员级的失败说明原样显示')
    await m.unmount()
  })

  test('官方报的 failure 必须原样显示（空队伍也要显示它）', async () => {
    const m = await open({ team: { members: [], tasks: [], failure: 'team/task 被拒：writeScopes 非法' } })
    const body = text(query(m.container, '[data-redline-block="team"]'))
    assert.ok(body.includes('team/task 被拒：writeScopes 非法'), '静默掉就是骗人')
    assert.ok(body.includes(DICT_EN['team.members.empty']) && body.includes(DICT_EN['team.tasks.empty']))
    await m.unmount()
  })
})

describe('官方团队那块的回退：投影读不到时问宿主（M5-07 / M5-24）', () => {
  const withFetch = async (payload: unknown, run: () => Promise<void>): Promise<void> => {
    const prev = globalThis.fetch
    let called = 0
    globalThis.fetch = (async () => { called++; return Response.json({ ok: true, value: payload }) }) as typeof fetch
    try { await run(); assert.equal(called, 1, '回退只问一次') } finally { globalThis.fetch = prev }
  }

  test('宿主给了任务 → 显示它们，并写明这块是直接问宿主拿的（没有名单）', async () => {
    await withFetch({ tasks: [{ id: 't-9', revision: 1, subject: '回退拿到的任务', status: 'pending', ready: false }], membership: null }, async () => {
      const m = await open({ team: null })
      await act(async () => { await new Promise(r => setTimeout(r, 50)) })
      const body = text(query(m.container, '[data-redline-block="team"]'))
      assert.ok(body.includes(DICT_EN['team.fallback.note']), '要说清来源，不能假装是官方投影给的')
      assert.ok(body.includes('回退拿到的任务'))
      assert.deepEqual(queryAll(m.container, '[data-redline-task]').map(e => e.getAttribute('data-redline-task')), ['t-9'])
      assert.equal(queryAll(m.container, '[data-redline-member]').length, 0, '回退里没有名单，就不显示名单')
      await m.unmount()
    })
  })

  test('投影与宿主都说没有 → 界面才说「这台运行时没有这份数据」', async () => {
    await withFetch(null, async () => {
      const m = await open({ team: null })
      await act(async () => { await new Promise(r => setTimeout(r, 50)) })
      const body = text(query(m.container, '[data-redline-block="team"]'))
      assert.ok(body.includes(DICT_EN['team.none']))
      assert.equal(queryAll(m.container, '[data-redline-task]').length, 0)
      await m.unmount()
    })
  })
})

describe('M5-02 界面半边：走的是哪条路如实标出来', () => {
  const runConfirm = async (via: string | undefined): Promise<Mounted> => {
    const m = await open({
      plan: () => Promise.resolve({ ok: true as const, value: PLAN }),
      start: () => Promise.resolve({ ok: true as const, value: { via, label: '上下文批改 · abcd1234', prompt: 'p', carriedSeqs: [], started: null } }),
    })
    await openDialog(m)
    const area = query<HTMLTextAreaElement>(m.container, '[data-redline-task]')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(area, '继续')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 300)) })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-confirm-ok]').click() })
    return m
  }

  test('兜底路径 → 明说「裸子会话：不在官方名单里，官方界面看不到它」', async () => {
    const m = await runConfirm('bare-child')
    const via = query(m.container, '[data-redline-via]')
    assert.equal(via.getAttribute('data-redline-via'), 'bare-child')
    const body = text(via)
    assert.ok(body.includes(DICT_EN['child.via.bare']), body)
    assert.ok(body.includes('invisible to the official UI'), '不能含糊：官方界面看不到它')
    await m.unmount()
  })

  test('宿主没报路径 → 如实说没拿到，不猜', async () => {
    const m = await runConfirm(undefined)
    const via = query(m.container, '[data-redline-via]')
    assert.equal(via.getAttribute('data-redline-via'), 'unknown')
    assert.ok(text(via).includes(DICT_EN['child.via.unknown']))
    await m.unmount()
  })
})
