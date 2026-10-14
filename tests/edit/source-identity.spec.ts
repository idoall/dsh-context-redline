import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  SourceCaptureError,
  captureEventSourceSnapshot,
  eventSourceKeyOf,
  type RequestMaterialSourceKey,
  type SessionSurfaceSnapshot,
} from '../../src/shared/redline-source'

const SESSION = 'session-source-identity-full-a'

const text = (value: string) => ({ type: 'text', text: value })
const reasoning = (value: string) => ({ type: 'reasoning', text: value })

function snapshot(
  events: SessionSurfaceSnapshot['events'],
  over: Partial<Omit<SessionSurfaceSnapshot, 'events'>> = {},
): SessionSurfaceSnapshot {
  return {
    sessionId: SESSION,
    capturedThroughSeq: 20,
    events,
    ...over,
  }
}

describe('event source identity', () => {
  test('the stable key contains the full source session id, seq, and durable type', () => {
    const one = eventSourceKeyOf({
      kind: 'event',
      sourceSessionId: SESSION,
      seq: 7,
      type: 'user/message',
    })
    const crossSession = eventSourceKeyOf({
      kind: 'event',
      sourceSessionId: 'session-source-identity-full-b',
      seq: 7,
      type: 'user/message',
    })
    const differentEvent = eventSourceKeyOf({
      kind: 'event',
      sourceSessionId: SESSION,
      seq: 7,
      type: 'assistant/message',
    })

    assert.equal(one, `event:${SESSION}:7:user/message`)
    assert.notEqual(one, crossSession, 'the same seq in another session is a different source')
    assert.notEqual(one, differentEvent, 'the same text/seq under another durable type is a different source')

    const sameText = captureEventSourceSnapshot(SESSION, snapshot([
      { seq: 7, type: 'user/message', data: { content: [text('identical')] } },
      { seq: 8, type: 'user/message', data: { content: [text('identical')] } },
    ]))
    assert.notEqual(
      eventSourceKeyOf(sameText.candidates[0]!.sourceKey),
      eventSourceKeyOf(sameText.candidates[1]!.sourceKey),
      'identity follows the event, never its text',
    )
  })

  test('request-material identity exists as a type but is never fabricated from event surface rows', () => {
    const compileTimeContract: RequestMaterialSourceKey = {
      kind: 'request-material',
      sourceSessionId: SESSION,
      requestIdentity: 'request-1',
      headerEpochIdentity: 'header-1',
      section: 'system',
      blockIdentity: 'block-1',
    }
    assert.equal(compileTimeContract.kind, 'request-material')

    const capture = captureEventSourceSnapshot(SESSION, snapshot([
      { seq: 1, type: 'system/message', data: { message: { content: [text('system')] } } },
      { seq: 2, type: 'user/message', data: { content: [text('user')] } },
    ]))
    assert.ok(capture.candidates.every(candidate => candidate.sourceKey.kind === 'event'))
  })
})

describe('one surface snapshot capture', () => {
  test('accepts an empty session snapshot and fingerprints its null high-water mark as -1', () => {
    const capture = captureEventSourceSnapshot(SESSION, snapshot([], { capturedThroughSeq: null }))
    assert.equal(capture.capturedThroughSeq, -1)
    assert.deepEqual(capture.candidates, [])
    assert.match(capture.surfaceFingerprint, /^[0-9a-f]{64}$/)
  })

  test('captures the snapshot version and extracts full text, reasoning, error, and explicit source roles', () => {
    const capture = captureEventSourceSnapshot(SESSION, snapshot([
      { seq: 2, type: 'user/message', data: { content: [text('first'), text('second')] } },
      {
        seq: 3,
        type: 'assistant/message',
        data: { message: { content: [reasoning('private visible reasoning'), text('answer')] } },
      },
      { seq: 4, type: 'tool/call', data: { callId: 'call-1', name: 'read', arguments: '{}' } },
      {
        seq: 5,
        type: 'tool/result',
        data: { message: { isError: true, toolCallId: 'call-1', content: [text('failed result')] } },
      },
    ], { capturedThroughSeq: 9 }))

    assert.equal(capture.sourceSessionId, SESSION)
    assert.equal(capture.capturedThroughSeq, 9)
    assert.match(capture.surfaceFingerprint, /^[0-9a-f]{64}$/)
    assert.deepEqual(capture.candidates.map(candidate => ({
      seq: candidate.sourceKey.seq,
      type: candidate.sourceKey.type,
      sourceRole: candidate.sourceRole,
      text: candidate.text,
      reasoning: candidate.reasoning,
      isError: candidate.isError,
    })), [
      { seq: 2, type: 'user/message', sourceRole: 'user', text: 'first\n\nsecond', reasoning: undefined, isError: undefined },
      { seq: 3, type: 'assistant/message', sourceRole: 'assistant', text: 'answer', reasoning: 'private visible reasoning', isError: undefined },
      { seq: 5, type: 'tool/result', sourceRole: 'tool', text: 'failed result', reasoning: undefined, isError: true },
    ])
  })

  test('pairs a tool result with the matching call id/name/arguments summary when the call is present', () => {
    const capture = captureEventSourceSnapshot(SESSION, snapshot([
      { seq: 10, type: 'tool/call', data: { callId: 'call-7', name: 'read', arguments: '{"file_path":"src/a.ts"}' } },
      {
        seq: 11,
        type: 'tool/result',
        data: {
          message: {
            source: { kind: 'tool', callId: 'call-7' },
            content: [{ type: 'tool-result', toolCallId: 'call-7', content: [text('whole file')] }],
          },
        },
      },
    ]))

    assert.equal(capture.candidates.length, 1, 'tool/call is pairing metadata, not fabricated migration material')
    assert.deepEqual(capture.candidates[0]?.toolLink, {
      callId: 'call-7',
      name: 'read',
      argsSummary: '{"file_path":"src/a.ts"}',
    })
    assert.equal(capture.candidates[0]?.text, 'whole file')
    assert.equal(capture.candidates[0]?.isError, false, 'a successful tool result must preserve the explicit false state')
  })

  test('distinguishes human user input from automatic injection and skill material', () => {
    const capture = captureEventSourceSnapshot(SESSION, snapshot([
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [text('human')] } },
      { seq: 2, type: 'user/message', data: { source: { kind: 'agent-instructions', form: 'instructions' }, content: [text('instructions')] } },
      { seq: 3, type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'pdf' }, content: [text('skill')] } },
    ]))
    assert.deepEqual(capture.candidates.map(item => item.sourceRole), ['user', 'inject', 'skill'])
  })

  test('fingerprint is deterministic and changes with captured version or effective content', () => {
    const baseSnapshot = snapshot([{ seq: 2, type: 'user/message', data: { content: [text('same')] } }], { capturedThroughSeq: 2 })
    const base = captureEventSourceSnapshot(SESSION, baseSnapshot)
    const again = captureEventSourceSnapshot(SESSION, baseSnapshot)
    const nextVersion = captureEventSourceSnapshot(SESSION, { ...baseSnapshot, capturedThroughSeq: 3 })
    const changed = captureEventSourceSnapshot(SESSION, snapshot([
      { seq: 2, type: 'user/message', data: { content: [text('changed')] } },
    ], { capturedThroughSeq: 2 }))

    assert.equal(base.surfaceFingerprint, again.surfaceFingerprint)
    assert.notEqual(base.surfaceFingerprint, nextVersion.surfaceFingerprint)
    assert.notEqual(base.surfaceFingerprint, changed.surfaceFingerprint)
  })
})

describe('capture refusal guardrails', () => {
  test('rejects duplicate event identities instead of merging them', () => {
    assert.throws(
      () => captureEventSourceSnapshot(SESSION, snapshot([
        { seq: 2, type: 'user/message', data: { content: [text('one')] } },
        { seq: 2, type: 'user/message', data: { content: [text('two')] } },
      ])),
      (error: unknown) => error instanceof SourceCaptureError && error.code === 'duplicate-identity',
    )
  })

  test('rejects a snapshot belonging to another session', () => {
    assert.throws(
      () => captureEventSourceSnapshot(SESSION, snapshot([], { sessionId: 'session-other' })),
      (error: unknown) => error instanceof SourceCaptureError && error.code === 'session-id-mismatch',
    )
  })

  test('rejects missing or invalid stable event identity', () => {
    for (const event of [
      { type: 'user/message', data: { content: [text('missing seq')] } },
      { seq: -1, type: 'user/message', data: { content: [text('negative seq')] } },
      { seq: 2, data: { content: [text('missing type')] } },
      { seq: 2, type: '', data: { content: [text('blank type')] } },
    ]) {
      assert.throws(
        () => captureEventSourceSnapshot(SESSION, snapshot([event])),
        (error: unknown) => error instanceof SourceCaptureError && error.code === 'invalid-identity',
      )
    }
  })

  test('rejects a tool result whose call identity cannot be paired instead of migrating an orphan result', () => {
    assert.throws(
      () => captureEventSourceSnapshot(SESSION, snapshot([
        { seq: 11, type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'missing-call' }, content: [text('orphan')] } } },
      ])),
      (error: unknown) => error instanceof SourceCaptureError && error.code === 'unpaired-tool-result',
    )
  })

  test('keeps text from mixed text/image messages and reports omitted images instead of blocking the whole plan', () => {
    const capture = captureEventSourceSnapshot(SESSION, snapshot([
      {
        seq: 2,
        type: 'user/message',
        data: { content: [text('before'), { type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png', bytes: 12, width: 1, height: 1 } }, text('after')] },
      },
    ]))
    assert.equal(capture.omittedImages, 1)
    assert.equal(capture.candidates.length, 1)
    assert.equal(capture.candidates[0]?.text, 'before\n\nafter')
  })

  test('also counts the alternate kind=image shape used by some admitted inputs', () => {
    const capture = captureEventSourceSnapshot(SESSION, snapshot([
      { seq: 2, type: 'user/message', data: { content: [text('caption'), { kind: 'image', attachment: { attachmentId: 'image-1' } }] } },
    ]))
    assert.equal(capture.omittedImages, 1)
    assert.equal(capture.candidates[0]?.text, 'caption')
  })

  test('a pure-image message contributes an omission count but no fabricated empty migration paragraph', () => {
    const capture = captureEventSourceSnapshot(SESSION, snapshot([
      { seq: 2, type: 'user/message', data: { content: [{ type: 'image', attachment: { attachmentId: 'image-1' } }] } },
    ]))
    assert.equal(capture.omittedImages, 1)
    assert.deepEqual(capture.candidates, [])
  })

  test('image identity still participates in the complete surface fingerprint', () => {
    const first = captureEventSourceSnapshot(SESSION, snapshot([
      { seq: 2, type: 'user/message', data: { content: [text('caption'), { type: 'image', attachment: { attachmentId: 'image-1' } }] } },
    ]))
    const second = captureEventSourceSnapshot(SESSION, snapshot([
      { seq: 2, type: 'user/message', data: { content: [text('caption'), { type: 'image', attachment: { attachmentId: 'image-2' } }] } },
    ]))
    assert.notEqual(first.surfaceFingerprint, second.surfaceFingerprint)
  })

  test('still rejects file, generic attachment, and unknown media instead of silently dropping it', () => {
    for (const block of [
      { type: 'file', path: '/tmp/a.pdf' },
      { type: 'file-ref', path: '/tmp/a.pdf' },
      { type: 'attachment', name: 'a.txt' },
      { type: 'audio', data: 'AAAA' },
      { kind: 'video', data: 'AAAA' },
    ]) {
      assert.throws(
        () => captureEventSourceSnapshot(SESSION, snapshot([
          { seq: 2, type: 'user/message', data: { content: [text('caption'), block] } },
        ])),
        (error: unknown) => error instanceof SourceCaptureError && error.code === 'unsupported-content',
      )
    }
  })
})
