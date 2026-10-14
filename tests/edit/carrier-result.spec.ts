import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  authorizeCarrier,
  bindCarrierResult,
  carrierConfigFingerprint,
  carrierContentFingerprint,
  classifyCarrierResult,
  createCarrierPreview,
  transitionCarrierTask,
  type CarrierAttributionEvidence,
  type CarrierExecutionInput,
  type CarrierTurnEndReason,
} from '../../src/shared/redline-carrier'

const executionInput: CarrierExecutionInput = {
  deliveryContent: 'approved bytes',
  contentFingerprint: carrierContentFingerprint('approved bytes'),
  workspaceId: 'workspace-1',
  confirmedConfig: { agentPreset: 'preset', provider: 'p', model: 'm', reasoningEffort: 'off', inheritedFrom: 'explicit' },
  attachments: [],
}

function running() {
  let op = createCarrierPreview({
    opId: 'op-result', carrierId: 'carrier-result', mainSessionId: 'main-result', plannedTitle: 'title',
    surfaceAsOfSeq: 1, surfaceFingerprint: 'surface', manifestFingerprint: 'manifest',
    promptRequestId: 'prompt-request', returnRequestId: 'return-request',
  })
  op = authorizeCarrier(op, {
    userConfirmedAt: '2026-10-09T12:00:00.000Z', manifestFingerprint: 'manifest', configFingerprint: carrierConfigFingerprint(executionInput.confirmedConfig),
    sourceSessionId: 'main-result', returnSessionId: 'main-result',
  }, executionInput)
  for (const state of ['creating', 'created', 'prompted', 'running'] as const) op = transitionCarrierTask(op, state)
  return op
}

function evidence(over: Partial<CarrierAttributionEvidence> = {}): CarrierAttributionEvidence {
  return {
    expectedPromptRequestId: 'prompt-request',
    promptRequestId: 'prompt-request',
    promptMessageId: 'prompt-message',
    claimedTurn: 7,
    enteredTurn: 7,
    directClaimRequestIds: ['prompt-request'],
    turn: 7,
    sourceAssistantMessageId: 'assistant-message',
    visibleText: 'final answer',
    ...over,
  }
}

describe('result classification and exact attribution', () => {
  test('only completed + uniquely bound visible output is success', () => {
    const result = classifyCarrierResult('completed', evidence())
    assert.equal(result.kind, 'success')
    if (result.kind === 'success') {
      assert.equal(result.completedTurn, 7)
      assert.equal(result.sourceAssistantMessageId, 'assistant-message')
      assert.equal(result.payload, 'final answer')
    }
  })

  test('multiple direct claims make attribution unknown; no latest-answer fallback', () => {
    const result = classifyCarrierResult('completed', evidence({ directClaimRequestIds: ['prompt-request', 'another-request'] }))
    assert.deepEqual(result, { kind: 'attribution-unknown', reason: 'multiple-direct-claims' })
  })

  test('missing entered binding or mismatched request is attribution unknown', () => {
    assert.equal(classifyCarrierResult('completed', evidence({ enteredTurn: undefined })).kind, 'attribution-unknown')
    assert.equal(classifyCarrierResult('completed', evidence({ promptRequestId: 'wrong-request' })).kind, 'attribution-unknown')
  })

  test('completed without visible output is a distinct fixed-notice result', () => {
    const result = classifyCarrierResult('completed', evidence({ sourceAssistantMessageId: undefined, visibleText: undefined }))
    assert.equal(result.kind, 'completed-no-visible-output')
  })

  test('a claimed pre-step failure binds without pretending the message entered the model request', () => {
    const result = classifyCarrierResult('error', evidence({ enteredTurn: undefined, sourceAssistantMessageId: undefined, visibleText: undefined }))
    assert.equal(result.kind, 'error')
  })

  test('blocked/interrupted/error/aborted/max-tokens/forked remain separate', () => {
    const reasons: readonly CarrierTurnEndReason[] = ['blocked', 'interrupted', 'error', 'aborted', 'max-tokens', 'forked']
    for (const reason of reasons) {
      const result = classifyCarrierResult(reason, evidence())
      assert.equal(result.kind, reason, reason)
      assert.notEqual(result.kind, 'success', reason)
    }
  })

  test('waiting-user is nonterminal and cannot be classified/frozen', () => {
    const waiting = transitionCarrierTask(running(), 'waiting-user')
    assert.equal(waiting.taskState, 'waiting-user')
    assert.equal(waiting.returnState, 'not-prepared')
    assert.throws(() => bindCarrierResult(waiting, classifyCarrierResult('completed', evidence())), /waiting-user|nonterminal/i)
  })
})

describe('S1 atomic terminal freeze', () => {
  test('one pure transition freezes terminal, identity, payload, fingerprint and pending-send together', () => {
    const terminal = bindCarrierResult(running(), classifyCarrierResult('completed', evidence()))
    assert.equal(terminal.taskState, 'completed')
    assert.equal(terminal.returnState, 'pending-send')
    assert.equal(terminal.promptMessageId, 'prompt-message')
    assert.equal(terminal.completedTurn, 7)
    assert.equal(terminal.sourceAssistantMessageId, 'assistant-message')
    assert.equal(terminal.returnPayload, 'final answer')
    assert.match(terminal.returnPayloadFingerprint ?? '', /^[0-9a-f]{64}$/)
    assert.equal(Object.isFrozen(terminal), true)
  })

  test('impossible terminal without payload is rejected by parser/transition', () => {
    assert.throws(() => transitionCarrierTask(running(), 'completed'), /atomic result freeze/i)
    const failed = classifyCarrierResult('error', evidence({ failureCode: 'model/error', failureMessage: 'model failed' }))
    const terminal = bindCarrierResult(running(), failed)
    assert.equal(terminal.taskState, 'failed')
    assert.equal(terminal.returnState, 'pending-send')
    assert.match(terminal.returnPayload ?? '', /model\/error/)
  })

  test('terminal/result identity/payload are immutable after freeze', () => {
    const terminal = bindCarrierResult(running(), classifyCarrierResult('completed', evidence()))
    assert.throws(() => bindCarrierResult(terminal, classifyCarrierResult('completed', evidence({ visibleText: 'new answer' }))), /terminal|already frozen/i)
    assert.throws(() => transitionCarrierTask(terminal, 'running'), /terminal/i)
  })

  test('cancelled also freezes a fixed notification atomically', () => {
    const terminal = bindCarrierResult(running(), { kind: 'cancelled', failureCode: 'user/cancelled', failureMessage: 'cancelled by user' })
    assert.equal(terminal.taskState, 'cancelled')
    assert.equal(terminal.returnState, 'pending-send')
    assert.match(terminal.returnPayload ?? '', /user\/cancelled/)
  })
})
