// The open-turn rule (`src/shared/redline-turn.ts`) — why the panel refuses to edit
// mid-turn, and how the answer is derived.
//
// The DEMO is the standard here (`docs/03` R4.3, and `demo/demo.js`'s
// `blocked = S.sw.turnOpen || !S.sw.live`): while the turn is open the editor shows
// `当前轮次还没结束 —— 改动只能在轮次边界提交。` and the save button is DISABLED.
// The reason is not bookkeeping: the model may still be reading the old context, so
// an edit prepared mid-turn is prepared against a surface that is about to move —
// and `AGENTS.md` §1 forbids relaxing the turn-boundary rule.
//
// `known:false` means "this process cannot tell" (a session it does not host /
// cannot observe) and the panel must then say "只能查看" rather than pretend.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { hasOpenTurn, turnStateOf, type TurnState } from '../../src/shared/redline-turn'

/** A durable event as far as the rule is concerned: just its type. */
const ev = (type: string): { type: string } => ({ type })

describe('hasOpenTurn counts turn boundaries', () => {
  test('no turns at all is closed', () => {
    assert.equal(hasOpenTurn([]), false)
    assert.equal(hasOpenTurn([ev('user/message'), ev('assistant/message')]), false)
  })

  test('a trailing turn/start without its turn/end is open', () => {
    assert.equal(hasOpenTurn([ev('turn/start'), ev('user/message')]), true)
  })

  test('a closed turn is closed', () => {
    assert.equal(hasOpenTurn([ev('turn/start'), ev('turn/end')]), false)
  })

  test('several turns: only the LAST boundary decides', () => {
    assert.equal(hasOpenTurn([ev('turn/start'), ev('turn/end'), ev('turn/start'), ev('turn/end')]), false)
    assert.equal(hasOpenTurn([
      ev('turn/start'), ev('turn/end'), ev('turn/start'), ev('turn/end'), ev('turn/start'),
    ]), true)
  })

  test('an unmatched turn/end does not "owe" a start (a fork prefix can begin mid-history)', () => {
    // The seed of a child session starts at a completed turn, so a log prefix may
    // legitimately carry ends whose starts were inherited or trimmed.
    assert.equal(hasOpenTurn([ev('turn/end')]), false)
    assert.equal(hasOpenTurn([ev('turn/end'), ev('turn/end')]), false)
  })

  test('events that merely contain the substring do not count', () => {
    assert.equal(hasOpenTurn([ev('turn/started'), ev('turn/ending')]), false)
    assert.equal(hasOpenTurn([ev('turn/start'), ev('turn/start')]), true, 'two starts, no end → open')
  })
})

describe('turnStateOf combines liveness with the boundary', () => {
  test('a session this process does not host is NOT KNOWN — never reported as closed', () => {
    const s: TurnState = turnStateOf(false, [ev('turn/start'), ev('turn/end')])
    assert.deepEqual(s, { known: false, open: false })
  })

  test('a hosted session reports the real boundary', () => {
    assert.deepEqual(turnStateOf(true, [ev('turn/start')]), { known: true, open: true })
    assert.deepEqual(turnStateOf(true, [ev('turn/start'), ev('turn/end')]), { known: true, open: false })
  })

  test('a hosted session with an unreadable log is not known either', () => {
    assert.deepEqual(turnStateOf(true, null), { known: false, open: false })
  })
})
