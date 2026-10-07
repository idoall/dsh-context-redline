// The panel's transport to our own route (`src/client/redlineChannel.ts`) — the
// CLIENT-LOGIC lane: our client-side logic, runnable without a browser.
//
// This is `docs/05-test-plan.md` §2.5 **A12** on the client side: the URL the
// browser actually POSTs must be the SAME constant the host registers
// (`REDLINE_CHANNEL_ROUTE`), because a hand-written path on either side is how the
// earlier attempt produced a silent 404. The `channel` lane asserts the host's
// registered path is exactly that constant; this file asserts the client uses it.
//
// It also locks the failure contract the editor depends on: the transport NEVER
// throws — every failure comes back as a stable code the UI maps to a sentence
// (`docs/03` R3.5 "保存失败时保留输入，并在编辑器内显示原因").

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import { REDLINE_ERROR } from '../../src/shared/redline-errors'
import { REDLINE_CHANNEL_ROUTE } from '../../src/shared/redline-route'
import { dropDraft, listDrafts, listTeam, planChild, readRow, saveDraft, startChild } from '../../src/client/redlineChannel'

interface Call { url: string, init: RequestInit | undefined }

const calls: Call[] = []

/** Install a fetch stub answering `responder`, and record every call. */
function stubFetch(responder: (call: Call) => Response | Promise<Response> | never): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init }
    calls.push(call)
    return await responder(call)
  }) as typeof fetch
}

const envelope = (value: unknown): Response =>
  Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })

const failure = (code: string, message: string): Response =>
  Response.json({ ok: false, error: { code, message } })

/** The JSON body a stub call carried. */
function bodyOf(call: Call): Record<string, unknown> {
  assert.equal(typeof call.init?.body, 'string')
  return JSON.parse(call.init!.body as string) as Record<string, unknown>
}

afterEach(() => { calls.length = 0 })

describe('A12 · the client POSTs our one namespaced route', () => {
  test('every op goes to REDLINE_CHANNEL_ROUTE as a POST with a JSON body', async () => {
    stubFetch(() => envelope({}))
    await readRow('s1', 7)
    await listDrafts('s1')
    await saveDraft('s1', 7, { text: 'x', reasoning: '', isError: false })
    await dropDraft('s1', 7)
    assert.equal(calls.length, 4)
    for (const call of calls) {
      assert.equal(call.url, REDLINE_CHANNEL_ROUTE, 'the path is the shared constant, never a literal')
      assert.equal(call.init?.method, 'POST')
      assert.equal((call.init?.headers as Record<string, string>)['content-type'], 'application/json')
    }
    assert.deepEqual(calls.map(c => bodyOf(c).op), ['node.read', 'draft.list', 'draft.update', 'draft.drop'])
  })

  test('the route constant is the host-registered one (one source for both halves)', () => {
    assert.equal(REDLINE_CHANNEL_ROUTE, '/api/dsh-context-redline/redline')
  })
})

describe('success envelopes come back as values', () => {
  test('node.read yields the row, unchanged (the editor prefills THIS text)', async () => {
    const row = { seq: 7, type: 'user/message', text: '第一段\n\n第二段', reasoning: '想法', isError: false }
    stubFetch(() => envelope(row))
    const result = await readRow('s1', 7)
    assert.deepEqual(result, { ok: true, value: row })
    assert.deepEqual(bodyOf(calls[0]!), { op: 'node.read', sessionId: 's1', seq: 7 })
  })

  test('draft.list / update / drop yield the table', async () => {
    const table = { '7': { seq: 7, text: 'a', reasoning: '', isError: false, updatedAt: '2026-10-04T00:00:00.000Z' } }
    stubFetch(() => envelope(table))
    assert.deepEqual(await listDrafts('s1'), { ok: true, value: table })
    assert.deepEqual(await saveDraft('s1', 7, { text: 'a', reasoning: '', isError: false }), { ok: true, value: table })
    assert.deepEqual(await dropDraft('s1', 7), { ok: true, value: table })
    assert.deepEqual(bodyOf(calls[1]!), { op: 'draft.update', sessionId: 's1', seq: 7, edit: { text: 'a', reasoning: '', isError: false } })
    assert.deepEqual(bodyOf(calls[2]!), { op: 'draft.drop', sessionId: 's1', seq: 7 })
  })
})

describe('refusals are values, never exceptions (the editor shows the reason)', () => {
  test('a host refusal passes its stable code through', async () => {
    for (const code of [REDLINE_ERROR.noChange, REDLINE_ERROR.emptyContent, REDLINE_ERROR.notLive]) {
      stubFetch(() => failure(code, 'wire text'))
      const result = await saveDraft('s1', 7, { text: '', reasoning: '', isError: false })
      assert.equal(result.ok, false)
      if (result.ok) continue
      assert.equal(result.code, code)
      assert.equal(result.message, 'wire text')
    }
  })

  test('an HTTP error becomes the transport code, not a throw', async () => {
    stubFetch(() => new Response('boom', { status: 500 }))
    const result = await listDrafts('s1')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, REDLINE_ERROR.transport)
    assert.ok(result.message.length > 0)
  })

  test('a non-JSON or non-envelope body becomes the transport code', async () => {
    for (const body of ['not json', '{}', '{"ok":"maybe"}', '[]']) {
      stubFetch(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
      const result = await listDrafts('s1')
      assert.equal(result.ok, false, body)
      if (result.ok) continue
      assert.equal(result.code, REDLINE_ERROR.transport, body)
    }
  })

  test('a network failure (fetch rejects) becomes the transport code', async () => {
    stubFetch(() => { throw new Error('offline') })
    const result = await readRow('s1', 7)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, REDLINE_ERROR.transport)
    assert.match(result.message, /offline/)
  })
})

describe('open a child session (the ONLY write point)', () => {
  test('planChild posts child.plan to OUR route and returns the five items verbatim', async () => {
    calls.length = 0
    stubFetch(() => envelope({
      items: [{ label: '从哪儿开始', text: '…' }, { label: '取消', text: '什么都不发生' }],
      carriedSeqs: [3358],
      prompt: '继续\n\n改好的正文',
      refusal: null,
    }))
    const result = await planChild('sv-1', '继续')
    assert.equal(result.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, REDLINE_CHANNEL_ROUTE)
    assert.equal(bodyOf(calls[0]).op, 'child.plan')
    assert.equal(bodyOf(calls[0]).sessionId, 'sv-1')
    assert.equal(bodyOf(calls[0]).humanTask, '继续')
    if (result.ok) {
      assert.equal(result.value.items.length, 2)
      assert.deepEqual(result.value.carriedSeqs, [3358])
      assert.equal(result.value.refusal, null)
    }
  })

  test('startChild posts child.start; a refusal comes back as a stable code + sentence (never thrown)', async () => {
    calls.length = 0
    stubFetch(() => failure(REDLINE_ERROR.emptyTask, '子会话的第一句话必须由你自己写'))
    const refused = await startChild('sv-1', '   ')
    assert.equal(refused.ok, false)
    if (!refused.ok) {
      assert.equal(refused.code, REDLINE_ERROR.emptyTask)
      assert.ok(refused.message.includes('自己写'), refused.message)
    }
    assert.equal(bodyOf(calls[0]).op, 'child.start')
  })

  test('a successful startChild hands back the platform receipt untouched', async () => {
    calls.length = 0
    const receipt = { childId: '66da37b9', messageId: 'aeb5e73b' }
    stubFetch(() => envelope({ label: '上下文批改 · x', prompt: '继续', carriedSeqs: [], started: receipt }))
    const started = await startChild('sv-1', '继续')
    assert.equal(started.ok, true)
    if (started.ok) assert.deepEqual(started.value.started, receipt)
  })
})

describe('team.list（投影读不到时的回退）', () => {
  test('打到我们的路由、body 正确，并把 null（不提供）如实交回', async () => {
    calls.length = 0
    stubFetch(() => envelope(null))
    const result = await listTeam('sv-1')
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value, null, '不提供就是 null，界面据此隐藏对接点')
    assert.equal(calls[0].url, REDLINE_CHANNEL_ROUTE)
    assert.equal(bodyOf(calls[0]).op, 'team.list')
    assert.equal(bodyOf(calls[0]).sessionId, 'sv-1')
  })

  test('宿主给了数据 → 原样交回（我们不在这里改写官方的字段）', async () => {
    calls.length = 0
    const payload = { tasks: [{ id: 't-1' }], membership: { role: 'lead' } }
    stubFetch(() => envelope(payload))
    const result = await listTeam('sv-1')
    if (result.ok) assert.deepEqual(result.value, payload)
    else assert.fail('应当成功')
  })
})
