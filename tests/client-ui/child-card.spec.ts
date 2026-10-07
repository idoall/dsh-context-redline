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
  draftRevision: 'd1-test-plan',
  prompt: '【探针】\n\n以下是我在「上下文批改」里改好的上下文……',
  // M2-20：确认框要显示「首条任务有多大」 ⟹ 桩里也得有这份读数。
  metrics: { bytes: 120, lines: 3, edits: 1 },
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
    assert.deepEqual(blocks, ['spawn', 'children'], 'demo 的卡片只有两块：开子会话 + 子会话索引')
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

  test('写一句话后按钮可用；确认只调一次 child.start，带上已审阅的草稿版本并显示回执', async () => {
    const starts: { task: string, revision: string }[] = []
    const m = await open({
      plan: () => Promise.resolve({ ok: true as const, value: PLAN }),
      start: (task: string, revision: string) => { starts.push({ task, revision }); return Promise.resolve({ ok: true as const, value: { via: 'official-member', label: '上下文批改 · abcd1234', prompt: 'p', carriedSeqs: [7879], started: null } }) },
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
    assert.deepEqual(starts, [{ task: '【探针】请只回答四个字：收到探针。', revision: 'd1-test-plan' }], '逐字交任务，同时只允许创建已审阅过的草稿版本')
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

describe('按 demo 撤下的两块（2026-10-02 用户裁定 + 2026-10-07 复核）', () => {
  // 这两样都是用户让删过的：官方团队整块（成员名册 / 任务板）与「标为已查看」。
  // 2026-10-06/07 被按 docs/10 又做回了插件，2026-10-07 用户裁定「按 demo 撤掉」⟹ 这里锁死"不出现"。
  test('卡片只有两块：官方团队块、已查看标记、已结算徽章都不出现', async () => {
    const m = await open()
    const blocks = queryAll(m.container, '[data-redline-block]').map(e => e.getAttribute('data-redline-block'))
    assert.deepEqual(blocks, ['spawn', 'children'], 'demo 的卡片只有这两块')
    assert.equal(queryAll(m.container, '[data-redline-block="team"]').length, 0, '官方团队块已按 demo 撤下')
    assert.equal(queryAll(m.container, '[data-redline-seen]').length, 0, '「标为已查看」已按 demo 撤下')
    assert.equal(queryAll(m.container, '[data-redline-settled]').length, 0, '结算徽章随那两块一起撤下')
    await m.unmount()
  })
})

describe('第 5 张卡：确认框报出「首条任务有多大」（M2-20）', () => {
  test('确认框里有一行读数：字节数原样来自宿主的 metrics', async () => {
    const m = await open()
    await openDialog(m)
    const line = query(m.container, '[data-redline-first-task]')
    assert.equal(line.getAttribute('data-redline-first-task'), '120', '字节数就是宿主给的那个')
    assert.equal(text(line), DICT_EN['child.confirm.metrics'].replace('{bytes}', '120').replace('{edits}', '1'))
    await m.unmount()
  })

  test('宿主没给 metrics（老宿主 / 被拒绝）⟹ 这一行不出现，也不编一个数', async () => {
    const m = await open({ plan: () => Promise.resolve({ ok: true as const, value: { ...PLAN, metrics: null } }) })
    await openDialog(m)
    assert.equal(queryAll(m.container, '[data-redline-first-task]').length, 0, '没有读数就不画这一行')
    await m.unmount()
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

describe('第 5 张卡：容量（M5-13，分母来自活服务、读不到就不写）', () => {
  // demo 的 `活跃 N / 8`：N = **运行中 + 空闲**（= 在场），不是"只有正在跑的"。
  const three = [
    { id: 'a', short: 'a', label: '', mode: 'continuable' as const, createdAt: 0, live: true, open: true },
    { id: 'b', short: 'b', label: '', mode: 'continuable' as const, createdAt: 0, live: true, open: false },
    { id: 'c', short: 'c', label: '', mode: 'continuable' as const, createdAt: 0, live: false, open: false },
  ]
  const scale = (m: Mounted): string => text(query(m.container, '.redline-card-scale'))

  test('知道上限 → 标题写「活跃 2 / 8 · 共 3 个」，且活跃 = 在场（运行中 + 空闲）', async () => {
    const m = await open({ rows: three, capacity: { known: true, max: 8 } })
    assert.equal(scale(m), DICT_EN['child.bmeta.cap'].replace('{a}', '2').replace('{max}', '8').replace('{n}', '3'))
    assert.equal(queryAll(m.container, '[data-redline-cap]').length, 0, '没触顶就不出现那句话')
    await m.unmount()
  })

  test('不知道上限 → 只写「活跃 2 · 共 3 个」，**不写分母**也不写那句话', async () => {
    const m = await open({ rows: three })
    assert.equal(scale(m), DICT_EN['child.bmeta'].replace('{a}', '2').replace('{n}', '3'))
    assert.equal(scale(m).includes('/'), false, '不知道就不许编分母')
    assert.equal(queryAll(m.container, '[data-redline-cap]').length, 0)
    await m.unmount()
  })

  test('触顶 → 给人话（说清是什么上限、下一步做什么），并禁用开启按钮，零计划请求', async () => {
    let planned = 0
    const m = await open({
      rows: three.slice(0, 2),
      capacity: { known: true, max: 2 },
      plan: () => { planned += 1; return Promise.resolve({ ok: true as const, value: PLAN }) },
    })
    const cap = query(m.container, '[data-redline-cap]')
    const body = text(cap)
    assert.equal(body, DICT_EN['child.cap.reached'].replace('{max}', '2'))
    assert.equal(/稍后重试|later/i.test(body), false, '不含糊、不说稍后重试')
    assert.equal(spawnButton(m).disabled, true, '已知触顶时不该诱导一次必然失败的创建')
    await act(async () => { spawnButton(m).click() })
    assert.equal(planned, 0, '禁用状态不许请求 child.plan')
    await m.unmount()
  })
})

describe('第 5 张卡：来源徽章（M5-12，靠我们自己记的台账）', () => {
  // 官方那本子会话目录里**没有来源字段**（只有 mode/label，docs/01 F59）⟹ 来源只能我们自己记。
  // 四种态必须说四句不同的话：本项目发起（官方成员 / 裸子会话）/ 不是在这儿开的 / 来源未知。
  const withVia = (via: 'official-member' | 'bare-child' | null) => [
    { id: 'c1', short: 'c1', label: '', mode: 'continuable' as const, createdAt: 0, live: true, open: false, via },
  ]
  const badge = (m: Mounted): HTMLElement => query<HTMLElement>(m.container, '[data-redline-src]')

  test('台账里记着（官方成员）⟹ "本项目发起 · 官方成员"', async () => {
    const m = await open({ rows: withVia('official-member') })
    assert.equal(badge(m).getAttribute('data-redline-src'), 'own')
    assert.equal(text(badge(m)), DICT_EN['child.src.own.official'])
    await m.unmount()
  })

  test('台账里记着（裸子会话）⟹ "本项目发起 · 裸子会话"', async () => {
    const m = await open({ rows: withVia('bare-child') })
    assert.equal(text(badge(m)), DICT_EN['child.src.own.bare'])
    await m.unmount()
  })

  test('台账里没有这条 ⟹ "不是在这儿开的"（**不猜**是谁开的）', async () => {
    const m = await open({ rows: withVia(null) })
    assert.equal(badge(m).getAttribute('data-redline-src'), 'other')
    assert.equal(text(badge(m)), DICT_EN['child.src.other'])
    await m.unmount()
  })

  test('台账读不出来 ⟹ "来源未知"（**不许**说成"不是在这儿开的"）', async () => {
    const m = await open({ rows: withVia(null), originsKnown: false })
    assert.equal(badge(m).getAttribute('data-redline-src'), 'unknown')
    assert.equal(text(badge(m)), DICT_EN['child.src.unknown'])
    assert.notEqual(text(badge(m)), DICT_EN['child.src.other'], '没有证据就不许下结论')
    await m.unmount()
  })

  test('台账读不出来时**把原因说出来**（错误码 → 人话，不许只写"来源未知"）', async () => {
    const m = await open({ rows: withVia(null), originsKnown: false, originsError: 'redline/origin-corrupt' })
    const line = query(m.container, '[data-redline-origins-error]')
    assert.equal(line.getAttribute('data-redline-origins-error'), 'redline/origin-corrupt')
    assert.equal(text(line), DICT_EN['redline.err.origin-corrupt'], '原料是错误码，界面给的是人话')
    assert.equal(text(line).includes('origin-corrupt'), false, '不许把码直接丢给人看')
    await m.unmount()
  })
})
