// The M2 write path (`node.read` / `draft.*` on the redline channel) — the CHANNEL lane.
//
// The hard constraint this file exists for (`docs/11` D15, `AGENTS.md` §1):
// **every save is temporary.** A save writes the plugin's own store and NOTHING
// else — the session log is not touched (`Session.append` is spied and must see
// zero calls), and what the current session's model sees does not change.
// The one and only write point is opening a child session (M5).
//
// It also locks the two refusals the demo defines (no-change / empty-content) and
// the full-text rule at the ROUTE level: what `node.read` returns is the durable
// event's complete text, never a preview.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, inject, name } from '../../src/host/index'
import { REDLINE_ERROR } from '../../src/shared/redline-errors'
import { REDLINE_CHANNEL_ROUTE } from '../../src/shared/redline-route'
import { draftFileName } from '../../src/shared/redline-drafts'
import { REDLINE_DATA_DIR_NAME } from '../../src/shared/redline-paths'

type RouteFetch = (request: Request) => Promise<Response>
interface CapturedRoute { path: string, methods: readonly string[], fetch: RouteFetch }

const plugin = { name, inject, apply } as never

/** The durable event we serve as "row #1301": long, multi-paragraph, exact. */
const LONG = [
  '第一条：把「上下文」面板的默认档位设成“注入的内容”，并且在每一行上显示 #seq。',
  '第二条：不要删除任何条目 —— 遮蔽可以，压缩要等我点头。',
  '第三条：跑测试请贴原始输出，不要只写“已通过”。',
].join('\n\n')
const TEXT_BLOCKS = [{ type: 'text', text: LONG }]
const SECOND = '另一条：这一条只用来验证“同一行只留一条改动”与“丢弃只清那一条”。'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

interface Ops {
  ctx: Context
  channel: CapturedRoute
  home: string
  /** The session the plugin is asked about; its write faces are spied. */
  sessionId: string
  /** Every call the plugin made to the session's `append` face. Must stay empty. */
  sessionWrites: string[]
  /** The session's durable log offset — must not move either. */
  logOffset: () => number
  reads: string[]
}

/**
 * Boot the real entry with a recording connection, a sessionQuery serving one
 * long user message, a session WRITE spy, and a throwaway DSH home.
 *
 * The session store is the REAL one (a fake `sessions` service would collide with
 * it — the plugin's module-level inject needs the real registry anyway); the write
 * spy wraps the ONE created session's `append`/`flush`.
 */
async function boot(): Promise<Ops> {
  // Assigned once the real session exists; the read faces below compare against it.
  let readable = ''
  const home = mkdtempSync(join(tmpdir(), 'redline-m2-'))
  homes.push(home)
  const routes: CapturedRoute[] = []
  const sessionWrites: string[] = []
  const reads: string[] = []
  const ctx = new Context()
  ctx.provide('connection', {
    fetch: {
      register(route: CapturedRoute) {
        routes.push(route)
        return () => {}
      },
    },
  })
  // The harness home service (what `host/version.ts` already probes) is also
  // where OUR data directory hangs off.
  ctx.provide('dshHomePath', (...segments: string[]) => join(home, ...segments))
  // Reads go through `sessionQuery` (docs/01 F5 — the sync event APIs are banned).
  // Shapes mirror the real service: `readEvent` answers a window whose `target` is
  // the full event; `readSurface` answers the current surface events.
  ctx.provide('sessionQuery', {
    async readSurface(sessionId: string) {
      reads.push(`readSurface:${sessionId}`)
      if (sessionId !== readable) throw new Error(`session "${sessionId}" is not readable here`)
      return {
        session: { id: sessionId },
        inheritedEventCount: 0,
        capturedThroughSeq: 1302,
        events: [
          { type: 'user/message', seq: 1301, data: { content: TEXT_BLOCKS } },
          { type: 'user/message', seq: 1302, data: { content: [{ type: 'text', text: SECOND }] } },
        ],
      }
    },
    async readEvent(request: { sessionId: string, seq: number }) {
      reads.push(`readEvent:${request.sessionId}:${request.seq}`)
      if (request.sessionId !== readable) throw new Error(`session "${request.sessionId}" is not readable here`)
      // Mirrors the real service: the window's `target` is the FULL event; a seq
      // that is not on the surface simply has no target.
      const content = request.seq === 1301 ? TEXT_BLOCKS : request.seq === 1302 ? [{ type: 'text', text: SECOND }] : undefined
      if (content === undefined) return { session: { id: request.sessionId }, inheritedEventCount: 0, target: undefined, events: [], startSeq: 0, endSeq: 0 }
      return {
        session: { id: request.sessionId },
        inheritedEventCount: 0,
        target: { type: 'user/message', seq: request.seq, data: { content } },
        events: [],
        startSeq: request.seq,
        endSeq: request.seq,
      }
    },
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const session = ctx.sessions.create()
  readable = session.id
  const originalAppend = session.append.bind(session)
  const spyAppend = (...args: unknown[]): unknown => {
    sessionWrites.push(`append:${String(args[0])}`)
    return (originalAppend as unknown as (...a: unknown[]) => unknown)(...args)
  }
  session.append = spyAppend as unknown as typeof session.append
  await ctx.plugin(plugin, {} as never)
  const channel = routes.find(r => r.path === REDLINE_CHANNEL_ROUTE)
  assert.ok(channel !== undefined, 'the channel registered')
  return { ctx, channel, home, sessionId: session.id, sessionWrites, logOffset: () => session.seq, reads }
}

async function call(ops: Ops, body: unknown): Promise<Record<string, unknown>> {
  const response = await ops.channel.fetch(new Request(`http://dsh.test${REDLINE_CHANNEL_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  assert.equal(response.status, 200)
  return await response.json() as Record<string, unknown>
}

/** Narrow a success envelope, failing loudly on a refusal. */
function value(reply: Record<string, unknown>): Record<string, unknown> {
  assert.equal(reply.ok, true, JSON.stringify(reply))
  return reply.value as Record<string, unknown>
}

function code(reply: Record<string, unknown>): string {
  assert.equal(reply.ok, false, JSON.stringify(reply))
  return (reply.error as { code: string }).code
}

const draftPath = (ops: Ops) => join(ops.home, REDLINE_DATA_DIR_NAME, draftFileName(ops.sessionId))

describe('node.read returns the durable full text', () => {
  test('the whole >200-char multi-paragraph message, verbatim', async () => {
    const ops = await boot()
    const row = value(await call(ops, { op: 'node.read', sessionId: ops.sessionId, seq: 1301 }))
    assert.equal(row.text, LONG)
    assert.equal((row.text as string).length, LONG.length)
    assert.ok((row.text as string).includes('\n\n'), 'paragraph breaks survive the route')
    assert.equal(row.type, 'user/message')
  })

  test('a seq that is not on the surface is a typed refusal, not an empty string', async () => {
    const ops = await boot()
    const reply = await call(ops, { op: 'node.read', sessionId: ops.sessionId, seq: 999999 })
    assert.ok(code(reply).startsWith('redline/'), JSON.stringify(reply))
  })
})

describe('every save is temporary (the hard constraint)', () => {
  test('draft.update writes ONLY our file — the session log is never touched', async () => {
    const ops = await boot()
    assert.equal(existsSync(draftPath(ops)), false, 'nothing is written before the first save')
    const before = ops.logOffset()

    const table = value(await call(ops, {
      op: 'draft.update',
      sessionId: ops.sessionId,
      seq: 1301,
      edit: { text: '只写本地的一版', reasoning: '', isError: false },
    }))
    assert.equal(Object.keys(table as Record<string, unknown>).length, 1)
    assert.deepEqual(ops.sessionWrites, [], 'ZERO session writes after a save')
    assert.equal(ops.logOffset(), before, 'the session log did not grow by a single event')
    assert.equal(existsSync(draftPath(ops)), true, 'the edit landed in OUR data directory')

    const stored = JSON.parse(readFileSync(draftPath(ops), 'utf8')) as { edits: { seq: number, text: string, updatedAt: string }[] }
    assert.deepEqual(stored.edits, [{
      seq: 1301,
      text: '只写本地的一版',
      reasoning: '',
      isError: false,
      updatedAt: stored.edits[0]!.updatedAt,
    }])
    assert.deepEqual(ops.sessionWrites, [], 'still zero session writes')
  })

  test('draft.list reads it back; a second save OVERWRITES the same row', async () => {
    const ops = await boot()
    await call(ops, { op: 'draft.update', sessionId: ops.sessionId, seq: 1301, edit: { text: '第一版', reasoning: '', isError: false } })
    await call(ops, { op: 'draft.update', sessionId: ops.sessionId, seq: 1301, edit: { text: '第二版：先跑全量测试', reasoning: '', isError: false } })

    const table = value(await call(ops, { op: 'draft.list', sessionId: ops.sessionId })) as Record<string, { text: string }>
    assert.deepEqual(Object.keys(table), ['1301'], 'one row, one local edit — no stacking')
    assert.equal(table['1301']!.text, '第二版：先跑全量测试', 'the latest version is the one that would be carried forward')
    assert.deepEqual(ops.sessionWrites, [])

    // …and it survives a reload from disk.
    const ops2 = await boot()
    const reloaded = value(await call(ops2, { op: 'draft.list', sessionId: ops.sessionId }))
    assert.deepEqual(reloaded, {})
  })

  test('draft.drop removes just that row and still writes nothing to the session', async () => {
    const ops = await boot()
    await call(ops, { op: 'draft.update', sessionId: ops.sessionId, seq: 1301, edit: { text: 'a', reasoning: '', isError: false } })
    await call(ops, { op: 'draft.update', sessionId: ops.sessionId, seq: 1302, edit: { text: 'b', reasoning: '', isError: false } })
    const left = value(await call(ops, { op: 'draft.drop', sessionId: ops.sessionId, seq: 1301 })) as Record<string, unknown>
    assert.deepEqual(Object.keys(left), ['1302'])
    assert.deepEqual(ops.sessionWrites, [])
  })
})

describe('the two refusals the demo defines', () => {
  test('a save identical to the version in effect is refused as no-change', async () => {
    const ops = await boot()
    const reply = await call(ops, { op: 'draft.update', sessionId: ops.sessionId, seq: 1301, edit: { text: LONG, reasoning: '', isError: false } })
    assert.equal(code(reply), REDLINE_ERROR.noChange)
    assert.equal(existsSync(draftPath(ops)), false, 'a refused save writes nothing at all')
  })

  test('emptying both text and reasoning is refused with its own code', async () => {
    const ops = await boot()
    const reply = await call(ops, { op: 'draft.update', sessionId: ops.sessionId, seq: 1301, edit: { text: '', reasoning: '', isError: false } })
    assert.equal(code(reply), 'redline/empty-content')
    assert.notEqual(code(reply), REDLINE_ERROR.noChange, 'the two refusals are distinguishable')
    assert.equal(existsSync(draftPath(ops)), false, 'a refused save writes nothing at all')
  })

  test('editing BACK to the original after a save is accepted (compared against the version in effect)', async () => {
    const ops = await boot()
    await call(ops, { op: 'draft.update', sessionId: ops.sessionId, seq: 1301, edit: { text: '先改成这个', reasoning: '', isError: false } })
    const back = await call(ops, { op: 'draft.update', sessionId: ops.sessionId, seq: 1301, edit: { text: LONG, reasoning: '', isError: false } })
    assert.equal(back.ok, true, JSON.stringify(back))
    assert.deepEqual(ops.sessionWrites, [])
  })
})

describe('argument validation', () => {
  test('a missing/ill-typed sessionId or seq is bad-request, never a crash', async () => {
    const ops = await boot()
    for (const body of [
      { op: 'node.read' },
      { op: 'node.read', sessionId: '', seq: 1 },
      { op: 'node.read', sessionId: ops.sessionId },
      { op: 'node.read', sessionId: ops.sessionId, seq: 'nope' },
      { op: 'draft.list' },
      { op: 'draft.update', sessionId: ops.sessionId, seq: 1301 },
      { op: 'draft.update', sessionId: ops.sessionId, seq: 1301, edit: { text: 42 } },
      { op: 'draft.drop', sessionId: ops.sessionId },
    ]) {
      const reply = await call(ops, body)
      assert.equal(code(reply), REDLINE_ERROR.badRequest, JSON.stringify(body))
    }
    assert.deepEqual(ops.sessionWrites, [])
  })

  test('an editable row in a session this process cannot read is a typed not-live refusal', async () => {
    const ops = await boot()
    const reply = await call(ops, { op: 'draft.update', sessionId: 'other', seq: 5, edit: { text: 'x', reasoning: '', isError: false } })
    assert.equal(code(reply), REDLINE_ERROR.notLive)
  })
})
