// 护栏：**面板的卡必须与 demo 一致**（用户 2026-10-05：「按 demo 去执行」）。
//
// 为什么要有这条：`docs/03` §0 曾写「布局与信息架构整体沿用上游」，被照做后真机上渲染出 **10 张卡** ——
// 上游的 插件信息 / Token 统计 / 耗时统计 / 当前上下文 / 文件活动 / Agent 网络 全都在，而 demo 只有 5 张、
// 且 demo 的第 5 张【子会话】反而缺。用户直接质问「怎么和上下文是一模一样的东西」。
//
// demo 的 5 张卡（`demo/redline-panel.html`）：上下文统计 / 上下文趋势 / 上下文事件 / 上下文浏览器 / 子会话。
// 前 4 张现在都在；第 5 张【子会话】随 M5 落地后加入 —— 那之前它不该出现，之后它必须出现。
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

  test('demo 的前四张卡都在（第 5 张【子会话】随 M5 落地）', () => {
    for (const [tag, label] of [
      ['StatsContext', '上下文统计'],
      ['TrendChart', '上下文趋势'],
      ['EventList', '上下文事件'],
      ['ContextBrowser', '上下文浏览器'],
    ] as const) {
      assert.ok(SRC.includes('<' + tag), `demo 的第 N 张卡【${label}】必须在（<${tag}>）`)
    }
  })
})
