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

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { REDLINE_ERROR, REDLINE_ERROR_MESSAGE, isRedlineErrorCode } from '../shared/redline-errors'
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
} from '../shared/redline-drafts'
import { fullReasoningOf, fullTextOf, isErrorOf, seqOf, typeOf } from '../redline/inspect'
import { ability, type RowClass } from '../shared/redline-ability'
import { turnStateOf, type TurnBoundaryEvent, type TurnState } from '../shared/redline-turn'
import { buildFirstTask, forkConfirmItems } from '../redline/orchestrate'

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
  readEvent?(request: { sessionId: string; seq: number }): Promise<unknown>
  readSurface?(sessionId: string): Promise<unknown>
  listEvents?(sessionId: string): Promise<readonly TurnBoundaryEvent[]>
}

/** `ctx.subagents` 里我们真正要用的那一小块（签名按 `docs/06` §3.1.1 的实测）。 */
interface SubagentsFace {
  startContinuable?(spec: {
    provider: string
    label: string
    /**
     * ⚠️ **真机纠正（2026-10-06）**：安装树里 `ContinuableStartSpec` 的 `request.parent` 要的是**活的 parent Agent
     * 对象**（不是会话 id 字符串）、`request.prompt` 要的是 `ContentBlock[]`（不是字符串），而 `signal` 是**必填**且在外层。
     * 第一版按 docs/06 §3.1.1 那句「parent/prompt 在 request 里」照传字符串 ⟹ 真机报
     * `Cannot read properties of undefined (reading 'header')`（它去读 Agent 的 header，读到 undefined）。
     */
    request: { parent: unknown; prompt: readonly { type: string; text: string }[] }
    signal: AbortSignal
  }): Promise<unknown>
}

/** The host session store, as far as liveness is concerned. */
interface SessionsHostFace {
  get?(id: string): unknown
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
  return redlineFailure(code, message ?? wireMessage(code))
}

/** The wire text for a code: ours when we know it, the code itself when we do not. */
function wireMessage(code: string): string {
  return isRedlineErrorCode(code) ? REDLINE_ERROR_MESSAGE[code] : code
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
    // A failed write must not leave `.tmp-*` litter behind (Code Review P2):
    // best-effort cleanup, never masking the original failure.
    await rm(temp, { force: true }).catch(() => undefined)
    return fail(REDLINE_ERROR.internal, error instanceof Error ? error.message : String(error))
  }
  return redlineOk(table)
}

/**
 * Whether that seq sits on the session's CURRENT surface (not merely in the log).
 *
 * `resolveEvent` reads the LOG, which keeps a replaced original — so log presence
 * alone cannot tell "superseded" from "editable". `null` = this host cannot answer
 * (no `readSurface` here); the caller then allows the save rather than inventing a
 * refusal (the type-level rules below are the ones that must never be skipped).
 */
async function onCurrentSurface(ctx: Context, sessionId: string, seq: number): Promise<boolean | null> {
  const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
  if (typeof query?.readSurface !== 'function') return null
  try {
    const surface = await query.readSurface(sessionId) as { events?: unknown } | null | undefined
    const events = surface?.events
    if (!Array.isArray(events)) return null
    return (events as unknown[]).some(event => seqOf(event as never) === seq)
  } catch {
    return null
  }
}

/**
 * The presentation bucket a durable type belongs to, **for the host gate only**
 * (the editor's fields still come from `node.read`'s real type).
 *
 * `null` = a type this plugin has no local-edit semantics for → refused as
 * `unsupportedType`. The shared `ability()` then applies the ONE rule both halves
 * obey (`AGENTS.md` §2.3.1): judge by the underlying event type, never by category.
 */
function gateClassOf(type: string): RowClass | null {
  if (type === 'user/message') return 'user'
  if (type === 'tool/result') return 'tool'
  if (type === 'assistant/message') return 'assistant'
  // Host-protected families: inert in the UI, and refused here as well.
  if (type === 'system/message' || type === 'developer/message' || type === 'request/header') return 'system'
  return null
}

/** The durable event for a seq, read through `ctx.sessionQuery` (never a sync reader). */
async function resolveEvent(ctx: Context, sessionId: string, seq: number): Promise<RedlineEnvelope<unknown>> {
  const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
  if (typeof query?.readEvent !== 'function' && typeof query?.readSurface !== 'function') {
    return fail(REDLINE_ERROR.notLive)
  }
  try {
    if (typeof query.readEvent === 'function') {
      const window = await query.readEvent({ sessionId, seq }) as { target?: unknown } | null | undefined
      if (window !== null && window !== undefined && window.target !== undefined && window.target !== null) {
        return redlineOk(window.target)
      }
    }
    if (typeof query.readSurface === 'function') {
      const surface = await query.readSurface(sessionId) as { events?: unknown } | null | undefined
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
  // 日志里也找不到这一条：这不是"被接替"，而是"没有这一条"（Code Review P1-1）。
  return fail(REDLINE_ERROR.notFound)
}

/**
 * Whether this session can be edited right now (`docs/03` R4.3):
 * `known: false` = this process does not host it (view only); `open: true` = the
 * turn has not closed, and the panel must not let an edit be prepared against a
 * surface that is still moving. The platform does NOT police this (`docs/01` F8).
 */
async function turnStateOfSession(ctx: Context, sessionId: string): Promise<TurnState> {
  const sessions = ctx.get('sessions') as SessionsHostFace | undefined
  const live = typeof sessions?.get === 'function' && sessions.get(sessionId) !== undefined
  if (!live) return turnStateOf(false, null)
  const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
  if (typeof query?.listEvents !== 'function') return turnStateOf(true, null)
  try {
    const events = await query.listEvents(sessionId)
    return turnStateOf(true, Array.isArray(events) ? events : null)
  } catch {
    return turnStateOf(true, null)
  }
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

/**
 * Whether the panel may edit this session at all, and if not, why in machine terms.
 * The client shows the demo's sentence and disables `保存` BEFORE any round trip.
 */
/**
 * 真机探针（M4.5 包 A 的**只读**半边；2026-10-05 用户授予"授权包②"后加）：
 * 把宿主**实际**提供的服务、以及它们的方法名外形报出来 —— 只回答"在不在 / 叫什么"，
 * **不读任何会话内容、不写任何东西**。用途：把 `docs/01` §6 里 V1–V6/V10/V12/V13 那些
 * "静态能读、真机未知"的条目落成实测。用完整名 `probe.services` 以免被误当业务能力。
 */
/** 把 catch 到的任何东西变成一句话（不要 `as Error` + 可选链堆在一起）。 */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const probeServices: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call) ?? ''
  const keys = ['subagents', 'agents', 'agentTeams', 'compaction', 'sessionQuery', 'sessions', 'projection', 'slots', 'settings', 'tools', 'commands']
  const present: Record<string, string[]> = {}
  for (const key of keys) {
    // 运行期拿到的可能是任何东西（含 null）：类型里如实带上 null，别让 lint 以为那个判断多余
    const svc = ctx.get(key) as Record<string, unknown> | undefined | null
    if (svc === undefined || svc === null) continue
    const proto = Object.getPrototypeOf(svc) as Record<string, unknown> | null
    const names = [...Object.getOwnPropertyNames(proto ?? {}), ...Object.keys(svc)]
    present[key] = [...new Set(names)].filter(n => n !== 'constructor').slice(0, 40)
  }
  const subagents = ctx.get('subagents') as { getProvider?: (n: string) => unknown } | undefined
  const agents = ctx.get('agents') as { get?: (id: string) => unknown } | undefined
  const providers: string[] = []
  for (const name of ['fork', 'spawn', 'fork-in-process', 'spawn-in-process']) {
    if (typeof subagents?.getProvider === 'function' && subagents.getProvider(name) !== undefined) providers.push(name)
  }
  // 顺带把"这个会话的日志读不读得到"也报出来 —— 这正是 V3/V6 想知道的（只读，读不到就如实说读不到）
  let logReadable: boolean | string = 'no-listEvents'
  let eventCount: number | null = null
  const query = ctx.get('sessionQuery') as SessionQueryFace | undefined | null
  if (typeof query?.listEvents === 'function' && sessionId !== '') {
    try {
      const events = await query.listEvents(sessionId)
      logReadable = true
      eventCount = Array.isArray(events) ? events.length : null
    } catch {
      logReadable = false
    }
  }
  // ── V2/V10 的路径探索：ctx 上到底挂了哪些服务（Cordis 的注册表通常可由 Object.keys 枚举）──
  let ctxKeys: string[] | string = 'not-enumerable'
  try {
    const keys = Object.keys(ctx as unknown as Record<string, unknown>)
    if (keys.length > 0) ctxKeys = keys.sort()
  } catch { /* 枚举不到就如实说枚举不到 */ }
  // ── V8：日志里"被遮蔽的原文"读不读得回来（回滚要用它；只读）──
  const shadow: Record<string, unknown> = { replaceish: 0, readback: 'no-log' }
  if (typeof query?.listEvents === 'function' && sessionId !== '') {
    try {
      const events = await query.listEvents(sessionId) as readonly Record<string, unknown>[]
      const carriers = events.filter(e => Array.isArray((e as { sourceEventSeqs?: unknown }).sourceEventSeqs))
      shadow.replaceish = carriers.length
      // `.at(0)`：类型上真的可能 undefined（下标写法被当成非空，判断会被 lint 判成多余）
      const first = carriers.at(0)
      if (first !== undefined && typeof query.readEvent === 'function') {
        const seqs = (first as { sourceEventSeqs?: number[] }).sourceEventSeqs ?? []
        const target = seqs.at(0)
        if (target === undefined) { shadow.readback = 'carrier-has-no-seq' } else {
          const back = await query.readEvent({ sessionId, seq: target }) as { text?: unknown; target?: unknown } | null | undefined
          const text = typeof back?.text === 'string' ? back.text : null
          shadow.readback = text === null ? 'no-text-field' : (text === '' ? 'empty' : 'ok')
          shadow.originalPrefix = text === null ? null : text.slice(0, 40)
          shadow.targetShape = back === null || back === undefined ? 'null' : Object.keys(back).slice(0, 8)
        }
      }
    } catch (error) {
      shadow.readback = 'threw: ' + messageOf(error).slice(0, 60)
    }
  }
  // ── V13：官方团队的 Lead 判定（只读试探）──
  let membership: unknown = 'no-agentTeams'
  const teams = ctx.get('agentTeams') as { tryMembership?: (id: string) => unknown; membership?: (id: string) => unknown } | undefined | null
  if (teams !== undefined && teams !== null && sessionId !== '') {
    try {
      if (typeof teams.tryMembership === 'function') membership = { via: 'tryMembership', value: teams.tryMembership(sessionId) }
      else if (typeof teams.membership === 'function') membership = { via: 'membership', value: teams.membership(sessionId) }
      else membership = 'no-method'
    } catch (error) {
      membership = { threw: messageOf(error).slice(0, 60) }
    }
  }
  return redlineOk({
    present,
    ctxKeys,
    shadow,
    membership,
    logReadable,
    eventCount,
    subagentsProviders: providers,
    subagentsHasStartContinuable: typeof (subagents as { startContinuable?: unknown } | undefined)?.startContinuable === 'function',
    agentForSession: typeof agents?.get === 'function' ? (sessionId !== '' && agents.get(sessionId) !== undefined) : 'no-agents.get',
  })
}

const readTurnState: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null) return fail(REDLINE_ERROR.badRequest)
  return redlineOk(await turnStateOfSession(ctx, sessionId))
}

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
  const bag = edit as { text?: unknown; reasoning?: unknown; isError?: unknown; cat?: unknown; name?: unknown }
  if (typeof bag.text !== 'string') return fail(REDLINE_ERROR.badRequest)
  if (bag.reasoning !== undefined && typeof bag.reasoning !== 'string') return fail(REDLINE_ERROR.badRequest)
  if (bag.isError !== undefined && typeof bag.isError !== 'boolean') return fail(REDLINE_ERROR.badRequest)
  const next = { text: bag.text, reasoning: bag.reasoning ?? '', isError: bag.isError ?? false }

  // The demo's own gate (`blocked = turnOpen || !live`), enforced on the host too:
  // the panel disables the button, and this is the safety net behind it.
  const state = await turnStateOfSession(ctx, sessionId)
  if (!state.known) return fail(REDLINE_ERROR.notLive)
  if (state.open) return fail(REDLINE_ERROR.turnOpen)

  const current = await readTable(ctx, sessionId)
  if (!current.ok) return current
  const event = await resolveEvent(ctx, sessionId, seq)
  if (!event.ok) return event
  // ── 宿主侧的能力校验（Code Review P1-3）──────────────────────────────────────
  // 客户端的能力判定只有一道门：旧客户端 / 另一个标签页 / 直接 POST 都能绕过它，
  // 而 `child.start` 会把草稿当"你改好的上下文"逐字写进子会话第一句话。
  // 这里用**两半共用**的 `ability()` 再判一次，判据是底层事件类型（`AGENTS.md` §2.3.1）。
  const type = typeOf(event.value as never)
  const rowClass = gateClassOf(type)
  if (rowClass === null) return fail(REDLINE_ERROR.unsupportedType)
  const onSurface = await onCurrentSurface(ctx, sessionId, seq)
  const shadowed = onSurface === false
  const verdictAbility = ability({
    seq,
    type,
    cat: rowClass,
    shadowed,
    isReplacement: !shadowed,
    compacted: false,
  })
  if (!verdictAbility.canRewrite) {
    if (verdictAbility.blockReason === 'assistant-immutable') return fail(REDLINE_ERROR.assistantImmutable)
    if (verdictAbility.blockReason === 'shadowed') return fail(REDLINE_ERROR.shadowed)
    return fail(REDLINE_ERROR.unsupportedType)
  }
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
  // 与 `draft.update` 同一道门（Code Review P2）：不 live / 轮次未闭合都不许写，
  // 否则任意 sessionId 都能在我们的数据目录里造出一个空草稿文件。
  const state = await turnStateOfSession(ctx, sessionId)
  if (!state.known) return fail(REDLINE_ERROR.notLive)
  if (state.open) return fail(REDLINE_ERROR.turnOpen)
  const current = await readTable(ctx, sessionId)
  if (!current.ok) return current
  const next = dropEdit(current.value, seq)
  // 没有任何改动可丢：什么都不做，也不创建文件（幂等且零副作用）。
  if (next === current.value) return redlineOk(current.value)
  return await writeTable(ctx, sessionId, next)
}

/**
 * 开子会话**之前**能问的全部事实（**只读**）：确认框五项 + 组装好的首条任务。
 * 起点恒为"最后聊完的那一轮"（`docs/01` F38：平台没有更早的起点可用）。
 */
const planChild: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null) return fail(REDLINE_ERROR.badRequest)
  const drafts = await readTable(ctx, sessionId)
  if (!drafts.ok) return drafts
  // `DraftTable` 是按 seq 键控的 Record（不是数组）⟹ 取值再按 seq 排序，顺序才稳定
  const edits = Object.values(drafts.value).sort((a, b) => a.seq - b.seq).map(edit => ({ seq: edit.seq, text: edit.text }))
  const humanTask = typeof call.humanTask === 'string' ? call.humanTask : ''
  const first = buildFirstTask({ humanTask, edits })
  const position = '从最后聊完的那一轮开始'
  return redlineOk({
    items: forkConfirmItems({ position, humanTask, edits }),
    carriedSeqs: edits.map(e => e.seq),
    prompt: first.ok ? first.prompt : null,
    refusal: first.ok ? null : { code: REDLINE_ERROR.emptyTask, message: first.message },
  })
}

/**
 * **开子会话**：全插件唯一的写入点（`AGENTS.md` §1 的"所有保存都是临时保存"）。
 *
 * 它只做三件事：组装首条任务（人写的话 + 逐字带入的改后正文）→ 调 `subagents.startContinuable`
 * → 把实际写进去的内容回报给调用方记台账。除此之外**不写任何会话**（`session.append` 一次都不调）。
 *
 * 拒绝顺序（先说的先算）：会话不在本进程 → 轮次未闭合 → 首条任务为空 → 运行时没有子会话服务。
 */
const startChild: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null) return fail(REDLINE_ERROR.badRequest)
  const turn = await turnStateOfSession(ctx, sessionId)
  if (!turn.known) return fail(REDLINE_ERROR.notLive)
  if (turn.open) return fail(REDLINE_ERROR.turnOpen)
  const drafts = await readTable(ctx, sessionId)
  if (!drafts.ok) return drafts
  // `DraftTable` 是按 seq 键控的 Record（不是数组）⟹ 取值再按 seq 排序，顺序才稳定
  const edits = Object.values(drafts.value).sort((a, b) => a.seq - b.seq).map(edit => ({ seq: edit.seq, text: edit.text }))
  const humanTask = typeof call.humanTask === 'string' ? call.humanTask : ''
  const first = buildFirstTask({ humanTask, edits })
  if (!first.ok) return redlineFailure(REDLINE_ERROR.emptyTask, first.message)
  // 活 Agent：真机的 request.parent 要的是它（agents.get 只对「本进程加载过的会话」有值 —— docs/01 F48）。
  const agents = ctx.get('agents') as { get?: (id: string) => unknown } | undefined | null
  const parent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  if (parent === undefined) return fail(REDLINE_ERROR.notLive)
  const subagents = ctx.get('subagents') as SubagentsFace | undefined | null
  if (subagents === undefined || subagents === null || typeof subagents.startContinuable !== 'function') {
    return fail(REDLINE_ERROR.noSubagents)
  }
  const label = '上下文批改 · ' + sessionId.slice(-8)
  const started = await subagents.startContinuable({
    provider: 'fork',
    label,
    request: { parent, prompt: [{ type: 'text', text: first.prompt }] },
    signal: new AbortController().signal,
  })
  return redlineOk({ label, prompt: first.prompt, carriedSeqs: edits.map(e => e.seq), started: started === undefined ? null : started })
}

/**
 * The op table. M2's entries; M3/M5 add theirs here and nowhere else.
 */
const OPS = new Map<string, RedlineOpHandler>([
  ['node.read', readRow],
  ['turnState', readTurnState],
  ['probe.services', probeServices],
  ['draft.list', listDrafts],
  ['draft.update', updateDraft],
  ['draft.drop', dropDraft],
  ['child.plan', planChild],
  ['child.start', startChild],
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
