import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  authorizeCarrier, carrierConfigFingerprint, carrierContentFingerprint, createCarrierPreview, transitionCarrierTask, type CarrierOperation,
} from '../../src/shared/redline-carrier'
import { runCarrierToReturn } from '../../src/host/redline-carrier-runner'

function running(): CarrierOperation {
  let op = createCarrierPreview({
    opId: 'op', carrierId: 'carrier', mainSessionId: 'main', plannedTitle: 'title', surfaceAsOfSeq: 1,
    surfaceFingerprint: 'surface', manifestFingerprint: 'manifest', promptRequestId: 'prompt-rpc', returnRequestId: 'return-rpc',
  })
  op = authorizeCarrier(op, {
    userConfirmedAt: 'now', manifestFingerprint: 'manifest', configFingerprint: carrierConfigFingerprint({ agentPreset: 'preset', provider: 'carrier-provider', model: 'carrier-model', reasoningEffort: 'high', inheritedFrom: 'confirmation-selection' }), sourceSessionId: 'main', returnSessionId: 'main',
  }, {
    deliveryContent: 'task', contentFingerprint: carrierContentFingerprint('task'), workspaceId: 'workspace',
    confirmedConfig: { agentPreset: 'preset', provider: 'carrier-provider', model: 'carrier-model', reasoningEffort: 'high', inheritedFrom: 'confirmation-selection' },
    returnConfig: { agentPreset: 'preset', provider: 'source-provider', model: 'source-model', reasoningEffort: 'off', inheritedFrom: 'main' },
    returnConfigFingerprint: carrierConfigFingerprint({ agentPreset: 'preset', provider: 'source-provider', model: 'source-model', reasoningEffort: 'off', inheritedFrom: 'main' }),
    attachments: [],
  })
  for (const state of ['creating', 'created', 'prompted', 'running'] as const) op = transitionCarrierTask(op, state)
  return op
}

const events = [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'step/start', seq: 2, data: { turn: 1, step: 1 } },
  { type: 'user/message', seq: 3, data: { id: 'prompt-message', source: { kind: 'user', rpcId: 'prompt-rpc' }, content: [{ type: 'text', text: 'task' }] } },
  { type: 'assistant/message', seq: 4, data: { turn: 1, step: 1, message: { id: 'answer', content: [{ type: 'text', text: 'verbatim result' }] } } },
  { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
]

describe('automatic carrier return', () => {
  test('freezes the bound result then sends the exact payload back under the fixed return id', async () => {
    let op = running()
    const writes: string[] = []
    const store = {
      async read() { return { ok: true as const, operation: op } },
      async mutate(_id: string, update: (value: CarrierOperation) => CarrierOperation) { op = update(op); writes.push(`${op.taskState}:${op.returnState}`); return op },
    }
    const deliveries: unknown[] = []
    const control = {
      async deliverToSession(value: unknown) { deliveries.push(value); return { ok: true as const, delivery: 'sent' as const, messageId: 'return-message', flushed: true } },
    }
    const readOrder: string[] = []
    const ctx = { get(name: string) {
      if (name === 'sessions') return { async flush() { readOrder.push('flush'); return true } }
      if (name === 'sessionQuery') return { async readSession() { readOrder.push('cold-read'); return { events } } }
      return undefined
    } }
    const result = await runCarrierToReturn(ctx, 'op', { session: { id: 'carrier' }, async whenIdle() { readOrder.push('idle') } }, store, control)
    assert.deepEqual(readOrder, ['idle', 'flush', 'cold-read'])
    assert.equal(result.kind, 'accepted')
    assert.equal(op.taskState, 'completed')
    assert.equal(op.returnState, 'accepted')
    assert.equal(op.returnPayload, 'verbatim result')
    assert.deepEqual(writes, ['completed:pending-send', 'completed:sending', 'completed:accepted'])
    assert.deepEqual(deliveries, [{
      sessionId: 'main', agentPreset: 'preset', agentOptions: { provider: 'source-provider', model: 'source-model', reasoningEffort: 'off' },
      requestId: 'return-rpc', text: '【承载会话结果 · title · carrier】\nverbatim result',
    }])
  })

  test('unknown return delivery stays uncertain and never claims accepted', async () => {
    let op = running()
    const store = {
      async read() { return { ok: true as const, operation: op } },
      async mutate(_id: string, update: (value: CarrierOperation) => CarrierOperation) { op = update(op); return op },
    }
    let attempts = 0
    const control = { async deliverToSession() { attempts += 1; return { ok: false as const, state: 'unknown' as const, cause: 'read failed' } } }
    const ctx = { get() { return { async readSession() { return { events } } } } }
    const result = await runCarrierToReturn(ctx, 'op', { async whenIdle() {} }, store, control)
    assert.equal(result.kind, 'uncertain')
    assert.equal(op.returnState, 'uncertain')
    assert.equal(attempts, 1, 'unknown never retries without a later explicit absence proof')
  })
})
