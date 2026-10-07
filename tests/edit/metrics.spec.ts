// M2-20 的口径层：**首条任务到底有多大**（确认框要把它如实报给人看）。
//
// 为什么值得单独立一条：这句话是新会话的第一句话，也是"本地改动唯一的出口"（`docs/11` D15）。
// 人点确认之前应该看得到它有多大、里面带了改动的**条数** —— 而不是点完才知道。
// 字节一律按 **UTF-8** 算（中文一字 3 字节，不能按字符数糊弄）。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { firstTaskMetricsOf, utf8BytesOf } from '../../src/redline/metrics'

describe('首条任务的计数（UTF-8 字节 / 行 / 带了几条改动）', () => {
  test('字节按 UTF-8：ASCII 一字节、中文三字节、emoji 四字节', () => {
    assert.equal(utf8BytesOf('abc'), 3)
    assert.equal(utf8BytesOf('中文'), 6)
    assert.equal(utf8BytesOf('🙂'), 4)
    assert.equal(utf8BytesOf(''), 0)
    assert.equal(utf8BytesOf('a中🙂'), 1 + 3 + 4)
  })

  test('行数按换行数 + 1（空串算 0 行，末尾换行不多算一行）', () => {
    assert.equal(firstTaskMetricsOf('', 0).lines, 0)
    assert.equal(firstTaskMetricsOf('一句话', 0).lines, 1)
    assert.equal(firstTaskMetricsOf('第一行\n第二行', 0).lines, 2)
    assert.equal(firstTaskMetricsOf('第一行\n第二行\n', 0).lines, 2, '末尾那个换行不算新行')
  })

  test('bytes 与 edits 如实报：一条改动都不带时 edits 是 0（不是"至少 1"）', () => {
    const withEdits = firstTaskMetricsOf('把测试补上\n\n【#1301】\n改好的正文', 1)
    assert.equal(withEdits.bytes, utf8BytesOf('把测试补上\n\n【#1301】\n改好的正文'))
    assert.equal(withEdits.edits, 1)
    assert.equal(firstTaskMetricsOf('把测试补上', 0).edits, 0)
  })

  test('数的就是**将要发出去的那段字**：多一个字符就多对得上的字节', () => {
    const base = firstTaskMetricsOf('a', 0).bytes
    assert.equal(firstTaskMetricsOf('ab', 0).bytes, base + 1)
    assert.equal(firstTaskMetricsOf('a中', 0).bytes, base + 3)
  })

  test('不改写任何东西：大小与原文逐字节一致（没有规范化/去空白）', () => {
    const text = '  前面有空格\t中间有制表符\n\n后面还有空行  '
    assert.equal(firstTaskMetricsOf(text, 0).bytes, utf8BytesOf(text), '一个字符都不许被"顺手整理"')
  })
})
