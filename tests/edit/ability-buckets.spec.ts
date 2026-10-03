// Why a row's CATEGORY is enough to decide its ACTIONS — and why it is not enough
// to decide the editor's fields.
//
// `AGENTS.md` §2.3.1 says the button set must come from the durable event type,
// never from the display category. The reason is real: a `skill` row can be a
// `tool/result` underneath. What makes the category safe HERE is not an
// assumption but an invariant, locked below: **every durable type a bucket can
// hold yields the same action set**. The bucket list itself is the fold's own
// (`src/host/fold.ts` `categoryOf`, whose contract is asserted in the host lane).
//
// The exact type still matters for one thing — the editor's fields (`docs/03`
// R3.2) — and that comes from `node.read`, which answers the real type. This file
// pins both halves of that split so neither can drift silently:
//   · if the fold ever puts a `tool/result` into a bucket where "editable" would
//     be wrong, the invariance assertion fails;
//   · the representative type must belong to its bucket.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { TYPES_BY_BUCKET, ability, durableTypeOf, rowActions, type RowClass, type SurfaceRow } from '../../src/shared/redline-ability'

const BUCKETS = Object.keys(TYPES_BY_BUCKET) as RowClass[]

const row = (cat: RowClass, type: string, over: Partial<SurfaceRow> = {}): SurfaceRow => ({
  seq: 1, cat, type, shadowed: false, isReplacement: false, compacted: false, ...over,
})

describe('the bucket table matches the buckets the UI has', () => {
  test('all seven categories are declared, each with at least one type', () => {
    assert.deepEqual([...BUCKETS].sort(), ['assistant', 'inject', 'skill', 'system', 'tool', 'tools', 'user'])
    for (const cat of BUCKETS) assert.ok(TYPES_BY_BUCKET[cat].length > 0, cat)
  })

  test('the representative type belongs to its own bucket', () => {
    for (const cat of BUCKETS) {
      assert.ok(TYPES_BY_BUCKET[cat].includes(durableTypeOf(cat)), `${cat} → ${durableTypeOf(cat)}`)
    }
  })

  test('the skill bucket really carries two types (the case that makes this necessary)', () => {
    assert.deepEqual([...TYPES_BY_BUCKET.skill].sort(), ['tool/result', 'user/message'])
  })
})

describe('the action set is invariant across a bucket\'s types', () => {
  test('every type in a bucket yields the same actions, inert flag and advancedOnly', () => {
    for (const cat of BUCKETS) {
      const seen = TYPES_BY_BUCKET[cat].map((type) => {
        const a = ability(row(cat, type))
        return JSON.stringify({ can: a.canRewrite, inert: a.inert, adv: a.advancedOnly, actions: rowActions(a, false), drop: rowActions(a, true), reason: a.blockReason ?? null })
      })
      assert.equal(new Set(seen).size, 1, `${cat} is NOT action-invariant: ${seen.join(' vs ')}`)
    }
  })

  test('exactly three buckets offer no action at all, and they are the host-protected/immutable ones', () => {
    const inert = BUCKETS.filter(cat => !ability(row(cat, durableTypeOf(cat))).canRewrite)
    assert.deepEqual([...inert].sort(), ['assistant', 'system', 'tools'])
    // …and the other four are editable, which is what the panel must show.
    const editable = BUCKETS.filter(cat => ability(row(cat, durableTypeOf(cat))).canRewrite)
    assert.deepEqual([...editable].sort(), ['inject', 'skill', 'tool', 'user'])
  })

  test('the reason a non-editable bucket gives is stable per bucket', () => {
    assert.equal(ability(row('assistant', 'assistant/message')).blockReason, 'assistant-immutable')
    assert.equal(ability(row('system', 'system/message')).blockReason, 'system-head')
    assert.equal(ability(row('tools', 'request/header')).blockReason, 'system-head')
  })

  test('a shadowed or compacted row loses its actions in EVERY bucket', () => {
    for (const cat of BUCKETS) {
      for (const type of TYPES_BY_BUCKET[cat]) {
        assert.equal(ability(row(cat, type, { shadowed: true })).canRewrite, false, `${cat}/${type} shadowed`)
        assert.equal(ability(row(cat, type, { compacted: true })).canRewrite, false, `${cat}/${type} compacted`)
      }
    }
  })
})

describe('the exact type is what the EDITOR needs (and it comes from node.read)', () => {
  test('the skill bucket proves why: one bucket, two different field sets', () => {
    const isToolResult = TYPES_BY_BUCKET.skill.includes('tool/result')
    assert.equal(isToolResult, true)
    // docs/03 R3.2 keys the fields off the type, not the bucket:
    //   tool/result  → result text + isError
    //   user/message → 正文 + thinking text (folded under 高级)
    // The panel reads that type from `node.read`, so a skill row that is a tool
    // result gets the tool-result editor even though it sits in the skill bucket.
    assert.notEqual('tool/result', 'user/message')
  })
})
