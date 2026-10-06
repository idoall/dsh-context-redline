// StatsContext (src/client/components/statsContext.tsx) rendered with real React:
// **the three cells the demo defines**（用户 2026-10-06 裁定，`docs/10` M4-07）——
// 模型可见条目（另 N 条被遮蔽）/ 用户消息 / 注入内容 + 标题里的当前视图与
// `本步可见 N 条 · ≈X tokens`，中英两locale。三个数字的口径在纯函数
// `stepStatsOf()`（`src/client/assemble.ts`）里单测；这里只钉"卡片渲染成什么样"。
// `countsOfRecords`（拆分代际的头里那份计数）与 `makeSubagentCost`（费用折叠，
// 本卡不再引用但模块保留）各自的下半部分仍在本文件里测。

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { countsOfRecords, makeStatsContext } from '../../../src/client/components/statsContext'
import type { StepStats } from '../../../src/client/assemble'
import type { ContextEventRecord, RequestRecord } from '../../../src/shared/types'
import { flush, makeKit, mount, queryAll, text } from '../helpers/kit'

const kit = makeKit()
/** 与卡片同一套数字格式（`kit.fmt`）：1_234 → `1.2k`。 */
const KIT_FMT = kit.fmt(1_234)
const kitZh = makeKit('zh')
const StatsContext = makeStatsContext(kit)
const StatsContextZh = makeStatsContext(kitZh)


function req(turn?: number): RequestRecord {
  return {
    time: 0, seq: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0,
    ...(turn !== undefined ? { turn } : {}),
  }
}

function ev(kind: ContextEventRecord['kind']): ContextEventRecord {
  return { seq: 0, time: 0, kind }
}

function cells(container: HTMLElement): { labels: string[]; values: string[] } {
  const grid = queryAll(container, '.redline-stat')
  return {
    labels: grid.map(el => el.querySelector('.redline-stat-label')?.textContent ?? ''),
    values: grid.map(el => el.querySelector('.redline-stat-value')?.textContent ?? ''),
  }
}


describe('countsOfRecords (the inline generation derivation)', () => {
  test('tallies distinct turns, records, and the three priced event kinds', () => {
    // Two steps in turn 1, one in turn 2, one without a turn (folds as turn 0).
    const counts = countsOfRecords(
      [req(1), req(1), req(2), req()],
      [ev('inject'), ev('inject'), ev('inject'), ev('compaction'), ev('compaction'), ev('prune'), ev('model'), ev('mode')],
    )
    // model/mode events do not appear (only the three priced kinds do).
    assert.deepEqual(counts, { turns: 3, steps: 4, injects: 3, compactions: 2, prunes: 1 })
  })

  test('empty collections tally zero', () => {
    assert.deepEqual(countsOfRecords([], []), { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 })
  })
})

describe('StatsContext — the three cells the demo defines (docs/10 M4-07)', () => {
  /** 该步读数（`stepStatsOf` 的产物）：卡片只负责渲染，口径在 assemble.ts 的纯函数里。 */
  const stepStats = (over: Partial<StepStats> = {}): StepStats =>
    ({ listed: 4, visible: 4, shadowed: 0, user: 1, inject: 2, tokens: 1_234, ...over })

  test('renders exactly three cells with the demo\'s words and the step reading line', async () => {
    const m = await mount(h(StatsContext, { stats: stepStats(), turn: 3, step: 4, live: false, ready: true }))
    await flush()
    assert.ok(text(m.container).includes('Context Stats'))
    const { labels, values } = cells(m.container)
    assert.equal(labels.length, 3, 'demo 只有三格')
    assert.deepEqual(labels, ['Model-visible items', 'User messages', 'Injected items'])
    assert.deepEqual(values, ['4', '1', '2'])
    // 标题里带当前视图 + 本步可见 N 条 · ≈X tokens（与 demo 同一句话）。
    assert.ok(text(m.container).includes('(showing turn 3 · step 4'), text(m.container))
    assert.ok(text(m.container).includes('4 items visible in this step · ≈' + KIT_FMT), text(m.container))
    await m.unmount()
  })

  test('the live view says so, and a superseded count is written parenthetically', async () => {
    const m = await mount(h(StatsContext, {
      stats: stepStats({ listed: 6, visible: 4, shadowed: 2 }),
      turn: 9, step: 1, live: true, ready: true,
    }))
    await flush()
    assert.ok(text(m.container).includes(' · live)'), text(m.container))
    const { labels, values } = cells(m.container)
    assert.deepEqual(labels, ['Model-visible items (2 more superseded)', 'User messages', 'Injected items'])
    assert.deepEqual(values, ['4', '1', '2'], '被遮蔽的不进可见计数')
    assert.ok(text(m.container).includes('6 items visible in this step'), 'N 是该步列表的总条数')
    await m.unmount()
  })

  test('no superseded items → no parenthetical at all', async () => {
    const m = await mount(h(StatsContext, { stats: stepStats({ shadowed: 0 }), turn: 1, step: 0, live: false, ready: true }))
    await flush()
    assert.ok(!text(m.container).includes('superseded'))
    await m.unmount()
  })

  test('the zh locale localizes the labels and the reading line', async () => {
    const m = await mount(h(StatsContextZh, {
      stats: stepStats({ listed: 5, visible: 3, shadowed: 2, user: 1, inject: 1, tokens: 900 }),
      turn: 2, step: 3, live: false, ready: true,
    }))
    await flush()
    const { labels, values } = cells(m.container)
    assert.deepEqual(labels, ['模型可见条目（另 2 条被遮蔽）', '用户消息', '注入内容'])
    assert.deepEqual(values, ['3', '1', '1'])
    assert.ok(text(m.container).includes('本步可见 5 条 · ≈900 tokens'), text(m.container))
    await m.unmount()
  })

  test('before the detail lands the three cells read — (never a made-up 0)', async () => {
    const m = await mount(h(StatsContext, {
      stats: { listed: 0, visible: 0, shadowed: 0, user: 0, inject: 0, tokens: 0 },
      turn: 3, step: 4, live: false, ready: false,
    }))
    await flush()
    const { values } = cells(m.container)
    assert.deepEqual(values, ['—', '—', '—'], 'slim head 里没有条目数 ⟹ 不许假装 0')
    assert.ok(!text(m.container).includes('items visible in this step'), '未就绪时连读数行都不写')
    await m.unmount()
  })

  test('zero everything still renders three cells, never a dash grid', async () => {
    const m = await mount(h(StatsContext, {
      stats: { listed: 0, visible: 0, shadowed: 0, user: 0, inject: 0, tokens: 0 },
      live: true, ready: true,
    }))
    await flush()
    const { labels, values } = cells(m.container)
    assert.deepEqual(values, ['0', '0', '0'])
    assert.equal(labels.length, 3)
    await m.unmount()
  })
})
