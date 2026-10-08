// 文案体检（`client-logic` lane，是门禁）：**用户看得见的字里不许出现 markdown 星号**。
//
// 真机踩到（2026-10-08）：确认框那一行是纯文本渲染（`h('p', null, item.text)`），
// 而 `child.spawn.note` / `child.hint.idle` 当时的文案里写着 `**最后聊完的那一轮**` 之类
// ⟹ 用户看到的是光秃秃的 `**`。这里把它钉死：词典里任何一个**值**都不许含 `**`。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { DICT_EN, DICT_ZH } from '../../src/client/i18n'

describe('词典（用户看得见的字）', () => {
  for (const [name, dict] of [['zh', DICT_ZH], ['en', DICT_EN]] as const) {
    test(`${name}：任何一条都不含 markdown 星号`, () => {
      const bad = Object.entries(dict).filter(([, v]) => typeof v === 'string' && v.includes('**'))
      assert.deepEqual(bad, [], '界面是纯文本渲染，星号会原样露出：' + JSON.stringify(bad.map(([k]) => k)))
    })

    test(`${name}：任何一条都不含 markdown 反引号（同一类问题）`, () => {
      const bad = Object.entries(dict).filter(([, v]) => typeof v === 'string' && v.includes('`'))
      assert.deepEqual(bad, [], '反引号同样不会被渲染：' + JSON.stringify(bad.map(([k]) => k)))
    })
  }
})
