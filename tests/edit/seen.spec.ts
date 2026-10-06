// 「已查看」标记的本地表（`docs/06` §3.3）—— 纯序列化/解析规则，`edit` 门禁 lane。
//
// 为什么单列一条：这份标记是**我们自己的东西**（不在任何会话里），所以它的失败模式与草稿表不同 ——
// 文件坏了/来自别的会话时必须**大声拒绝**（不能悄悄当空表：那会让"未确认"永远亮着，或把别的会话的
// 标记算到这一条上），而"文件不存在"才是正常的第一天。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  REDLINE_SEEN_SCHEMA_VERSION,
  dropSeen,
  hasSeen,
  parseSeen,
  putSeen,
  seenFileName,
  serializeSeen,
} from '../../src/shared/redline-seen'
import { REDLINE_ERROR } from '../../src/shared/redline-errors'

describe('已查看标记的本地表', () => {
  test('标记与取消都是幂等的，且永远交出升序去重的一份', () => {
    assert.deepEqual(putSeen([], 5), [5])
    assert.deepEqual(putSeen([5], 5), [5], '重复标记同一条不会变成两条')
    assert.deepEqual(putSeen([9, 5], 7), [5, 7, 9], '升序')
    assert.deepEqual(dropSeen([5, 7], 5), [7])
    assert.deepEqual(dropSeen([7], 5), [7], '取消没标过的无害')
    assert.equal(hasSeen([5], 5), true)
    assert.equal(hasSeen([5], 6), false)
  })

  test('坏值不进表：负数、小数、NaN 全被丢掉', () => {
    assert.deepEqual(putSeen([], -1), [])
    assert.deepEqual(putSeen([1], 2.5), [1])
    assert.deepEqual(putSeen([1], Number.NaN), [1])
    assert.deepEqual(dropSeen([1, 2], 2), [1])
  })

  test('文件名带可读前缀 + 稳定哈希（两个会话不会共用一份）', () => {
    const a = seenFileName('session-abcdefgh-1111')
    const b = seenFileName('session-abcdefgh-2222')
    assert.notEqual(a, b, '可读前缀相同的两个会话也必须分文件')
    assert.equal(a, seenFileName('session-abcdefgh-1111'), '同名同会话稳定')
    assert.ok(a.startsWith('redline-seen-') && a.endsWith('.json'))
  })

  test('round-trip：写出去再读回来是同一条规则下的同一份', () => {
    const text = serializeSeen('s-1', [9, 3, 3])
    const parsed = parseSeen(text, 's-1')
    assert.equal(parsed.ok, true)
    assert.deepEqual(parsed.ok ? parsed.seen : null, [3, 9])
    assert.equal(JSON.parse(text).schemaVersion, REDLINE_SEEN_SCHEMA_VERSION)
  })

  test('文件不存在/空白 = 空表（第一天就是这样）', () => {
    for (const raw of [null, undefined, '', '   \n']) {
      const parsed = parseSeen(raw, 's-1')
      assert.equal(parsed.ok, true)
      assert.deepEqual(parsed.ok ? parsed.seen : null, [])
    }
  })

  test('读不出来就**大声拒绝**：坏 JSON / 不是对象 / 缺数组 / seq 不可用', () => {
    for (const raw of ['{', '[]', '{"schemaVersion":1,"sessionId":"s-1"}', '{"schemaVersion":1,"sessionId":"s-1","seen":[1,"x"]}']) {
      const parsed = parseSeen(raw, 's-1')
      assert.equal(parsed.ok, false, raw)
      assert.equal(parsed.ok ? null : parsed.code, REDLINE_ERROR.seenCorrupt)
    }
  })

  test('串档防线：文件里记的是别的会话 ⟹ 拒绝（不把它的标记算到这一条上）', () => {
    const text = serializeSeen('s-OTHER', [4])
    const parsed = parseSeen(text, 's-1')
    assert.equal(parsed.ok, false)
    assert.match(parsed.ok ? '' : parsed.message, /another session/)
  })

  test('版本不认识 ⟹ 用另一个错误码（升级/降级场景要能分开说）', () => {
    const parsed = parseSeen('{"schemaVersion":99,"sessionId":"s-1","seen":[]}', 's-1')
    assert.equal(parsed.ok, false)
    assert.equal(parsed.ok ? null : parsed.code, REDLINE_ERROR.seenSchema)
  })
})
