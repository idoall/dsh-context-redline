// `childRowsOf` 是**纯函数**（把宿主给的 `subagentCatalog` 投影解析成索引行）——
// 所以它放在自有门禁 lane `client-logic` 里 TDD，而不是等界面手工看。
//
// 为什么要这条：投影是**宿主数据**，形状不对时不能把渲染炸掉，也不能瞎猜状态；
// 解析必须 total（坏条目 → 该行说"模式未知"），且**顺序稳定**（新的在上）。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { childRowsOf } from '../../src/client/childSessions'

describe('子会话索引的解析（childRowsOf）', () => {
  test('正常形状：id / label / mode / createdAt 都取到，新的排在前面', () => {
    const rows = childRowsOf([
      { id: '92414bcf-396a-4272-9ca1-4486700c6805', mode: 'continuable', label: '上下文批改 · 61dffc3d', createdAt: 1000 },
      { id: '66da37b9-4bdb-4b9a-98a4-93c0c1747787', mode: 'one-shot', createdAt: 2000 },
    ])
    assert.equal(rows.length, 2)
    assert.equal(rows[0].id, '66da37b9-4bdb-4b9a-98a4-93c0c1747787', '最新的在前（fold 是追加序）')
    assert.equal(rows[0].short, 'c1747787', '短 id = 末 8 位（与官方谱系一致的那一眼）')
    assert.equal(rows[0].mode, 'one-shot')
    assert.equal(rows[0].label, '', '没有 label 就是空串（不是 undefined）')
    assert.equal(rows[1].label, '上下文批改 · 61dffc3d')
    assert.equal(rows[1].mode, 'continuable')
    assert.equal(rows[1].createdAt, 1000)
    assert.equal(rows[0].live, null, '状态没读之前是 null —— 不许猜成 idle')
    assert.equal(rows[0].open, null)
  })

  test('坏数据照样 total：非数组 / null / 没 id / mode 认不出来', () => {
    assert.deepEqual(childRowsOf(undefined), [])
    assert.deepEqual(childRowsOf(null), [])
    assert.deepEqual(childRowsOf({ id: 'x' }), [], '对象不是数组 ⟹ 空索引')
    const rows = childRowsOf([null, 'nope', { mode: 'continuable' }, { id: 'keep-me', mode: 'weird', createdAt: 'soon' }])
    assert.equal(rows.length, 1, '只有带 id 的条目成为行')
    assert.equal(rows[0].id, 'keep-me')
    assert.equal(rows[0].mode, 'unknown', '认不出的 mode → unknown（不冒充 one-shot）')
    assert.equal(rows[0].createdAt, 0, '非数字时间戳 → 0（界面就不显示时刻）')
    assert.equal(rows[0].short, 'keep-me', '短 id 不是 uuid 形状时原样显示')
  })
})
