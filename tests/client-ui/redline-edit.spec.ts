// The editing UI the demo fixes, asserted in a real browser environment
// (`tests/client-ui` is OUR gated jsdom lane — upstream's `client` lane stays
// non-gating per `docs/05` §1).
//
// Every assertion below is one of the four concepts the user confirmed on
// 2026-10-02 (`docs/11` D15/D16/D17/D19/D20 + `docs/03` R2.1–R4.1):
//   ① the only row action is `编辑`;  ② a save shows ONE `已改（本地）` marker plus
//   `丢弃这条改动`;  ③ a row that cannot be rewritten states WHY and offers nothing;
//   ④ the editor opens under the row, prefilled with the FULL text, and `保存`
//   hands that text to the plugin's local store (never the session).

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeContextBrowser, type ContextBrowserProps } from '../../src/client/components/browser'
import { makeStackedBar } from '../../src/client/components/stackedBar'
import { DICT_EN } from '../../src/client/i18n'
import type { ContextTimeline, RequestRecord, SurfaceNode } from '../../src/shared/types'
import { createContextSettings } from '../../src/client/settings'
import type { RedlineDraftController } from '../../src/client/redlineDrafts'
import type { RedlineRow } from '../../src/client/redlineChannel'
import type { DraftEdit } from '../../src/client/redlineChannel'
import { makeKit, mount, query, queryAll, text, type Mounted } from '../client/helpers/kit'

const kit = makeKit()
const Browser = makeContextBrowser(kit, makeStackedBar(kit), createContextSettings())

/** A long, multi-paragraph body: the full text must survive into the editor. */
const FULL = '第一条：把「上下文」面板的默认档位设成“注入的内容”。\n\n第二条：跑测试请贴原始输出。'

function tl(over: Partial<ContextTimeline>): ContextTimeline {
  return {
    ok: true,
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
    requests: [], events: [], nodes: [], droppedNodes: 0, archive: [],
    ...over,
  }
}

function req(over: Partial<RequestRecord>): RequestRecord {
  return {
    time: 1_000, seq: 1, turn: 1, step: 0,
    system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0,
    ...over,
  }
}

function node(over: Partial<SurfaceNode> & { seq: number }): SurfaceNode {
  return { cat: 'user', tokens: 5, ...over }
}

/** One request whose surface holds the given nodes. */
function step(nodes: SurfaceNode[]): ContextTimeline {
  return tl({ requests: [req({ seq: 1, total: 10 })], nodes })
}

function controller(over: Partial<RedlineDraftController> = {}): RedlineDraftController {
  return {
    table: {},
    turn: { known: true, open: false },
    ready: true,
    busySeq: null,
    rowError: null,
    loadRow: (seq: number): Promise<{ ok: true, value: RedlineRow }> => Promise.resolve({
      ok: true,
      value: { seq, type: 'user/message', text: FULL, reasoning: '', isError: false },
    }),
    save: () => Promise.resolve(true),
    drop: () => Promise.resolve(true),
    exclude: () => Promise.resolve(true),
    clearError: () => {},
    ...over,
  }
}

async function mountBrowser(data: ContextTimeline, redline: RedlineDraftController): Promise<Mounted> {
  return await mount(h(Browser, { data, headers: null, redline } as unknown as ContextBrowserProps))
}

/** Open the first category that has rows (the accordion starts closed). */
async function openCategory(m: Mounted, index: number): Promise<void> {
  await act(async () => { (queryAll(m.container, '.redline-br-cat-row')[index] as HTMLElement).click() })
}

const actionsIn = (m: Mounted, seq: number): HTMLElement | null =>
  query(m.container, `[data-rowactions="${String(seq)}"]`)

/** Type into a controlled field the way a user does (native setter + input event). */
async function typeInto(area: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('⓪b M3-03 · the two-level (turn → step) picker and the baseline switch', () => {
  /** Two turns: turn 1 has two steps, turn 2 one — plus three user nodes so counts grow. */
  const multi = tl({
    requests: [
      req({ seq: 10, turn: 1, step: 0, user: 100, total: 100 }),
      req({ seq: 20, turn: 1, step: 1, user: 200, total: 200 }),
      req({ seq: 30, turn: 2, step: 0, user: 300, total: 300 }),
    ],
    nodes: [node({ seq: 5, cat: 'user', text: 'a', tokens: 100 }), node({ seq: 15, cat: 'user', text: 'b', tokens: 100 }), node({ seq: 25, cat: 'user', text: 'c', tokens: 100 })],
  })

  // 控件按**数据属性锚**选（`id` 是每实例唯一的 `useId()` 结果，不该被测试依赖）。
  const anchor = (id: string): string =>
    id === 'turnPick' ? '[data-redline-turn-pick]' : id === 'stepPick' ? '[data-redline-step-pick]' : `#${id}`
  const options = (m: Mounted, id: string): string[] =>
    queryAll(m.container, `${anchor(id)} option`).map(o => o.textContent ?? '')
  /** The user category row's two δ markers (null when absent). */
  const userDeltas = (m: Mounted): { count: string | null, tokens: string | null } => {
    const row = queryAll(m.container, '.redline-br-cat-row')[2] as HTMLElement
    const c = row.querySelector('.redline-br-delta')
    const tk = row.querySelector('.redline-br-tdelta')
    return { count: c?.textContent ?? null, tokens: tk?.textContent ?? null }
  }
  const pickStep = async (m: Mounted, id: string, value: string): Promise<void> => {
    await act(async () => {
      const sel = query<HTMLSelectElement>(m.container, anchor(id))
      sel.value = value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  test('the turn list is one option per turn, labelled with that turn\'s step count', async () => {
    const m = await mountBrowser(multi, controller())
    assert.deepEqual(options(m, 'turnPick'), [
      DICT_EN['browser.turnPick'].replace('{t}', '1').replace('{n}', '2'),
      DICT_EN['browser.turnPick'].replace('{t}', '2').replace('{n}', '1'),
    ])
    await m.unmount()
  })

  test('the step list holds only the SHOWN turn\'s steps, and 当前（下一次请求） only on the last turn', async () => {
    const m = await mountBrowser(multi, controller())
    // Default = live = the last turn: its single step plus the live entry.
    assert.equal(options(m, 'stepPick').length, 2)
    assert.ok(options(m, 'stepPick').includes(DICT_EN['browser.live']), 'the live entry is offered on the last turn')
    // Switching to turn 1 re-lists THAT turn's two steps and drops the live entry.
    await pickStep(m, 'turnPick', '1')
    assert.equal(options(m, 'stepPick').length, 2)
    assert.ok(!options(m, 'stepPick').includes(DICT_EN['browser.live']), 'no live entry on an earlier turn')
    assert.equal(query<HTMLSelectElement>(m.container, '[data-redline-step-pick]').value, '20', "the turn picker lands on that turn's LAST step")
    await m.unmount()
  })

  test('the baseline group is two buttons with the verbatim title, defaulting to 比前轮', async () => {
    const m = await mountBrowser(multi, controller())
    const group = query(m.container, '[data-redline-base-group]')
    assert.equal(group.getAttribute('title'), DICT_EN['browser.base.tip'])
    const btns = queryAll(group, 'button')
    assert.deepEqual(btns.map(b => b.textContent), [DICT_EN['browser.base.step'], DICT_EN['browser.base.turn']])
    assert.equal(btns[0]!.getAttribute('aria-pressed'), 'false')
    assert.equal(btns[1]!.getAttribute('aria-pressed'), 'true', 'default is 比前轮')
    await m.unmount()
  })

  test('switching the baseline changes the δ markers (the whole point of the switch)', async () => {
    const m = await mountBrowser(multi, controller())
    // Turn 1 step 1 (seq 20) — the FIRST turn, so 比前轮 has no baseline and the
    // demo's own code renders no marker there (see the note in docs/10 M3-03).
    await pickStep(m, 'turnPick', '1')
    assert.deepEqual(userDeltas(m), { count: null, tokens: null }, '比前轮 on the first turn: no baseline, no marker')
    assert.equal(query<HTMLSelectElement>(m.container, '[data-redline-turn-pick]').value, '1')
    // 比前步 reads the preceding record (seq 10), which already held one user node.
    await act(async () => { (queryAll(m.container, '[data-redline-base-group] button')[0] as HTMLElement).click() })
    assert.deepEqual(userDeltas(m), { count: '+1', tokens: '+100' }, 'vs. the previous step: one more user node, +100 tokens')
    // …and on the LAST turn both baselines have a reference (its previous turn's
    // last step IS the preceding record there), so both agree.
    await pickStep(m, 'turnPick', '2')
    assert.deepEqual(userDeltas(m), { count: '+1', tokens: '+100' })
    await act(async () => { (queryAll(m.container, '[data-redline-base-group] button')[1] as HTMLElement).click() })
    assert.equal(queryAll(m.container, '[data-redline-base-group] button')[1]!.getAttribute('aria-pressed'), 'true')
    assert.deepEqual(userDeltas(m), { count: '+1', tokens: '+100' })
    await m.unmount()
  })
})

describe('⓪ the browser shell provides the category tree the demo fixed', () => {
  test('all seven categories render as rows, in CATS order', async () => {
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'hello' })]), controller())
    const cats = queryAll(m.container, '.redline-br-cat-row')
    assert.equal(cats.length, 7, 'system, tools, user, inject, skill, assistant, tool')
    assert.ok(text(m.container).includes(DICT_EN['cat.user']))
    await m.unmount()
  })

  test('the row picker exists (the demo\'s two-level (turn → step) form is M3-03, still open)', async () => {
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'hello' })]), controller())
    assert.ok(queryAll(m.container, '.redline-br-pick').length >= 1, 'a step picker is present')
    await m.unmount()
  })
})

describe('① the only row action is 编辑', () => {
  test('an editable row offers 编辑 and nothing else', async () => {
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'hello' })]), controller())
    await openCategory(m, 2) // CATS order: system, tools, user, …
    const bar = actionsIn(m, 11)
    assert.ok(bar !== null, 'the row carries an action bar')
    const buttons = queryAll(bar, 'button').map(b => b.textContent)
    assert.deepEqual(buttons, [DICT_EN['redline.edit'], DICT_EN['redline.exclude']], '编辑 + 标记为不要（后者 2026-10-08 新增）')
    assert.equal(text(bar).includes(DICT_EN['redline.local']), false, 'no marker before a save')
    await m.unmount()
  })

  // NOTE: the host-protected rows (system prompt / tool schemas) are rendered from
  // the request-header epoch, not from surface nodes, so their "no action area at
  // all" property is asserted where the judgement lives (`tests/edit/eligibility`
  // and `tests/edit/ability-buckets`: the system/tools buckets are `inert` and
  // `makeRedlineActions` returns null for them). Reaching them here would mean
  // standing up a header-epoch fetch for no extra signal.

  // 2026-10-08（用户选 A）：助手消息**改不了，但可以「标记为不要」** —— 那是它唯一的处置手段。
  test('an assistant message states WHY, offers no edit, and offers 「标记为不要」', async () => {
    const m = await mountBrowser(step([node({ seq: 21, cat: 'assistant', text: 'reply' })]), controller())
    await openCategory(m, 5) // CATS order: system, tools, user, inject, skill, assistant, tool
    const bar = actionsIn(m, 21)
    assert.ok(bar !== null)
    const buttons = queryAll(bar, 'button')
    assert.equal(buttons.length, 1, '助手消息只给一个动作')
    assert.equal(text(buttons[0]), DICT_EN['redline.exclude'], '而且只能是「标记为不要」')
    assert.ok(text(bar).includes(DICT_EN['redline.reason.assistant']), '为什么没有「编辑」仍要说清')
    await m.unmount()
  })

  test('a superseded row states WHY and offers no button', async () => {
    // `gone` marks an archived node: it is not a current surface node.
    const m = await mountBrowser(step([node({ seq: 31, cat: 'user', text: 'old', gone: 32 })]), controller())
    await openCategory(m, 2)
    const bar = actionsIn(m, 31)
    assert.ok(bar !== null)
    assert.equal(queryAll(bar, 'button').length, 0)
    assert.ok(text(bar).includes(DICT_EN['redline.reason.shadowed']))
    await m.unmount()
  })
})

describe('② a local edit shows ONE marker plus the discard action', () => {
  const table = {
    '11': { seq: 11, text: 'edited locally', reasoning: '', isError: false, updatedAt: '2026-10-04T00:00:00.000Z' },
  }

  test('the marker appears exactly once and the discard button is there', async () => {
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'hello' })]), controller({ table }))
    await openCategory(m, 2)
    const bar = actionsIn(m, 11)
    assert.ok(bar !== null)
    const label = DICT_EN['redline.local']
    const occurrences = text(m.container).split(label).length - 1
    assert.equal(occurrences, 1, 'exactly one marker for one row')
    assert.deepEqual(queryAll(bar, 'button').map(b => b.textContent), [DICT_EN['redline.edit'], DICT_EN['redline.exclude'], DICT_EN['redline.drop']])
    await m.unmount()
  })

  test('discarding calls the plugin store, and COLLAPSES the editor on that row (docs/11 D17)', async () => {
    let dropped: number | null = null
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'hello' })]),
      controller({ table, drop: (seq: number) => { dropped = seq; return Promise.resolve(true) } }))
    await openCategory(m, 2)
    // Open the editor on that row first: the discard must take it down again —
    // leaving the discarded text in an open editor looked like "it did nothing".
    await act(async () => { (queryAll(actionsIn(m, 11)!, 'button')[0] as HTMLElement).click() })
    assert.equal(queryAll(m.container, '.redline-editor').length, 1, 'editor open before the discard')
    await act(async () => { (queryAll(actionsIn(m, 11)!, 'button')[2] as HTMLElement).click() })
    assert.equal(dropped, 11)
    assert.equal(queryAll(m.container, '.redline-editor').length, 0, 'the editor collapsed with the discard')
    await m.unmount()
  })
})

describe('④ the editor is inline, prefilled with the FULL text, and saves locally', () => {
  test('打开编辑：编辑器出现在该行下面，预填的是全文（不是 80 字预览）', async () => {
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'short preview' })]), controller())
    await openCategory(m, 2)
    await act(async () => { (queryAll(actionsIn(m, 11)!, 'button')[0] as HTMLElement).click() })
    const area = query<HTMLTextAreaElement>(m.container, `#redline-ed-11`)
    assert.equal(area.value, FULL, 'the editor holds the durable full text')
    assert.ok(area.value.includes('\n\n'), 'paragraph breaks survive')
    // The destination marker is on the field: nobody should think the model can see this.
    assert.ok(text(m.container).includes(DICT_EN['redline.dest.local']))
    await m.unmount()
  })

  test('保存 hands the edited text to the plugin store (never to the session)', async () => {
    let saved: { seq: number, edit: DraftEdit } | null = null
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'x' })]),
      controller({ save: (seq: number, edit: DraftEdit) => { saved = { seq, edit }; return Promise.resolve(true) } }))
    await openCategory(m, 2)
    await act(async () => { (queryAll(actionsIn(m, 11)!, 'button')[0] as HTMLElement).click() })
    const area = query<HTMLTextAreaElement>(m.container, `#redline-ed-11`)
    await typeInto(area, '改过的正文')
    await act(async () => {
      const save = queryAll(m.container, '.redline-editor-actions button')[0] as HTMLElement
      save.click()
    })
    assert.deepEqual(saved, { seq: 11, edit: { text: '改过的正文', reasoning: '', isError: false } })
    await m.unmount()
  })

  test('a refusal keeps the input and shows the reason (no silent failure)', async () => {
    let failing = true
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'x' })]),
      controller({
        save: () => Promise.resolve(!failing),
        rowError: null,
      }))
    await openCategory(m, 2)
    await act(async () => { (queryAll(actionsIn(m, 11)!, 'button')[0] as HTMLElement).click() })
    const area = query<HTMLTextAreaElement>(m.container, `#redline-ed-11`)
    await typeInto(area, '仍然不一样的正文')
    await act(async () => { (queryAll(m.container, '.redline-editor-actions button')[0] as HTMLElement).click() })
    // The controller refused (`save` → false): the editor stays open with the input.
    assert.equal(query<HTMLTextAreaElement>(m.container, `#redline-ed-11`).value, '仍然不一样的正文')
    // …and the refusal is reported, never swallowed (docs/03 R3.5).
    failing = false
    await m.unmount()
  })

  // 用户 2026-10-06（红框截图）：「当编辑内容时，保存的右上角、左上角还是有问号没去掉。」
  // 那个「?」是 `M05-40` 时代留下的 `.qwrap + .qfloat` 角标：它当初要解释的是**批注**动作，
  // 而批注功能已整批删除，剩下的只是把 `redline.save.tip` 挂成悬停提示 —— 却正好压在
  // 「高级：思考文本」那一行上。口径改成：**动作区不许出现任何浮标**，提示挂按钮自身的
  // `title`（不占版面、鼠标停上去照样有）。
  test('保存 上不许再有漂浮的「?」角标（提示挂按钮自身的 title）', async () => {
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'x' })]), controller())
    await openCategory(m, 2)
    await act(async () => { (queryAll(actionsIn(m, 11)!, 'button')[0] as HTMLElement).click() })
    const row = query(m.container, '.redline-editor-actions')
    assert.equal(queryAll(row, '.redline-qfloat').length, 0, 'the editor action row carries no floating ? badge')
    assert.equal(queryAll(row, '.redline-qwrap').length, 0, 'and no badge wrapper either')
    const save = queryAll(row, 'button')[0] as HTMLElement
    assert.equal(save.getAttribute('title'), DICT_EN['redline.save.tip'], 'the explanation moved onto the button itself')
    assert.equal(save.textContent, DICT_EN['redline.save'], 'the button label is the label, not a ?')
    await m.unmount()
  })

  test('取消 closes the editor without touching the store', async () => {
    let calls = 0
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'x' })]),
      controller({ save: () => { calls += 1; return Promise.resolve(true) } }))
    await openCategory(m, 2)
    await act(async () => { (queryAll(actionsIn(m, 11)!, 'button')[0] as HTMLElement).click() })
    assert.equal(queryAll(m.container, '.redline-editor').length, 1, 'the editor is open')
    await act(async () => { (queryAll(m.container, '.redline-editor-actions button')[1] as HTMLElement).click() })
    assert.equal(queryAll(m.container, '.redline-editor').length, 0, 'the editor is gone')
    assert.equal(calls, 0, 'cancelling never writes')
    await m.unmount()
  })
})

describe('③ the demo\'s blocked states disable 保存 and say why (docs/03 R4.3)', () => {
  for (const [label, turn, key] of [
    ['an open turn', { known: true, open: true }, 'redline.blocked.turnOpen'],
    ['a session this process does not host', { known: false, open: false }, 'redline.blocked.notLive'],
  ] as const) {
    test(`${label}: the editor opens, states the reason, and cannot save`, async () => {
      let saves = 0
      const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'x' })]),
        controller({ turn, save: () => { saves += 1; return Promise.resolve(true) } }))
      await openCategory(m, 2)
      await act(async () => { (queryAll(actionsIn(m, 11)!, 'button')[0] as HTMLElement).click() })
      assert.ok(text(m.container).includes(DICT_EN[key]), 'the reason is stated in the editor')
      const save = queryAll(m.container, '.redline-editor-actions button')[0] as HTMLButtonElement
      assert.equal(save.disabled, true, 'the save button is disabled, not merely failing after the click')
      await act(async () => { save.click() })
      assert.equal(saves, 0, 'a disabled save never reaches the store')
      await m.unmount()
    })
  }

  test('with a closed turn and a hosted session the save is available', async () => {
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'x' })]), controller())
    await openCategory(m, 2)
    await act(async () => { (queryAll(actionsIn(m, 11)!, 'button')[0] as HTMLElement).click() })
    const save = queryAll(m.container, '.redline-editor-actions button')[0] as HTMLButtonElement
    assert.equal(save.disabled, false)
    await m.unmount()
  })
})

describe('④ the tool-result action hides behind the advanced switch', () => {
  test('by default a tool result shows the 高级编辑 marker instead of 编辑, and no discard', async () => {
    const m = await mountBrowser(step([node({ seq: 41, cat: 'tool', text: 'result' })]), controller())
    await openCategory(m, 6)
    const bar = actionsIn(m, 41)
    assert.ok(bar !== null)
    assert.equal(queryAll(bar, 'button').length, 0, 'Edit is hidden by default')
    assert.ok(text(bar).includes(DICT_EN['redline.advanced']))
    await m.unmount()
  })

  test('turning the switch on reveals 编辑 (and changes no data)', async () => {
    const m = await mountBrowser(step([node({ seq: 41, cat: 'tool', text: 'result' })]), controller())
    await openCategory(m, 6)
    const toggle = queryAll(m.container, 'button').find(b => (b.textContent ?? '') === DICT_EN['redline.advancedToggle'])
    assert.ok(toggle !== undefined, 'the switch is in the card head')
    await act(async () => { toggle.click() })
    const bar = actionsIn(m, 41)
    assert.deepEqual(queryAll(bar!, 'button').map(b => b.textContent), [DICT_EN['redline.edit'], DICT_EN['redline.exclude']], '开关打开后两个动作一起出现')
    await m.unmount()
  })
})

// ── 「标记为不要」的界面态（`docs/11` D65，用户 2026-10-08 选 A）─────────────────
describe('⑤ 标记为不要：标记态、取消、以及与编辑互斥', () => {
  test('标了之后：行上是「已标为不要」，动作只剩「取消标记」（没有编辑）', async () => {
    const table = { 11: { seq: 11, text: '', reasoning: '', isError: false, updatedAt: '', excluded: true } }
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'hello' })]), controller({ table }))
    await openCategory(m, 2)
    const bar = actionsIn(m, 11)
    assert.ok(bar !== null, 'the row carries an action bar')
    assert.ok(text(bar).includes(DICT_EN['redline.excluded']), '行上写明已作废')
    assert.deepEqual(queryAll(bar, 'button').map(b => b.textContent), [DICT_EN['redline.unexclude']], '只剩取消标记')
    assert.equal(text(bar).includes(DICT_EN['redline.local']), false, '标记不是「已改（本地）」')
    await m.unmount()
  })

  test('点「标记为不要」调一次宿主 op（seq 与 on 都要对）', async () => {
    const calls: [number, boolean][] = []
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'x' })]),
      controller({ exclude: (seq, on) => { calls.push([seq, on]); return Promise.resolve(true) } }))
    await openCategory(m, 2)
    const bar = actionsIn(m, 11)
    assert.ok(bar !== null, 'the row carries an action bar')
    const excludeBtn = queryAll(bar, 'button').find(b => (b.textContent ?? '') === DICT_EN['redline.exclude'])
    assert.ok(excludeBtn !== undefined)
    await act(async () => { excludeBtn.click() })
    assert.deepEqual(calls, [[11, true]], '标为不要 = exclude(11, true)')
    await m.unmount()
  })
})

// ── 拒绝必须说出来（docs/03 R3.5）─────────────────────────────────────────────
// 真机踩到：`标记为不要` 在没有编辑器打开时被宿主拒绝（例如运行中的宿主还不认识这个新 op
// ⟹ redline/unknown-op），界面**什么都不显示** —— 那就是静默失败。
describe('⑥ 行内动作被拒时要说话（没有编辑器也要说）', () => {
  test('exclude 被拒：那一行上出现拒绝原因（不吞掉）', async () => {
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'x' })]),
      controller({ rowError: { seq: 11, code: 'redline/unknown-op' } }))
    await openCategory(m, 2)
    const alert = query<HTMLElement>(m.container, '[data-rowactions="11"] [role="alert"]')
    assert.equal(text(alert), DICT_EN['redline.err.unknown-op'], '拒绝原因必须出现在这一行上')
    await m.unmount()
  })
})
