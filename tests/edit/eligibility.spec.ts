// Capability judgement (`src/redline/eligibility.ts`) — A17 in `docs/05-test-plan.md` §2.2:
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
import { ability, rowActions, type RowClass, type SurfaceRow } from '../../src/redline/eligibility'

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
      assert.deepEqual(rowActions(a, false), ['edit'], `${cat}/${type}`)
    }
  })

  test('assistant messages cannot be rewritten, with the stable reason key', () => {
    const a = ability(surface({ type: 'assistant/message', cat: 'assistant' }))
    assert.equal(a.canRewrite, false)
    assert.equal(a.inert, false, 'not inert: the UI still explains why there is no action')
    assert.equal(a.blockReason, 'assistant-immutable')
    assert.deepEqual(rowActions(a, false), [])
  })

  test('a shadowed ORIGINAL cannot be edited; the replacement that superseded it can', () => {
    const original = ability(surface({ seq: 1287, type: 'user/message', cat: 'user', shadowed: true }))
    assert.equal(original.canRewrite, false)
    assert.equal(original.blockReason, 'shadowed')
    assert.deepEqual(rowActions(original, false), [])

    const body = ability(surface({ seq: 1301, type: 'user/message', cat: 'user', isReplacement: true }))
    assert.equal(body.canRewrite, true, 'the replacement body is a CURRENT surface node → editable')
    assert.deepEqual(rowActions(body, false), ['edit'])
  })

  test('a compacted-away row is out of reach', () => {
    const a = ability(surface({ type: 'user/message', cat: 'user', compacted: true }))
    assert.equal(a.canRewrite, false)
    assert.equal(a.blockReason, 'compacted')
    assert.deepEqual(rowActions(a, false), [])
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
    assert.deepEqual(rowActions(a, true), ['edit', 'drop'])
  })

  test('a row that cannot be edited never offers a drop, even with a local edit', () => {
    const a = ability(surface({ type: 'assistant/message', cat: 'assistant' }))
    assert.deepEqual(rowActions(a, true), [])
  })
})
