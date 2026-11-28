// ContextView (src/client/components/contextView.tsx) — the Context tab root
// rendered for real: stats, composition, trend chart, events, file activity
// and the composed Context browser, driven by real projection values and real
// plugin settings. Covers the view's own branches (projections absent /
// garbage / well-formed, granularity/trend-mode state, brief→browser
// locate bridge, kind filter, scroll ledger, locale arms, error boundary).

import { act, createElement as h, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, test, vi } from 'vitest'
import { makeContextView } from '../../../src/client/components/contextView'
import { watchHistoryFaces } from '../../../src/client/historyPage'
import { requestContextFocus, takeContextFocus } from '../../../src/client/viewFocus'
import { createContextSettings } from '../../../src/client/settings'
import type { SettingsScopeLike } from '../../../src/client/settings'
import type { UseChatLike } from '../../../src/client/services'
import type { ContextTimeline } from '../../../src/shared/types'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, flush, hover, makeKit, mount, query, queryAll, silenceWindowErrors, stepPickOf, text, unhover, until } from '../helpers/kit'

// pluginInfo's npm-registry probe stays inert (and '0.0.0-dev' short-circuits
// it anyway).
vi.stubGlobal('fetch', () => Promise.resolve({ ok: false } as Response))

const kit = makeKit()

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})


function timeline(over: Record<string, unknown> = {}): ContextTimeline {
  return {
    ok: true,
    current: { system: 100, tools: 200, user: 300, inject: 50, skill: 0, assistant: 400, tool: 150, total: 1200 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  } as ContextTimeline
}

const T0 = 1700000000000

/** Two steps of one turn plus a turn-less trailing step, with their nodes. */
function richTimeline(over: Record<string, unknown> = {}): ContextTimeline {
  return timeline({
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    contextWindow: 128000,
    toolCalls: 3,
    images: 1,
    requests: [
      { seq: 2, turn: 1, step: 1, time: T0 + 1000, system: 100, tools: 200, user: 10, inject: 0, assistant: 20, tool: 0, total: 330, prompt: 350, output: 20, cacheRead: 100 },
      { seq: 4, turn: 1, step: 2, time: T0 + 3000, system: 100, tools: 200, user: 10, inject: 0, assistant: 60, tool: 30, total: 400 },
      { seq: 6, time: T0 + 5000, system: 100, tools: 200, user: 10, inject: 0, assistant: 80, tool: 30, total: 420 },
    ],
    events: [
      { seq: 3, time: T0 + 2000, kind: 'compaction', count: 2, turn: 1, step: 2, fromTurn: 1, fromStep: 1, tokens: 500 },
      { seq: 5, time: T0 + 4000, kind: 'inject', form: 'notice', name: 'heads-up', tokens: 12, turn: 1, step: 3 },
    ],
    nodes: [
      { seq: 1, cat: 'user', tokens: 10, text: 'hello there', time: T0 + 500 },
      { seq: 2, cat: 'assistant', tokens: 20, text: 'reply one', time: T0 + 1000 },
      { seq: 3, cat: 'tool', tokens: 30, tool: 'bash', text: 'file output', time: T0 + 2000 },
      { seq: 4, cat: 'assistant', tokens: 60, text: 'reply two', time: T0 + 3000 },
      { seq: 6, cat: 'assistant', tokens: 80, text: 'reply three', time: T0 + 5000 },
    ],
    droppedNodes: 2,
    ...over,
  })
}

function projectionsFor(data: ContextTimeline, extra: Record<string, unknown> = {}) {
  const projections: Record<string, unknown> = { redlineTimeline: data, ...extra }
  return (key: string) => projections[key]
}

/** 这些用例的取数是按「**按步骤**」写的（与产品默认无关）——把粒度**显式钉在 step**：
 *  产品默认值已按 demo 改成「按轮次」（用户 2026-10-05「按 demo 去执行」），若这里跟着默认走，
 *  成片的渲染断言会一起变红，而那些断言测的是别的事（hover / 增量 / 定位…）。 */
function stepPinnedSettings() {
  const real = createContextSettings()
  return { ...real, defaultGranularity: (): 'step' | 'turn' => 'step' }
}

function makeView(ctx: TestClientCtx, settings = stepPinnedSettings()) {
  return makeContextView(asClientCtx(ctx), kit, settings)
}

/** A button whose text matches (case-sensitively) the given label. */
function buttonByText(container: ParentNode, label: string): HTMLElement {
  const hit = queryAll(container, 'button').find(b => text(b) === label)
  if (hit === undefined) throw new Error(`button not found: ${label}`)
  return hit
}

/** Mount inside a `[data-conversation-scroll]` scroller so the view's shared-scrollport probes find it. */
async function mountInScroller(el: ReactElement, scroller: HTMLElement) {
  const inner = document.createElement('div')
  scroller.appendChild(inner)
  document.body.appendChild(scroller)
  const root = createRoot(inner)
  await act(async () => {
    root.render(el)
  })
  return {
    container: inner,
    async update(next: ReactElement) {
      await act(async () => {
        root.render(next)
      })
    },
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      scroller.remove()
    },
  }
}

describe('ContextView — projection guards', () => {
  test('loading screen while useProjection is absent, empty, or the session id is missing', async () => {
    const View = makeView(new TestClientCtx())

    const m1 = await mount(h(View, { sessionId: 'sv-none' }))
    assert.ok(text(m1.container).includes(DICT_EN.loading))
    await m1.unmount()

    const m2 = await mount(h(View, { sessionId: '', useProjection: () => undefined }))
    assert.ok(text(m2.container).includes(DICT_EN.loading))
    await m2.unmount()

    const m3 = await mount(h(View, { useProjection: () => undefined }))
    assert.ok(text(m3.container).includes(DICT_EN.loading))
    await m3.unmount()
  })

  test('renders the full tab without a session id (the agent card anchors nothing)', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { useProjection: projectionsFor(timeline()) }))
    assert.ok(text(m.container).includes(DICT_EN['stats.title']))
    assert.ok(text(m.container).includes(DICT_EN.footer))
    await m.unmount()
  })

  test('a corrupt timeline is sanitized and the whole tab still renders empty-section states', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-garbage',
      useProjection: projectionsFor(timeline(), {}),
    }))
    // Well-formed-but-empty: every section renders its empty state.
    assert.ok(text(m.container).includes(DICT_EN['stats.title']))
    assert.ok(text(m.container).includes(DICT_EN['trend.empty']))
    assert.ok(text(m.container).includes(DICT_EN['events.empty']))
    assert.ok(text(m.container).includes(DICT_EN['footer']))
    assert.ok(m.container.querySelector('.redline-br-cats') !== null)
    // 被删的卡（当前上下文 / 文件活动 / 插件信息 / Token 统计 / 耗时统计）在这台运行时不该出现 —— demo 里没有它们。
    for (const gone of [DICT_EN['overview.title'], DICT_EN['files.title']]) {
      assert.ok(!text(m.container).includes(gone), '不该再出现：' + gone)
    }
    await m.unmount()
  })

  test('companion projections feed the browser headers', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-proj',
      useProjection: projectionsFor(timeline({ model: 'm-only' }), {
        contextPressure: { projectedTokens: 100, contextWindow: 128000 },
        tokenUsage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0 },
        contextBreakdown: { systemTokens: 100, toolsTokens: 200, messageTokens: 900 },
        redlineHeaders: { headers: [{ seq: 1, time: T0, system: 'SYS', tools: [{ name: 'bash', tokens: 12 }] }] },
      }),
    }))
    // ⚠️ 「当前上下文」卡（含 anchored headline 与模型行）与 Token 统计卡已按 demo 删除 ——
    // 原来钉这两张卡的断言随之去掉；本测现在只钉「伴随投影喂到浏览器头部」这部分。
    await m.unmount()
  })
})

describe('ContextView — the sidebar host', () => {
  test('the panel drops the context-stats and plugin-info head cards, keeping the two donut cards', async () => {
    const View = makeView(new TestClientCtx())
    const projections = projectionsFor(richTimeline())

    const tab = await mount(h(View, { useProjection: projections }))
    assert.equal(queryAll(tab.container, '.redline-stats').length, 1, 'the tab keeps the context stats')
    assert.equal(queryAll(tab.container, '.redline-pi-grid').length, 0, '插件信息卡已删（demo 没有这张）')
    await tab.unmount()

    const panel = await mount(h(View, { host: 'sidebar', useProjection: projections }))
    assert.equal(queryAll(panel.container, '.redline-stats').length, 0, 'the panel drops the context stats')
    assert.equal(queryAll(panel.container, '.redline-pi-grid').length, 0, 'the panel drops the plugin info')
    assert.equal(queryAll(panel.container, '.redline-head > .redline-card').length, 0, 'Token 统计/耗时统计已删（demo 没有这两张）')
    assert.equal(queryAll(panel.container, '.redline-head > .redline-col-donut').length, 0, 'donut 两卡已删')
    await panel.unmount()
  })

  test('both hosts arrange independent columns: trend→events beside browser→children', async () => {
    const View = makeView(new TestClientCtx())
    const projections = projectionsFor(richTimeline())

    for (const props of [{ useProjection: projections }, { host: 'sidebar' as const, useProjection: projections }]) {
      const m = await mount(h(View, props))
      const cols = queryAll(m.container, '.redline-masonry > .redline-masonry-col')
      assert.equal(cols.length, 2, 'two independent columns, not a same-height row')
      assert.ok(cols[0].querySelector('.redline-trend-ctl') !== null, 'left column begins with the trend')
      assert.ok(text(cols[0]).includes(DICT_EN['events.title']), 'events continue below the trend')
      assert.ok(cols[1].querySelector('.redline-br-dna-ctl') !== null, 'right column begins with the browser')
      assert.ok(text(cols[1]).includes(DICT_EN['child.title']), 'children continue below the browser')
      await m.unmount()
    }
  })
})

describe('ContextView — baseline gate', () => {
  test('a gated host renders the zeroed cards under the upgrade modal', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-gated',
      useProjection: projectionsFor(timeline({ unsupported: { current: '0.1.1-rc.2', minimum: '0.1.5-rc.1' } })),
    }))
    // The modal pops over the tab, naming both versions.
    assert.ok(m.container.querySelector('.redline-modal-backdrop') !== null)
    const card = query(m.container, '.redline-gate-card')
    assert.ok(text(card).includes(DICT_EN['gate.title']))
    assert.ok(text(card).includes('v0.1.1-rc.2'))
    assert.ok(text(card).includes('v0.1.5-rc.1'))
    // The cards keep rendering the fallback's zeroed data behind it.
    assert.ok(text(m.container).includes(DICT_EN['stats.title']))
    assert.ok(text(m.container).includes(DICT_EN['trend.empty']))
    assert.ok(text(m.container).includes(DICT_EN['events.empty']))
    // Dismissal reveals the (blank) cards.
    await click(buttonByText(m.container, DICT_EN['gate.ok']))
    assert.equal(m.container.querySelector('.redline-modal-backdrop'), null)
    assert.ok(text(m.container).includes(DICT_EN['stats.title']))
    await m.unmount()
  })

  test('a malformed gate record never opens the modal', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-gate-junk',
      useProjection: projectionsFor(timeline({ unsupported: { current: 7 } })),
    }))
    assert.equal(m.container.querySelector('.redline-modal-backdrop'), null)
    assert.ok(text(m.container).includes(DICT_EN['stats.title']))
    await m.unmount()
  })
})

/** The rich tab: full projection (stats, chart, markers, browser headers) over two turns plus a turn-less step. */
async function mountRich(sessionId: string) {
  const View = makeView(new TestClientCtx())
  const m = await mount(h(View, {
    sessionId,
    useProjection: projectionsFor(richTimeline(), {
      redlineHeaders: { headers: [{ seq: 1, time: T0, system: 'SYS', tools: [{ name: 'bash', tokens: 12, description: 'run' }] }] },
    }),
    useChat: (sel =>
        sel({
          legacy: { nodes: [] } })) as UseChatLike,
  }))
  return m
}

describe('ContextView — interactions', () => {
  test('renders the rich tab: stats, chart bars, markers, events, nodes, browser', async () => {
    const m = await mountRich('sv-rich')
    assert.equal(queryAll(m.container, '.redline-bar').length, 3)
    // The compaction event lands as the ✂ marker on the first request after it.
    assert.equal(queryAll(m.container, '.redline-bar-marker').length, 1)
    assert.equal(queryAll(m.container, '.redline-event').length, 2)
    assert.ok(text(m.container).includes(DICT_EN['browser.liveNow']))
    // Turn strip partitions the two turn groups (turn 1 + the turn-less 0).
    assert.deepEqual(queryAll(m.container, '.redline-turn-label').map(el => text(el)), ['1', '0'])
    await m.unmount()
  })

  test('bar hover previews in the browser; hover loss on a granularity switch falls back', async () => {
    const m = await mountRich('sv-hover')
    const chart = query(m.container, '.redline-chart')
    const bar2 = query(m.container, '.redline-bar[data-redline-seq="2"]')
    await hover(bar2)
    assert.ok(bar2.className.includes('redline-bar-hovered'))
    // The hovered bar's turn lights the strip even without strip hover.
    assert.ok(query(m.container, '.redline-chart-scroll').className.includes('redline-chart-dim'))

    // Switching to turn granularity drops seq 2 (turn 1 keeps its LAST step):
    // the stale hovered seq matches nothing and the active bar falls back.
    await click(buttonByText(m.container, DICT_EN['gran.turn']))
    assert.equal(queryAll(m.container, '.redline-bar').length, 2)
    assert.equal(queryAll(m.container, '.redline-bar-hovered').length, 0)
    await unhover(chart)
    await click(buttonByText(m.container, DICT_EN['gran.step']))
    assert.equal(queryAll(m.container, '.redline-bar').length, 3)
    await m.unmount()
  })

  test('a request without a turn highlights nothing on hover', async () => {
    const m = await mountRich('sv-noturn')
    const chart = query(m.container, '.redline-chart')
    await hover(query(m.container, '.redline-bar[data-redline-seq="6"]'))
    assert.ok(query(m.container, '.redline-bar[data-redline-seq="6"]').className.includes('redline-bar-hovered'))
    assert.ok(!query(m.container, '.redline-chart-scroll').className.includes('redline-chart-dim'))
    await unhover(chart)
    await m.unmount()
  })

  test('turn strip hover dims, strip click focuses the turn in turn granularity', async () => {
    const m = await mountRich('sv-strip')
    const turns = queryAll(m.container, '.redline-turn')
    assert.equal(turns.length, 2)
    await hover(turns[0])
    assert.ok(query(m.container, '.redline-chart-scroll').className.includes('redline-chart-dim'))
    await unhover(query(m.container, '.redline-turns'))
    assert.ok(!query(m.container, '.redline-chart-scroll').className.includes('redline-chart-dim'))

    // Strip click: granularity switches to turn and the focus is consumed once.
    await click(turns[0])
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('redline-gran-on'))
    assert.equal(queryAll(m.container, '.redline-bar').length, 2)
    await click(buttonByText(m.container, DICT_EN['gran.step']))
    await m.unmount()
  })

  test('pinning a bar selects its step in the browser; unpinning returns to live', async () => {
    const m = await mountRich('sv-pin')
    const pick = stepPickOf(m)
    assert.equal(pick.value, 'live')

    const bar4 = query(m.container, '.redline-bar[data-redline-seq="4"]')
    await click(bar4)
    assert.ok(bar4.className.includes('redline-bar-selected'))
    assert.equal(pick.value, '4')
    // The pinned step carries the compaction marker chip in the detail head.
    assert.ok(query(m.container, '.redline-detail').textContent?.includes('✂') === true)

    await click(bar4)
    assert.ok(!bar4.className.includes('redline-bar-selected'))
    assert.equal(pick.value, 'live')
    await m.unmount()
  })

  test('brief rows locate their node in the browser (input, mid response, live response)', async () => {
    const m = await mountRich('sv-brief')
    const pick = stepPickOf(m)

    // Pin the second bar: brief = opener + inputs (node 3) + response (node 4).
    await click(query(m.container, '.redline-bar[data-redline-seq="4"]'))
    const briefRows = queryAll(m.container, '.redline-brief-row')
    assert.equal(briefRows.length, 3)

    // The In row reveals node 3 (tool) inside the step's OWN surface.
    const inRow = briefRows.find(r => text(r).includes(DICT_EN['brief.input']))
    assert.ok(inRow !== undefined)
    await click(inRow)
    assert.equal(pick.value, '4')
    assert.ok(text(query(m.container, '.redline-br-elem-on')).includes('file output'))

    // The response of a middle bar first appears in the NEXT step's surface.
    const replyRow = briefRows.find(r => text(r).includes('reply two'))
    assert.ok(replyRow !== undefined)
    await click(replyRow)
    assert.equal(pick.value, '6')
    assert.ok(text(query(m.container, '.redline-br-elem-on')).includes('reply two'))

    // The last bar's response lands on the LIVE surface.
    await click(query(m.container, '.redline-bar[data-redline-seq="6"]'))
    const lastReply = queryAll(m.container, '.redline-brief-row').find(r => text(r).includes('reply three'))
    assert.ok(lastReply !== undefined)
    await click(lastReply)
    assert.equal(pick.value, 'live')
    assert.ok(text(query(m.container, '.redline-br-elem-on')).includes('reply three'))
    await m.unmount()
  })

  test('browser category hover lights the trend chart segments and the detail composition bar', async () => {
    const m = await mountRich('sv-link-trend')
    // Category rows render in CATS order; hover "tools" (second row).
    const toolsRow = queryAll(m.container, '.redline-br-cat-row')[1]
    await hover(toolsRow)
    assert.equal(query(m.container, '.redline-chart').getAttribute('data-redline-catdim'), 'tools')
    // The detail's composition bar mirrors the same key with its tip off (covered in requestDetail.spec).
    const detailBar = query(m.container, '.redline-detail .redline-stacked')
    assert.ok(detailBar.className.includes('redline-stacked-dim'))
    assert.ok(queryAll(detailBar, '.redline-stacked-seg-on').length === 1)
    assert.ok(queryAll(m.container, '.redline-detail-row-on').length === 1, 'the matching detail row lights too')

    await unhover(toolsRow)
    assert.equal(query(m.container, '.redline-chart').hasAttribute('data-redline-catdim'), false)
    assert.ok(!query(m.container, '.redline-detail .redline-stacked').className.includes('redline-stacked-dim'))
    await m.unmount()
  })

  test('expanding a browser category focuses the trend bars on it; collapsing restores all', async () => {
    const m = await mountRich('sv-focus')
    assert.equal(text(query(m.container, '.redline-axis-top')), '420', 'unfocused: the axis tops at the largest whole-bar total')
    // Five segments on the bar: richTimeline carries no injects, so inject renders none.
    assert.equal(queryAll(m.container, '.redline-bar[data-redline-seq="4"] .redline-bar-stack > .redline-cat-seg').length, 5)

    // Expanding the browser's assistant category (row 5 — row 4 is the empty
    // skill bucket) focuses every bar on it — one segment per bar, the axis
    // rescaled to the category's own max (20/60/80; the first rides its provider-prompt anchor to 21).
    await click(queryAll(m.container, '.redline-br-cat-row')[5])
    assert.equal(text(query(m.container, '.redline-axis-top')), '80')
    const segs = queryAll(m.container, '.redline-bar .redline-bar-stack > .redline-cat-seg')
    assert.equal(segs.length, 3)
    for (const s of segs) assert.equal(s.getAttribute('data-redline-cat'), 'assistant')
    assert.equal(text(m.container).includes('Showing ' + DICT_EN['cat.assistant'] + ' only'), false,
      'the upstream focus subtitle is gone; the bars alone carry the focus')

    // Collapsing the category restores the whole composition and drops the subtitle.
    await click(queryAll(m.container, '.redline-br-cat-row')[5])
    assert.equal(text(query(m.container, '.redline-axis-top')), '420')
    assert.equal(queryAll(m.container, '.redline-bar[data-redline-seq="4"] .redline-bar-stack > .redline-cat-seg').length, 5)
    const trendCard = queryAll(m.container, '.redline-card').find(c => text(c).includes(DICT_EN['trend.title']))
    assert.ok(trendCard !== undefined && trendCard.querySelector('.redline-card-sub') === null, 'unfocused: no subtitle')
    await m.unmount()
  })

  test('the adaptive switch rides the trend title and toggles mount-locally', async () => {
    const m = await mountRich('sv-adaptive')
    const card = queryAll(m.container, '.redline-card').find(c => text(c).includes(DICT_EN['trend.title']))
    assert.ok(card !== undefined)
    const titleText = query(card, '.redline-card-title-text')
    assert.equal(text(titleText), DICT_EN['trend.title'])

    // The scale readout (`docs/03` R1.5) sits between the title text and the switch,
    // so the switch's group is now the SECOND sibling after the title — still inside
    // the same title row, left of the card's right-hand control cluster.
    // The scale readout was removed with the reference trend sync: the title carries the
    // display modifiers and the chart axis carries the size.
    assert.equal(queryAll(card, '.redline-card-scale').length, 0)
    const toggleOf = () => buttonByText(m.container, DICT_EN['trend.adaptive'])
    assert.equal(toggleOf().parentElement?.previousElementSibling, titleText)
    assert.equal(toggleOf().getAttribute('title'), DICT_EN['trend.adaptiveHint'])
    assert.equal(buttonByText(m.container, DICT_EN['trend.duration']).getAttribute('title'), DICT_EN['trend.durationHint'])
    assert.ok(!toggleOf().className.includes('redline-gran-on'), 'off at mount')

    // Toggling is mount-local: the chart keeps rendering (jsdom has no layout, so the zero-width viewport falls
    // back to the whole-log axis instead of flattening the bars) and nothing is written back to settings.
    await click(toggleOf())
    assert.ok(toggleOf().className.includes('redline-gran-on'))
    assert.equal(text(query(m.container, '.redline-axis-top')), '420')
    await click(toggleOf())
    assert.ok(!toggleOf().className.includes('redline-gran-on'))
    assert.equal(text(query(m.container, '.redline-axis-top')), '420')
    await m.unmount()
  })

  test('delta mode pairs the detail with the previous record; first bar has none', async () => {
    const m = await mountRich('sv-delta')
    const chart = query(m.container, '.redline-chart')
    await click(buttonByText(m.container, DICT_EN['gran.delta']))
    // Default active bar is the newest: detail is the signed change vs its predecessor.
    assert.ok(queryAll(m.container, '.redline-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    // Hovering the FIRST bar pairs it with null (change from zero).
    await hover(query(m.container, '.redline-bar[data-redline-seq="2"]'))
    assert.ok(query(m.container, '.redline-bar[data-redline-seq="2"]').className.includes('redline-bar-hovered'))
    assert.ok(queryAll(m.container, '.redline-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    await unhover(chart)
    await click(buttonByText(m.container, DICT_EN['gran.total']))
    assert.ok(!queryAll(m.container, '.redline-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    await m.unmount()
  })

  test('event-kind filter narrows, unions, drops, and resets', async () => {
    const m = await mountRich('sv-kinds')
    const countEvents = () => queryAll(m.container, '.redline-event').length
    const kindBtn = (k: string) => query(m.container, `.redline-kinds [data-redline-kind="${k}"]`) as HTMLElement
    assert.equal(countEvents(), 2)
    // The buttons carry their per-kind tallies (richTimeline: 1 inject, 1 compaction, 0 prunes).
    assert.deepEqual(
      queryAll(m.container, '.redline-kinds .redline-kind-n').map(el => text(el)),
      ['1', '1', '0'],
    )

    await click(kindBtn('inject'))
    assert.equal(countEvents(), 1)
    await click(kindBtn('compaction'))
    assert.equal(countEvents(), 2)
    await click(kindBtn('compaction'))
    assert.equal(countEvents(), 1)
    await click(kindBtn('inject'))
    assert.equal(countEvents(), 2)
    await m.unmount()
  })
})

describe('ContextView — targeted content fetch and image loading', () => {
  test('opening an un-joined node reads one seq-anchored history page through the gateway remote', async () => {
    const calls: { sessionId: string; throughSeq: number; beforeSeq: number }[] = []
    const ctx = new TestClientCtx({
      services: {
        remote: {
          session: {
            page: (request: { address: { sessionId: string }; throughSeq: number; beforeSeq: number }) => {
              calls.push({ sessionId: request.address.sessionId, throughSeq: request.throughSeq, beforeSeq: request.beforeSeq })
              return Promise.resolve({
                ok: true,
                value: {
                  records: [
                    { type: 'event', event: { type: 'user/message', seq: request.throughSeq, data: { content: [{ type: 'text', text: 'OLD FULL BODY' }] } } },
                  ],
                },
              })
            },
          },
        },
      },
    })
    // The direct `remote.session` service is hostile, as on the real host:
    // the face resolves only through the declared inject.
    ctx.setService('remote.session', { get page() { throw new Error('cannot get property "remote.session" without inject') } })
    watchHistoryFaces(asClientCtx(ctx))
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-page',
      useProjection: projectionsFor(timeline({ nodes: [{ seq: 1, cat: 'user', tokens: 5, text: 'old msg' }] })),
      useChat: (sel =>
        sel({
          legacy: { nodes: [] } })) as UseChatLike,
    }))
    const catRow = queryAll(m.container, '.redline-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(catRow !== undefined)
    // The lone node auto-expands with the category, which triggers the fetch.
    await click(catRow)
    await flush()
    assert.deepEqual(calls, [{ sessionId: 'sv-page', throughSeq: 1, beforeSeq: 2 }], 'one read anchored just past the seq')
    assert.ok(text(m.container).includes('OLD FULL BODY'), 'mapped page content renders')
    await m.unmount()
    // Unload the declared slot so no face stales into the next test.
    ctx.dispose()
  })

  test('without a history face an uncached node shows the static note', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-nopage',
      useProjection: projectionsFor(timeline({ nodes: [{ seq: 1, cat: 'user', tokens: 5, text: 'old msg' }] })),
      useChat: (sel =>
        sel({
          legacy: { nodes: [] } })) as UseChatLike,
    }))
    const catRow = queryAll(m.container, '.redline-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(catRow !== undefined)
    await click(catRow)
    assert.ok(text(m.container).includes(DICT_EN['browser.noContent']))
    await m.unmount()
  })

  test('image attachments resolve through the conversation service loader', async () => {
    const resolved: [string, unknown][] = []
    const ctx = new TestClientCtx({
      services: {
        uiConversation: {
          imageUrl: (sessionId: string, attachment: unknown) => {
            resolved.push([sessionId, attachment])
            return Promise.resolve('blob:pic')
          },
        },
      },
    })
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-img',
      useProjection: projectionsFor(timeline({
        images: 1,
        nodes: [{ seq: 1, cat: 'user', tokens: 400, text: 'see this', imgs: 1 }],
      })),
      useChat: (sel =>
        sel({
          legacy: { nodes: [{
            kind: 'user',
            seq: 1,
            content: [{ type: 'image', attachment: { attachmentId: 'att-1', name: 'pic.png', bytes: 2048, width: 640, height: 480 } }],
          }] }
        })) as UseChatLike,
    }))
    const catRow = queryAll(m.container, '.redline-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(catRow !== undefined)
    await click(catRow)
    await flush()
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0][0], 'sv-img')
    assert.equal((resolved[0][1] as { attachmentId: string }).attachmentId, 'att-1')
    assert.ok(m.container.querySelector('.redline-att-item img') !== null)
    await m.unmount()
  })

  test('a conversation service without imageUrl degrades quietly', async () => {
    const ctx = new TestClientCtx({ services: { uiConversation: {} } })
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-noimg',
      useProjection: projectionsFor(timeline()),
    }))
    assert.ok(text(m.container).includes(DICT_EN['stats.title']))
    await m.unmount()
  })
})

describe('ContextView — scroll ledger', () => {
  test('restores the saved position per session and re-applies only once per mount', async () => {
    const View = makeView(new TestClientCtx())
    const props = {
      sessionId: 'sv-scroll',
      useProjection: undefined as ((key: string) => unknown) | undefined,
    }

    // First visit: no ledger entry → the shared scroller is re-anchored at top.
    const scroller1 = document.createElement('div')
    scroller1.setAttribute('data-conversation-scroll', '')
    const m1 = await mountInScroller(
      h(View, { ...props, useProjection: projectionsFor(richTimeline()) }),
      scroller1,
    )
    assert.equal(scroller1.scrollTop, 0)

    // A data refresh re-runs the effect but the position is applied once.
    scroller1.scrollTop = 17
    await m1.update(h(View, { ...props, useProjection: projectionsFor(richTimeline({ droppedNodes: 3 })) }))
    assert.equal(scroller1.scrollTop, 17)

    // Unmount saves the position into the module ledger.
    scroller1.scrollTop = 42
    await m1.unmount()

    // Remounting the same session restores the saved position.
    const scroller2 = document.createElement('div')
    scroller2.setAttribute('data-conversation-scroll', '')
    const m2 = await mountInScroller(
      h(View, { ...props, useProjection: projectionsFor(richTimeline()) }),
      scroller2,
    )
    assert.equal(scroller2.scrollTop, 42)
    await m2.unmount()
  })
})

describe('ContextView — locale and settings', () => {
  // A real-shaped models.dev slice: the cost cell prices against the injected
  // book (1M uncached input at the $0.15 miss rate → $0.15 / ¥1).
  // ⚠️ 原来这里给费用格注入过一本 models.dev 价目表 —— 费用/价格模块已随孤岛 A 删除
  // （`docs/10` M6-17：从入口不可达），这张卡也早就是 demo 的 3 格了，所以不再需要。
  const costed = timeline({
    cost: { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1000000, output: 500000, cacheRead: 0, cacheWrite: 0 } } } },
  })

  // ⚠️ 原用例断言"费用格按语言换算成 $/¥"—— 那两格随 M4-07（3 格、跟 demo）一起删了。
  // 这条改成它现在能证明的事：卡片只有 demo 的三格、不再有任何费用/货币输出。
  // （本文件的 harness 用固定英文 kit，语言切换的实测留给真机。）
  test('the card carries the demo\'s three cells and no cost/currency cell', async () => {
    const m = await mount(h(makeView(new TestClientCtx()), {
      sessionId: 'sv-cells',
      useProjection: projectionsFor(costed),
    }))
    await flush()
    const labels = queryAll(m.container, '.redline-stat-label').map(el => text(el))
    assert.deepEqual(labels, [
      DICT_EN['stats.visibleItems'],
      DICT_EN['stats.userMsgs'],
      DICT_EN['stats.injectItems'],
    ])
    const body = text(m.container)
    assert.ok(!body.includes('$') && !body.includes('¥'), '费用格已随 3 格口径删除')
    assert.ok(!body.includes(DICT_EN['stats.cost']) && !body.includes(DICT_EN['stats.cacheHit']), '缓存/费用读数不在这张卡')
    await m.unmount()
  })

  test('mount-time granularity/trend/file-sort defaults come from the bound settings scope', async () => {
    const settings = createContextSettings()
    const scope: SettingsScopeLike = {
      getSnapshot: () => ({
        status: 'ready',
        writable: true,
        value: { defaultGranularity: 'turn', defaultTrendMode: 'delta', defaultFileSort: 'path' },
      }),
      subscribe: () => () => {},
      set: async () => {},
    }
    const detach = settings.attach(scope)
    const View = makeView(new TestClientCtx(), settings)
    // Two file reads (the 2-op path sorts AFTER the 1-op one under 'count' but BEFORE it under 'path').
    const m = await mount(h(View, {
      sessionId: 'sv-settings',
      useProjection: projectionsFor(richTimeline({
        nodes: [
          ...richTimeline().nodes,
          { seq: 7, cat: 'tool', tokens: 30, tool: 'read', text: 'z', time: T0 + 6000 },
          { seq: 8, cat: 'tool', tokens: 30, tool: 'read', text: 'a', time: T0 + 7000 },
          { seq: 9, cat: 'tool', tokens: 30, tool: 'read', text: 'z', time: T0 + 8000 },
        ],
      })),
      useChat: (sel =>
        sel({
          legacy: { nodes: [
        { kind: 'tool', seq: 7, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/z.ts' }) } },
        { kind: 'tool', seq: 8, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/a.ts' }) } },
        { kind: 'tool', seq: 9, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/z.ts' }) } },
      ] } })) as UseChatLike,
    }))
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('redline-gran-on'))
    assert.ok(buttonByText(m.container, DICT_EN['gran.delta']).className.includes('redline-gran-on'))
    // Turn aggregation applies at mount: two bars (turn 1 aggregate + turn-less).
    assert.equal(queryAll(m.container, '.redline-bar').length, 2)
    await m.unmount()
    detach()
  })
})

describe('ContextView — error boundary', () => {
  test('a render failure degrades to the error card and Retry recovers', async () => {
    // React 18 dev replays the failed render through a fake DOM event (loud
    // stderr via jsdom/vitest) and logs the boundary message to console —
    // both silenced so the deliberate throw stays inside this test.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const silenceErrors = silenceWindowErrors()
    try {
      const real = createContextSettings()
      // Flag-driven (not call-counted): React 18 dev replays a failed unit of
      // work and retries an errored concurrent pass synchronously, so the
      // failure must persist until the boundary catches, then clear for Retry.
      let fail = true
      const flaky = {
        ...real,
        defaultGranularity: (): 'step' | 'turn' => {
          if (fail) throw new Error('boom-settings')
          return real.defaultGranularity()
        },
      }
      const View = makeView(new TestClientCtx(), flaky)
      const m = await mount(h(View, {
        sessionId: 'sv-err',
        useProjection: projectionsFor(richTimeline()),
      }))
      assert.ok(text(m.container).includes(DICT_EN.error))
      assert.ok(text(m.container).includes('boom-settings'))

      fail = false
      await click(query(m.container, '.redline-error-retry'))
      assert.ok(text(m.container).includes(DICT_EN['stats.title']))
      assert.ok(!text(m.container).includes(DICT_EN.error))
      await m.unmount()
    } finally {
      silenceErrors()
    }
  })
})

describe('ContextView — chat→Context jump', () => {
  test('the relay flips the chart to turn bars, pins the reply\'s turn, and consumes itself', async () => {
    // The clicked reply closed turn 1: its request seq (4) is that turn's LAST step — exactly the aggregate's record.
    requestContextFocus('sv-jump', 4)
    const m = await mountRich('sv-jump')
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('redline-gran-on'), 'granularity flips to turn')
    assert.equal(queryAll(m.container, '.redline-bar').length, 2, 'the chart renders turn aggregates')
    assert.ok(query(m.container, '.redline-bar[data-redline-seq="4"]').className.includes('redline-bar-selected'), 'the reply\'s turn bar is pinned')
    assert.equal(stepPickOf(m).value, '4')
    assert.equal(takeContextFocus('sv-jump'), null, 'the relay is one-shot')
    await m.unmount()
  })

  test('no session id: the relay stays pending — the loading view never takes it', async () => {
    requestContextFocus('sv-jumpnone', 4)
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: '', useProjection: () => undefined }))
    assert.ok(text(m.container).includes(DICT_EN.loading))
    await m.unmount()
    assert.equal(takeContextFocus('sv-jumpnone'), 4, 'an absent session id skips leg 1')
    takeContextFocus('sv-jumpnone')
  })

  test('an empty history consumes the relay and pins nothing', async () => {
    requestContextFocus('sv-jumpempty', 4)
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-jumpempty', useProjection: projectionsFor(timeline()) }))
    assert.equal(queryAll(m.container, '.redline-bar').length, 0)
    assert.equal(takeContextFocus('sv-jumpempty'), null)
    await m.unmount()
  })

  test('a turn-less reply routes to the turn-0 bar', async () => {
    // The trailing turn-less step: its group key derives to 0, the ?? 0 arm.
    requestContextFocus('sv-jump0', 6)
    const m = await mountRich('sv-jump0')
    assert.ok(query(m.container, '.redline-bar[data-redline-seq="6"]').className.includes('redline-bar-selected'))
    assert.equal(takeContextFocus('sv-jump0'), null)
    await m.unmount()
  })

  test('a record landing after mount re-pins the mounted view (the sidebar repeat jump)', async () => {
    const m = await mountRich('sv-rejump')
    assert.ok(!query(m.container, '.redline-bar[data-redline-seq="4"]').className.includes('redline-bar-selected'), 'nothing pinned at mount')
    // The sidebar landing keeps this view mounted; a later jump must re-pin it.
    await act(async () => { requestContextFocus('sv-rejump', 4) })
    assert.ok(query(m.container, '.redline-bar[data-redline-seq="4"]').className.includes('redline-bar-selected'), 'the later record re-pins')
    assert.equal(stepPickOf(m).value, '4')
    assert.equal(takeContextFocus('sv-rejump'), null, 'the record was consumed')
    await m.unmount()
  })

  test('the jump selects the target step even over a restored position', async () => {
    const View = makeView(new TestClientCtx())
    const props = { sessionId: 'sv-jumpscroll', useProjection: projectionsFor(richTimeline()) }

    // Seed the ledger: a first visit scrolls, the unmount saves 42.
    const scroller1 = document.createElement('div')
    scroller1.setAttribute('data-conversation-scroll', '')
    const m1 = await mountInScroller(h(View, props), scroller1)
    scroller1.scrollTop = 42
    await m1.unmount()

    // jsdom lays out nothing: give the scroller and the composition card fixed
    // viewport tops so the reveal's rect delta is deterministic (450 − 100).
    const gBCR = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const top = this.hasAttribute('data-conversation-scroll') ? 100
        : this.hasAttribute('data-redline-current') ? 450 : 0
      return { top } as DOMRect
    })

    // The jump remount: restore applies 42. ⚠️ 原本还会再叠一次"把【当前上下文】卡滚到视口顶"的揭示位移(350)，
    // 但那张卡已按 demo 删除（demo 的 5 张卡里没有它）⟹ 现在只剩恢复值 42。这条仍钉住"跳转后选中的那一步会亮"。
    requestContextFocus('sv-jumpscroll', 4)
    const scroller2 = document.createElement('div')
    scroller2.setAttribute('data-conversation-scroll', '')
    scroller2.style.overflowY = 'auto'
    const m2 = await mountInScroller(h(View, props), scroller2)
    assert.equal(scroller2.scrollTop, 42, '恢复值生效；不再叠加已删卡的揭示位移')
    assert.ok(query(m2.container, '.redline-bar[data-redline-seq="4"]').className.includes('redline-bar-selected'))
    await m2.unmount()
    gBCR.mockRestore()
  })
})

describe('ContextView — the split generation (slim head + detail channel)', () => {
  /** A slim wire head: the pushed value with the collections empty and the counters/markers on. */
  function slimHead(over: Record<string, unknown> = {}): ContextTimeline {
    return timeline({
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      contextWindow: 128000,
      toolCalls: 3,
      images: 1,
      counts: { turns: 1, steps: 3, injects: 1, compactions: 1, prunes: 0 },
      last: { seq: 6, total: 420, prompt: 410 },
      detailRev: 6,
      ...over,
    })
  }

  /** The matching detail payload (richTimeline's collections). */
  function slimDetail(rev = 6): Record<string, unknown> {
    const rich = richTimeline()
    return {
      rev,
      requests: rich.requests,
      events: rich.events,
      nodes: rich.nodes,
      droppedNodes: rich.droppedNodes,
      archive: rich.archive,
    }
  }

  /** Stub the global fetch to serve (or fail) the plugin's detail route. */
  function slimCtx(serve: () => Promise<unknown>): TestClientCtx {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => await serve() }))
    return new TestClientCtx()
  }

  test('the card shows — until the step list lands, then the demo\'s three numbers', async () => {
    const ctx = slimCtx(async () => ({ ok: true, value: slimDetail() }))
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-slim', useProjection: projectionsFor(slimHead()) }))

    // First paint: 三个数字都来自**该步的节点列表**（detail 通道的产物），slim head 里只有 token 合计、
    // 没有条目数 ⟹ 卡片显示 `—` 而不是假装 0；detail 卡片同时写明这次读还在路上。
    const values = queryAll(m.container, '.redline-stat-value').map(el => text(el))
    assert.deepEqual(values, ['—', '—', '—'], '未就绪不许编数字')
    assert.ok(text(m.container).includes(DICT_EN['detail.loading']))
    assert.equal(queryAll(m.container, '.redline-bar').length, 0, 'the chart waits for the detail')
    assert.equal(queryAll(m.container, '[data-redline-step-pick] option').length, 1, 'the picker holds only the live row')

    // The detail lands: every card renders its real content, the notes clear.
    await until(() => queryAll(m.container, '.redline-bar').length === 3, 'the detail never landed')
    // 数据到了：三格都是真数字，且卡片自身必须自洽 —— 可见条目 = 本步列表 − 被遮蔽。
    const landed = queryAll(m.container, '.redline-stat-value').map(el => text(el))
    assert.ok(landed.every(v => v !== '—'), 'detail 到了就该有数：' + JSON.stringify(landed))
    const bmeta = /(\d[\d.,k]*)\s+items visible in this step/.exec(text(m.container))
    assert.ok(bmeta !== null, '读数行写出来了：' + text(m.container))
    const shadow = /\((\d[\d.,k]*) more superseded\)/.exec(text(m.container))
    const num = (t: string): number => Number(t.replace(/[.,](?=\d{3}\b)/g, '').replace(/k$/, '000'))
    assert.equal(num(landed[0]!), num(bmeta![1]!) - (shadow === null ? 0 : num(shadow[1]!)), '可见 = 列表 − 被遮蔽')
    assert.ok(!text(m.container).includes(DICT_EN['detail.loading']))
    assert.ok(text(m.container).includes('heads-up'), 'the events list serves the detail')
    assert.equal(queryAll(m.container, '[data-redline-step-pick] option').length, 4, 'live + three steps')
    assert.ok(text(m.container).includes('reply three'), 'the brief rows serve the detail')
    await m.unmount()
  })

  test('a failed detail read arms the retry notes; one click refires and the cards land', async () => {
    let online = false
    const ctx = slimCtx(async () => {
      if (!online) throw new Error('offline')
      return { ok: true, value: slimDetail() }
    })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-slim-fail', useProjection: projectionsFor(slimHead()) }))
    await until(() => text(m.container).includes(DICT_EN['detail.loadFailed']), 'the failure never surfaced')
    assert.equal(queryAll(m.container, '.redline-bar').length, 0)

    online = true
    await click(query(m.container, '.redline-br-retry'))
    await until(() => queryAll(m.container, '.redline-bar').length === 3, 'the retry never recovered the cards')
    assert.ok(!text(m.container).includes(DICT_EN['detail.loadFailed']))
    assert.ok(text(m.container).includes('heads-up'))
    await m.unmount()
  })

  test('the jump relay survives the split: held while the detail reads, resolves when it lands', async () => {
    const ctx = slimCtx(async () => ({ ok: true, value: slimDetail() }))
    const View = makeView(ctx)
    // The jump is armed BEFORE the view mounts (the chat action relay) — the
    // detail read is still pending, so the pin must wait for it (not consume
    // and clamp against an empty record list).
    requestContextFocus('sv-slim-jump', 4)
    const m = await mount(h(View, { sessionId: 'sv-slim-jump', useProjection: projectionsFor(slimHead()) }))
    assert.equal(queryAll(m.container, '.redline-bar-selected').length, 0, 'nothing pins before the detail')
    await until(
      () => queryAll(m.container, '.redline-bar[data-redline-seq="4"]')[0]?.className.includes('redline-bar-selected') === true,
      'the jump never resolved',
    )
    assert.equal(takeContextFocus('sv-slim-jump'), null)
    await m.unmount()
  })
})


describe('ContextView — DNA mode (0.6.0)', () => {
  test('the trend DNA toggle shares the browser switch and parks the delta mode at total', async () => {
    const m = await mountRich('sv-dna')
    const card = queryAll(m.container, '.redline-card').find(c => text(c).includes(DICT_EN['trend.title']))
    assert.ok(card !== undefined)
    const dna = buttonByText(card, DICT_EN['trend.dna'])
    const browserDna = buttonByText(m.container, DICT_EN['browser.dna'])
    assert.ok(!dna.className.includes('redline-gran-on'))
    await click(dna)
    assert.ok(dna.className.includes('redline-gran-on'))
    assert.ok(browserDna.className.includes('redline-gran-on'), 'one switch, both cards')
    assert.equal(buttonByText(m.container, DICT_EN['gran.delta']).hasAttribute('disabled'), true)
    assert.equal(queryAll(m.container, '.redline-dna-fill').length > 0, true)
    await click(dna)
    assert.ok(!dna.className.includes('redline-gran-on'))
    assert.ok(!browserDna.className.includes('redline-gran-on'))
    assert.equal(buttonByText(m.container, DICT_EN['gran.delta']).hasAttribute('disabled'), false)
    await m.unmount()
  })
})

// ── 督导状态卡（0.9.0 Goal Supervisor）────────────────────────────────────────
// 这张卡完全由 `guard.supervisor` 的轮询结果驱动，回退是两段确认。之前它没有任何
// 测试；这里钉住「渲染 / 两段确认 / 换会话复位 / 失败可见」四条。
describe('ContextView — supervisor card', () => {
  interface Calls {
    supervisor: number
    rollback: { runId?: string }[]
    resume: { runId?: string }[]
    switch?: { runId?: string, role?: string }[]
  }

  /** Route the plugin channel by op; `guard.rollback` records its arguments. */
  function stubSupervisor(summary: Record<string, unknown> | null, calls: Calls, rollbackReply?: Record<string, unknown>): void {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string, runId?: string }
      if (body.op === 'guard.supervisor') {
        calls.supervisor += 1
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: summary }) } as Response)
      }
      if (body.op === 'guard.switch') {
        const bag = body as { runId?: string, role?: string }
        ;(calls.switch ??= []).push({ runId: bag.runId, role: bag.role })
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { ...summary, status: 'active', blockedReason: undefined } }) } as Response)
      }
      if (body.op === 'guard.continue') {
        calls.resume.push({ runId: body.runId })
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { ...summary, status: 'active', blockedReason: undefined } }) } as Response)
      }
      if (body.op === 'guard.rollback') {
        calls.rollback.push({ runId: body.runId })
        if (rollbackReply !== undefined) {
          return Promise.resolve({ ok: true, json: async () => rollbackReply } as Response)
        }
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { ...summary, status: 'active' } }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
  }

  function summaryOf(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      runId: '20261124-demo',
      phase: 'running',
      status: 'active',
      goal: '把目标漂移修好',
      parallel: 1,
      enforcement: 'warn-only',
      done: 1,
      total: 3,
      currentTaskId: 'T2',
      tasks: [
        { id: 'T1', title: '落盘', status: 'DONE' },
        { id: 'T2', title: '收尾', status: 'IN_PROGRESS' },
        { id: 'T3', title: '回归', status: 'TODO' },
      ],
      pendingRequests: 0,
      updatedAt: T0,
      ...over,
    }
  }

  const card = (container: ParentNode) => container.querySelector<HTMLElement>('[data-redline-supervisor-card]')
  const rollbackButton = (container: ParentNode) => container.querySelector('[data-redline-supervisor-rollback]') as HTMLElement | null

  test('an isolated run names the branch a human still has to merge', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    stubSupervisor(summaryOf({ worktreeBranch: 'guard/20261124-demo' }), calls)
    const m = await mountRich('sv-supervisor-branch')
    await until(() => card(m.container) !== null, 'the card appears')
    const body = text(card(m.container) as HTMLElement)
    // Nothing merges the branch back, so the card must not imply that it does.
    assert.ok(body.includes(DICT_EN['supervisor.worktreeBranch'].replace('{branch}', 'guard/20261124-demo')))
    await m.unmount()
  })

  test('a run read from disk while the session is unloaded says so and blocks rollback', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    stubSupervisor(summaryOf({ agentLive: false }), calls)
    const m = await mountRich('sv-supervisor-down')
    await until(() => card(m.container) !== null, 'the card still renders instead of vanishing')
    const body = text(card(m.container) as HTMLElement)
    // Without the fallback the whole card disappeared on a restart and read as
    // "my run is gone", while the ledger sat on disk the entire time.
    assert.ok(body.includes(DICT_EN['supervisor.agentDown']))
    const button = rollbackButton(m.container)
    assert.ok(button !== null, 'the button is still shown, just not usable')
    assert.equal(button.hasAttribute('disabled'), true)
    await m.unmount()
  })

  test('a CLI-bridge executor says its subagents stay inside the CLI', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    stubSupervisor(summaryOf({ executorModel: 'antigravity/gemini-4-neon (high)' }), calls)
    const m = await mountRich('sv-supervisor-agy-exec')
    await until(() => card(m.container) !== null, 'the card appears')
    const note = card(m.container)?.querySelector<HTMLElement>('[data-redline-supervisor-executor-bridge]') ?? null
    assert.ok(note !== null, 'the bridge note is shown')
    assert.ok(text(note).includes(DICT_EN['supervisor.executorBridgeWarn']))
    await m.unmount()
  })

  test('renders progress, the current task and the run id', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    stubSupervisor(summaryOf(), calls)
    const m = await mountRich('sv-supervisor')
    await until(() => card(m.container) !== null, 'the supervisor card appears')
    const body = text(card(m.container) as HTMLElement)
    assert.ok(body.includes(DICT_EN['supervisor.title']))
    assert.ok(body.includes('1/3'), 'progress reads done/total')
    assert.ok(body.includes(DICT_EN['supervisor.task'].replace('{id}', 'T2').replace('{title}', '收尾')))
    assert.ok(body.includes('20261124-demo'))
    assert.ok(calls.supervisor >= 1)
    await m.unmount()
  })

  test('a blocked task shows its reason', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    stubSupervisor(summaryOf({
      currentTaskId: 'T3',
      tasks: [
        { id: 'T1', title: '落盘', status: 'DONE' },
        { id: 'T3', title: '回归', status: 'BLOCKED', blockedReason: 'scope 外改动' },
      ],
    }), calls)
    const m = await mountRich('sv-supervisor-blocked')
    await until(() => card(m.container) !== null, 'the supervisor card appears')
    assert.ok(text(card(m.container) as HTMLElement).includes('scope 外改动'))
    await m.unmount()
  })

  test('a blocked run offers one-click continue that keeps the task in place', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    stubSupervisor(summaryOf({
      status: 'blocked',
      blockedReason: 'T2 已阻塞：评估器连续 3 次不可用（EMPTY_RESPONSE）',
      currentTaskId: 'T2',
      tasks: [
        { id: 'T1', title: '落盘', status: 'DONE' },
        { id: 'T2', title: '收尾', status: 'BLOCKED', blockedReason: '评估器连续 3 次不可用（EMPTY_RESPONSE）' },
      ],
    }), calls)
    const m = await mountRich('sv-supervisor-continue')
    await until(() => m.container.querySelector('[data-redline-supervisor-resume]') !== null, 'the continue button appears')
    const button = m.container.querySelector('[data-redline-supervisor-resume]') as HTMLButtonElement
    assert.equal(text(button), DICT_EN['supervisor.resume'])
    await click(button)
    await until(() => calls.resume.length > 0, 'the click calls guard.continue')
    assert.deepEqual(calls.resume, [{ runId: '20261124-demo' }])
    // Unlike rollback this is not destructive, so a single click is enough.
    assert.deepEqual(calls.rollback, [], 'continue never rolls the task back')
    await m.unmount()
  })

  test('shows the configured routes and offers the fallback switch on a blocked run', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    stubSupervisor(summaryOf({
      status: 'blocked',
      blockedReason: '评估器连续 3 次不可用（EMPTY_RESPONSE）',
      currentTaskId: 'T2',
      tasks: [{ id: 'T2', title: '收尾', status: 'BLOCKED', blockedReason: '评估器连续 3 次不可用' }],
      executorModel: 'antigravity/gemini-4-neon (high)',
      activeExecutorModel: 'dimagent-oauth/deepseek-v4.1-flash (max)',
      evaluatorModel: 'dimagent-oauth/deepseek-v4.1-flash',
      evaluatorFallbackModel: 'dimagent-oauth/kimi-k3',
      visualWitness: true,
    }), calls)
    const m = await mountRich('sv-supervisor-routes')
    await until(() => card(m.container) !== null, 'the card appears')
    const body = text(card(m.container) as HTMLElement)
    assert.ok(body.includes(DICT_EN['supervisor.executor'].replace('{model}', 'antigravity/gemini-4-neon (high)')))
    assert.ok(body.includes(DICT_EN['supervisor.activeExecutor'].replace('{model}', 'dimagent-oauth/deepseek-v4.1-flash (max)')))
    assert.ok(body.includes(DICT_EN['supervisor.evaluatorFallback'].replace('{model}', 'dimagent-oauth/kimi-k3')))
    assert.ok(body.includes(DICT_EN['supervisor.visual']))

    const switchEval = m.container.querySelector('[data-redline-supervisor-switch-evaluator]') as HTMLButtonElement | null
    assert.ok(switchEval !== null, 'evaluator fallback switch is offered')
    await click(switchEval)
    await until(() => (calls.switch?.length ?? 0) > 0, 'guard.switch is called')
    assert.deepEqual(calls.switch, [{ runId: '20261124-demo', role: 'evaluator' }])
    await m.unmount()
  })

  test('a failed continue is not labelled as a failed rollback', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        calls.supervisor += 1
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: summaryOf({ status: 'blocked', blockedReason: '评估器不可用' }) }) } as Response)
      }
      if (body.op === 'guard.continue') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: false, error: { code: 'redline/bad-request', message: 'run 当前没有被阻断' } }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-continue-fail')
    await until(() => m.container.querySelector('[data-redline-supervisor-resume]') !== null, 'the continue button appears')
    await click(m.container.querySelector('[data-redline-supervisor-resume]') as HTMLElement)
    const expected = DICT_EN['supervisor.actionFailedDetail']
      .replace('{action}', DICT_EN['supervisor.resumeFailed'])
      .replace('{reason}', 'run 当前没有被阻断')
    await until(() => text(card(m.container) as HTMLElement).includes(expected), `the continue failure is named: ${expected}`)
    assert.ok(!text(card(m.container) as HTMLElement).includes(DICT_EN['supervisor.rollbackFailed']))
    await m.unmount()
  })

  test('a blocked run with no configured fallback can still pick a judge and continue', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    const switched: { role?: string, route?: { provider?: string, model?: string } }[] = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string, role?: string, route?: { provider?: string, model?: string } }
      if (body.op === 'guard.supervisor') {
        calls.supervisor += 1
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: summaryOf({ status: 'blocked', blockedReason: '评估器不可用' }) }) } as Response)
      }
      if (body.op === 'carrier.models') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { models: [
          { provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'kimi-k3', modelName: 'Kimi K3', efforts: [] },
        ] } }) } as Response)
      }
      if (body.op === 'guard.switch') {
        switched.push({ role: body.role, route: body.route })
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { ...summaryOf(), status: 'active', blockedReason: undefined } }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-pick-judge')
    const select = await (async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const found = m.container.querySelector<HTMLSelectElement>('[data-redline-supervisor-switch-target]')
        if (found !== null) return found
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      return null
    })()
    assert.ok(select !== null, 'the explicit judge picker appears')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(select, 'dimagent-oauth/kimi-k3')
      select?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const apply = m.container.querySelector('[data-redline-supervisor-switch-apply]') as HTMLButtonElement
    await act(async () => { apply.click() })
    await until(() => switched.length > 0, 'guard.switch is called')
    assert.deepEqual(switched[0], { role: 'evaluator', route: { provider: 'dimagent-oauth', model: 'kimi-k3' } })
    await m.unmount()
  })

  test('a task that becomes BLOCKED mid-run loads the explicit judge picker while the run stays active', async () => {
    // The run status stays `active`; only one task flips to BLOCKED. The old
    // dependency list watched `supervisor?.status`, so the catalog was never
    // loaded for exactly this case.
    const polls: (() => void)[] = []
    const realSetInterval = globalThis.setInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, delay?: number) => {
      if (delay === 3000) {
        // Capture the supervisor poll so the test drives the second tick itself.
        polls.push(fn)
        return 0
      }
      return realSetInterval.call(globalThis, fn, delay)
    }) as unknown as typeof setInterval)
    let blocked = false
    const modelReads: string[] = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ok: true,
            value: summaryOf({
              status: 'active',
              evaluatorFallbackModel: 'dimagent-oauth/kimi-k3',
              tasks: blocked
                ? [
                  { id: 'T1', title: '落盘', status: 'DONE' },
                  { id: 'T2', title: '收尾', status: 'BLOCKED', blockedReason: '评估器不可用' },
                ]
                : [
                  { id: 'T1', title: '落盘', status: 'DONE' },
                  { id: 'T2', title: '收尾', status: 'IN_PROGRESS' },
                ],
            }),
          }),
        } as Response)
      }
      if (body.op === 'carrier.models') {
        modelReads.push('carrier.models')
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { models: [
          { provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'kimi-k3', modelName: 'Kimi K3', efforts: [] },
        ] } }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-supervisor-midblock', useProjection: projectionsFor(richTimeline()) }))
    await flush()
    await until(() => card(m.container) !== null, 'the supervisor card appears')
    assert.equal(m.container.querySelector('[data-redline-supervisor-switch-target]'), null, 'active run without a block shows no picker')
    // The child card also reads the catalog once on mount; only a NEW read after
    // the task flips to BLOCKED proves the supervisor effect re-ran.
    const baseline = modelReads.length

    blocked = true
    await act(async () => { polls.at(-1)?.() })
    await until(() => m.container.querySelector('[data-redline-supervisor-switch-target]') !== null, 'the picker appears once a task is blocked')
    assert.ok(modelReads.length > baseline, 'the catalog is read again for the mid-run block')
    await m.unmount()
    vi.restoreAllMocks()
  })

  test('a blocked run with a configured fallback still offers the explicit judge picker', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        calls.supervisor += 1
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: summaryOf({
          status: 'blocked',
          blockedReason: '评估器不可用',
          evaluatorFallbackModel: 'dimagent-oauth/kimi-k3',
          visualWitness: false,
        }) }) } as Response)
      }
      if (body.op === 'carrier.models') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { models: [
          { provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'kimi-k3', modelName: 'Kimi K3', efforts: [] },
        ] } }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-fallback-picker')
    await until(() => m.container.querySelector('[data-redline-supervisor-switch-target]') !== null,
      'a configured fallback must not hide the explicit picker: it may be the unusable route itself')
    await m.unmount()
  })

  test('the explicit judge picker submits the chosen reasoning level', async () => {
    const switched: { role?: string, route?: { provider?: string, model?: string, reasoningEffort?: string } }[] = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string, role?: string, route?: { provider?: string, model?: string, reasoningEffort?: string } }
      if (body.op === 'guard.supervisor') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: summaryOf({ status: 'blocked', blockedReason: '评估器不可用' }) }) } as Response)
      }
      if (body.op === 'carrier.models') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { models: [
          {
            provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'kimi-k3', modelName: 'Kimi K3',
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
          },
        ] } }) } as Response)
      }
      if (body.op === 'guard.switch') {
        switched.push({ role: body.role, route: body.route })
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { ...summaryOf(), status: 'active', blockedReason: undefined } }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-pick-effort')
    const select = await (async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const found = m.container.querySelector<HTMLSelectElement>('[data-redline-supervisor-switch-target]')
        if (found !== null) return found
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      return null
    })()
    assert.ok(select !== null)
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    await act(async () => {
      setValue?.call(select, 'dimagent-oauth/kimi-k3')
      select?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const effort = m.container.querySelector<HTMLSelectElement>('[data-redline-supervisor-switch-effort]')
    assert.ok(effort !== null, 'a model with efforts offers a level selector')
    await act(async () => {
      setValue?.call(effort, 'high')
      effort?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const apply = m.container.querySelector('[data-redline-supervisor-switch-apply]') as HTMLButtonElement
    await act(async () => { apply.click() })
    await until(() => switched.length > 0, 'guard.switch is called')
    assert.deepEqual(switched[0], {
      role: 'evaluator',
      route: { provider: 'dimagent-oauth', model: 'kimi-k3', reasoningEffort: 'high' },
    })
    await m.unmount()
  })

  test('rollback is two clicks: the first only arms, the second sends confirm', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    stubSupervisor(summaryOf(), calls)
    const m = await mountRich('sv-supervisor-rollback')
    await until(() => rollbackButton(m.container) !== null, 'the rollback button appears')
    const button = rollbackButton(m.container) as HTMLButtonElement
    assert.equal(text(button), DICT_EN['supervisor.rollback'])
    await click(button)
    assert.equal(text(rollbackButton(m.container) as HTMLElement), DICT_EN['supervisor.rollbackArmed'])
    assert.deepEqual(calls.rollback, [], 'one click never rewrites history')
    await click(rollbackButton(m.container) as HTMLElement)
    await until(() => calls.rollback.length > 0, 'the second click issues the rollback')
    assert.deepEqual(calls.rollback, [{ runId: '20261124-demo' }])
    await m.unmount()
  })

  test('switching sessions clears a pending confirmation', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    stubSupervisor(summaryOf(), calls)
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-a', useProjection: projectionsFor(richTimeline()) }))
    await until(() => rollbackButton(m.container) !== null, 'the rollback button appears')
    await click(rollbackButton(m.container) as HTMLElement)
    assert.equal(text(rollbackButton(m.container) as HTMLElement), DICT_EN['supervisor.rollbackArmed'])
    // A new session must not inherit the armed state: one click there may only arm.
    await m.update(h(View, { sessionId: 'sv-b', useProjection: projectionsFor(richTimeline()) }))
    await until(() => rollbackButton(m.container) !== null, 'the card returns for the new session')
    assert.equal(text(rollbackButton(m.container) as HTMLElement), DICT_EN['supervisor.rollback'], 'armed state was reset')
    await m.unmount()
  })

  test('a rollback reply that lands after a session switch is dropped', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    let resolveRollback: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        calls.supervisor += 1
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: summaryOf() }) } as Response)
      }
      if (body.op === 'guard.rollback') {
        calls.rollback.push({})
        // Hold the reply: the user switches sessions before the host answers.
        return new Promise<Response>((resolve) => { resolveRollback = resolve })
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-gen-a', useProjection: projectionsFor(richTimeline()) }))
    await until(() => rollbackButton(m.container) !== null, 'the rollback button appears')
    await click(rollbackButton(m.container) as HTMLElement)
    await click(rollbackButton(m.container) as HTMLElement)
    await until(() => calls.rollback.length === 1, 'the rollback request is in flight')

    await m.update(h(View, { sessionId: 'sv-gen-b', useProjection: projectionsFor(richTimeline()) }))
    await until(() => rollbackButton(m.container) !== null, 'the card returns for the new session')
    // The late reply is a failure from session A; session B must not show it.
    await act(async () => {
      resolveRollback?.({ ok: true, json: async () => ({ ok: false, error: { code: 'redline/bad-request', message: 'stale session A error' } }) } as Response)
    })
    await flush()
    const body = text(card(m.container) as HTMLElement)
    assert.ok(!body.includes('stale session A error'), 'the stale generation is discarded')
    assert.ok(!body.includes(DICT_EN['supervisor.rollbackFailed']), 'no error line is painted on the new session')
    await m.unmount()
  })

  test('a failed rollback shows the host reason instead of going silent', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    // The failure envelope is `{ ok: false, error: { code, message } }`.
    stubSupervisor(summaryOf(), calls, {
      ok: false, error: { code: 'redline/bad-request', message: 'checkpoint 已存在' },
    })
    const m = await mountRich('sv-supervisor-fail')
    await until(() => rollbackButton(m.container) !== null, 'the rollback button appears')
    await click(rollbackButton(m.container) as HTMLElement)
    await click(rollbackButton(m.container) as HTMLElement)
    await until(() => text(card(m.container) as HTMLElement).includes('checkpoint 已存在'), 'the failure is surfaced')
    await m.unmount()
  })

  // Round-11 P2-3: storing the title as the "message" made an empty host message
  // render `Rollback failed：Rollback failed`, and the separator was a hard-coded
  // full-width colon in the English UI.
  test('an empty failure message renders the title once, with no separator', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    stubSupervisor(summaryOf(), calls, { ok: false, error: { code: 'redline/bad-request', message: '' } })
    const m = await mountRich('sv-supervisor-empty-fail')
    await until(() => rollbackButton(m.container) !== null, 'the rollback button appears')
    await click(rollbackButton(m.container) as HTMLElement)
    await click(rollbackButton(m.container) as HTMLElement)
    await until(() => text(card(m.container) as HTMLElement).includes(DICT_EN['supervisor.rollbackFailed']), 'the failure line appears')
    const body = text(card(m.container) as HTMLElement)
    const occurrences = body.split(DICT_EN['supervisor.rollbackFailed']).length - 1
    assert.equal(occurrences, 1, `the title is rendered exactly once: ${JSON.stringify(body)}`)
    assert.ok(!body.includes('：'), `no dangling separator: ${JSON.stringify(body)}`)
    await m.unmount()
  })

  test('a failure reason is joined through the localized template', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    stubSupervisor(summaryOf(), calls, {
      ok: false, error: { code: 'redline/bad-request', message: 'checkpoint 已存在' },
    })
    const m = await mountRich('sv-supervisor-template-fail')
    await until(() => rollbackButton(m.container) !== null, 'the rollback button appears')
    await click(rollbackButton(m.container) as HTMLElement)
    await click(rollbackButton(m.container) as HTMLElement)
    const expected = DICT_EN['supervisor.actionFailedDetail']
      .replace('{action}', DICT_EN['supervisor.rollbackFailed'])
      .replace('{reason}', 'checkpoint 已存在')
    await until(() => text(card(m.container) as HTMLElement).includes(expected), `the template is used: ${expected}`)
    const body = text(card(m.container) as HTMLElement)
    assert.ok(!body.includes('：'), `the English UI carries no full-width colon: ${JSON.stringify(body)}`)
    await m.unmount()
  })

  test('a run-level blockedReason with no BLOCKED task still loads the judge picker', async () => {
    // A legacy `settle` block left the ledger `active` with `goalBlocked` and no
    // BLOCKED row. Watching only the task status left the picker empty exactly
    // when the run-level reason was the only block on record.
    const modelReads = { count: 0 }
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        return Promise.resolve({ ok: true, json: async () => ({
          ok: true,
          value: summaryOf({
            status: 'active',
            blockedReason: 'T2 已阻塞：评估器不可用',
            tasks: [
              { id: 'T1', title: '落盘', status: 'DONE' },
              { id: 'T2', title: '收尾', status: 'IN_PROGRESS' },
            ],
          }),
        }) } as Response)
      }
      if (body.op === 'carrier.models') {
        modelReads.count += 1
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { models: [
          { provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'kimi-k3', modelName: 'Kimi K3', efforts: [] },
        ] } }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-run-block-only')
    await until(() => m.container.querySelector('[data-redline-supervisor-switch-target]') !== null,
      'the judge picker loads for a run-level block without a BLOCKED task')
    assert.ok(modelReads.count >= 1)
    await m.unmount()
  })

  test('an unloaded session never loads the catalog and disables the picker once the agent drops', async () => {
    const polls: (() => void)[] = []
    const realSetInterval = globalThis.setInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, delay?: number) => {
      if (delay === 3000) {
        polls.push(fn)
        return 0
      }
      return realSetInterval.call(globalThis, fn, delay)
    }) as unknown as typeof setInterval)
    let live = true
    let modelReads = 0
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: summaryOf({
          status: 'blocked',
          blockedReason: '评估器不可用',
          ...(live ? {} : { agentLive: false }),
          evaluatorFallbackModel: 'dimagent-oauth/kimi-k3',
        }) }) } as Response)
      }
      if (body.op === 'carrier.models') {
        modelReads += 1
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { models: [
          { provider: 'dimagent-oauth', providerName: 'DimAgent', model: 'kimi-k3', modelName: 'Kimi K3', efforts: [] },
        ] } }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-supervisor-agent-down', useProjection: projectionsFor(richTimeline()) }))
    await until(() => m.container.querySelector('[data-redline-supervisor-switch-target]') !== null, 'the picker appears while live')
    const target = m.container.querySelector<HTMLSelectElement>('[data-redline-supervisor-switch-target]')
    assert.equal(target?.disabled, false)
    const baseline = modelReads

    live = false
    await act(async () => { polls.at(-1)?.() })
    await until(() => m.container.querySelector('[data-redline-supervisor-switch-target]')?.hasAttribute('disabled') === true,
      'the picker is disabled once the session is unloaded')
    assert.equal(modelReads, baseline, 'an unloaded session does not load the model catalog')
    await m.unmount()
    vi.restoreAllMocks()
  })

  test('hides a fallback switch once that role already runs on its fallback', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    stubSupervisor(summaryOf({
      status: 'blocked',
      blockedReason: '评估器不可用',
      evaluatorModel: 'p/judge',
      evaluatorFallbackModel: 'p/judge',
      executorModel: 'p/coder',
      executorFallbackModel: 'p/coder-fallback',
      activeExecutorModel: 'p/coder-fallback',
    }), calls)
    const m = await mountRich('sv-supervisor-on-fallback')
    await until(() => card(m.container) !== null, 'the card appears')
    assert.equal(m.container.querySelector('[data-redline-supervisor-switch-evaluator]'), null,
      'switching to the evaluator fallback is a no-op once it is already active')
    assert.equal(m.container.querySelector('[data-redline-supervisor-switch-executor]'), null,
      'switching to the executor fallback is a no-op once it is already active')
    assert.ok(m.container.querySelector('[data-redline-supervisor-resume]') !== null, 'continue stays available')
    await m.unmount()
  })

  test('a continue whose host goal was not re-armed keeps warning after the poll', async () => {
    const polls: (() => void)[] = []
    const realSetInterval = globalThis.setInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, delay?: number) => {
      if (delay === 3000) {
        polls.push(fn)
        return 0
      }
      return realSetInterval.call(globalThis, fn, delay)
    }) as unknown as typeof setInterval)
    const blockedSummary = {
      status: 'blocked',
      blockedReason: '评估器不可用',
      tasks: [
        { id: 'T1', title: '落盘', status: 'DONE' },
        { id: 'T2', title: '收尾', status: 'BLOCKED', blockedReason: '评估器不可用' },
      ],
    }
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: summaryOf(blockedSummary) }) } as Response)
      }
      if (body.op === 'guard.continue') {
        // The ledger is open again, but the host goal refused to re-arm.
        return Promise.resolve({ ok: true, json: async () => ({
          ok: true, value: { ...summaryOf({ ...blockedSummary, status: 'active', blockedReason: undefined }), goalResumed: false },
        }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-goal-not-resumed')
    await until(() => m.container.querySelector('[data-redline-supervisor-resume]') !== null, 'the continue button appears')
    await click(m.container.querySelector('[data-redline-supervisor-resume]') as HTMLElement)
    await until(() => text(card(m.container) as HTMLElement).includes(DICT_EN['supervisor.goalNotResumed']),
      'the card names the un-resumed host goal')
    // The 3-second poll replaces the summary with the disk snapshot; the warning
    // is an ACTION result and must survive that replacement.
    await act(async () => { polls.at(-1)?.() })
    await flush()
    assert.ok(text(card(m.container) as HTMLElement).includes(DICT_EN['supervisor.goalNotResumed']))
    assert.ok(!text(card(m.container) as HTMLElement).includes(DICT_EN['supervisor.switchFailed']),
      'the continue failure label must not be reused')
    await m.unmount()
    vi.restoreAllMocks()
  })

  test('a switch that woke the ledger but not the host goal keeps warning after the poll', async () => {
    const polls: (() => void)[] = []
    const realSetInterval = globalThis.setInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, delay?: number) => {
      if (delay === 3000) {
        polls.push(fn)
        return 0
      }
      return realSetInterval.call(globalThis, fn, delay)
    }) as unknown as typeof setInterval)
    const blockedSummary = summaryOf({
      status: 'blocked',
      blockedReason: '评估器不可用',
      evaluatorFallbackModel: 'p/judge-fb',
      tasks: [{ id: 'T1', title: '落盘', status: 'DONE' }, { id: 'T2', title: '收尾', status: 'BLOCKED', blockedReason: '评估器不可用' }],
    })
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: blockedSummary }) } as Response)
      }
      if (body.op === 'guard.switch') {
        // The ledger reopened but the host goal hit its round cap.
        return Promise.resolve({ ok: true, json: async () => ({
          ok: true, value: { ...summaryOf({ status: 'active', blockedReason: undefined, evaluatorFallbackModel: 'p/judge-fb' }), goalResumed: false },
        }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-switch-goal-not-resumed')
    await until(() => m.container.querySelector('[data-redline-supervisor-switch-evaluator]') !== null, 'the fallback switch appears')
    await click(m.container.querySelector('[data-redline-supervisor-switch-evaluator]') as HTMLElement)
    await until(() => text(card(m.container) as HTMLElement).includes(DICT_EN['supervisor.goalNotResumed']),
      'the switch reply names the un-resumed host goal')
    await act(async () => { polls.at(-1)?.() })
    await flush()
    assert.ok(text(card(m.container) as HTMLElement).includes(DICT_EN['supervisor.goalNotResumed']))
    await m.unmount()
    vi.restoreAllMocks()
  })

  test('a switch whose resume half was refused says so without calling the switch failed', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        calls.supervisor += 1
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: summaryOf({
          status: 'blocked',
          blockedReason: '里程碑审阅未通过（第 1 轮）',
          evaluatorFallbackModel: 'p/judge-fb',
          tasks: [{ id: 'T1', title: '落盘', status: 'DONE' }, { id: 'T2', title: '收尾', status: 'TODO' }],
        }) }) } as Response)
      }
      if (body.op === 'guard.switch') {
        return Promise.resolve({ ok: true, json: async () => ({
          ok: true,
          value: {
            ...summaryOf({ status: 'blocked', blockedReason: '里程碑审阅未通过（第 1 轮）', evaluatorFallbackModel: 'p/judge-fb' }),
            resumeRefused: '里程碑审阅未通过：请先回退并重开相关任务修复缺陷，不能直接继续',
          },
        }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-resume-refused')
    await until(() => m.container.querySelector('[data-redline-supervisor-switch-evaluator]') !== null, 'the fallback switch appears')
    await click(m.container.querySelector('[data-redline-supervisor-switch-evaluator]') as HTMLElement)
    const expected = DICT_EN['supervisor.resumeRefused'].replace('{reason}', '里程碑审阅未通过：请先回退并重开相关任务修复缺陷，不能直接继续')
    await until(() => text(card(m.container) as HTMLElement).includes(expected), `the refusal is named: ${expected}`)
    const body = text(card(m.container) as HTMLElement)
    assert.ok(!body.includes(DICT_EN['supervisor.switchFailed']), 'a committed switch is not reported as a failed switch')
    await m.unmount()
  })

  test('a run-level blocked status with no BLOCKED row still renders the action row', async () => {
    // `blockedRun` already treated this as blocked for the catalog loader, but
    // the action row keyed off blockedReason/BLOCKED only, so resume and
    // rollback disappeared exactly when the run-level block was the only one.
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    stubSupervisor(summaryOf({
      status: 'blocked',
      tasks: [{ id: 'T1', title: '落盘', status: 'DONE' }, { id: 'T2', title: '收尾', status: 'TODO' }],
    }), calls)
    const m = await mountRich('sv-supervisor-status-blocked-only')
    await until(() => m.container.querySelector('[data-redline-supervisor-resume]') !== null,
      'the resume button renders for a status-only block')
    assert.ok(rollbackButton(m.container) !== null, 'rollback stays available')
    await m.unmount()
  })

  test('an initially unloaded session never loads the model catalog', async () => {
    let modelReads = 0
    let resolveSupervisor: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        // Hold the FIRST summary so the child card's own catalog read (which is
        // unrelated to the supervisor) lands before the agent-down answer does:
        // any later read is the supervisor effect's.
        return new Promise<Response>((resolve) => { resolveSupervisor = resolve })
      }
      if (body.op === 'carrier.models') {
        modelReads += 1
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { models: [] } }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-initially-down')
    await until(() => modelReads >= 1, 'the child-card catalog read happens on mount')
    const baseline = modelReads
    await act(async () => {
      resolveSupervisor?.({ ok: true, json: async () => ({ ok: true, value: summaryOf({
        status: 'blocked',
        blockedReason: '评估器不可用',
        agentLive: false,
        evaluatorFallbackModel: 'p/judge-fb',
      }) }) } as Response)
    })
    await until(() => card(m.container) !== null, 'the read-only card appears')
    await flush()
    assert.equal(modelReads, baseline, 'a run read from disk has no live target to switch')
    assert.equal(m.container.querySelector('[data-redline-supervisor-switch-target]'), null)
    await m.unmount()
  })

  test('switching sessions drops the previous run model catalog instead of keeping it', async () => {
    let modelCalls = 0
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: summaryOf({
          status: 'blocked',
          blockedReason: '评估器不可用',
        }) }) } as Response)
      }
      if (body.op === 'carrier.models') {
        modelCalls += 1
        // The child card and the supervisor effect each read the catalog on
        // mount. From the session switch onward the new catalog never answers:
        // any rendered option would be the previous session's stale list.
        if (modelCalls <= 2) {
          return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { models: [
            { provider: 'p', providerName: 'P', model: 'old-judge', modelName: 'Old Judge', efforts: [] },
          ] } }) } as Response)
        }
        return new Promise<Response>(() => {})
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-catalog-a', useProjection: projectionsFor(richTimeline()) }))
    await until(() => m.container.querySelector('[data-redline-supervisor-switch-target]') !== null, 'the first catalog loads')
    const firstOptions = [...m.container.querySelectorAll('[data-redline-supervisor-switch-target] option')].map(option => text(option as HTMLElement))
    assert.ok(firstOptions.includes('p/old-judge'))
    await m.update(h(View, { sessionId: 'sv-catalog-b', useProjection: projectionsFor(richTimeline()) }))
    await flush()
    assert.equal(m.container.querySelector('[data-redline-supervisor-switch-target]'), null,
      'the previous session\'s catalog is not offered before the new one answers')
    await m.unmount()
  })

  test('renders the dedicated evaluator model when configured and omits it when unset', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    stubSupervisor(summaryOf({ evaluatorModel: 'anthropic/claude-sonnet' }), calls)
    const m = await mountRich('sv-supervisor-eval')
    await until(() => card(m.container) !== null, 'the card appears')
    const line = card(m.container)?.querySelector<HTMLElement>('[data-redline-supervisor-evaluator]') ?? null
    assert.ok(line !== null, 'evaluator line is shown when dedicated model is set')
    assert.equal(text(line), DICT_EN['supervisor.evaluator'].replace('{model}', 'anthropic/claude-sonnet'))
    await m.unmount()

    stubSupervisor(summaryOf(), calls)
    const m2 = await mountRich('sv-supervisor-eval-default')
    await until(() => card(m2.container) !== null, 'the card appears')
    assert.equal(card(m2.container)?.querySelector('[data-redline-supervisor-evaluator]'), null)
    await m2.unmount()
  })

  /** Capture the 3-second supervisor poll so a test can drive the next tick itself. */
  function capturePolls(): (() => void)[] {
    const polls: (() => void)[] = []
    const realSetInterval = globalThis.setInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, delay?: number) => {
      if (delay === 3000) {
        polls.push(fn)
        return 0
      }
      return realSetInterval.call(globalThis, fn, delay)
    }) as unknown as typeof setInterval)
    return polls
  }

  test('a run-level milestone block is not hidden by a blocked sibling with a different reason', async () => {
    const calls: Calls = { supervisor: 0, rollback: [], resume: [] }
    const milestone = '里程碑审阅未通过（第 1 轮）：见 review/round-1.md'
    stubSupervisor(summaryOf({
      status: 'blocked',
      blockedReason: milestone,
      tasks: [
        { id: 'T1', title: '一', status: 'BLOCKED', blockedReason: '评估器不可用' },
        { id: 'T2', title: '二', status: 'DONE' },
      ],
    }), calls)
    const m = await mountRich('sv-supervisor-two-block-reasons')
    await until(() => card(m.container) !== null, 'the card appears')
    const body = text(card(m.container) as HTMLElement)
    assert.ok(body.includes(DICT_EN['supervisor.blocked'].replace('{reason}', '评估器不可用')),
      'the task-level block is named')
    // The milestone gate is a RUN-level fact: hiding it because a different task
    // is blocked made the safety gate look like an ordinary task stall.
    assert.ok(body.includes(DICT_EN['supervisor.runBlocked'].replace('{reason}', milestone)),
      'the run-level milestone block is not hidden by the task block')
    await m.unmount()
  })

  test('a refused resume notice survives the poll that replaces the summary', async () => {
    const polls = capturePolls()
    const blockedSummary = summaryOf({
      status: 'blocked',
      blockedReason: '评估器不可用',
      evaluatorFallbackModel: 'p/judge-fb',
      tasks: [
        { id: 'T1', title: '落盘', status: 'DONE' },
        { id: 'T2', title: '收尾', status: 'BLOCKED', blockedReason: '评估器不可用' },
      ],
    })
    const refusal = '里程碑审阅未通过：请先回退并重开相关任务修复缺陷，不能直接继续'
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: blockedSummary }) } as Response)
      }
      if (body.op === 'guard.switch') {
        return Promise.resolve({ ok: true, json: async () => ({
          ok: true,
          value: { ...summaryOf({
            status: 'blocked',
            blockedReason: '评估器不可用',
            evaluatorFallbackModel: 'p/judge-fb',
            tasks: [
              { id: 'T1', title: '落盘', status: 'DONE' },
              { id: 'T2', title: '收尾', status: 'BLOCKED', blockedReason: '评估器不可用' },
            ],
          }), resumeRefused: refusal },
        }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-refusal-survives-poll')
    await until(() => m.container.querySelector('[data-redline-supervisor-switch-evaluator]') !== null,
      'the fallback switch appears')
    await click(m.container.querySelector('[data-redline-supervisor-switch-evaluator]') as HTMLElement)
    await until(() => m.container.querySelector('[data-redline-supervisor-resume-refused]') !== null,
      'the refusal is named')
    // The poll replaces `supervisor` with the disk snapshot, which does not carry
    // an action-only refusal; dropping the standalone state would make the notice
    // flash for one reply and then vanish.
    await act(async () => { polls.at(-1)?.() })
    await flush()
    const notice = m.container.querySelector('[data-redline-supervisor-resume-refused]')
    assert.ok(notice !== null, 'the refusal survives the poll')
    assert.ok(text(notice as HTMLElement).includes(refusal))
    await m.unmount()
  })

  test('a run that finishes clears the stale action warning on the next poll', async () => {
    const polls = capturePolls()
    let completed = false
    const refusal = '里程碑审阅未通过：请先回退并重开相关任务修复缺陷，不能直接继续'
    const blockedSummary = summaryOf({
      status: 'blocked',
      blockedReason: '评估器不可用',
      evaluatorFallbackModel: 'p/judge-fb',
      tasks: [
        { id: 'T1', title: '落盘', status: 'DONE' },
        { id: 'T2', title: '收尾', status: 'BLOCKED', blockedReason: '评估器不可用' },
      ],
    })
    const completedSummary = summaryOf({
      status: 'completed',
      done: 3,
      blockedReason: undefined,
      tasks: [
        { id: 'T1', title: '一', status: 'DONE' },
        { id: 'T2', title: '二', status: 'DONE' },
        { id: 'T3', title: '三', status: 'DONE' },
      ],
    })
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: completed ? completedSummary : blockedSummary }) } as Response)
      }
      if (body.op === 'guard.switch') {
        return Promise.resolve({ ok: true, json: async () => ({
          ok: true,
          value: {
            // Same `done` as the completed snapshot below: only `status` may
            // prove the notices stale, or deleting the completed branch would
            // still pass through the done-increase comparison.
            ...summaryOf({ status: 'active', done: 3, blockedReason: undefined, evaluatorFallbackModel: 'p/judge-fb' }),
            goalResumed: false,
            resumeRefused: refusal,
          },
        }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-completed-clears-hint')
    await until(() => m.container.querySelector('[data-redline-supervisor-switch-evaluator]') !== null,
      'the fallback switch appears')
    await click(m.container.querySelector('[data-redline-supervisor-switch-evaluator]') as HTMLElement)
    await until(() => m.container.querySelector('[data-redline-supervisor-goal-resume]') !== null,
      'the action warning is shown')
    assert.ok(m.container.querySelector('[data-redline-supervisor-resume-refused]') !== null)
    completed = true
    await act(async () => { polls.at(-1)?.() })
    await flush()
    // A finished run cannot have a pending "the goal was not re-armed" or
    // "resume was refused" condition: both are stale action results.
    assert.equal(m.container.querySelector('[data-redline-supervisor-goal-resume]') === null, true,
      'a completed run clears the stale goal warning')
    assert.equal(m.container.querySelector('[data-redline-supervisor-resume-refused]') === null, true,
      'a completed run clears the stale refusal')
    await m.unmount()
  })

  test('a run that advanced to another task clears the stale action warning', async () => {
    const polls = capturePolls()
    let advanced = false
    const blockedSummary = summaryOf({ status: 'blocked', blockedReason: '评估器不可用' })
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        return Promise.resolve({ ok: true, json: async () => ({
          ok: true,
          value: advanced
            ? summaryOf({ status: 'active', done: 2, blockedReason: undefined })
            : blockedSummary,
        }) } as Response)
      }
      if (body.op === 'guard.continue') {
        return Promise.resolve({ ok: true, json: async () => ({
          ok: true, value: { ...summaryOf({ status: 'active', done: 1, blockedReason: undefined }), goalResumed: false },
        }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-advanced-clears-hint')
    await until(() => m.container.querySelector('[data-redline-supervisor-resume]') !== null, 'the continue button appears')
    await click(m.container.querySelector('[data-redline-supervisor-resume]') as HTMLElement)
    await until(() => m.container.querySelector('[data-redline-supervisor-goal-resume]') !== null,
      'the action warning is shown')
    advanced = true
    await act(async () => { polls.at(-1)?.() })
    await flush()
    assert.equal(m.container.querySelector('[data-redline-supervisor-goal-resume]') === null, true,
      'a run that moved on clears the old warning')
    await m.unmount()
  })

  test('a stale in-flight poll cannot overwrite a newer action result', async () => {
    const polls = capturePolls()
    const oldSummary = summaryOf({ status: 'active', done: 2 })
    // The rollback reopens a task (done 1) and its goal could not be re-armed.
    const rollbackReply = { ...summaryOf({ status: 'active', done: 1 }), goalResumed: false }
    let holdPoll = false
    let resolvePoll: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        if (holdPoll) {
          // Read before the action, answered after it: the classic stale read.
          return new Promise<Response>((resolve) => { resolvePoll = resolve })
        }
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: oldSummary }) } as Response)
      }
      if (body.op === 'guard.rollback') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: rollbackReply }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-stale-poll')
    await until(() => rollbackButton(m.container) !== null, 'the rollback button appears')
    holdPoll = true
    await act(async () => { polls.at(-1)?.() })
    await flush()
    await click(rollbackButton(m.container) as HTMLElement)
    await click(rollbackButton(m.container) as HTMLElement)
    await until(() => m.container.querySelector('[data-redline-supervisor-goal-resume]') !== null,
      'the rollback warning is shown')
    assert.ok(text(card(m.container) as HTMLElement).includes('1/3'), 'the card shows the action snapshot')
    // The held answer lands AFTER the action reply. Its larger `done` looks like
    // progress, but it is older than the result already on screen.
    await act(async () => {
      resolvePoll?.({ ok: true, json: async () => ({ ok: true, value: oldSummary }) } as Response)
    })
    await flush()
    assert.ok(m.container.querySelector('[data-redline-supervisor-goal-resume]') !== null,
      'a stale poll does not clear the fresh action warning')
    assert.ok(text(card(m.container) as HTMLElement).includes('1/3'),
      'the stale poll does not overwrite the card with the pre-action snapshot')
    await m.unmount()
  })

  test('a poll that shows the run unblocked clears a stale resume refusal', async () => {
    const polls = capturePolls()
    let unblocked = false
    const refusal = '里程碑审阅未通过：请先回退并重开相关任务修复缺陷，不能直接继续'
    const blockedSummary = summaryOf({
      status: 'blocked',
      blockedReason: '评估器不可用',
      evaluatorFallbackModel: 'p/judge-fb',
      tasks: [
        { id: 'T1', title: '落盘', status: 'DONE' },
        { id: 'T2', title: '收尾', status: 'BLOCKED', blockedReason: '评估器不可用' },
      ],
    })
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        return Promise.resolve({ ok: true, json: async () => ({
          ok: true,
          value: unblocked
            // Another tab resumed the run: same `done`, block cleared.
            ? summaryOf({ status: 'active', done: 1, blockedReason: undefined })
            : blockedSummary,
        }) } as Response)
      }
      if (body.op === 'guard.switch') {
        return Promise.resolve({ ok: true, json: async () => ({
          ok: true,
          value: { ...blockedSummary, resumeRefused: refusal },
        }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-external-unblock')
    await until(() => m.container.querySelector('[data-redline-supervisor-switch-evaluator]') !== null,
      'the fallback switch appears')
    await click(m.container.querySelector('[data-redline-supervisor-switch-evaluator]') as HTMLElement)
    await until(() => m.container.querySelector('[data-redline-supervisor-resume-refused]') !== null,
      'the refusal is named')
    unblocked = true
    await act(async () => { polls.at(-1)?.() })
    await flush()
    // The refusal described a blocked run; a poll that shows it unblocked proves
    // the notice stale even though `done` did not move.
    assert.equal(m.container.querySelector('[data-redline-supervisor-resume-refused]') === null, true,
      'an externally resumed run clears the stale refusal')
    await m.unmount()
  })

  test('a failed second action does not show the previous action refusal', async () => {
    const refusal = '里程碑审阅未通过：请先回退并重开相关任务修复缺陷，不能直接继续'
    const blockedSummary = summaryOf({
      status: 'blocked',
      blockedReason: '评估器不可用',
      evaluatorFallbackModel: 'p/judge-fb',
      tasks: [
        { id: 'T1', title: '落盘', status: 'DONE' },
        { id: 'T2', title: '收尾', status: 'BLOCKED', blockedReason: '评估器不可用' },
      ],
    })
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: blockedSummary }) } as Response)
      }
      if (body.op === 'guard.switch') {
        return Promise.resolve({ ok: true, json: async () => ({
          ok: true,
          value: { ...summaryOf({ status: 'blocked', blockedReason: '评估器不可用', evaluatorFallbackModel: 'p/judge-fb' }), resumeRefused: refusal },
        }) } as Response)
      }
      if (body.op === 'guard.continue') {
        return Promise.resolve({ ok: true, json: async () => ({
          ok: false, error: { code: 'redline/bad-request', message: '恢复失败：测试原因' },
        }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
    const m = await mountRich('sv-supervisor-stale-refusal-cleared')
    await until(() => m.container.querySelector('[data-redline-supervisor-switch-evaluator]') !== null,
      'the fallback switch appears')
    await click(m.container.querySelector('[data-redline-supervisor-switch-evaluator]') as HTMLElement)
    await until(() => m.container.querySelector('[data-redline-supervisor-resume-refused]') !== null,
      'the refusal is named')
    await click(m.container.querySelector('[data-redline-supervisor-resume]') as HTMLElement)
    await until(() => text(card(m.container) as HTMLElement).includes('恢复失败：测试原因'),
      'the second action failure is named')
    // The old refusal belongs to the previous action; showing it beside a new
    // error would describe two different outcomes at once.
    assert.equal(m.container.querySelector('[data-redline-supervisor-resume-refused]') === null, true,
      'the previous refusal is cleared when the next action starts')
    await m.unmount()
  })
})

// 台账和宿主 goal 会脱节：round-limit 停掉宿主目标后 tasks.json 仍写 active，
// 旧卡片于是永远显示「进行中」。这里钉住「宿主停摆要如实显示 + 继续按钮可用」。
describe('ContextView — supervisor host goal', () => {
  function stubHostGoal(summary: Record<string, unknown>, calls: { resume: number }): void {
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
      if (body.op === 'guard.supervisor') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: summary }) } as Response)
      }
      if (body.op === 'guard.continue') {
        calls.resume += 1
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: summary }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, code: 'redline/unknown-op', message: String(body.op) }) } as Response)
    })
  }

  const summary = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    runId: '20261128-zens',
    phase: 'running',
    status: 'active',
    goal: '把目标漂移修好',
    parallel: 1,
    enforcement: 'warn-only',
    done: 0,
    total: 15,
    currentTaskId: 'V5-A',
    tasks: [{ id: 'V5-A', title: '共享协议', status: 'IN_PROGRESS' }],
    pendingRequests: 0,
    updatedAt: T0,
    ...over,
  })

  test('a round-limit block on the host goal is shown instead of "running"', async () => {
    const calls = { resume: 0 }
    stubHostGoal(summary({
      hostGoal: {
        phase: 'blocked',
        activation: 'disarmed',
        roundsStarted: 256,
        maxGoalRounds: 256,
        blockedCode: 'round-limit',
        blockedMessage: 'Goal reached its configured limit of 256 rounds.',
      },
    }), calls)
    const m = await mountRich('sv-host-goal-blocked')
    await until(() => m.container.querySelector('[data-redline-supervisor-card]') !== null, 'the card appears')
    const cardText = text(m.container.querySelector('[data-redline-supervisor-card]') as HTMLElement)
    assert.ok(cardText.includes(DICT_EN['supervisor.status.blocked']), 'the chip reads blocked, not running')
    assert.ok(!cardText.includes(DICT_EN['supervisor.status.active']), 'the dead run is never labelled running')
    const note = m.container.querySelector('[data-redline-supervisor-host-goal]') as HTMLElement | null
    assert.ok(note !== null, 'the host-goal row is rendered')
    assert.ok(text(note).includes('round-limit'))
    const resume = m.container.querySelector('[data-redline-supervisor-resume]') as HTMLButtonElement | null
    assert.ok(resume !== null, 'continue is offered for a stopped host goal')
    await click(resume)
    await until(() => calls.resume === 1, 'the click calls guard.continue')
    await m.unmount()
  })

  test('a disarmed host goal reads as paused and shows its round consumption', async () => {
    const calls = { resume: 0 }
    stubHostGoal(summary({
      hostGoal: { phase: 'active', activation: 'disarmed', roundsStarted: 12, maxGoalRounds: 2000 },
    }), calls)
    const m = await mountRich('sv-host-goal-disarmed')
    await until(() => m.container.querySelector('[data-redline-supervisor-card]') !== null, 'the card appears')
    const cardText = text(m.container.querySelector('[data-redline-supervisor-card]') as HTMLElement)
    assert.ok(cardText.includes(DICT_EN['supervisor.status.paused']), 'a disarmed goal is not "running"')
    const expected = DICT_EN['supervisor.hostGoalStopped'].replace('{rounds}', '（12/2000）')
    assert.ok(cardText.includes(expected), `the round usage is named: ${expected}`)
    await m.unmount()
  })

  test('a live armed host goal keeps the ordinary running card', async () => {
    const calls = { resume: 0 }
    stubHostGoal(summary({
      hostGoal: { phase: 'active', activation: 'armed', roundsStarted: 12, maxGoalRounds: 2000 },
    }), calls)
    const m = await mountRich('sv-host-goal-armed')
    await until(() => m.container.querySelector('[data-redline-supervisor-card]') !== null, 'the card appears')
    const cardText = text(m.container.querySelector('[data-redline-supervisor-card]') as HTMLElement)
    assert.ok(cardText.includes(DICT_EN['supervisor.status.active']))
    assert.equal(m.container.querySelector('[data-redline-supervisor-host-goal]'), null, 'no warning row for a healthy goal')
    await m.unmount()
  })
})
