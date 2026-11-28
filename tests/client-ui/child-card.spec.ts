// 第 5 张【子会话】卡（`docs/10` M3-16/M3-17，随 M5 落地）—— 真 React + jsdom 的自有门禁 lane。
//
// 锁四件事（`docs/03` R5.1 / R5.1.1 / R5.1.3）：
//   ① 卡片只有两块：开子会话 + 子会话索引；索引**不重画会话树**、不给跳转按钮；
//   ② 索引每行说清"这个状态意味着什么"（运行中只能看 / 空闲可进入 / 不在进程只能查看）；
//   ③ `开启子会话` 的门禁与 `保存` **完全一致**（父不 live / 轮次未闭合 → 禁用 + 一句话）；
//   ④ 确认框用**宿主自己的五项**（`child.plan`），第一句话由人写；空任务时按钮禁用并显示拒绝原因；
//      确认只调一次 `child.start`，取消什么都不发生。

import { act, createElement as h } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { makeChildCard, type ChildCardProps } from '../../src/client/components/childCard'
import { childRowsOf, type ChildRow } from '../../src/client/childSessions'
import { DICT_EN } from '../../src/client/i18n'
import { makeKit, mount, query, queryAll, text, type Mounted } from '../client/helpers/kit'

/** 确认框样式表原文：下面两条真机回归就是拿它判的。 */
const CONFIRM_CSS = readFileSync(join(process.cwd(), 'src/client/styles/childCard.css'), 'utf8')
const ruleOf = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(CONFIRM_CSS)?.[1] ?? ''
}

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
  excludedSeqs: [],
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
    planAnchor: () => Promise.resolve({
      ok: true as const,
      value: {
        snapshot: '目标：目标\n\n验收：验收\n\n纪律：纪律', snapshotFingerprint: 'sf', requestFingerprint: 'rf',
        title: '目标', workspaceId: 'workspace', config: { agentPreset: 'standard', provider: 'provider-a', model: 'model-a' },
        cwd: '/Volumes/SSD/Home/lionm4/my_project/_AI/x9Copy',
      },
    }),
    startAnchor: () => Promise.resolve({
      ok: true as const,
      value: { sessionId: 'session-anchor-test', title: '目标', mode: 'created' as const, delivery: 'sent' as const, messageId: 'm1' },
    }),
    openSession: () => {},
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
    assert.equal(queryAll(m.container, 'button').length, 2, '开子会话 + 新建带规则的对话；索引行本身不带动作')
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

  test('宿主内部错误会保留具体原因，而不是笼统说保存失败', async () => {
    const m = await open({ plan: () => Promise.resolve({ ok: false as const, code: 'redline/internal', message: 'source workspace is unavailable' }) })
    await openDialog(m)
    const error = query(m.container, '[role="alert"]')
    assert.ok(text(error).includes('source workspace is unavailable'))
    await m.unmount()
  })

  // 用户 2026-10-08：「子会话的第一句话必须由你自己写 —— 这是它在做的事，不能替你决定。」可以去掉。
  // 口径改为：**按钮禁用**（拒绝仍生效、仍可观测），但**不再把那句话打在弹窗里**。
  test('空任务：宿主拒绝 → 确认按钮禁用、拒绝状态可观测，但不再显示那句话', async () => {
    const refusal = { code: 'redline/empty-task', message: '第一句话必须你自己写' }
    const m = await open({ plan: () => Promise.resolve({ ok: true as const, value: { ...PLAN, prompt: null, refusal } }) })
    await openDialog(m)
    const box = query(m.container, '[data-redline-confirm]')
    assert.equal(query(m.container, '[data-redline-confirm-ok]').hasAttribute('disabled'), true, '拒绝时按钮禁用')
    assert.equal(query(box, '[data-redline-refusal]').getAttribute('data-redline-refusal'), refusal.code, '拒绝状态仍在（挂在任务块上）')
    assert.equal(text(box).includes(refusal.message), false, '那句拒绝话术不再显示')
    await m.unmount()
  })

  test('写一句话后按钮可用；确认只调一次 child.start，带上已审阅的草稿版本并关闭确认框回到子会话索引', async () => {
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
    assert.equal(queryAll(m.container, '[data-redline-confirm]').length, 0, '成功后不保留第二张成功回执页；回到卡片索引等待投影刷新')
    assert.equal(queryAll(m.container, '[data-redline-started]').length, 0, '不在确认框内重复呈现创建结果')
    await m.unmount()
  })

  test('可直接改最终发送全文并为新会话选择其他模型与推理档', async () => {
    const starts: unknown[][] = []
    const modernPlan = { ...PLAN, config: { agentPreset: 'standard', provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' } }
    const models = [
      { provider: 'provider-a', providerName: 'Provider A', model: 'model-a', modelName: 'Model A', efforts: [{ id: 'low', name: 'Low' }] },
      { provider: 'provider-b', providerName: 'Provider B', model: 'model-b', modelName: 'Model B', efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
    ]
    const m = await open({
      models,
      plan: () => Promise.resolve({ ok: true as const, value: modernPlan }),
      start: (...args: unknown[]) => { starts.push(args); return Promise.resolve({ ok: true as const, value: { label: 'x', prompt: 'p', carriedSeqs: [], started: null } }) },
    })
    await openDialog(m)
    const initialEffort = query<HTMLButtonElement>(m.container, '[data-redline-effort]')
    assert.ok(text(initialEffort).includes(DICT_EN['child.confirm.effortDefault']), '即使来源显式为 low，也统一从模型默认值开始')
    const final = query<HTMLTextAreaElement>(m.container, '[data-redline-final]')
    assert.equal(final.value, PLAN.prompt, '默认就是宿主拼好的实际发送全文')
    assert.equal(final.rows, 6, '默认只显示六行，长文本在文本框自身滚动')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(final, '我直接改好的最终全文')
      final.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const model = query<HTMLButtonElement>(m.container, '[data-redline-model]')
    assert.equal(model.tagName, 'BUTTON', '跟输入框一样使用紧凑按钮，不再渲染原生 select')
    assert.equal(queryAll(m.container, '.redline-picker-bar select').length, 0)
    assert.equal(queryAll(m.container, '[data-redline-picker]').length, 1, '模型与推理等级只占一行')
    await act(async () => { model.click() })
    let modelMenu = query<HTMLElement>(document.body, '[data-redline-picker-menu="model"]')
    assert.ok(modelMenu.scrollHeight >= modelMenu.clientHeight, '模型列表允许滚动')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(queryAll(document.body, '[data-redline-picker-menu]').length, 0, 'Esc 关闭浮层')
    await act(async () => { model.click() })
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    assert.equal(queryAll(document.body, '[data-redline-picker-menu]').length, 0, '点击外部关闭浮层')
    await act(async () => { model.click() })
    modelMenu = query<HTMLElement>(document.body, '[data-redline-picker-menu="model"]')
    const modelB = queryAll<HTMLButtonElement>(modelMenu, '[role="menuitemradio"]').find(button => text(button).includes('Model B'))
    assert.ok(modelB !== undefined)
    await act(async () => { modelB.click() })
    const effort = query<HTMLButtonElement>(m.container, '[data-redline-effort]')
    assert.ok(text(effort).includes(DICT_EN['child.confirm.effortDefault']), '换模型后统一回到模型默认推理档')
    await act(async () => { effort.click() })
    const effortMenu = query<HTMLElement>(document.body, '[data-redline-picker-menu="effort"]')
    const high = queryAll<HTMLButtonElement>(effortMenu, '[role="menuitemradio"]').find(button => text(button).includes('High'))
    assert.ok(high !== undefined)
    await act(async () => { high.click() })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-confirm-ok]').click() })
    assert.deepEqual(starts[0], ['', 'd1-test-plan', '我直接改好的最终全文', { provider: 'provider-b', model: 'model-b', reasoningEffort: 'high' }])
    await m.unmount()
  })

  test('取消：什么都不发生（一次 start 都不发）', async () => {
    let started = 0
    const m = await open({ start: () => { started += 1; return Promise.resolve({ ok: true as const, value: { label: 'x', prompt: 'p', carriedSeqs: [], started: null } }) } })
    await openDialog(m)
    await act(async () => { (query(m.container, '[data-redline-confirm] .redline-confirm-btn-cancel') as HTMLElement).click() })
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
  test('确认框读数跟随最终发送全文，而不是停在宿主最初拼好的旧字节数', async () => {
    const m = await open()
    await openDialog(m)
    const line = query(m.container, '[data-redline-first-task]')
    const bytes = String(new TextEncoder().encode(PLAN.prompt).byteLength)
    assert.equal(line.getAttribute('data-redline-first-task'), bytes)
    assert.equal(text(line), DICT_EN['child.confirm.metrics'].replace('{bytes}', bytes).replace('{edits}', '1'))
    await m.unmount()
  })

  test('宿主没给 metrics（老宿主 / 被拒绝）⟹ 这一行不出现，也不编一个数', async () => {
    const m = await open({ plan: () => Promise.resolve({ ok: true as const, value: { ...PLAN, metrics: null } }) })
    await openDialog(m)
    assert.equal(queryAll(m.container, '[data-redline-first-task]').length, 0, '没有读数就不画这一行')
    await m.unmount()
  })
})

describe('确认成功后的结果呈现', () => {
  test('创建结果由子会话索引承接：确认框不会再复制一张「已开启」页面', async () => {
    const m = await open({
      rows: [{ id: 'new-child', short: 'new-child', label: '上下文批改 · 新建', mode: 'continuable', createdAt: 0, live: true, open: true, via: 'official-member' }],
      plan: () => Promise.resolve({ ok: true as const, value: PLAN }),
      start: () => Promise.resolve({ ok: true as const, value: { via: 'official-member', label: '上下文批改 · 新建', prompt: 'p', carriedSeqs: [], started: null } }),
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
    assert.equal(queryAll(m.container, '[data-redline-confirm]').length, 0)
    const row = query(m.container, '[data-redline-child="new-child"]')
    assert.ok(text(row).includes(DICT_EN['child.src.own.official']), '来源在索引中如实呈现')
    await m.unmount()
  })
})

describe('承载会话不受 Agent Team 成员上限限制', () => {
  const three = [
    { id: 'a', short: 'a', label: '', mode: 'continuable' as const, createdAt: 0, live: true, open: true },
    { id: 'b', short: 'b', label: '', mode: 'continuable' as const, createdAt: 0, live: true, open: false },
    { id: 'c', short: 'c', label: '', mode: 'continuable' as const, createdAt: 0, live: false, open: false },
  ]
  const scale = (m: Mounted): string => text(query(m.container, '.redline-card-scale'))

  test('即使旧团队服务报触顶，普通承载会话入口仍可用且不显示团队分母', async () => {
    const m = await open({ rows: three, capacity: { known: true, max: 2 } })
    assert.equal(scale(m), DICT_EN['child.bmeta'].replace('{a}', '2').replace('{n}', '3'))
    assert.equal(queryAll(m.container, '[data-redline-cap]').length, 0)
    assert.equal(spawnButton(m).disabled, false)
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

// ── 两条**真机回归**（2026-10-08 用户实测报的），用样式表原文钉死，避免再犯 ──────────
// ① 底栏原来靠另一条通用规则提供 `display:flex`；重写时删掉后，`justify-content:flex-end`
//    与 `gap` 全部失效 ⟹ 按钮左对齐且贴在一起。
// ② 浅色主题下 `--dsw-alias-bg-base` / `bg-layer-1..3` 实测**全是 `#fff`** ⟹ 首条任务块与
//    输入框不能再用它们，否则纯白叠纯白、看不出是输入区；`label-dimmed`（浅色 #e1e5ee）
//    也不能当 placeholder 色，几乎不可见。
describe('确认框样式的两条真机回归', () => {
  test('底栏自己声明 display:flex（否则右对齐与间距全失效）', () => {
    const foot = ruleOf('.redline-modal-card[data-redline-confirm] .redline-modal-foot')
    assert.ok(/display:\s*flex/.test(foot), '底栏必须自己声明 display:flex，不能依赖别处的通用规则')
    assert.ok(/justify-content:\s*flex-end/.test(foot), '两个按钮要靠右')
    assert.ok(/gap:\s*[1-9]/.test(foot), '两个按钮之间必须有间距')
  })

  test('首条任务块与输入框不许用"浅色下等于纯白"的令牌，placeholder 不许用 label-dimmed', () => {
    const task = ruleOf('.redline-confirm-task')
    assert.ok(!/bg-layer-2|bg-layer-3|bg-base/.test(task), '整块底色若取后者，浅色主题下等于 #fff，与卡片无差别')
    assert.ok(/interactive-bg-hover-solid/.test(task), '整块底色用 interactive-bg-hover-solid（浅 #f1f3f5 / 深 #353638）')
    const area = ruleOf('.redline-confirm-task textarea')
    assert.ok(!/bg-layer-2|bg-layer-3/.test(area), '输入框底色不要用与块相同的令牌')
    assert.ok(/border-l4/.test(area), '输入框需要看得见的边框')
    const ph = /\.redline-confirm-task textarea::placeholder\s*\{([^}]*)\}/.exec(CONFIRM_CSS)?.[1] ?? ''
    assert.ok(/label-caption/.test(ph), 'placeholder 用 label-caption')
    assert.ok(!/label-dimmed/.test(ph), 'label-dimmed 在浅色下是 #e1e5ee，当文字色几乎看不见')
  })
})

describe('首尾锚点（0.2.0）', () => {
  test('可选锚点输入框会重新规划，并在确认时随任务交给宿主；空锚点保持旧调用', async () => {
    const plans: { task: string, anchor?: string }[] = []
    const starts: unknown[][] = []
    const modernPlan = {
      ...PLAN,
      config: { agentPreset: 'standard', provider: 'provider-a', model: 'model-a' },
      prompt: '任务\n\n【锚点】\n必须用 TypeScript。',
    }
    const models = [{ provider: 'provider-a', providerName: 'A', model: 'model-a', modelName: 'A', efforts: [] }]
    const m = await open({
      models,
      plan: (task: string, anchor?: string) => {
        plans.push({ task, anchor })
        return Promise.resolve({ ok: true as const, value: modernPlan })
      },
      start: (...args: unknown[]) => {
        starts.push(args)
        return Promise.resolve({ ok: true as const, value: { label: 'x', prompt: 'p', carriedSeqs: [], started: null } })
      },
    })
    await openDialog(m)
    const anchor = query<HTMLTextAreaElement>(m.container, '[data-redline-anchor]')
    assert.equal(anchor.value, '', '默认空锚点')
    assert.ok(text(m.container).includes(DICT_EN['child.confirm.anchorLabel']))
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(anchor, '必须用 TypeScript。')
      anchor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 300)) })
    assert.ok(plans.some(plan => plan.anchor === '必须用 TypeScript。'), '锚点变化会重新规划')
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-confirm-ok]').click() })
    assert.deepEqual(starts[0]?.slice(-2), ['必须用 TypeScript。', 'message'], '确认时锚点与生效方式一起交给宿主')
    await m.unmount()
  })
})

describe('运行时规则模式（0.3.0）', () => {
  test('填锚点后可切到每轮运行时规则；重新规划并在确认时把模式交给宿主', async () => {
    const plans: { anchor?: string, mode?: string }[] = []
    const starts: unknown[][] = []
    const modernPlan = {
      ...PLAN,
      config: { agentPreset: 'standard', provider: 'provider-a', model: 'model-a' },
      prompt: '任务\n\n以下是经你确认后迁移到这个零历史新会话的上下文。',
    }
    const models = [{ provider: 'provider-a', providerName: 'A', model: 'model-a', modelName: 'A', efforts: [] }]
    const m = await open({
      models,
      plan: (_task: string, anchor?: string, mode?: string) => {
        plans.push({ anchor, mode })
        return Promise.resolve({ ok: true as const, value: modernPlan })
      },
      start: (...args: unknown[]) => {
        starts.push(args)
        return Promise.resolve({ ok: true as const, value: { label: 'x', prompt: 'p', carriedSeqs: [], started: null } })
      },
    })
    await openDialog(m)
    const anchor = query<HTMLTextAreaElement>(m.container, '[data-redline-anchor]')
    const runtime = query<HTMLButtonElement>(m.container, '[data-redline-anchor-mode="runtime"]')
    assert.equal(runtime.disabled, true, '空锚点不能选运行时模式')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(anchor, '保持用户意图优先级')
      anchor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 300)) })
    const enabled = query<HTMLButtonElement>(m.container, '[data-redline-anchor-mode="runtime"]')
    assert.equal(enabled.disabled, false)
    await act(async () => { enabled.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 300)) })
    assert.ok(plans.some(plan => plan.mode === 'runtime'), '切换模式会重新规划')
    assert.equal(queryAll(m.container, '[data-redline-anchor-runtime-note]').length, 1, '运行时模式给出说明')
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-confirm-ok]').click() })
    assert.deepEqual(starts[0]?.slice(-2), ['保持用户意图优先级', 'runtime'])
    await m.unmount()
  })
})

describe('锚定会话（0.4.0）', () => {
  test('新入口打开三段式确认框：目标跟随任务、预览精确快照、确认后打开新会话', async () => {
    const plans: { task?: string, goal?: string }[] = []
    const starts: unknown[][] = []
    const opened: string[] = []
    const anchorPlan = {
      snapshot: '目标：目标 A\n\n验收：验收 A\n\n纪律：纪律 A',
      snapshotFingerprint: 'snapshot-fp',
      requestFingerprint: 'request-fp',
      title: '目标 A',
      workspaceId: 'workspace',
      config: { agentPreset: 'standard', provider: 'provider-a', model: 'model-a' },
    }
    const m = await open({
      planAnchor: (input) => {
        plans.push({ task: input.task, goal: input.goal })
        return Promise.resolve({ ok: true as const, value: anchorPlan })
      },
      startAnchor: (...args) => {
        starts.push(args)
        return Promise.resolve({
          ok: true as const,
          value: { sessionId: 'session-anchor-created', title: '目标 A', mode: 'created' as const, delivery: 'sent' as const, messageId: 'm1' },
        })
      },
      openSession: (id) => { opened.push(id) },
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    assert.ok(modal, '锚定会话确认框出现')
    const setValue = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setValue('[data-redline-anchor-task]', '任务 A')
    assert.equal(query<HTMLTextAreaElement>(modal, '[data-redline-anchor-goal]').value, '任务 A', '目标默认跟随首条任务')
    await setValue('[data-redline-anchor-acceptance]', '验收 A')
    assert.ok(query<HTMLTextAreaElement>(modal, '[data-redline-anchor-discipline]').value.includes('不得因为出错而修改目标'))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    assert.equal(text(query(modal, '[data-redline-anchor-snapshot]')), anchorPlan.snapshot, '预览就是宿主返回的精确快照')
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
    assert.equal(starts.length, 1)
    const args = starts[0] ?? []
    assert.equal(typeof args[0], 'string', '带上稳定的 operationId')
    assert.deepEqual((args[1] as { task: string, goal: string }).task, '任务 A')
    assert.equal(args[2], 'snapshot-fp')
    assert.equal(args[3], 'request-fp')
    assert.deepEqual(opened, ['session-anchor-created'])
    assert.equal(queryAll(m.container, '[data-redline-anchor-modal]').length, 0, '创建后关闭确认框')
    await m.unmount()
  })

  test('督导运行：先建记录目录（两步进度），再带着 runId 创建会话', async () => {
    const prepared: { tasks?: string }[] = []
    const starts: unknown[][] = []
    let finishPrepare: ((value: { ok: true, value: { runId: string, root: string, files: string[] } }) => void) | undefined
    const m = await open({
      prepareGuard: (input) => {
        prepared.push({ tasks: input.tasks })
        return new Promise(resolve => { finishPrepare = resolve })
      },
      startAnchor: (...args) => {
        starts.push(args)
        return Promise.resolve({
          ok: true as const,
          value: { sessionId: 'session-supervised', title: '目标', mode: 'created' as const, delivery: 'sent' as const, messageId: 'm1' },
        })
      },
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    const setValue = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setValue('[data-redline-anchor-task]', '任务 A')
    await setValue('[data-redline-anchor-acceptance]', '验收 A')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor]').click() })
    await setValue('[data-redline-anchor-supervisor-tasks]', 'T1 | 落盘 | 文件存在')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })

    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
    const progress = query<HTMLElement>(modal, '[data-redline-anchor-progress]')
    assert.ok(progress, '创建过程中出现两步进度')
    assert.ok(text(progress).includes(DICT_EN['anchor.stepCard']))
    assert.ok(text(progress).includes(DICT_EN['anchor.stepPrepare']))
    assert.deepEqual(prepared, [{ tasks: 'T1 | 落盘 | 文件存在' }])

    await act(async () => {
      finishPrepare?.({
        ok: true,
        value: { runId: '20261124-督导', root: '/tmp/run', files: ['tasks.json', 'TASKS.md', 'tasks/T1/notes.md'] },
      })
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    assert.equal(starts.length, 1)
    const input = starts[0]?.[1] as { guardRunId?: string }
    assert.equal(input.guardRunId, '20261124-督导')
    await m.unmount()
  })

  test('督导运行：勾选 worktree 后把隔离检出路径交给宿主（首次点击即生效）', async () => {
    const prepared: { tasks?: string, worktree?: boolean, runId?: string }[] = []
    const starts: unknown[][] = []
    const m = await open({
      prepareGuard: (input) => {
        prepared.push({
          tasks: input.tasks,
          ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
          ...(input.runId === undefined ? {} : { runId: input.runId }),
        })
        return Promise.resolve({
          ok: true as const,
          value: {
            runId: '20261124-worktree',
            root: '/repo/.guard/worktrees/20261124-worktree/docs/guard/20261124-worktree',
            files: ['tasks.json'],
            worktreePath: '/repo/.guard/worktrees/20261124-worktree',
          },
        })
      },
      startAnchor: (...args) => {
        starts.push(args)
        return Promise.resolve({
          ok: true as const,
          value: { sessionId: 'session-worktree', title: '目标', mode: 'created' as const, delivery: 'sent' as const, messageId: 'm1' },
        })
      },
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    const setValue = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setValue('[data-redline-anchor-task]', '任务 A')
    await setValue('[data-redline-anchor-acceptance]', '验收 A')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor]').click() })
    await setValue('[data-redline-anchor-supervisor-tasks]', 'T1 | 落盘 | 文件存在')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor-worktree]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })

    assert.deepEqual(prepared, [{ tasks: 'T1 | 落盘 | 文件存在', worktree: true }])
    assert.equal(starts.length, 1)
    const input = starts[0]?.[1] as { guardRunId?: string, guardWorktreePath?: string }
    assert.equal(input.guardRunId, '20261124-worktree')
    assert.equal(input.guardWorktreePath, '/repo/.guard/worktrees/20261124-worktree', '首次点击就必须带上隔离检出路径')
    await m.unmount()
  })

  test('督导运行：检测到 git 仓库时默认勾选独立 worktree，并说明为什么', async () => {
    const prepared: { worktree?: boolean }[] = []
    const m = await open({
      readRepo: () => Promise.resolve({
        ok: true as const,
        value: { isGit: true, branch: 'dev', defaultBranch: 'main', remoteKind: 'gitlab' as const, remoteHost: 'lionm4' },
      }),
      prepareGuard: (input) => {
        prepared.push(input.worktree === undefined ? {} : { worktree: input.worktree })
        return Promise.resolve({
          ok: true as const,
          value: {
            runId: '20261124-auto-wt',
            root: '/repo/.guard/worktrees/20261124-auto-wt/docs/guard/20261124-auto-wt',
            files: ['tasks.json'],
            worktreePath: '/repo/.guard/worktrees/20261124-auto-wt',
          },
        })
      },
      startAnchor: () => Promise.resolve({
        ok: true as const,
        value: { sessionId: 'session-auto-wt', title: '目标', mode: 'created' as const, delivery: 'sent' as const, messageId: 'm1' },
      }),
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    const setValue = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setValue('[data-redline-anchor-task]', '任务 A')
    await setValue('[data-redline-anchor-acceptance]', '验收 A')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor]').click() })
    await setValue('[data-redline-anchor-supervisor-tasks]', 'T1 | 落盘 | 文件存在')
    // Nothing was clicked on the worktree row: the detected repository is what
    // checks it, so an in-place run cannot happen by accident.
    assert.ok(query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor-worktree]').checked)
    assert.ok(text(modal).includes(DICT_EN['anchor.supervisorRepoGitlab'].replace('{branch}', 'dev')))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    assert.deepEqual(prepared, [{ worktree: true }])
    await m.unmount()
  })

  test('督导运行：默认分支上取消隔离 worktree 时给出警告，取消本身被尊重', async () => {
    const m = await open({
      readRepo: () => Promise.resolve({
        ok: true as const,
        value: { isGit: true, branch: 'main', defaultBranch: 'main' },
      }),
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor]').click() })
    const worktree = query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor-worktree]')
    assert.equal(worktree.checked, true, 'a git repository defaults to the isolated checkout')
    await act(async () => { worktree.click() })
    assert.equal(worktree.checked, false, 'the human can always turn the default off')
    assert.equal(queryAll(modal, '[data-redline-anchor-worktree-warn]').length, 1)
    assert.ok(text(modal).includes(DICT_EN['anchor.supervisorWorktreeMainWarn'].replace('{branch}', 'main')))
    await m.unmount()
  })

  test('督导运行：不是 git 仓库时保持不勾选（没有仓库可隔离）', async () => {
    const m = await open({
      readRepo: () => Promise.resolve({ ok: true as const, value: { isGit: false } }),
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor]').click() })
    assert.equal(query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor-worktree]').checked, false)
    assert.equal(queryAll(modal, '[data-redline-anchor-repo-hint]').length, 0)
    await m.unmount()
  })

  test('督导运行：探针行被解析成插件自己运行的命令探针', async () => {
    const prepared: { probes?: readonly { id: string, taskId: string, spec: { kind: string, cmd: string, args: readonly string[] } }[] }[] = []
    const m = await open({
      prepareGuard: (input) => {
        prepared.push({ ...(input.probes === undefined ? {} : { probes: input.probes as never }) })
        return Promise.resolve({
          ok: true as const,
          value: { runId: '20261124-probe', root: '/tmp/run', files: ['tasks.json'] },
        })
      },
      startAnchor: () => Promise.resolve({
        ok: true as const,
        value: { sessionId: 'session-probe', title: '目标', mode: 'created' as const, delivery: 'sent' as const, messageId: 'm1' },
      }),
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    const setArea = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const setProbes = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setArea('[data-redline-anchor-task]', '任务 A')
    await setArea('[data-redline-anchor-acceptance]', '验收 A')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor]').click() })
    await setArea('[data-redline-anchor-supervisor-tasks]', 'T1 | 落盘 | 文件存在')
    await setProbes('[data-redline-anchor-supervisor-probes]', 'T1 | pnpm test -- --run')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    assert.equal(prepared.length, 1)
    const probes = prepared[0]?.probes ?? []
    assert.equal(probes.length, 1)
    assert.equal(probes[0]?.taskId, 'T1')
    assert.equal(probes[0]?.spec.kind, 'command')
    assert.equal(probes[0]?.spec.cmd, 'pnpm')
    assert.deepEqual(probes[0]?.spec.args, ['test', '--', '--run'])
    await m.unmount()
  })

  test('督导运行：改动任务表会让已建目录失效，重试时用同一 runId 重写台账', async () => {
    const prepared: { runId?: string, tasks?: string }[] = []
    let attempt = 0
    const m = await open({
      prepareGuard: (input) => {
        prepared.push({ tasks: input.tasks, ...(input.runId === undefined ? {} : { runId: input.runId }) })
        return Promise.resolve({
          ok: true as const,
          value: { runId: '20261124-retry', root: '/tmp/run', files: ['tasks.json'] },
        })
      },
      startAnchor: () => {
        attempt += 1
        if (attempt === 1) return Promise.resolve({ ok: false as const, code: 'redline/internal', message: '宿主炸了' })
        return Promise.resolve({
          ok: true as const,
          value: { sessionId: 'session-retry', title: '目标', mode: 'created' as const, delivery: 'sent' as const, messageId: 'm1' },
        })
      },
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    const setValue = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setValue('[data-redline-anchor-task]', '任务 A')
    await setValue('[data-redline-anchor-acceptance]', '验收 A')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor]').click() })
    await setValue('[data-redline-anchor-supervisor-tasks]', 'T1 | 落盘 | 文件存在')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    assert.match(text(modal), /宿主炸了/, '失败原因照原文展示')

    // Edit the task table, then retry: the run must be re-prepared with the SAME
    // run id so no orphan directory is left behind.
    await setValue('[data-redline-anchor-supervisor-tasks]', 'T2 | 换一条 | 通过')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })

    assert.deepEqual(prepared, [
      { tasks: 'T1 | 落盘 | 文件存在' },
      { tasks: 'T2 | 换一条 | 通过', runId: '20261124-retry' },
    ])
    await m.unmount()
  })

  test('不安全上下文（http 局域网地址）不崩溃：缺少 randomUUID 时仍能渲染并发起', async () => {
    // 真机回归：DSH 以 http://<局域网IP>:<端口> 打开时不是 secure context，
    // crypto.randomUUID 为 undefined，卡片一渲染就抛
    // "crypto.randomUUID is not a function"（0.8.4 修复）。
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 29 + 3) & 0xff
        return bytes
      },
    })
    try {
      const starts: unknown[][] = []
      const m = await open({
        startAnchor: (...args) => {
          starts.push(args)
          return Promise.resolve({
            ok: true as const,
            value: { sessionId: 'session-anchor-insecure', title: '目标', mode: 'created' as const, delivery: 'sent' as const, messageId: 'm1' },
          })
        },
      })
      assert.ok(query(m.container, '[data-redline-spawn]'), '卡片照常渲染')
      await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
      const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
      const setValue = async (selector: string, value: string): Promise<void> => {
        const area = query<HTMLTextAreaElement>(modal, selector)
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
          setter?.call(area, value)
          area.dispatchEvent(new Event('input', { bubbles: true }))
        })
      }
      await setValue('[data-redline-anchor-task]', '任务 A')
      await setValue('[data-redline-anchor-acceptance]', '验收 A')
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
      await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
      assert.equal(starts.length, 1)
      assert.match(
        String(starts[0]?.[0]),
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        'operationId 仍是合法 UUID',
      )
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('督导运行：评估模型选择与旧目标守卫下线', () => {
  test('弹窗不再显示旧目标守卫，并在督导运行中提供独立评估模型与推理等级双段选择器', async () => {
    const prepared: unknown[] = []
    const m = await open({
      models: [
        { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat', modelName: 'DeepSeek Chat', efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }] },
        { provider: 'anthropic', providerName: 'Anthropic', model: 'claude-sonnet', modelName: 'Claude Sonnet', efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }] },
      ],
      prepareGuard: (input) => {
        prepared.push(input)
        return Promise.resolve({ ok: true as const, value: { runId: 'r-eval', root: '/tmp/r-eval', files: ['tasks.json'] } })
      },
      startAnchor: () => Promise.resolve({
        ok: true as const,
        value: { sessionId: 'session-supervisor-eval', title: '目标', mode: 'created' as const, delivery: 'sent' as const, messageId: 'm1' },
      }),
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    assert.equal(queryAll(modal, '[data-redline-anchor-guard]').length, 0, '旧目标守卫入口已下线')
    const setValue = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setValue('[data-redline-anchor-task]', '任务 A')
    await setValue('[data-redline-anchor-acceptance]', '验收 A')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor]').click() })
    await setValue('[data-redline-anchor-supervisor-tasks]', 'T1 | one | e1 | src/a.ts')

    // Uses the custom two-segment picker (model + effort), never a bare native <select>.
    assert.equal(queryAll(modal, '[data-redline-anchor-supervisor-options] select').length, 0)
    const evalBtn = query<HTMLButtonElement>(modal, '[data-redline-anchor-supervisor-evaluator]')
    assert.equal(evalBtn.tagName, 'BUTTON')
    assert.ok(text(evalBtn).includes(DICT_EN['anchor.supervisorEvaluatorSame']), '评估模型默认跟随主会话')
    const evalEffortBtn = query<HTMLButtonElement>(modal, '[data-redline-anchor-supervisor-evaluator-effort]')
    assert.equal(evalEffortBtn.disabled, true, '跟随主会话时评估推理等级禁用')

    await act(async () => { evalBtn.click() })
    const modelMenu = query<HTMLElement>(document.body, '[data-redline-picker-menu="model"]')
    const claude = queryAll<HTMLButtonElement>(modelMenu, '[role="menuitemradio"]').find(btn => text(btn).includes('Claude Sonnet'))
    assert.ok(claude !== undefined)
    await act(async () => { claude.click() })
    assert.equal(evalEffortBtn.disabled, false)

    await act(async () => { evalEffortBtn.click() })
    const effortMenu = query<HTMLElement>(document.body, '[data-redline-picker-menu="effort"]')
    const maxBtn = queryAll<HTMLButtonElement>(effortMenu, '[role="menuitemradio"]').find(btn => text(btn).includes('Max'))
    assert.ok(maxBtn !== undefined)
    await act(async () => { maxBtn.click() })

    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    assert.equal(prepared.length, 1)
    const input = prepared[0] as { evaluator?: { provider: string; model: string; reasoningEffort?: string } }
    assert.deepEqual(input.evaluator, { provider: 'anthropic', model: 'claude-sonnet', reasoningEffort: 'max' }, '选中的独立评估模型与推理等级传给督导运行')
    await m.unmount()
  })

  test('锚定对话：手动选择模型与 Max 推理等级后继续填写任务表不会被 planAnchor 重置为 Default，且支持开启 danger-full-access', async () => {
    const starts: unknown[][] = []
    const m = await open({
      models: [
        { provider: 'dimagent-oauth', providerName: 'DimAgent OAuth', model: 'deepseek-v4.1-flash', modelName: 'DeepSeek 4.1 Flash', efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }] },
      ],
      planAnchor: () => Promise.resolve({
        ok: true as const,
        value: {
          snapshot: '目标：目标', snapshotFingerprint: 'sf', requestFingerprint: 'rf',
          title: '目标', workspaceId: 'workspace',
          config: { agentPreset: 'standard', provider: 'dimagent-oauth', model: 'deepseek-v4.1-flash' },
        },
      }),
      prepareGuard: () => Promise.resolve({ ok: true as const, value: { runId: 'r-max', root: '/tmp/r-max', files: ['tasks.json'] } }),
      startAnchor: (...args) => {
        starts.push(args)
        return Promise.resolve({
          ok: true as const,
          value: { sessionId: 'session-anchor-max', title: '目标', mode: 'created' as const, delivery: 'sent' as const, messageId: 'm1' },
        })
      },
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    const setValue = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    // User picks model + Max BEFORE finishing the supervisor task table (the exact real-machine repro).
    const execModelBtn = query<HTMLButtonElement>(modal, '[data-redline-model]')
    await act(async () => { execModelBtn.click() })
    const modelMenu = query<HTMLElement>(document.body, '[data-redline-picker-menu="model"]')
    const flash = queryAll<HTMLButtonElement>(modelMenu, '[role="menuitemradio"]').find(btn => text(btn).includes('DeepSeek 4.1 Flash'))
    assert.ok(flash !== undefined)
    await act(async () => { flash.click() })

    const execEffortBtn = query<HTMLButtonElement>(modal, '[data-redline-effort]')
    await act(async () => { execEffortBtn.click() })
    const effortMenu = query<HTMLElement>(document.body, '[data-redline-picker-menu="effort"]')
    const maxOpt = queryAll<HTMLButtonElement>(effortMenu, '[role="menuitemradio"]').find(btn => text(btn).includes('Max'))
    assert.ok(maxOpt !== undefined)
    await act(async () => { maxOpt.click() })
    assert.ok(text(execEffortBtn).includes('Max'))

    // Now fill in the fields + supervisor table, which triggers debounced planAnchor.
    await setValue('[data-redline-anchor-task]', '任务 A')
    await setValue('[data-redline-anchor-acceptance]', '验收 A')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor]').click() })
    await setValue('[data-redline-anchor-supervisor-tasks]', 'T1 | one | e1 | src/a.ts')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-danger-full-access]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })

    // Re-plan must NOT have wiped Max back to Default.
    assert.ok(text(query<HTMLButtonElement>(modal, '[data-redline-effort]')).includes('Max'), '手动选择的 Max 推理等级不能被 planAnchor 抹成 Default')
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })

    assert.equal(starts.length, 1)
    const anchorInput = starts[0]?.[1] as { permissionPreset?: string }
    const sentConfig = starts[0]?.[4] as { provider?: string; model?: string; reasoningEffort?: string }
    assert.equal(anchorInput.permissionPreset, 'danger-full-access')
    assert.deepEqual(sentConfig, { provider: 'dimagent-oauth', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' })
    await m.unmount()
  })

  test('锚定对话：督导复选框各自独立占行且前端即时校验非法 scope 与未知依赖', async () => {
    const css = readFileSync(join(process.cwd(), 'src/client/styles/childCard.css'), 'utf8')
    const checksRule = /\.redline-guard-checks\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.match(checksRule, /display:\s*flex/)
    assert.match(checksRule, /flex-direction:\s*column/)
    assert.match(checksRule, /margin-top:\s*4px/)
    assert.match(checksRule, /padding-top:\s*10px/)

    const m = await open()
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    const setValue = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setValue('[data-redline-anchor-task]', '任务 A')
    await setValue('[data-redline-anchor-acceptance]', '验收 A')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor]').click() })

    // Invalid dependency (e.g. T0) is caught inline before clicking confirm.
    await setValue('[data-redline-anchor-supervisor-tasks]', 'T1 | 一 | 通过 | src/a.ts | T0')
    await act(async () => {})
    assert.equal(query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').disabled, true)
    assert.match(text(query(modal, '[data-redline-supervisor-tasks-err]')), /T0/)

    // Invalid absolute scope path is caught inline too.
    await setValue('[data-redline-anchor-supervisor-tasks]', 'T1 | 一 | 通过 | /abs/path')
    await act(async () => {})
    assert.equal(query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').disabled, true)
    assert.match(text(query(modal, '[data-redline-supervisor-tasks-err]')), /\/abs\/path/)

    // A `|` inside a quoted regex is part of the acceptance cell, not a column
    // separator: `-run "Playbook|WalkForward"` must not shift the scope into the
    // dependency slot (the real-machine report named `internal/service/` as an
    // unknown dependency).
    await setValue(
      '[data-redline-anchor-supervisor-tasks]',
      'T4 | P1: playbook 枚举 + walk-forward 闸 | go test ./internal/... -run "Playbook|WalkForward" -count=1 退出 0 | internal/service/,internal/domain/',
    )
    await act(async () => {})
    assert.equal(queryAll(modal, '[data-redline-supervisor-tasks-err]').length, 0, '引号内的竖线不算列分隔符')
    await m.unmount()
  })

  test('行内校验红字与输入框留 5px 间距', () => {
    const css = readFileSync(join(process.cwd(), 'src/client/styles/browser.css'), 'utf8')
    const rule = /\.redline-editor-err\[data-redline-supervisor-tasks-err\][^{]*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.match(rule, /margin-top:\s*5px/, '红字不能贴着 textarea 边框')
  })
})

describe('锚定会话弹窗滚动（0.9.3 回归）', () => {
  test('卡片是定高 flex 列：头/脚固定，内容区是唯一滚动者', () => {
    const css = readFileSync(join(process.cwd(), 'src/client/styles/childCard.css'), 'utf8')
    const card = /\.redline-modal-card\[data-redline-anchor-modal\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.match(card, /display:\s*flex/, '卡片必须自己成为 flex 列，否则内容区没有高度约束')
    assert.match(card, /flex-direction:\s*column/)
    assert.match(card, /overflow:\s*hidden/, '外层不再整块滚动')
    assert.match(card, /padding:\s*0/)
    assert.match(card, /max-height:/, '必须有高度上限，长表单才能内部滚动')
    const head = /\.redline-modal-card\[data-redline-anchor-modal\] \.redline-modal-head\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.match(head, /flex:\s*0 0 auto/)
    const foot = /\.redline-modal-card\[data-redline-anchor-modal\] \.redline-modal-foot\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.match(foot, /flex:\s*0 0 auto/, '底栏固定，不随表单滚走')
    const body = /\.redline-confirm-body\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.match(body, /overflow:\s*auto/)
    assert.match(body, /min-height:\s*0/)
    const bodyOverride = /\.redline-modal-card\[data-redline-anchor-modal\] \.redline-confirm-body\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.match(bodyOverride, /flex:\s*1 1 auto/, '内容区占满剩余高度，成为唯一滚动者')
  })
})

describe('锚定会话弹窗底栏间距（0.4.1 回归）', () => {
  test('底栏是 flex 且有 10px 间距，说明文字与按钮之间留出空隙', () => {
    const css = readFileSync(join(process.cwd(), 'src/client/styles/childCard.css'), 'utf8')
    const rule = /\.redline-modal-card\[data-redline-anchor-modal\] \.redline-modal-foot\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.match(rule, /display:\s*flex/)
    assert.match(rule, /gap:\s*10px/)
    const scope = /\.redline-modal-card\[data-redline-anchor-modal\] \.redline-confirm-scope\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.match(scope, /margin-right:\s*auto/)
    assert.match(scope, /padding-right:\s*10px/)
  })

  test('督导运行：探针行写错（缺任务 ID / 任务不存在）时按钮禁用，而不是静默丢弃', async () => {
    const prepared: unknown[] = []
    const m = await open({
      prepareGuard: (input) => {
        prepared.push(input)
        return Promise.resolve({ ok: true as const, value: { runId: 'r-p', root: '/tmp/r', files: [] } })
      },
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    const setArea = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setArea('[data-redline-anchor-task]', '任务 A')
    await setArea('[data-redline-anchor-acceptance]', '验收 A')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor]').click() })
    await setArea('[data-redline-anchor-supervisor-tasks]', 'T1 | 落盘 | 文件存在')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    const confirm = (): HTMLButtonElement => query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]')

    // A line without a task id is not a probe: the button must refuse to submit.
    await setArea('[data-redline-anchor-supervisor-probes]', 'pnpm test')
    await act(async () => {})
    assert.equal(confirm().disabled, true, 'a probe line without a task id disables the confirm')
    assert.match(text(query(modal, '[data-redline-supervisor-probes-err]')), /Line 1|第 1 行/, 'shows inline probe format error')
    // A probe for a task the table does not define is refused too.
    await setArea('[data-redline-anchor-supervisor-probes]', 'T9 | pnpm test')
    await act(async () => {})
    assert.equal(confirm().disabled, true, 'a probe for an unknown task disables the confirm')
    assert.match(text(query(modal, '[data-redline-supervisor-probes-err]')), /T9/, 'names the unknown task id inline')
    // A pasted Chinese header line in the task table shows a clear line-1 inline error.
    await setArea('[data-redline-anchor-supervisor-tasks]', '任务表（每行四段；scope 必填）\nT1 | 落盘 | 文件存在')
    await act(async () => {})
    assert.equal(confirm().disabled, true)
    assert.match(text(query(modal, '[data-redline-supervisor-tasks-err]')), /Line 1|第 1 行/, 'names the bad task header line inline')
    await setArea('[data-redline-anchor-supervisor-tasks]', 'T1 | 落盘 | 文件存在')
    // A well-formed line enables it again and is sent as a heavy command probe.
    await setArea('[data-redline-anchor-supervisor-probes]', 'T1 | pnpm test -- --run')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    assert.equal(confirm().disabled, false)
    assert.equal(queryAll(modal, '[data-redline-supervisor-tasks-err]').length, 0)
    assert.equal(queryAll(modal, '[data-redline-supervisor-probes-err]').length, 0)
    await act(async () => { confirm().click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    const input = prepared[0] as { probes?: readonly { taskId: string, weight: string, spec: { cmd: string, args: readonly string[] } }[] }
    assert.equal(input.probes?.length, 1)
    assert.equal(input.probes?.[0]?.taskId, 'T1')
    assert.equal(input.probes?.[0]?.weight, 'heavy', 'command probes are the expensive tier')
    assert.equal(input.probes?.[0]?.spec.cmd, 'pnpm')
    assert.deepEqual(input.probes?.[0]?.spec.args, ['test', '--', '--run'])
    await m.unmount()
  })

  test('点「督导运行（实验 · 自动跑任务）」这行文字也能勾选/取消，不必非点小方框', async () => {
    const m = await open()
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    const box = query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor]')
    assert.equal(box.checked, false, '默认不勾选')
    const toggle = query<HTMLElement>(modal, '[data-redline-anchor-supervisor-toggle]')
    assert.ok(text(toggle).includes(DICT_EN['anchor.supervisorLabel']), '这行文字就是开关的标签')
    await act(async () => { toggle.click() })
    assert.equal(box.checked, true, '点文字应当勾选')
    assert.ok(query(modal, '[data-redline-anchor-supervisor-tasks]'), '勾选后任务表出现')
    await act(async () => { toggle.click() })
    assert.equal(box.checked, false, '再点文字应当取消')
    assert.equal(queryAll(modal, '[data-redline-anchor-supervisor-tasks]').length, 0, '取消后任务表收起')
    await m.unmount()
  })

  test('督导运行对话框提供执行/评估回退模型与视觉取证，并默认全部关闭', async () => {
    const m = await open()
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    await act(async () => { query<HTMLElement>(modal, '[data-redline-anchor-supervisor-toggle]').click() })

    const execFallback = query<HTMLElement>(modal, '[data-redline-anchor-executor-fallback-picker]')
    const evalFallback = query<HTMLElement>(modal, '[data-redline-anchor-evaluator-fallback-picker]')
    assert.ok(execFallback, '执行回退 picker 就位')
    assert.ok(evalFallback, '评估回退 picker 就位')
    assert.ok(text(execFallback).includes(DICT_EN['anchor.supervisorNoFallback']), '默认不设置回退')

    // Visual evidence starts off and its model picker only appears once enabled.
    const visual = query<HTMLInputElement>(modal, '[data-redline-anchor-visual]')
    assert.equal(visual.checked, false, '视觉取证默认关闭')
    assert.equal(queryAll(modal, '[data-redline-anchor-visual-picker]').length, 0)
    await act(async () => { visual.click() })
    assert.ok(query(modal, '[data-redline-anchor-visual-picker]'), '启用后出现视觉模型 picker')
    await m.unmount()
  })

  test('开启督导运行后，「对话执行模型」移进选项区并排在执行回退之前', async () => {
    // 同一个控件两个位置：不让执行模型和自己的回退被运行配置隔开。
    const m = await open()
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    const before = query<HTMLElement>(modal, '[data-redline-anchor-exec-model-row]')
    assert.ok(before, '未开启督导时执行模型仍在运行配置里')
    assert.equal(queryAll(modal, '[data-redline-anchor-supervisor-options]').length, 0)

    await act(async () => { query<HTMLElement>(modal, '[data-redline-anchor-supervisor-toggle]').click() })
    const panel = query<HTMLElement>(modal, '[data-redline-anchor-supervisor-options]')
    const exec = query<HTMLElement>(panel, '[data-redline-anchor-exec-model-row]')
    assert.ok(exec, '开启后执行模型出现在选项区')
    assert.equal(queryAll(modal, '[data-redline-anchor-exec-model-row]').length, 1, '只渲染一处，不重复')
    const fallback = query<HTMLElement>(panel, '[data-redline-anchor-executor-fallback-picker]')
    assert.ok(exec.compareDocumentPosition(fallback) & Node.DOCUMENT_POSITION_FOLLOWING, '执行模型排在执行回退之前')
    const evaluator = query<HTMLElement>(panel, '[data-redline-anchor-supervisor-eval-picker]')
    assert.ok(evaluator.compareDocumentPosition(exec) & Node.DOCUMENT_POSITION_FOLLOWING, '评估模型仍在上方')
    const evalFallbackRow = query<HTMLElement>(panel, '[data-redline-anchor-evaluator-fallback-picker]')
    assert.ok(evaluator.compareDocumentPosition(evalFallbackRow) & Node.DOCUMENT_POSITION_FOLLOWING, '评估回退紧接评估模型')
    assert.ok(evalFallbackRow.compareDocumentPosition(exec) & Node.DOCUMENT_POSITION_FOLLOWING, '评估对整体排在执行对之前')
    await m.unmount()
  })

  test('评估模型选到 CLI 桥接型 provider 时给出硬提示', async () => {
    const m = await open({ models: [
      { provider: 'antigravity', providerName: 'Antigravity', model: 'gemini-4-neon', modelName: 'Gemini 4 Neon', efforts: [] },
      { provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash', efforts: [] },
    ] })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    await act(async () => { query<HTMLElement>(modal, '[data-redline-anchor-supervisor-toggle]').click() })

    const evalPicker = query<HTMLElement>(modal, '[data-redline-anchor-supervisor-eval-picker]')
    await act(async () => { query<HTMLButtonElement>(evalPicker, '[data-redline-anchor-supervisor-evaluator]').click() })
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .find(item => text(item).includes('Gemini 4 Neon'))
    assert.ok(option, '评估模型菜单列出桥接型模型')
    await act(async () => { option?.click() })
    assert.ok(query(modal, '[data-redline-anchor-eval-bridge-warning]'), '桥接型当评估器时给出警告')
    await m.unmount()
  })

  test('执行模型选到 CLI 桥接型时提示子代理会留在 CLI 里', async () => {
    const m = await open({ models: [
      { provider: 'antigravity', providerName: 'Antigravity', model: 'gemini-4-neon', modelName: 'Gemini 4 Neon', efforts: [] },
      { provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash', efforts: [] },
    ] })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    assert.equal(queryAll(modal, '[data-redline-anchor-exec-bridge-warning]').length, 0, '原生模型不提示')
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-model]').click() })
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .find(item => text(item).includes('Gemini 4 Neon'))
    assert.ok(option, '执行模型菜单列出桥接型模型')
    await act(async () => { option?.click() })
    const warn = query<HTMLElement>(modal, '[data-redline-anchor-exec-bridge-warning]')
    assert.ok(warn, '桥接型执行模型给出子代理不可见提示')
    assert.ok(text(warn).includes(DICT_EN['anchor.executorBridgeWarn']))
    await m.unmount()
  })

  test('执行模型是 CLI 桥接型、评估又跟随主会话时同样给出硬提示', async () => {
    // The zenspace incident: no explicit evaluator was chosen, the judge followed
    // the executor, and that executor was the CLI bridge. Warning only when an
    // explicit evaluator was picked would have missed it.
    const m = await open({ models: [
      { provider: 'antigravity', providerName: 'Antigravity', model: 'gemini-4-neon', modelName: 'Gemini 4 Neon', efforts: [] },
      { provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash', efforts: [] },
    ] })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    await act(async () => { query<HTMLElement>(modal, '[data-redline-anchor-supervisor-toggle]').click() })

    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-model]').click() })
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .find(item => text(item).includes('Gemini 4 Neon'))
    assert.ok(option, '执行模型菜单列出桥接型模型')
    await act(async () => { option?.click() })
    assert.ok(query(modal, '[data-redline-anchor-eval-bridge-warning]'), '跟随主会话时也要警告')
    await m.unmount()
  })

  test('评估「跟随主会话」时选定的推理等级会作为显式评估路由提交', async () => {
    const prepared: { evaluator?: { provider: string, model: string, reasoningEffort?: string } }[] = []
    const m = await open({
      models: [
        {
          provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'deepseek-v4.1-flash',
          modelName: 'DeepSeek V4.1 Flash',
          efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        },
      ],
      prepareGuard: (input) => {
        prepared.push({ evaluator: input.evaluator })
        return Promise.resolve({ ok: true as const, value: { runId: 'r1', root: '/tmp/run', files: [] } })
      },
      startAnchor: () => Promise.resolve({
        ok: true as const,
        value: { sessionId: 's1', title: '目标', mode: 'created' as const, delivery: 'sent' as const, messageId: 'm1' },
      }),
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    await act(async () => { query<HTMLElement>(modal, '[data-redline-anchor-supervisor-toggle]').click() })

    // Executor: the only model, then pick the "High" level.
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-model]').click() })
    const model = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .find(item => text(item).includes('DeepSeek V4.1 Flash'))
    assert.ok(model)
    await act(async () => { model?.click() })
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-effort]').click() })
    const high = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .find(item => text(item).trim() === 'High')
    assert.ok(high, '执行模型提供 High 推理等级')
    await act(async () => { high?.click() })

    // Evaluator stays on "follow the session model" but inherits that level.
    const evalEffort = query<HTMLButtonElement>(modal, '[data-redline-anchor-supervisor-evaluator-effort]')
    await act(async () => { evalEffort.click() })
    const evalHigh = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .filter(item => text(item).trim() === 'High')
      .at(-1)
    assert.ok(evalHigh, '评估跟随模式也能选等级')
    await act(async () => { evalHigh?.click() })

    const setValue = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setValue('[data-redline-anchor-task]', '任务 A')
    await setValue('[data-redline-anchor-acceptance]', '验收 A')
    await setValue('[data-redline-anchor-supervisor-tasks]', 'T1 | 落盘 | 文件存在')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(prepared.at(-1)?.evaluator, {
      provider: 'dimagent-oauth', model: 'deepseek-v4.1-flash', reasoningEffort: 'high',
    })
    await m.unmount()
  })

  test('确认框显示新会话的运行目录（只读），让"探针跑在哪个仓库"一眼可见', async () => {
    const m = await open()
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    const setArea = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setArea('[data-redline-anchor-task]', '任务 A')
    await setArea('[data-redline-anchor-acceptance]', '验收 A')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
    const dir = query<HTMLElement>(modal, '[data-redline-anchor-run-dir]')
    assert.ok(dir, '运行目录必须显示')
    assert.equal(text(dir), '/Volumes/SSD/Home/lionm4/my_project/_AI/x9Copy')
    assert.equal(
      queryAll(modal, '[data-redline-anchor-run-dir] input').length
        + queryAll(modal, '[data-redline-anchor-run-dir] select').length,
      0,
      '运行目录只读，不能在确认框里改',
    )
    // Checking supervisor + worktree previews the isolated checkout root instead of only showing the source root.
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor]').click() })
    await setArea('[data-redline-anchor-supervisor-tasks]', 'T1 | 落盘 | 文件存在')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor-worktree]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
    assert.equal(
      text(query<HTMLElement>(modal, '[data-redline-anchor-run-dir]')),
      '/Volumes/SSD/Home/lionm4/my_project/_AI/x9Copy/.guard/worktrees/<runId>',
    )
    await m.unmount()
  })

  test('督导运行：启动失败后切换 worktree 开关重试，必须清空旧 runId 与 operationId，不沿用旧模式台账', async () => {
    const prepared: { worktree?: boolean, runId?: string }[] = []
    const starts: { opId: string, input: { guardRunId?: string, guardWorktreePath?: string } }[] = []
    let prepareCount = 0
    let startCount = 0
    const m = await open({
      prepareGuard: (input) => {
        prepareCount += 1
        prepared.push({
          ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
          ...(input.runId === undefined ? {} : { runId: input.runId }),
        })
        if (prepareCount === 1) {
          return Promise.resolve({
            ok: true as const,
            value: {
              runId: '20261127-wt-first',
              root: '/repo/.guard/worktrees/20261127-wt-first/docs/guard/20261127-wt-first',
              files: ['tasks.json'],
              worktreePath: '/repo/.guard/worktrees/20261127-wt-first',
            },
          })
        }
        return Promise.resolve({
          ok: true as const,
          value: {
            runId: '20261127-main-retry',
            root: '/repo/docs/guard/20261127-main-retry',
            files: ['tasks.json'],
          },
        })
      },
      startAnchor: (opId, input) => {
        startCount += 1
        starts.push({ opId, input: input as { guardRunId?: string, guardWorktreePath?: string } })
        if (startCount === 1) {
          return Promise.resolve({ ok: false as const, code: 'redline/bad-request', message: 'selected model is unavailable' })
        }
        return Promise.resolve({
          ok: true as const,
          value: { sessionId: 'session-main-retry', title: '目标', mode: 'created' as const, delivery: 'sent' as const, messageId: 'm2' },
        })
      },
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    const setArea = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setArea('[data-redline-anchor-task]', '任务 A')
    await setArea('[data-redline-anchor-acceptance]', '验收 A')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor]').click() })
    await setArea('[data-redline-anchor-supervisor-tasks]', 'T1 | 落盘 | 文件存在')
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor-worktree]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })

    assert.equal(prepared.length, 1)
    assert.equal(starts.length, 1)
    assert.equal(starts[0]?.input.guardRunId, '20261127-wt-first')
    assert.equal(starts[0]?.input.guardWorktreePath, '/repo/.guard/worktrees/20261127-wt-first')

    // Uncheck worktree and retry: must NOT reuse the old runId or operationId.
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-supervisor-worktree]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })

    assert.equal(prepared.length, 2)
    assert.deepEqual(prepared[1], { worktree: false })
    assert.equal(starts.length, 2)
    assert.notEqual(starts[1]?.opId, starts[0]?.opId)
    assert.equal(starts[1]?.input.guardRunId, '20261127-main-retry')
    assert.equal(starts[1]?.input.guardWorktreePath, undefined)
    await m.unmount()
  })

  test('视觉回退 picker 有自己的行标题与说明，不与主视觉 picker 挤在同一行', async () => {
    const m = await open()
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    await act(async () => { query<HTMLElement>(modal, '[data-redline-anchor-supervisor-toggle]').click() })
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-visual]').click() })
    const main = query<HTMLElement>(modal, '[data-redline-anchor-visual-picker]')
    const fallback = query<HTMLElement>(modal, '[data-redline-anchor-visual-fallback-picker]')
    const fallbackRow = query<HTMLElement>(modal, '[data-redline-anchor-visual-fallback-row]')
    assert.ok(fallbackRow !== null, '视觉回退 picker 有独立的设置行')
    assert.equal(fallbackRow === main.parentElement, false, '回退 picker 不挂在主 picker 的行里')
    assert.ok(fallbackRow.contains(fallback), '回退 picker 在该行内')
    assert.equal(fallbackRow.contains(main), false, '两行互不嵌套')
    assert.ok(text(fallbackRow).includes(DICT_EN['anchor.supervisorVisualFallbackLabel']))
    assert.ok(text(fallbackRow).includes(DICT_EN['anchor.supervisorVisualFallbackHint']))
    await m.unmount()
  })

  test('视觉取证关闭后，残留的视觉路由不再触发桥接告警', async () => {
    const m = await open({ models: [
      { provider: 'antigravity', providerName: 'Antigravity', model: 'gemini-4-neon', modelName: 'Gemini 4 Neon', efforts: [] },
      { provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash', efforts: [] },
    ] })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    await act(async () => { query<HTMLElement>(modal, '[data-redline-anchor-supervisor-toggle]').click() })
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-visual]').click() })

    // Pick the CLI-bridge model for the witness: that is a real warning.
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-visual-model]').click() })
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .find(item => text(item).includes('Gemini 4 Neon'))
    assert.ok(option !== undefined)
    await act(async () => { option.click() })
    assert.ok(query(modal, '[data-redline-anchor-eval-bridge-warning]'), 'enabled visual route warns')

    // Turning visual evidence off must also drop the warning: the stale route
    // state is not part of the submitted run any more.
    await act(async () => { query<HTMLInputElement>(modal, '[data-redline-anchor-visual]').click() })
    assert.equal(queryAll(modal, '[data-redline-anchor-eval-bridge-warning]').length, 0)
    await m.unmount()
  })

  test('独立评估路由与等级不会被执行模型切换清空', async () => {
    const prepared: { evaluator?: { provider: string, model: string, reasoningEffort?: string } }[] = []
    const m = await open({
      models: [
        {
          provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'deepseek-v4.1-flash',
          modelName: 'DeepSeek V4.1 Flash', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        },
        {
          provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'kimi-k3',
          modelName: 'Kimi K3', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        },
        {
          provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'glm-5',
          modelName: 'GLM 5', efforts: [{ id: 'low', name: 'Low' }],
        },
      ],
      prepareGuard: (input) => {
        prepared.push({ evaluator: input.evaluator })
        return Promise.resolve({ ok: true as const, value: { runId: 'r-independent', root: '/tmp/r-independent', files: [] } })
      },
      startAnchor: () => Promise.resolve({
        ok: true as const,
        value: { sessionId: 's-independent', title: '目标', mode: 'created' as const, delivery: 'sent' as const, messageId: 'm1' },
      }),
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    await act(async () => { query<HTMLElement>(modal, '[data-redline-anchor-supervisor-toggle]').click() })
    const pick = async (trigger: string, label: string): Promise<void> => {
      await act(async () => { query<HTMLButtonElement>(modal, trigger).click() })
      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
        .filter(item => text(item).trim() === label)
        .at(-1)
      assert.ok(option !== undefined, `menu option ${label}`)
      await act(async () => { option.click() })
    }
    // Executor: DeepSeek. Judge: an INDEPENDENT Kimi K3 route at High.
    await pick('[data-redline-model]', 'DeepSeek V4.1 Flash')
    await pick('[data-redline-anchor-supervisor-evaluator]', 'Kimi K3')
    await pick('[data-redline-anchor-supervisor-evaluator-effort]', 'High')

    // Changing the executor cannot invalidate a judge level for another model.
    await pick('[data-redline-model]', 'GLM 5')

    const setArea = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setArea('[data-redline-anchor-task]', '任务 A')
    await setArea('[data-redline-anchor-acceptance]', '验收 A')
    await setArea('[data-redline-anchor-supervisor-tasks]', 'T1 | 落盘 | 文件存在')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    assert.equal(prepared.length, 1)
    assert.deepEqual(prepared[0]?.evaluator, {
      provider: 'dimagent-oauth', model: 'kimi-k3', reasoningEffort: 'high',
    }, 'the independent judge route keeps its own level across an executor change')
    await m.unmount()
  })

  test('切换执行模型会清空评估推理等级，避免沿用新模型不支持的重等级', async () => {
    const prepared: { evaluator?: { provider: string, model: string, reasoningEffort?: string } }[] = []
    const m = await open({
      models: [
        {
          provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'deepseek-v4.1-flash',
          modelName: 'DeepSeek V4.1 Flash', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        },
        {
          provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'kimi-k3',
          modelName: 'Kimi K3', efforts: [{ id: 'low', name: 'Low' }],
        },
      ],
      prepareGuard: (input) => {
        prepared.push({ evaluator: input.evaluator })
        return Promise.resolve({ ok: true as const, value: { runId: 'r-switch', root: '/tmp/r-switch', files: [] } })
      },
      startAnchor: () => Promise.resolve({
        ok: true as const,
        value: { sessionId: 's-switch', title: '目标', mode: 'created' as const, delivery: 'sent' as const, messageId: 'm1' },
      }),
    })
    await act(async () => { query<HTMLButtonElement>(m.container, '[data-redline-anchor-open]').click() })
    const modal = query<HTMLElement>(m.container, '[data-redline-anchor-modal]')
    await act(async () => { query<HTMLElement>(modal, '[data-redline-anchor-supervisor-toggle]').click() })
    const pick = async (trigger: string, label: string): Promise<void> => {
      await act(async () => { query<HTMLButtonElement>(modal, trigger).click() })
      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
        .find(item => text(item).trim() === label)
      assert.ok(option !== undefined, `menu option ${label}`)
      await act(async () => { option.click() })
    }
    // Executor: model + High; the followed evaluator inherits that level.
    await pick('[data-redline-model]', 'DeepSeek V4.1 Flash')
    await pick('[data-redline-effort]', 'High')
    await pick('[data-redline-anchor-supervisor-evaluator-effort]', 'High')

    // Switching the executor model changes the follow target; the old level is
    // not necessarily supported by the new model and must not be submitted.
    await pick('[data-redline-model]', 'Kimi K3')

    const setArea = async (selector: string, value: string): Promise<void> => {
      const area = query<HTMLTextAreaElement>(modal, selector)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setArea('[data-redline-anchor-task]', '任务 A')
    await setArea('[data-redline-anchor-acceptance]', '验收 A')
    await setArea('[data-redline-anchor-supervisor-tasks]', 'T1 | 落盘 | 文件存在')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
    await act(async () => { query<HTMLButtonElement>(modal, '[data-redline-anchor-confirm]').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    assert.equal(prepared.length, 1)
    assert.equal(prepared[0]?.evaluator, undefined, 'the stale reasoning level is not submitted for the new model')
    await m.unmount()
  })
})
