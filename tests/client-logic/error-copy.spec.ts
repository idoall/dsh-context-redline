// 错误码 → 句子的完整性护栏（Code Review P1-5）。
//
// 为什么需要它：客户端的回退是"键本身"（`i18n.ts` 头注释），所以**缺一个键**的
// 表现是用户看到 `redline.err.draft-corrupt` 这种机器话，而不是一句人话。
// 码表是唯一的对外契约（`src/shared/redline-errors.ts`），所以这条用"遍历码表"
// 的方式锁住 —— 以后新增一个码、忘了写句子，这里立刻红。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { REDLINE_ERROR } from '../../src/shared/redline-errors'
import { DICT_EN, DICT_ZH } from '../../src/client/i18n'

const codes = Object.values(REDLINE_ERROR)

describe('every error code has a sentence in both languages', () => {
  test('the key set is exactly redline.err.<code suffix>', () => {
    for (const code of codes) {
      const key = `redline.err.${code.replace('redline/', '')}`
      assert.ok(typeof DICT_ZH[key] === 'string' && DICT_ZH[key] !== '', `zh 缺句子：${key}`)
      assert.ok(typeof DICT_EN[key] === 'string' && DICT_EN[key] !== '', `en 缺句子：${key}`)
    }
  })

  test('no shipped sentence is the key itself (a silent-fallback would read as machine text)', () => {
    for (const code of codes) {
      const key = `redline.err.${code.replace('redline/', '')}`
      assert.notEqual(DICT_ZH[key], key)
      assert.notEqual(DICT_EN[key], key)
    }
  })

  test('draft-corrupt / draft-schema are first-class codes, not loose strings', () => {
    // 这几个码曾是 `redline-drafts.ts` 里手写的字符串 ⟹ `isRedlineErrorCode()` 不认、
    // 宿主只能把码本身当 wire message、客户端也没有句子（Code Review P1-5）。
    assert.equal(REDLINE_ERROR.draftCorrupt, 'redline/draft-corrupt')
    assert.equal(REDLINE_ERROR.draftSchema, 'redline/draft-schema')
    assert.equal(REDLINE_ERROR.notFound, 'redline/not-found')
  })
})
