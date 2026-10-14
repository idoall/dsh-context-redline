import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { carrierEvidenceFromEvents } from '../../src/host/redline-carrier-runner'

const user = (seq: number, rpcId: string, id = 'prompt-message') => ({
  type: 'user/message', seq, data: { id, role: 'user', content: [{ type: 'text', text: 'task' }], source: { kind: 'user', rpcId } },
})

describe('carrier durable result trace', () => {
  test('binds the exact request to its turn and final visible assistant only', () => {
    const evidence = carrierEvidenceFromEvents('prompt-request', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } }, user(2, 'old'),
      { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { id: 'old-answer', content: [{ type: 'text', text: 'old' }] } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 5, data: { turn: 2 } },
      { type: 'step/start', seq: 6, data: { turn: 2, step: 1 } }, user(7, 'prompt-request'),
      { type: 'assistant/message', seq: 8, data: { turn: 2, step: 1, message: { id: 'answer', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] } } },
      { type: 'turn/end', seq: 9, data: { turn: 2, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 10, data: { turn: 3 } },
      { type: 'assistant/message', seq: 11, data: { turn: 3, step: 1, message: { id: 'later', content: [{ type: 'text', text: 'later' }] } } },
    ])
    assert.equal(evidence?.claimedTurn, 2)
    assert.equal(evidence?.enteredTurn, 2)
    assert.equal(evidence?.sourceAssistantMessageId, 'answer')
    assert.equal(evidence?.visibleText, 'first\n\nsecond')
    assert.equal(evidence?.turnEndReason, 'completed')
  })

  test('another direct rpc request in the same turn is preserved as ambiguity evidence', () => {
    const evidence = carrierEvidenceFromEvents('prompt-request', [
      { type: 'turn/start', seq: 1, data: { turn: 4 } },
      { type: 'step/start', seq: 2, data: { turn: 4, step: 1 } },
      user(3, 'prompt-request'), user(4, 'another-request', 'another-message'),
      { type: 'turn/end', seq: 5, data: { turn: 4, reason: { kind: 'completed' } } },
    ])
    assert.deepEqual(evidence?.directClaimRequestIds, ['prompt-request', 'another-request'])
  })

  test('binds a pre-step error from durable inbox claim even when no user/message was entered', () => {
    const prompt = user(0, 'prompt-request').data
    const evidence = carrierEvidenceFromEvents('prompt-request', [
      { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [prompt] } },
      { type: 'turn/start', seq: 2, data: { turn: 6 } },
      { type: 'agent/inbox/spliced', seq: 3, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
      { type: 'turn/end', seq: 4, data: { turn: 6, reason: { kind: 'error', error: { code: 'CONFIG', message: 'bad config' } } } },
    ])
    assert.equal(evidence?.promptMessageId, 'prompt-message')
    assert.equal(evidence?.claimedTurn, 6)
    assert.equal(evidence?.enteredTurn, undefined)
    assert.equal(evidence?.turnEndReason, 'error')
    assert.equal(evidence?.failureCode, 'CONFIG')
  })

  test('a user-aborted turn is classified as cancelled rather than a generic failure', () => {
    const evidence = carrierEvidenceFromEvents('prompt-request', [
      { type: 'turn/start', seq: 1, data: { turn: 7 } },
      { type: 'step/start', seq: 2, data: { turn: 7, step: 1 } }, user(3, 'prompt-request'),
      { type: 'turn/end', seq: 4, data: { turn: 7, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ])
    assert.equal(evidence?.turnEndReason, 'cancelled')
  })

  test('assistant/attempt is never surfaced as the final answer', () => {
    const evidence = carrierEvidenceFromEvents('prompt-request', [
      { type: 'turn/start', seq: 1, data: { turn: 5 } },
      { type: 'step/start', seq: 2, data: { turn: 5, step: 1 } }, user(3, 'prompt-request'),
      { type: 'assistant/attempt', seq: 4, data: { turn: 5, step: 1, stream: [] } },
      { type: 'turn/end', seq: 5, data: { turn: 5, reason: { kind: 'error', error: { code: 'MODEL', message: 'failed' } } } },
    ])
    assert.equal(evidence?.sourceAssistantMessageId, undefined)
    assert.equal(evidence?.turnEndReason, 'error')
    assert.equal(evidence?.failureCode, 'MODEL')
  })
})
