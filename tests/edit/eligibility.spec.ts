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

  test('user message / injected content / skill injection / tool result are editable', () => {
    const cases: [RowClass, string][] = [
      ['user', 'user/message'],
      ['inject', 'user/message'],
      ['skill', 'user/message'],
      ['tool', 'tool/result'],
    ]
    for (const [cat, type] of cases) {
      const a = ability(surface({ type, cat }))
      assert.equal(a.canRewrite, true, `${cat}/${type}`)
      assert.deepEqual(rowActions(a, false), ['edit', 'exclude'], `${cat}/${type}`)
    }
  })

  test('assistant messages cannot be rewritten, with the stable reason key', () => {
    const a = ability(surface({ type: 'assistant/message', cat: 'assistant' }))
    assert.equal(a.canRewrite, false)
    assert.equal(a.inert, false, 'not inert: the UI still explains why there is no action')
    assert.equal(a.blockReason, 'assistant-immutable')
    // 2026-10-08：助手消息**改不了但能作废** —— 「标记为不要」是它唯一的处置手段。
    assert.equal(a.canExclude, true)
    assert.deepEqual(rowActions(a, false), ['exclude'])
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

  test('已标为「不要」的行只剩「取消标记」（与编辑互斥）', () => {
    const a = ability(surface({ type: 'user/message', cat: 'user' }))
    assert.deepEqual(rowActions(a, false, true), ['unexclude'])
    assert.deepEqual(rowActions(a, true, true), ['unexclude'], '即使本地有改动，标记状态优先')
    const assistant = ability(surface({ type: 'assistant/message', cat: 'assistant' }))
    assert.deepEqual(rowActions(assistant, false, true), ['unexclude'])
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

  test('the reason keys are exactly the four the UI knows how to explain', () => {
    const keys = new Set<string | undefined>()
    keys.add(ability(surface({ type: 'system/message', cat: 'system' })).blockReason)
    keys.add(ability(surface({ type: 'assistant/message', cat: 'assistant' })).blockReason)
    keys.add(ability(surface({ type: 'user/message', cat: 'user', shadowed: true })).blockReason)
    keys.add(ability(surface({ type: 'user/message', cat: 'user', compacted: true })).blockReason)
    assert.deepEqual([...keys].sort(), ['assistant-immutable', 'compacted', 'shadowed', 'system-head'])
  })

  test('the assistant rule wins when a row is shadowed AND an assistant message', () => {
    // docs/11 实施共识 §6: both reasons apply → assistant wins; only the wording differs.
    const a = ability(surface({ type: 'assistant/message', cat: 'assistant', shadowed: true }))
    assert.equal(a.blockReason, 'assistant-immutable')
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

  test('不能编辑的行不许出现「丢弃这条改动」', () => {
    // 助手消息**可以作废**，但"丢弃改动"只属于"有过改动"的行 —— 它没有。
    const assistant = ability(surface({ type: 'assistant/message', cat: 'assistant' }))
    assert.deepEqual(rowActions(assistant, true), ['exclude'])
    assert.equal(rowActions(assistant, true).includes('drop'), false)
    // 真正什么都给不了的行（已被接替 / 被压缩埋掉 / 宿主保护）：连 exclude 都不给。
    for (const row of [
      surface({ type: 'user/message', cat: 'user', shadowed: true }),
      surface({ type: 'user/message', cat: 'user', compacted: true }),
      surface({ type: 'system/message', cat: 'system' }),
    ]) {
      assert.deepEqual(rowActions(ability(row), true), [], JSON.stringify(row))
    }
  })
})
