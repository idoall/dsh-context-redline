import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  CARRIER_LEDGER_SCHEMA_VERSION,
  authorizeCarrier,
  bindCarrierResult,
  carrierConfigFingerprint,
  carrierContentFingerprint,
  carrierFileName,
  classifyCarrierResult,
  createCarrierPreview,
  parseCarrierOperation,
  retryDecision,
  serializeCarrierOperation,
  setTitleStatus,
  transitionCarrierTask,
  transitionCarrierReturn,
  type CarrierExecutionInput,
} from '../../src/shared/redline-carrier'

const executionInput: CarrierExecutionInput = {
  deliveryContent: 'approved bytes',
  contentFingerprint: carrierContentFingerprint('approved bytes'),
  workspaceId: 'workspace-1',
  confirmedConfig: {
    agentPreset: 'preset-1',
    provider: 'provider-1',
    model: 'model-1',
    reasoningEffort: 'medium',
    inheritedFrom: 'confirmation-selection',
  },
  returnConfig: {
    agentPreset: 'preset-1',
    provider: 'source-provider',
    model: 'source-model',
    reasoningEffort: 'high',
    inheritedFrom: 'main-session',
  },
  returnConfigFingerprint: carrierConfigFingerprint({
    agentPreset: 'preset-1', provider: 'source-provider', model: 'source-model', reasoningEffort: 'high', inheritedFrom: 'main-session',
  }),
  attachments: [],
}

function preview() {
  return createCarrierPreview({
    opId: 'op-1',
    carrierId: 'carrier-1',
    mainSessionId: 'main-1',
    plannedTitle: '↳ main · task',
    surfaceAsOfSeq: 42,
    surfaceFingerprint: 'surface-fp',
    manifestFingerprint: 'manifest-fp',
    promptRequestId: 'prompt-request-1',
    returnRequestId: 'return-request-1',
  })
}

function authorized() {
  return authorizeCarrier(preview(), {
    userConfirmedAt: '2026-10-09T12:00:00.000Z',
    manifestFingerprint: 'manifest-fp',
    configFingerprint: carrierConfigFingerprint(executionInput.confirmedConfig),
    sourceSessionId: 'main-1',
    returnSessionId: 'main-1',
  }, executionInput)
}

describe('carrier ledger: disjoint task/title/return state', () => {
  test('preview fixes all operation/request identities and is not resumable', () => {
    const op = preview()
    assert.equal(op.taskState, 'previewed')
    assert.equal(op.titleStatus, 'pending')
    assert.equal(op.returnState, 'not-prepared')
    assert.equal(op.opId, 'op-1')
    assert.equal(op.carrierId, 'carrier-1')
    assert.equal(op.mainSessionId, 'main-1')
    assert.equal(op.promptRequestId, 'prompt-request-1')
    assert.equal(op.returnRequestId, 'return-request-1')
    assert.equal(op.authorization, undefined)
    assert.equal(op.executionInput, undefined)
    assert.equal(op.taskState === 'previewed', true, 'previewed must require confirmation, not resume')
    assert.throws(() => transitionCarrierTask(op, 'creating'), /authorization|execution input/i)
  })

  test('authorization and immutable execution input are frozen together', () => {
    const mutable = structuredClone(executionInput) as CarrierExecutionInput & { deliveryContent: string }
    const auth = { userConfirmedAt: '2026-10-09T12:00:00.000Z', manifestFingerprint: 'manifest-fp', configFingerprint: carrierConfigFingerprint(executionInput.confirmedConfig), sourceSessionId: 'main-1', returnSessionId: 'main-1' }
    const op = authorizeCarrier(preview(), auth, mutable)

    mutable.deliveryContent = 'stale draft mutation'
    auth.manifestFingerprint = 'mutated-fp'
    assert.equal(op.executionInput?.deliveryContent, 'approved bytes')
    assert.equal(op.authorization?.manifestFingerprint, 'manifest-fp')
    assert.equal(Object.isFrozen(op.executionInput), true)
    assert.equal(Object.isFrozen(op.executionInput?.confirmedConfig), true)
    assert.equal(Object.isFrozen(op.authorization), true)
    assert.throws(() => authorizeCarrier(op, auth, mutable), /invalid transition/i)
  })

  test('v1 refuses nonempty attachments instead of silently dropping them', () => {
    assert.throws(() => authorizeCarrier(preview(), {
      userConfirmedAt: '2026-10-09T12:00:00.000Z', manifestFingerprint: 'manifest-fp',
      configFingerprint: carrierConfigFingerprint(executionInput.confirmedConfig), sourceSessionId: 'main-1', returnSessionId: 'main-1',
    }, { ...executionInput, attachments: [{ id: 'a', fingerprint: 'f' }] }), /attachments are unsupported/)
  })

  test('valid lifecycle is explicit; invalid skips and execution without input are rejected', () => {
    let op = authorized()
    for (const state of ['creating', 'created', 'prompted', 'running', 'waiting-user', 'running'] as const) {
      op = transitionCarrierTask(op, state)
      assert.equal(op.taskState, state)
    }
    assert.equal(op.returnState, 'not-prepared', 'waiting/running are nonterminal and do not queue a return')
    assert.throws(() => transitionCarrierTask(op, 'created'), /invalid transition/i)

    const corrupt = { ...authorized(), executionInput: undefined }
    assert.throws(() => transitionCarrierTask(corrupt, 'creating'), /execution input/i)
  })

  test('title status is independent and never invents a named task state', () => {
    const created = transitionCarrierTask(transitionCarrierTask(authorized(), 'creating'), 'created')
    const failed = setTitleStatus(created, 'failed')
    assert.equal(failed.taskState, 'created')
    assert.equal(failed.titleStatus, 'failed')
    const succeeded = setTitleStatus(created, 'succeeded')
    assert.equal(succeeded.taskState, 'created')
    assert.equal(succeeded.titleStatus, 'succeeded')
    assert.throws(() => setTitleStatus(succeeded, 'failed'), /terminal title status/i)
  })
})

describe('carrier ledger: durable one-file-per-op representation', () => {
  test('stable serializer/parser round-trip and schema version', () => {
    const op = authorized()
    const raw = serializeCarrierOperation(op)
    assert.equal(raw, serializeCarrierOperation(op))
    assert.match(raw, new RegExp(`"schemaVersion": ${String(CARRIER_LEDGER_SCHEMA_VERSION)}`))
    const parsed = parseCarrierOperation(raw, 'op-1')
    assert.equal(parsed.ok, true)
    if (parsed.ok) assert.deepEqual(parsed.operation, op)
  })

  test('parser rejects corrupt/schema/identity mismatch instead of repairing', () => {
    assert.equal(parseCarrierOperation('{').ok, false)
    assert.equal(parseCarrierOperation(JSON.stringify({ schemaVersion: 999 })).ok, false)
    assert.equal(parseCarrierOperation(serializeCarrierOperation(authorized()), 'other-op').ok, false)
  })

  test('parser rejects edited frozen bytes/config/session identities when fingerprints were not updated', () => {
    const original = authorized()
    for (const mutate of [
      (value: Record<string, any>) => { value.executionInput.deliveryContent = 'tampered' },
      (value: Record<string, any>) => { value.executionInput.confirmedConfig.model = 'other-model' },
      (value: Record<string, any>) => { value.executionInput.returnConfig.model = 'other-source-model' },
      (value: Record<string, any>) => { value.authorization.returnSessionId = 'other-main' },
    ]) {
      const value = JSON.parse(serializeCarrierOperation(original)) as Record<string, any>
      mutate(value)
      assert.equal(parseCarrierOperation(JSON.stringify(value), 'op-1').ok, false)
    }
  })

  test('T1 filename is one stable safe file per op', () => {
    assert.equal(carrierFileName('op-1'), carrierFileName('op-1'))
    assert.notEqual(carrierFileName('op-1'), carrierFileName('op-2'))
    assert.match(carrierFileName('../../op'), /^redline-carrier-______op-[0-9a-f]{16}\.json$/)
  })
})

describe('separate return delivery state', () => {
  test('a frozen terminal moves pending-send -> sending -> accepted without changing task result', () => {
    let op = authorized()
    for (const state of ['creating', 'created', 'prompted', 'running'] as const) op = transitionCarrierTask(op, state)
    op = bindCarrierResult(op, classifyCarrierResult('completed', {
      expectedPromptRequestId: 'prompt-request-1', promptRequestId: 'prompt-request-1', promptMessageId: 'message-1',
      claimedTurn: 1, enteredTurn: 1, directClaimRequestIds: ['prompt-request-1'], turn: 1,
      sourceAssistantMessageId: 'assistant-1', visibleText: 'answer',
    }))
    const sending = transitionCarrierReturn(op, 'sending')
    const accepted = transitionCarrierReturn(sending, 'accepted')
    assert.equal(accepted.taskState, 'completed')
    assert.equal(accepted.returnPayload, 'answer')
    assert.equal(accepted.returnState, 'accepted')
    for (const mutate of [
      (value: Record<string, any>) => { value.returnPayload = 'tampered answer' },
      (value: Record<string, any>) => { value.returnPayloadFingerprint = '0'.repeat(64) },
    ]) {
      const value = JSON.parse(serializeCarrierOperation(accepted)) as Record<string, any>
      mutate(value)
      assert.equal(parseCarrierOperation(JSON.stringify(value), 'op-1').ok, false)
    }
    assert.throws(() => transitionCarrierReturn(accepted, 'sending'), /return transition/i)
  })
})

describe('three-valued duplicate/retry decision', () => {
  test('exists accepts, absent resends original id, unknown never resends', () => {
    assert.deepEqual(retryDecision('exists'), { action: 'accept', resend: false })
    assert.deepEqual(retryDecision('absent'), { action: 'resend-original', resend: true })
    assert.deepEqual(retryDecision('unknown'), { action: 'wait', resend: false })
  })
})
