// S1.1 的第三个样本在**界面**上的落点（`docs/10` M2-26）：缺 token 时不许把 `≈N` 说成完整数字。
// 口径在 `stepStatsOf()`（client-logic 那条），这里只验卡片**把它说出来**。

import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { describe, test } from 'vitest'
import { makeStatsContext } from '../../src/client/components/statsContext'
import { DICT_EN } from '../../src/client/i18n'
import { makeKit, mount, query, queryAll, text, type Mounted } from '../client/helpers/kit'

const kit = makeKit()
const Stats = makeStatsContext(kit)

const stats = (missingTokens: number) => ({
  listed: 10, visible: 9, shadowed: 1, user: 3, inject: 4, tokens: 1234, missingTokens,
})

async function open(missingTokens: number): Promise<Mounted> {
  return await mount(h(Stats, { stats: stats(missingTokens), turn: 1, step: 1, live: false, ready: true }))
}

describe('统计卡：缺 token 时把话说全（M2-26 / S1.1）', () => {
  test('有缺失 ⟹ 明说"另有 N 条未计入"（不许把 ≈ 数字说成完整）', async () => {
    const m = await open(2)
    const note = query(m.container, '[data-redline-missing-tokens]')
    assert.equal(note.getAttribute('data-redline-missing-tokens'), '2')
    assert.equal(text(note), DICT_EN['stats.missing'].replace('{m}', '2'))
    await m.unmount()
  })

  test('都齐 ⟹ 一个字都不加（与 demo 逐字一致）', async () => {
    const m = await open(0)
    assert.equal(queryAll(m.container, '[data-redline-missing-tokens]').length, 0)
    await m.unmount()
  })
})
