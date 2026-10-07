// M5-12 的**口径层**：这条子会话是不是**在这个面板里**开的。
//
// 为什么要有这本台账：官方 `subagentCatalog` 里**没有来源字段**（只有 childId/createdAt/
// version/mode/label，`docs/01` F59 实测）⟹ 平台答不出"本项目发起 / 来自 Agent Teams"。
// 三种诚实态：台账里有 = 本项目发起（并写明官方成员/裸子会话）；没有 = 不是在这儿开的（不猜）；
// 台账**读不出来** = 来源未知并大声报错（不许把第三种说成第二种）。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { REDLINE_ERROR } from '../../src/shared/redline-errors'
import {
  ORIGIN_LEDGER_CAP,
  type OriginRecord,
  ORIGIN_LEDGER_SCHEMA_VERSION,
  originsFileName,
  parseOrigins,
  putOrigin,
  serializeOrigins,
  viaOf,
} from '../../src/shared/redline-origins'

const one = { childId: 'c-1', via: 'official-member' as const, at: 1 }
const two = { childId: 'c-2', via: 'bare-child' as const, at: 2 }

describe('台账解析：缺文件是空、读不出来是大声明说', () => {
  test('缺文件 / 空文件 = 空台账（我们确实没在这条会话里开过）', () => {
    for (const raw of [null, undefined, '', '   \n']) {
      assert.deepEqual(parseOrigins(raw), { ok: true, records: [] })
    }
  })

  test('坏 JSON / 不是对象 / 没有 sessionId / records 不是数组 ⟹ 一律 origin-corrupt', () => {
    const raws = [
      '{',
      '[]',
      '"x"',
      JSON.stringify({ schemaVersion: ORIGIN_LEDGER_SCHEMA_VERSION, records: [] }),
      JSON.stringify({ schemaVersion: ORIGIN_LEDGER_SCHEMA_VERSION, sessionId: 's', records: {} }),
    ]
    for (const raw of raws) {
      const parsed = parseOrigins(raw)
      assert.equal(parsed.ok, false, raw)
      if (!parsed.ok) assert.equal(parsed.code, REDLINE_ERROR.originCorrupt, raw)
    }
  })

  test('schemaVersion 不认识 ⟹ origin-schema（不是 corrupt —— 界面话术不同）', () => {
    const parsed = parseOrigins(JSON.stringify({ schemaVersion: 99, sessionId: 's', records: [] }))
    assert.equal(parsed.ok, false)
    if (!parsed.ok) assert.equal(parsed.code, REDLINE_ERROR.originSchema)
  })

  test('串档（台账上写着别的会话）⟹ 大声拒绝，不拿别人的记录冒充', () => {
    const raw = serializeOrigins('session-a', [one])
    const parsed = parseOrigins(raw, 'session-b')
    assert.equal(parsed.ok, false)
    if (!parsed.ok) assert.equal(parsed.code, REDLINE_ERROR.originCorrupt)
    assert.equal(parseOrigins(raw, 'session-a').ok, true, '同一条会话就认')
  })

  test('坏条目丢掉、好条目留下；同 childId 去重（一条垃圾不该让整本变"来源未知"）', () => {
    const raw = JSON.stringify({
      schemaVersion: ORIGIN_LEDGER_SCHEMA_VERSION,
      sessionId: 's',
      records: [one, { childId: 'c-1', via: 'official-member', at: 9 }, { childId: '', via: 'bare-child' }, { childId: 'c-3', via: 'nope' }, two],
    })
    const parsed = parseOrigins(raw)
    assert.equal(parsed.ok, true)
    if (parsed.ok) assert.deepEqual(parsed.records, [one, two])
  })
})

describe('台账写入：按 childId 幂等、新的在前、有上限', () => {
  test('同一条子会话只留最新那次（重开/重记不叠加）', () => {
    const again = { childId: 'c-1', via: 'bare-child' as const, at: 7 }
    assert.deepEqual(putOrigin([one, two], again), [again, two])
  })

  test('超上限丢最老的（不是丢最新的）', () => {
    let records: OriginRecord[] = []
    for (let i = 0; i < ORIGIN_LEDGER_CAP + 5; i += 1) records = putOrigin(records, { childId: 'c-' + String(i), via: 'bare-child', at: i })
    assert.equal(records.length, ORIGIN_LEDGER_CAP)
    assert.equal(records[0].childId, 'c-' + String(ORIGIN_LEDGER_CAP + 4), '最新的还在最前')
    assert.equal(records.some(r => r.childId === 'c-0'), false, '最老的被丢了')
  })

  test('viaOf：只认台账里那条，并说清走的是哪条路', () => {
    assert.equal(viaOf([one, two], 'c-2'), 'bare-child')
    assert.equal(viaOf([one, two], 'c-9'), null)
  })

  test('serialize → parse 往返一致（并且是确定性输出）', () => {
    const raw = serializeOrigins('session-a', [one, two])
    assert.equal(raw, serializeOrigins('session-a', [one, two]))
    const parsed = parseOrigins(raw, 'session-a')
    assert.equal(parsed.ok, true)
    if (parsed.ok) assert.deepEqual(parsed.records, [one, two])
  })
})

describe('台账文件名：可读前缀 + 稳定短哈希（同会话同名、不同会话不同名）', () => {
  test('同一条会话永远同一个名字；两条不同会话不撞名', () => {
    assert.equal(originsFileName('session-a'), originsFileName('session-a'))
    assert.notEqual(originsFileName('session-a'), originsFileName('session-b'))
    assert.match(originsFileName('session-a'), /^redline-origins-session-a-[0-9a-f]{8}\.json$/)
    // ⚠️ 连 `.` 都被换成 `_`（`[^A-Za-z0-9_-]`）⟹ `../..` 这种路径穿越**根本活不下来**。
    assert.match(originsFileName('../../etc/passwd'), /^redline-origins-______etc_passwd-[0-9a-f]{8}\.json$/)
  })
})
