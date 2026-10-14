// Capability judgement (`src/shared/redline-ability.ts` — shared by both halves) — A17 in `docs/05-test-plan.md` §2.2:
// **the button set is decided by the UNDERLYING EVENT TYPE, never by the display category**
// (`AGENTS.md` §2.3.1, `docs/01` F7.2).
//
// Locked here:
//   · system prompt / tool definitions (the host-protected node 0 family): NO actions at all —
//     not an empty action bar, and not a button that will fail;
//   · `assistant/message`: cannot be rewritten on this platform (two rules are mutually
//     exclusive) → no action, plus a stable reason key the UI turns into a sentence;
//   · a shadowed original (already replaced): cannot be a replace target again → no action;
//   · a compacted-away row: out of reach → no action;
//   · a REPLACEMENT body is a current surface node → editable (this is why editing twice works);
//   · tool results are the "advanced" class (the demo hides `Edit` behind a switch).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { ability, rowActions, type RowClass, type SurfaceRow } from '../../src/shared/redline-ability'

const surface = (over: Partial<SurfaceRow> & { type: string; cat: RowClass }): SurfaceRow => ({
  seq: 1,
  shadowed: false,
  isReplacement: false,
  compacted: false,
  ...over,
})

describe('A17 · one button set per underlying event type', () => {
  test('system prompt and tool definitions get NO actions and are marked inert', () => {
    for (const cat of ['system', 'tools'] as const) {
      const a = ability(surface({ type: cat === 'system' ? 'system/message' : 'request/header', cat }))
      assert.equal(a.canRewrite, false, cat)
      assert.equal(a.inert, true, cat)
      assert.deepEqual(rowActions(a, false), [], cat)
      // "no action bar at all" is the UI contract; `inert` is the flag it reads.
    }
  })

  test('user / inject / skill / assistant / tool material are editable for zero-history migration', () => {
    const cases: [RowClass, string][] = [
      ['user', 'user/message'],
      ['inject', 'user/message'],
      ['skill', 'user/message'],
      ['assistant', 'assistant/message'],
      ['tool', 'tool/result'],
    ]
    for (const [cat, type] of cases) {
      const a = ability(surface({ type, cat }))
      assert.equal(a.canRewrite, true, `${cat}/${type}`)
      assert.deepEqual(rowActions(a, false), ['edit', 'exclude'], `${cat}/${type}`)
    }
  })


  test('a shadowed ORIGINAL cannot be edited; the replacement that superseded it can', () => {
    const original = ability(surface({ seq: 1287, type: 'user/message', cat: 'user', shadowed: true }))
    assert.equal(original.canRewrite, false)
    assert.equal(original.blockReason, 'shadowed')
    assert.deepEqual(rowActions(original, false), [])

    const body = ability(surface({ seq: 1301, type: 'user/message', cat: 'user', isReplacement: true }))
    assert.equal(body.canRewrite, true, 'the replacement body is a CURRENT surface node → editable')
    assert.deepEqual(rowActions(body, false), ['edit', 'exclude'])
  })

  test('a compacted-away row is out of reach', () => {
    const a = ability(surface({ type: 'user/message', cat: 'user', compacted: true }))
    assert.equal(a.canRewrite, false)
    assert.equal(a.blockReason, 'compacted')
    assert.deepEqual(rowActions(a, false), [])
  })

  // ⚠️ 2026-10-09 按 `docs/03` R4.8 重写：旧断言是"已标为不要 ⟹ 只剩取消标记（与编辑互斥）"，
  // 而互斥已被 R4.8 硬要求 3 作废。新合同：删除态给「取消删除」；**有改稿时再给「丢弃这条改动」**
  // （那是「已删除编辑稿 ──丢弃这条改动──▶ 已删除原文」，只清正文、保持删除态）。
  test('已删除的行给「取消删除」；有改稿时再给「丢弃这条改动」（互斥已作废）', () => {
    const a = ability(surface({ type: 'user/message', cat: 'user' }))
    assert.deepEqual(rowActions(a, false, true), ['unexclude'], '没有改稿 ⟹ 只有取消删除')
    assert.deepEqual(rowActions(a, true, true), ['unexclude', 'drop'], '有改稿 ⟹ 还能丢弃改动')
    assert.deepEqual(rowActions(a, false, false), ['edit', 'exclude'], '没删除的行照旧')
    assert.deepEqual(rowActions(a, true, false), ['edit', 'exclude', 'drop'], '没删除且已改 ⟹ 三个动作都在')
    const assistant = ability(surface({ type: 'assistant/message', cat: 'assistant' }))
    assert.deepEqual(rowActions(assistant, false, true), ['unexclude'])
    assert.deepEqual(rowActions(assistant, true, true), ['unexclude', 'drop'], '助手改稿与删除标记独立')
  })

  test('宿主保护的两类与"够不到"的行，既不能编辑也不能作废', () => {
    for (const row of [
      surface({ type: 'system/message', cat: 'system' }),
      surface({ type: 'request/header', cat: 'tools' }),
      surface({ type: 'user/message', cat: 'user', shadowed: true }),
      surface({ type: 'user/message', cat: 'user', compacted: true }),
    ]) {
      const a = ability(row)
      assert.equal(a.canExclude, false, JSON.stringify(row))
      assert.deepEqual(rowActions(a, false), [], JSON.stringify(row))
    }
  })

  test('the reason keys are exactly the three the UI still needs', () => {
    const keys = new Set<string | undefined>()
    keys.add(ability(surface({ type: 'system/message', cat: 'system' })).blockReason)
    keys.add(ability(surface({ type: 'user/message', cat: 'user', shadowed: true })).blockReason)
    keys.add(ability(surface({ type: 'user/message', cat: 'user', compacted: true })).blockReason)
    assert.deepEqual([...keys].sort(), ['compacted', 'shadowed', 'system-head'])
  })

  test('a shadowed assistant row is unreachable for the ordinary shadowed reason', () => {
    const a = ability(surface({ type: 'assistant/message', cat: 'assistant', shadowed: true }))
    assert.equal(a.blockReason, 'shadowed')
  })
})

describe('tool results are the "advanced" class only', () => {
  test('advancedOnly is true for tool results and false for everything else', () => {
    assert.equal(ability(surface({ type: 'tool/result', cat: 'tool' })).advancedOnly, true)
    for (const [cat, type] of [['user', 'user/message'], ['inject', 'user/message'], ['skill', 'user/message'], ['assistant', 'assistant/message'], ['system', 'system/message']] as [RowClass, string][]) {
      assert.equal(ability(surface({ type, cat })).advancedOnly, false, cat)
    }
  })
})

describe('row actions follow the local-edit state, not the class alone', () => {
  test('an editable row with a local edit offers edit + drop', () => {
    const a = ability(surface({ type: 'user/message', cat: 'user' }))
    assert.deepEqual(rowActions(a, true), ['edit', 'exclude', 'drop'])
  })

  test('真正不能编辑的行不许出现「丢弃这条改动」', () => {
    // 已被接替 / 被压缩埋掉 / 宿主保护：连 exclude 都不给。
    for (const row of [
      surface({ type: 'user/message', cat: 'user', shadowed: true }),
      surface({ type: 'user/message', cat: 'user', compacted: true }),
      surface({ type: 'system/message', cat: 'system' }),
    ]) {
      assert.deepEqual(rowActions(ability(row), true), [], JSON.stringify(row))
    }
  })
})
