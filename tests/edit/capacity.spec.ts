// M5-13 的**口径层**：这台机器允许几个成员。
//
// 为什么要单独一个纯函数（`src/shared/redline-capacity.ts`）：
//   ① 分母**不是我们能编的常数** —— `maxMembers` 的**库默认是 16**，本机由
//      `…/dsh-experimental-agent-team-profile/cordis.patch.yml` 配成 **8**（`docs/01` F31）；
//   ② 从**活服务**读一个字段是"可能读不到"的动作（服务缺失、字段改名、读到垃圾）⟹
//      读不到时**必须说"不知道"**，界面才只写 `活跃 N`、**绝不编一个分母**；
//   ③ 通道来的值进渲染前要 re-prove（`docs/11` D54 的教训）。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { UNKNOWN_CAPACITY, capacityFromService, capacityOf } from '../../src/shared/redline-capacity'

describe('成员上限：读不到就说读不到，不许编数字', () => {
  test('服务在且配了 maxMembers（本机 8）→ 如实读出', () => {
    assert.deepEqual(capacityFromService({ config: { maxMembers: 8 } }), { known: true, max: 8 })
  })

  test('服务不在 / 没有 config / 字段不在 → 一律"不知道"', () => {
    for (const service of [undefined, null, {}, { config: {} }, { config: null }, 'agentTeams']) {
      assert.deepEqual(capacityFromService(service), UNKNOWN_CAPACITY, JSON.stringify(service))
    }
  })

  test('读到垃圾（0 / 负数 / 小数 / 字符串 / NaN）也算"不知道"—— 不许凑一个分母', () => {
    for (const bad of [0, -1, 3.5, '8', NaN, Infinity, true, []]) {
      assert.deepEqual(capacityFromService({ config: { maxMembers: bad } }), UNKNOWN_CAPACITY, String(bad))
    }
  })

  test('通道回答要 re-prove：形状不对就是"不知道"', () => {
    assert.deepEqual(capacityOf({ known: true, max: 8 }), { known: true, max: 8 })
    for (const bad of [null, 42, 'x', {}, { known: true }, { known: true, max: '8' }, { known: false, max: 8 }]) {
      assert.deepEqual(capacityOf(bad), UNKNOWN_CAPACITY, JSON.stringify(bad))
    }
  })

  test('常量是冻结的那一份（不许被调用方就地改）', () => {
    assert.equal(Object.isFrozen(UNKNOWN_CAPACITY), true)
  })
})
