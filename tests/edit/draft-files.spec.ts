// 草稿文件名的两条硬性质（Code Review P2）。
//
// 本地改动是**唯一副本**（会话日志里没有），所以"两个会话落到同一个文件"或
// "文件名超长导致写不进去"都是**直接丢数据**。这两条以前没有任何护栏：
//   · macOS 默认大小写不敏感 ⟹ 仅大小写不同的两个 id 会串档；
//   · 超长 id 会撞 255 字节的文件名上限 ⟹ ENAMETOOLONG。
// 另外：文件里写着它属于哪个会话，读回来必须核对（改名/串档不能被当成本会话的草稿）。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { draftFileName, parseDrafts, serializeDrafts, REDLINE_DRAFT_SCHEMA_VERSION } from '../../src/shared/redline-drafts'

describe('the draft file name is collision-free and always writable', () => {
  test('two ids that differ only in case never share a file', () => {
    assert.notEqual(draftFileName('Session-A'), draftFileName('session-a'))
  })

  test('a path-traversal-shaped id cannot escape the data directory', () => {
    const name = draftFileName('../../etc/passwd')
    assert.ok(!name.includes('/'), name)
    assert.ok(!name.includes('..'), name)
  })

  test('even an absurdly long id stays well under the 255-byte file-name limit', () => {
    const name = draftFileName('x'.repeat(4000))
    assert.ok(Buffer.byteLength(name, 'utf8') < 120, `len=${Buffer.byteLength(name, 'utf8')} name=${name.slice(0, 60)}…`)
  })

  test('the name is stable for the same id (reads and writes agree)', () => {
    assert.equal(draftFileName('session-1'), draftFileName('session-1'))
  })
})

describe('a draft file must belong to the session it is read for', () => {
  const file = serializeDrafts('session-1', { '7': { seq: 7, text: 't', reasoning: '', isError: false, updatedAt: '' } })

  test('the owner session parses', () => {
    const parsed = parseDrafts(file, 'session-1')
    assert.equal(parsed.ok, true)
    assert.equal(Object.keys(parsed.ok ? parsed.table : {}).length, 1)
  })

  test("another session's file is refused, never silently adopted", () => {
    const parsed = parseDrafts(file, 'session-2')
    assert.equal(parsed.ok, false)
    assert.equal(parsed.ok === false ? parsed.code : '', 'redline/draft-corrupt')
  })

  test('an old-format file still reports the schema code', () => {
    const parsed = parseDrafts(JSON.stringify({ schemaVersion: REDLINE_DRAFT_SCHEMA_VERSION + 1, sessionId: 'session-1', edits: [] }), 'session-1')
    assert.equal(parsed.ok === false ? parsed.code : '', 'redline/draft-schema')
  })
})
