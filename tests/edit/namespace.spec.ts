// The shared redline contract (`src/shared/`), from the EDIT lane: pure values
// only — no host, no upstream, no DOM. This is the seed of the lane
// `docs/05-test-plan.md` §1 defines; M2 grows the editing guardrails here.
//
// What it locks (M1's "identity" deliverable):
//   · every route we register lives under OUR `/api` prefix and never under
//     upstream's (`docs/01` F1 — a duplicate exact path makes the host THROW);
//   · the error-code table is stable, prefixed and fully documented;
//   · the data directory is ours (`docs/01` F4);
//   · the envelope helpers produce the one shape both halves agree on.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { REDLINE_ERROR, REDLINE_ERROR_MESSAGE, isRedlineErrorCode } from '../../src/shared/redline-errors'
import { REDLINE_DATA_DIR_NAME } from '../../src/shared/redline-paths'
import {
  REDLINE_API_PREFIX,
  REDLINE_BACKFILL_ROUTE,
  REDLINE_BALANCE_ROUTE,
  REDLINE_CHANNEL_ROUTE,
  REDLINE_DETAIL_ROUTE,
  REDLINE_ROUTES,
  asRedlineCall,
  redlineFailure,
  redlineOk,
} from '../../src/shared/redline-route'

/** Upstream's prefix, guarded so our own name cannot satisfy the assertion. */
const UPSTREAM_PREFIX = /^\/api\/dsh-context\/(?!redline)/

describe('route namespace', () => {
  test('the prefix is ours alone', () => {
    assert.equal(REDLINE_API_PREFIX, '/api/dsh-context-redline')
    assert.ok(!UPSTREAM_PREFIX.test(REDLINE_API_PREFIX), 'our own prefix must not read as upstream\'s')
  })

  test('every registered route hangs off our prefix and off nobody else\'s', () => {
    assert.deepEqual(
      [...REDLINE_ROUTES].sort(),
      [REDLINE_BACKFILL_ROUTE, REDLINE_BALANCE_ROUTE, REDLINE_CHANNEL_ROUTE, REDLINE_DETAIL_ROUTE].sort(),
      'REDLINE_ROUTES lists exactly the four routes M1 registers',
    )
    assert.equal(new Set(REDLINE_ROUTES).size, REDLINE_ROUTES.length, 'no duplicate path')
    for (const route of REDLINE_ROUTES) {
      assert.ok(route.startsWith(`${REDLINE_API_PREFIX}/`), `${route} sits under our prefix`)
      assert.ok(!UPSTREAM_PREFIX.test(route), `${route} must not collide with upstream's`)
      // The `path` a route registers includes the `/api` prefix (docs/01 F1
      // records that upstream's own type comment says otherwise).
      assert.ok(route.startsWith('/api/'), `${route} keeps the /api prefix`)
    }
  })

  test('the four documented paths are spelled exactly once, here', () => {
    assert.equal(REDLINE_CHANNEL_ROUTE, '/api/dsh-context-redline/redline')
    assert.equal(REDLINE_DETAIL_ROUTE, '/api/dsh-context-redline/detail')
    assert.equal(REDLINE_BALANCE_ROUTE, '/api/dsh-context-redline/balance')
    assert.equal(REDLINE_BACKFILL_ROUTE, '/api/dsh-context-redline/backfill')
  })
})

describe('error-code table', () => {
  test('every code is namespaced and unique', () => {
    const codes = Object.values(REDLINE_ERROR)
    for (const code of codes) assert.ok(code.startsWith('redline/'), code)
    assert.equal(new Set(codes).size, codes.length, 'no duplicate code')
  })

  test('every code has a wire message, and only known codes pass the guard', () => {
    for (const code of Object.values(REDLINE_ERROR)) {
      assert.equal(typeof REDLINE_ERROR_MESSAGE[code], 'string', code)
      assert.ok(REDLINE_ERROR_MESSAGE[code].length > 0, code)
      assert.equal(isRedlineErrorCode(code), true, code)
    }
    assert.equal(isRedlineErrorCode('gateway/internal'), false)
    assert.equal(isRedlineErrorCode('redline/not-a-code'), false)
  })

  test('the codes the refusal paths need are present and stable', () => {
    // These strings are the client's lookup keys (docs/03 R4.7) and the tests'
    // assertions — renaming one is a contract change, not a refactor.
    assert.deepEqual(
      {
        badRequest: REDLINE_ERROR.badRequest,
        unknownOp: REDLINE_ERROR.unknownOp,
        notLive: REDLINE_ERROR.notLive,
        turnOpen: REDLINE_ERROR.turnOpen,
        noDraft: REDLINE_ERROR.noDraft,
        noChange: REDLINE_ERROR.noChange,
        assistantImmutable: REDLINE_ERROR.assistantImmutable,
        shadowed: REDLINE_ERROR.shadowed,
        badRange: REDLINE_ERROR.badRange,
        historyUnavailable: REDLINE_ERROR.historyUnavailable,
        unsupportedType: REDLINE_ERROR.unsupportedType,
      },
      {
        badRequest: 'redline/bad-request',
        unknownOp: 'redline/unknown-op',
        notLive: 'redline/not-live',
        turnOpen: 'redline/turn-open',
        noDraft: 'redline/no-draft',
        noChange: 'redline/no-change',
        assistantImmutable: 'redline/assistant-immutable',
        shadowed: 'redline/shadowed',
        badRange: 'redline/bad-range',
        historyUnavailable: 'redline/history-unavailable',
        unsupportedType: 'redline/unsupported-type',
      },
    )
  })
})

describe('data directory namespace', () => {
  test('our data directory is ours, not the upstream package name', () => {
    assert.equal(REDLINE_DATA_DIR_NAME, 'dsh-context-redline')
    assert.ok(!UPSTREAM_PREFIX.test(`/${REDLINE_DATA_DIR_NAME}`))
  })
})

describe('the wire envelope', () => {
  test('success and failure halves have the documented shape', () => {
    assert.deepEqual(redlineOk({ a: 1 }), { ok: true, value: { a: 1 } })
    assert.deepEqual(redlineFailure(REDLINE_ERROR.badRequest, 'nope'), {
      ok: false,
      error: { code: 'redline/bad-request', message: 'nope' },
    })
  })

  test('asRedlineCall accepts only an object carrying a non-empty string op', () => {
    assert.deepEqual(asRedlineCall({ op: 'node.read', sessionId: 's1' }), { op: 'node.read', sessionId: 's1' })
    for (const bad of [null, undefined, 42, 'op', [], { op: '' }, { op: 7 }, { noOp: true }]) {
      assert.equal(asRedlineCall(bad), null, JSON.stringify(bad) ?? 'undefined')
    }
  })
})
