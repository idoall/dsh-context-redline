// 「当前这一步的统计」的口径（`docs/10` M4-07 —— 用户 2026-10-06 裁定：统计卡取 **3 格、跟 demo**）。
//
// 为什么要单独立一条：demo 是用户逐条确认过的交互，而它的三个数字都是**定义出来的**：
//   · 模型可见条目 = 该步列表里**没有** `gone` 的那些（`gone` = 已被某条接替）；
//   · 另 N 条被遮蔽 = 该步列表里**有** `gone` 的那些 —— `assemble()` 会把"在那一步还活着、
//     如今已被接替"的原文也放进该步的列表（判据见 `src/client/assemble.ts` 的注释：
//     `n.seq < seq && n.gone > seq`），所以这两个数**直接数那张列表**即可，不必另定边界；
//   · 用户消息 / 注入内容 = 只数**可见**的那些（demo 同样从 `vis` 里筛）。
// 靠肉眼数界面改错了没人知道；所以口径钉在这里，卡片只负责渲染。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { stepStatsOf } from '../../src/client/assemble'
import type { SurfaceNode } from '../../src/shared/types'

/** 一条该步列表里的节点：`gone` 存在 = 它已被接替（界面渲染成"已被接替"那行）。 */
const node = (seq: number, cat: SurfaceNode['cat'], tokens = 10, gone?: number): SurfaceNode =>
  ({ seq, cat, tokens, ...(gone === undefined ? {} : { gone }) })

describe('stepStatsOf — the three cells the demo defines', () => {
  test('counts the visible rows, their categories, and the whole list\'s tokens', () => {
    const stats = stepStatsOf({ nodes: [
      node(1, 'user', 100),
      node(2, 'inject', 20),
      node(3, 'inject', 5),
      node(4, 'assistant', 50),
    ] })
    assert.equal(stats.listed, 4, '本步列表 4 条')
    assert.equal(stats.visible, 4, '模型可见条目')
    assert.equal(stats.shadowed, 0, '没有被接替的原文')
    assert.equal(stats.user, 1, '用户消息')
    assert.equal(stats.inject, 2, '注入内容')
    assert.equal(stats.tokens, 175, '≈tokens 按整张列表合计')
  })

  test('a superseded original is NOT visible, and IS the "另 N 条被遮蔽" number', () => {
    const stats = stepStatsOf({ nodes: [
      node(1, 'user', 100),
      node(2, 'inject', 20, 20),   // 已被 #20 接替 ⟹ 界面把这一行渲染成"已被接替"
      node(3, 'inject', 5),
    ] })
    assert.equal(stats.listed, 3)
    assert.equal(stats.visible, 2, '被遮蔽的那条不算可见')
    assert.equal(stats.shadowed, 1, '另 1 条被遮蔽')
    assert.equal(stats.inject, 1, '分类计数只数可见的')
    assert.equal(stats.tokens, 125, 'tokens 仍按整张列表合计（对得上 本步可见 N 条）')
  })

  test('the same seq twice counts once — the #1600 double-count the user caught', () => {
    const stats = stepStatsOf({ nodes: [
      node(2, 'inject', 20, 20),
      node(2, 'inject', 20, 20),
    ] })
    assert.equal(stats.listed, 1, '同一 seq 只算一次')
    assert.equal(stats.shadowed, 1)
    assert.equal(stats.tokens, 20, 'token 也不重复计')
  })

  test('an empty list degrades to zeros, never to NaN', () => {
    const stats = stepStatsOf({ nodes: [] })
    assert.deepEqual(stats, { listed: 0, visible: 0, shadowed: 0, user: 0, inject: 0, tokens: 0, missingTokens: 0 })
  })
})

describe('S1.1 的第三个样本：token 缺失不得用 0 冒充（M2-26）', () => {
  // `docs/00` S1.1 原文：「token 用宿主投影里该节点的 tokens；**缺失时显示 `—`**，不得用 0 冒充」。
  // 求和那格没法显示 `—`，但**绝不能把"没有 token"算成 0 之后当完整数字报出去** ⟹
  // 单列一个计数，界面据此说明"另有 N 条未计入"。
  test('把"没有 token"的条数单列出来（0 是"都齐"，不是"缺了但看不见"）', () => {
    const stats = stepStatsOf({ nodes: [
      node(1, 'user', 100),
      // ⚠️ 线上 schema 里 tokens 是 optional、而 TS 类型写成必填 ⟹ 这里只能断言过去。
      { seq: 2, cat: 'inject' } as unknown as SurfaceNode,
      { seq: 3, cat: 'inject', tokens: 0 }, // 明确是 0 ⟹ 算"有"，不算缺
      node(4, 'assistant', 50),
    ] })
    assert.equal(stats.missingTokens, 1, '只有真的没有 tokens 的那条才算缺')
    assert.equal(stats.tokens, 150, '缺的那条不计入合计（而不是当 0 混进去）')
  })

  test('全都齐的时候是 0（界面才敢不加任何说明）', () => {
    assert.equal(stepStatsOf({ nodes: [node(1, 'user', 10)] }).missingTokens, 0)
    assert.equal(stepStatsOf({ nodes: [] }).missingTokens, 0)
  })
})
