/**
 * The redline channel — OUR ONLY wiring file into the upstream host
 * (`docs/11` D3.1, `UPSTREAM.md` §3.3). Everything rides the single namespaced
 * route `REDLINE_CHANNEL_ROUTE`, discriminated by `op` (`docs/02` §5.1/§5.2):
 * adding an op never adds a route, so the "two plugins must not register the same
 * path" trap (`docs/01` F1) can only be sprung by editing the shared constant,
 * which the namespace contract watches.
 *
 * ── What lives here (M2) ────────────────────────────────────────────────────
 *   `node.read`    — one row's COMPLETE content (full text, never the 80-char
 *                    preview; `docs/01` F35). Reads go through `ctx.sessionQuery`
 *                    (`docs/01` F5: the sync event readers are banned for new code).
 *   `draft.list`   — the plugin's local edits for a session.
 *   `draft.update` — validate (empty-content / no-change) then write OUR file.
 *   `draft.drop`   — forget one row's local edit.
 *
 * ── The hard constraint ────────────────────────────────────────────────────
 * The three `draft.*` ops write ONE json file under our data directory and
 * NOTHING else: no `Session.append`, no `flush`, no projection write. The current
 * session's model keeps seeing exactly what it saw before (`docs/11` D15). The one
 * and only write point is opening a child session (M5). The `redline-ops` spec
 * proves the zero-write claim by spying on the session's write faces.
 *
 * ── Why the registration is defensive ──────────────────────────────────────
 * The route arms only while the `connection` service is composed (load order is
 * never assumed), the registration rides the injected fiber (an unloaded plugin
 * withdraws it), and a registry that rejects leaves the plugin otherwise intact.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { REDLINE_ERROR, REDLINE_ERROR_MESSAGE } from '../shared/redline-errors'
import {
  REDLINE_CHANNEL_ROUTE,
  asRedlineCall,
  redlineFailure,
  redlineOk,
  type RedlineCall,
  type RedlineEnvelope,
} from '../shared/redline-route'
import {
  REDLINE_DATA_DIR_NAME,
  checkChange,
  draftFileName,
  dropEdit,
  parseDrafts,
  putEdit,
  serializeDrafts,
  type DraftTable,
  type LocalEdit,
  type SurfaceRowText,
} from '../redline/drafts'
import { fullReasoningOf, fullTextOf, isErrorOf, seqOf, typeOf } from '../redline/inspect'

/** The host `connection` service, as far as this route consumes it. */
interface ConnectionHostFace {
  fetch?: {
    register?(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered'
      fetch: (request: Request) => Promise<Response>
    }): () => void
  }
}

/** The harness home anchor (also probed by `host/version.ts`). */
type HomePathFace = (...segments: string[]) => string

/** `ctx.sessionQuery`, as far as we consume it (signatures per the 0.2.0-rc.2 `.d.ts`). */
interface SessionQueryFace {
  readEvent?(request: { sessionId: string, seq: number }): Promise<unknown>
  readSurface?(sessionId: string): Promise<unknown>
}

/** What an op handler is given. */
export interface RedlineOpContext {
  /** The host context the channel was armed on. */
  readonly ctx: Context
  /** The parsed call: `op` plus its op-specific fields. */
  readonly call: RedlineCall
}

/**
 * One op. Handlers answer with the envelope themselves, so a refusal is a
 * value (a stable code the client can map) rather than an exception.
 */
export type RedlineOpHandler = (op: RedlineOpContext) => Promise<RedlineEnvelope<unknown>>

// ── helpers ─────────────────────────────────────────────────────────────────

function fail(code: string, message?: string): RedlineEnvelope<never> {
  return redlineFailure(code, message ?? REDLINE_ERROR_MESSAGE[code as keyof typeof REDLINE_ERROR_MESSAGE] ?? code)
}

/** A required non-empty session id, or null. */
function sessionIdOf(call: RedlineCall): string | null {
  const id = call.sessionId
  return typeof id === 'string' && id !== '' ? id : null
}

/** A required non-negative integer seq, or null. */
function seqArgOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** Our data directory, or null when the harness home is not composed. */
function dataDirOf(ctx: Context): string | null {
  const home = ctx.get('dshHomePath') as HomePathFace | undefined
  if (typeof home !== 'function') return null
  try {
    return join(home(REDLINE_DATA_DIR_NAME))
  } catch {
    return null
  }
}

/** Read a session's local edits. A missing file is an empty table; a corrupt one refuses loudly. */
async function readTable(ctx: Context, sessionId: string): Promise<RedlineEnvelope<DraftTable>> {
  const dir = dataDirOf(ctx)
  if (dir === null) return fail(REDLINE_ERROR.internal, 'the harness home is not available')
  let raw: string | null = null
  try {
    raw = await readFile(join(dir, draftFileName(sessionId)), 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      return fail(REDLINE_ERROR.internal, error instanceof Error ? error.message : String(error))
    }
  }
  const parsed = parseDrafts(raw)
  if (!parsed.ok) return fail(parsed.code, parsed.message)
  return redlineOk(parsed.table)
}

/** Write a session's local edits atomically (`.tmp` + rename) — our ONLY write. */
async function writeTable(ctx: Context, sessionId: string, table: DraftTable): Promise<RedlineEnvelope<DraftTable>> {
  const dir = dataDirOf(ctx)
  if (dir === null) return fail(REDLINE_ERROR.internal, 'the harness home is not available')
  const target = join(dir, draftFileName(sessionId))
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(temp, serializeDrafts(sessionId, table), 'utf8')
    await rename(temp, target)
  } catch (error) {
    return fail(REDLINE_ERROR.internal, error instanceof Error ? error.message : String(error))
  }
  return redlineOk(table)
}

/** The durable event for a seq, read through `ctx.sessionQuery` (never a sync reader). */
async function resolveEvent(ctx: Context, sessionId: string, seq: number): Promise<RedlineEnvelope<unknown>> {
  const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
  if (typeof query?.readEvent !== 'function' && typeof query?.readSurface !== 'function') {
    return fail(REDLINE_ERROR.notLive)
  }
  try {
    if (typeof query.readEvent === 'function') {
      const window = await query.readEvent({ sessionId, seq }) as { target?: unknown } | null
      if (window !== null && window !== undefined && window.target !== undefined && window.target !== null) {
        return redlineOk(window.target)
      }
    }
    if (typeof query.readSurface === 'function') {
      const surface = await query.readSurface(sessionId) as { events?: unknown } | null
      const events = surface?.events
      if (Array.isArray(events)) {
        const hit = (events as unknown[]).find(event => seqOf(event as never) === seq)
        if (hit !== undefined) return redlineOk(hit)
      }
    }
  } catch (error) {
    // The session cannot be read here (not live, no permission, no log): the
    // stable not-live code is what the client turns into a sentence.
    return fail(REDLINE_ERROR.notLive, error instanceof Error ? error.message : String(error))
  }
  return fail(REDLINE_ERROR.shadowed)
}

/** One row's complete content, shaped for the client. */
function rowOf(seq: number, event: unknown): Record<string, unknown> {
  return {
    seq,
    type: typeOf(event as never),
    text: fullTextOf(event as never),
    reasoning: fullReasoningOf(event as never),
    ...(isErrorOf(event as never) ? { isError: true } : {}),
  }
}

// ── the ops ─────────────────────────────────────────────────────────────────

/** One row's full content. The editor's only prefill source. */
const readRow: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  const seq = seqArgOf(call.seq)
  if (sessionId === null || seq === null) return fail(REDLINE_ERROR.badRequest)
  const event = await resolveEvent(ctx, sessionId, seq)
  if (!event.ok) return event
  return redlineOk(rowOf(seq, event.value))
}

/** The local edits of one session. */
const listDrafts: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null) return fail(REDLINE_ERROR.badRequest)
  return await readTable(ctx, sessionId)
}

/**
 * Save one row's local edit. Overwrites (one row, one edit), refuses an empty or
 * unchanged submission, and writes ONLY our own file.
 */
const updateDraft: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  const seq = seqArgOf(call.seq)
  if (sessionId === null || seq === null) return fail(REDLINE_ERROR.badRequest)
  const edit = call.edit
  if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) return fail(REDLINE_ERROR.badRequest)
  const bag = edit as { text?: unknown, reasoning?: unknown, isError?: unknown, cat?: unknown, name?: unknown }
  if (typeof bag.text !== 'string') return fail(REDLINE_ERROR.badRequest)
  if (bag.reasoning !== undefined && typeof bag.reasoning !== 'string') return fail(REDLINE_ERROR.badRequest)
  if (bag.isError !== undefined && typeof bag.isError !== 'boolean') return fail(REDLINE_ERROR.badRequest)
  const next = { text: bag.text, reasoning: bag.reasoning ?? '', isError: bag.isError ?? false }

  const current = await readTable(ctx, sessionId)
  if (!current.ok) return current
  const event = await resolveEvent(ctx, sessionId, seq)
  if (!event.ok) return event
  const row: SurfaceRowText = {
    seq,
    text: fullTextOf(event.value as never),
    reasoning: fullReasoningOf(event.value as never),
    isError: isErrorOf(event.value as never),
  }
  const verdict = checkChange(row, current.value, next)
  if (!verdict.ok) return fail(verdict.code)

  const localEdit: LocalEdit = {
    seq,
    text: next.text,
    reasoning: next.reasoning,
    isError: next.isError,
    updatedAt: new Date().toISOString(),
    ...(typeof bag.cat === 'string' ? { cat: bag.cat } : {}),
    ...(typeof bag.name === 'string' ? { name: bag.name } : {}),
  }
  return await writeTable(ctx, sessionId, putEdit(current.value, localEdit))
}

/** Forget one row's local edit (the row goes back to its original). */
const dropDraft: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  const seq = seqArgOf(call.seq)
  if (sessionId === null || seq === null) return fail(REDLINE_ERROR.badRequest)
  const current = await readTable(ctx, sessionId)
  if (!current.ok) return current
  return await writeTable(ctx, sessionId, dropEdit(current.value, seq))
}

/**
 * The op table. M2's entries; M3/M5 add theirs here and nowhere else.
 */
const OPS = new Map<string, RedlineOpHandler>([
  ['node.read', readRow],
  ['draft.list', listDrafts],
  ['draft.update', updateDraft],
  ['draft.drop', dropDraft],
])

/** One JSON reply on the channel. `no-store` matches every other plugin route. */
function reply(envelope: RedlineEnvelope<unknown>): Response {
  return Response.json(envelope, { headers: { 'cache-control': 'no-store' } })
}

/** Route one already-parsed call through the op table. */
async function dispatch(ctx: Context, call: RedlineCall): Promise<RedlineEnvelope<unknown>> {
  const handler = OPS.get(call.op)
  if (handler === undefined) {
    return redlineFailure(REDLINE_ERROR.unknownOp, `${REDLINE_ERROR_MESSAGE[REDLINE_ERROR.unknownOp]}: ${call.op}`)
  }
  try {
    return await handler({ ctx, call })
  } catch (error) {
    return redlineFailure(
      REDLINE_ERROR.internal,
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * Arm the channel while the `connection` service is composed. The registration's
 * own disposer rides the injected fiber.
 *
 * @param ctx - the host context the plugin was applied to.
 */
export function watchRedlineChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {
    const connection = c.get('connection') as ConnectionHostFace | undefined
    // Bind at extraction: an unbound hand-off loses `this` on the real face.
    const register = typeof connection?.fetch?.register === 'function'
      ? connection.fetch.register.bind(connection.fetch)
      : undefined
    if (register === undefined) return

    const fetch = async (request: Request): Promise<Response> => {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return reply(redlineFailure(REDLINE_ERROR.badRequest, 'body is not JSON'))
      }
      const call = asRedlineCall(body)
      if (call === null) {
        return reply(redlineFailure(REDLINE_ERROR.badRequest, REDLINE_ERROR_MESSAGE[REDLINE_ERROR.badRequest]))
      }
      return reply(await dispatch(c, call))
    }

    c.effect(() => register({
      path: REDLINE_CHANNEL_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch,
    }), 'dsh-context-redline: redline channel route')
  })
}
