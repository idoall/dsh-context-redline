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

describe('① the only row action is 编辑', () => {
  test('an editable row offers 编辑 and nothing else', async () => {
    const m = await mountBrowser(step([node({ seq: 11, cat: 'user', text: 'hello' })]), controller())
    await openCategory(m, 2) // CATS order: system, tools, user, …
    const bar = actionsIn(m, 11)
    assert.ok(bar !== null, 'the row carries an action bar')
    const buttons = queryAll(bar, 'button').map(b => b.textContent)
    assert.deepEqual(buttons, [DICT_EN['redline.edit']])
    assert.equal(text(bar).includes(DICT_EN['redline.local']), false, 'no marker before a save')
    await m.unmount()
  })

  // NOTE: the host-protected rows (system prompt / tool schemas) are rendered from
  // the request-header epoch, not from surface nodes, so their "no action area at
  // all" property is asserted where the judgement lives (`tests/edit/eligibility`
  // and `tests/edit/ability-buckets`: the system/tools buckets are `inert` and
  // `makeRedlineActions` returns null for them). Reaching them here would mean
  // standing up a header-epoch fetch for no extra signal.

  test('an assistant message states WHY and offers no button', async () => {
    const m = await mountBrowser(step([node({ seq: 21, cat: 'assistant', text: 'reply' })]), controller())
    await openCategory(m, 5) // CATS order: system, tools, user, inject, skill, assistant, tool
    const bar = actionsIn(m, 21)
    assert.ok(bar !== null)
    assert.equal(queryAll(bar, 'button').length, 0, 'no action on an assistant message')
    assert.ok(text(bar).includes(DICT_EN['redline.reason.assistant']))
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
    assert.deepEqual(queryAll(bar, 'button').map(b => b.textContent), [DICT_EN['redline.edit'], DICT_EN['redline.drop']])
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
    await act(async () => { (queryAll(actionsIn(m, 11)!, 'button')[1] as HTMLElement).click() })
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
    assert.deepEqual(queryAll(bar!, 'button').map(b => b.textContent), [DICT_EN['redline.edit']])
    await m.unmount()
  })
})
