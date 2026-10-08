// 护栏：**面板的卡必须与 demo 一致**（用户 2026-10-05：「按 demo 去执行」）。
//
// 为什么要有这条：`docs/03` §0 曾写「布局与信息架构整体沿用上游」，被照做后真机上渲染出 **10 张卡** ——
// 上游的 插件信息 / Token 统计 / 耗时统计 / 当前上下文 / 文件活动 / Agent 网络 全都在，而 demo 只有 5 张、
// 且 demo 的第 5 张【子会话】反而缺。用户直接质问「怎么和上下文是一模一样的东西」。
//
// demo 的 5 张卡（`demo/redline-panel.html`）：上下文统计 / 上下文趋势 / 上下文事件 / 上下文浏览器 / 子会话。
// **2026-10-06 起 5 张全在** —— 第 5 张【子会话】随 M5 落地（`docs/10` M3-16/M3-17）：
// 那之前它不该出现（防"提前做一个假按钮"），**之后它必须出现**（防"删了没人发现"）。
//
// 这条用**源码断言**而不是 DOM 断言：卡的存在性由「渲染了哪个组件」决定，源码是最直接的判据，
// 而且它跑在**我们自己的门禁 lane**（`client-ui`）里，不会像上游 lane 那样被环境问题连坐。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'

// jsdom 下 import.meta.url 不是 file: 方案 —— 直接从仓库根解析（vitest 的工作目录就是仓库根）
const SRC = readFileSync(join(process.cwd(), 'src/client/components/contextView.tsx'), 'utf8')

describe('面板卡片清单 = demo（不是上游那张长清单）', () => {
  test('demo 没有的六张卡，一个都不许出现在面板里', () => {
    const upstreamOnly = [
      ['PluginInfo', '插件信息'],
      ['StatsTokens', 'Token 统计'],
      ['StatsTiming', '耗时统计'],
      ['CurrentComposition', '当前上下文'],
      ['FileCard', '文件活动'],
      ['AgentGraph', 'Agent 网络'],
    ] as const
    for (const [tag, label] of upstreamOnly) {
      assert.ok(!SRC.includes('<' + tag), `【${label}】是上游那张清单里的卡，demo 没有 ⟹ 不该再渲染（<${tag}>）`)
    }
  })

  test('demo 的五张卡全在（第 5 张【子会话】已随 M5 落地）', () => {
    for (const [tag, label] of [
      ['StatsContext', '上下文统计'],
      ['TrendChart', '上下文趋势'],
      ['EventList', '上下文事件'],
      ['ContextBrowser', '上下文浏览器'],
      ['ChildCard', '子会话'],
    ] as const) {
      assert.ok(SRC.includes('<' + tag), `demo 的第 N 张卡【${label}】必须在（<${tag}>）`)
    }
  })

  test('主工作区按 demo 分成独立两列：左边趋势→事件，右边浏览器→子会话', () => {
    const masonry = SRC.indexOf('className="redline-masonry"')
    const trend = SRC.indexOf('{trendCard}', masonry)
    const events = SRC.indexOf('<EventList', masonry)
    const browser = SRC.indexOf('{browserCard}', masonry)
    const child = SRC.indexOf('<ChildCard', masonry)
    assert.ok(masonry >= 0, '主工作区必须是独立两列，而不是按行强制对齐')
    assert.ok(trend >= masonry && events > trend, '左列 = 趋势 → 上下文事件')
    assert.ok(browser >= masonry && child > browser, '右列 = 上下文浏览器 → 子会话')
  })

  // 用户 2026-10-08 真机截图：统计卡留在顶部整宽横幅时，demo 的紧凑三格被拉成整宽三大行。
  // 口径回到 demo —— 统计卡就是**左列第一张卡**，那条横幅不再存在。
  test('统计卡是左列第一张卡（顶部整宽横幅已删除）', () => {
    const masonry = SRC.indexOf('className="redline-masonry"')
    const stats = SRC.indexOf('<StatsContext', masonry)
    const trend = SRC.indexOf('{trendCard}', masonry)
    assert.ok(stats > masonry, '统计卡必须落在 masonry 左列里')
    assert.ok(stats < trend, '统计卡在左列的第一位（趋势卡之前）')
    assert.equal(SRC.includes('redline-head'), false, '旧的顶部整宽横幅 .redline-head 必须已经删除')
  })

  // 2026-10-08 真机：统计卡三格用的 Tailwind 任意值类 `grid-cols-[repeat(auto-fit,minmax(108px,1fr))]`
  // **没有被生成**（`grid-template-columns` 只剩一列）⟹ 三格竖着堆满整宽。布局改回我们自己的样式表，
  // 并在这里钉住"不再押注扫描器会发出那个任意值"。
  test('统计卡三格的网格由我们自己的样式表负责（不押 Tailwind 任意值）', () => {
    const statsSrc = readFileSync(join(process.cwd(), 'src/client/components/statsContext.tsx'), 'utf8')
    assert.equal(/grid-cols-\[/.test(statsSrc), false, 'TSX 里不许再用 grid-cols-[…] 任意值类做布局')
    const css = readFileSync(join(process.cwd(), 'src/client/styles/stats.css'), 'utf8')
    const rule = css.match(/\.redline-stats\s*\{[^}]*\}/)?.[0] ?? ''
    assert.ok(/display:\s*grid/.test(rule), '.redline-stats 必须由我们的样式表声明为 grid')
    assert.ok(/grid-template-columns/.test(rule), '.redline-stats 必须自己声明列定义')
  })
})
