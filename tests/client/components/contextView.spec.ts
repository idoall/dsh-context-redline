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
  interface Calls { supervisor: number, rollback: { runId?: string }[] }

  /** Route the plugin channel by op; `guard.rollback` records its arguments. */
  function stubSupervisor(summary: Record<string, unknown> | null, calls: Calls, rollbackReply?: Record<string, unknown>): void {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string, runId?: string }
      if (body.op === 'guard.supervisor') {
        calls.supervisor += 1
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: summary }) } as Response)
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
    const calls: Calls = { supervisor: 0, rollback: [] }
    stubSupervisor(summaryOf({ worktreeBranch: 'guard/20261124-demo' }), calls)
    const m = await mountRich('sv-supervisor-branch')
    await until(() => card(m.container) !== null, 'the card appears')
    const body = text(card(m.container) as HTMLElement)
    // Nothing merges the branch back, so the card must not imply that it does.
    assert.ok(body.includes(DICT_EN['supervisor.worktreeBranch'].replace('{branch}', 'guard/20261124-demo')))
    await m.unmount()
  })

  test('a run read from disk while the session is unloaded says so and blocks rollback', async () => {
    const calls: Calls = { supervisor: 0, rollback: [] }
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

  test('renders progress, the current task and the run id', async () => {
    const calls: Calls = { supervisor: 0, rollback: [] }
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
    const calls: Calls = { supervisor: 0, rollback: [] }
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

  test('rollback is two clicks: the first only arms, the second sends confirm', async () => {
    const calls: Calls = { supervisor: 0, rollback: [] }
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
    const calls: Calls = { supervisor: 0, rollback: [] }
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
    const calls: Calls = { supervisor: 0, rollback: [] }
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
    const calls: Calls = { supervisor: 0, rollback: [] }
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
    const calls: Calls = { supervisor: 0, rollback: [] }
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
    const calls: Calls = { supervisor: 0, rollback: [] }
    stubSupervisor(summaryOf(), calls, {
      ok: false, error: { code: 'redline/bad-request', message: 'checkpoint 已存在' },
    })
    const m = await mountRich('sv-supervisor-template-fail')
    await until(() => rollbackButton(m.container) !== null, 'the rollback button appears')
    await click(rollbackButton(m.container) as HTMLElement)
    await click(rollbackButton(m.container) as HTMLElement)
    const expected = DICT_EN['supervisor.rollbackFailedDetail'].replace('{reason}', 'checkpoint 已存在')
    await until(() => text(card(m.container) as HTMLElement).includes(expected), `the template is used: ${expected}`)
    const body = text(card(m.container) as HTMLElement)
    assert.ok(!body.includes('：'), `the English UI carries no full-width colon: ${JSON.stringify(body)}`)
    await m.unmount()
  })
})
