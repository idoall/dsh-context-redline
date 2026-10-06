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
    assert.deepEqual(blocks, ['spawn', 'children'], '只有这两块（冻结/派活/压缩/任务板都是后续阶段）')
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
      start: (task: string) => { starts.push(task); return Promise.resolve({ ok: true as const, value: { label: '上下文批改 · abcd1234', prompt: 'p', carriedSeqs: [7879], started: null } }) },
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
