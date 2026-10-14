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
import { randomUUID } from 'node:crypto'
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
  draftRevisionOf,
  draftFileName,
  dropEdit,
  deletedSeqsOf,
  isDeleted,
  parseDrafts,
  putDeleted,
  putEdit,
  serializeDrafts,
  unmarkDeleted,
  type DraftTable,
  type LocalEdit,
  type SurfaceRowText,
} from '../shared/redline-drafts'
import { fullReasoningOf, fullTextOf, isErrorOf, seqOf, typeOf } from '../redline/inspect'
import { ability, type RowClass } from '../shared/redline-ability'
import { turnStateOf, type TurnBoundaryEvent, type TurnState } from '../shared/redline-turn'
import { buildFirstTask, forkConfirmItems } from '../redline/orchestrate'
import { firstTaskMetricsOf } from '../redline/metrics'
import { capacityFromService } from '../shared/redline-capacity'
import { originsFileName, parseOrigins } from '../shared/redline-origins'
import { captureEventSourceSnapshot, eventSourceKeyOf, type CapturedEventSource, type SurfaceSnapshotEvent } from '../shared/redline-source'
import { buildManifest, serializeManifestDelivery, stableFingerprint, type ManifestCandidate } from '../redline/manifest'
import {
  authorizeCarrier,
  createCarrierPreview,
  setTitleStatus,
  transitionCarrierTask,
  type CarrierConfirmedConfig,
  type CarrierExecutionInput,
  type CarrierOperation,
} from '../shared/redline-carrier'
import { createRedlineCarrierStore } from './redline-carrier-store'
import { redlineSessionControlFor, type CarrierSessionRequest } from './redline-session-control'
import { runCarrierToReturn } from './redline-carrier-runner'

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
  readSession?(sessionId: string): Promise<{ readonly events: readonly unknown[] }>
  listEvents?(sessionId: string): Promise<readonly TurnBoundaryEvent[]>
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
  const parsed = parseDrafts(raw, sessionId)
  if (!parsed.ok) return fail(parsed.code, parsed.message)
  return redlineOk(parsed.table)
}

/**
 * Per-session write queue (Code Review P1-4).
 *
 * `draft.update` / `draft.drop` are read-modify-write over ONE file, and the local
 * edits are the only copy that exists (the session log never sees them). Two clients
 * (two tabs, a double click, a stale page) used to interleave: both read the same
 * table, both wrote it whole, and the later write won — silently losing the other
 * edit. Serializing per session makes the pair of operations atomic with respect to
 * each other; different sessions still proceed in parallel.
 */
const writeQueues = new Map<string, Promise<unknown>>()
let writeTicket = 0

/** Run `task` after every earlier queued write for that session has settled. */
function withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(sessionId) ?? Promise.resolve()
  // Run regardless of whether the previous write succeeded or failed.
  const run = previous.then(task, task)
  const tail = run.then(() => undefined, () => undefined)
  writeQueues.set(sessionId, tail)
  void tail.then(() => {
    // Only the last queued write clears the slot (a later one may have replaced it).
    if (writeQueues.get(sessionId) === tail) writeQueues.delete(sessionId)
  })
  return run
}

/** Write a session's local edits atomically (`.tmp` + rename) — our ONLY write. */
async function writeTable(ctx: Context, sessionId: string, table: DraftTable): Promise<RedlineEnvelope<DraftTable>> {
  const dir = dataDirOf(ctx)
  if (dir === null) return fail(REDLINE_ERROR.internal, 'the harness home is not available')
  const target = join(dir, draftFileName(sessionId))
  // 唯一临时名：同进程同一毫秒的两次并发写不能用同一个 .tmp（Code Review P1-4 实测到
  // rename 互相搬走 ⟹ ENOENT，比"后写覆盖先写"更早暴露）。
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}-${(writeTicket += 1).toString(36)}`
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
/** 把 catch 到的任何东西变成一句话。 */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

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

  // 读—改—写整段串行化（同一会话的并发保存不再互相覆盖）。
  return await withSessionLock(sessionId, async () => {
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
  })
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
  return await withSessionLock(sessionId, async () => {
    const current = await readTable(ctx, sessionId)
    if (!current.ok) return current
    const next = dropEdit(current.value, seq)
    // 没有任何改动可丢：什么都不做，也不创建文件（幂等且零副作用）。
    if (next === current.value) return redlineOk(current.value)
    return await writeTable(ctx, sessionId, next)
  })
}

/**
 * 把某一行标为「不要」或取消这个标记（`docs/11` D65）。**只写我们自己的草稿文件。**
 *
 * ⚠️ 这不是"删除"：平台只有 append/replace（`docs/01`），fork 的种子也排除不掉某一条（F38）。
 * 它只是把"这一条作废"记在本地，开启子会话时由首条任务**逐字声明**。
 */
const excludeDraft: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  const seq = seqArgOf(call.seq)
  if (sessionId === null || seq === null) return fail(REDLINE_ERROR.badRequest)
  const state = await turnStateOfSession(ctx, sessionId)
  if (!state.known) return fail(REDLINE_ERROR.notLive)
  if (state.open) return fail(REDLINE_ERROR.turnOpen)
  const on = call.excluded !== false
  return await withSessionLock(sessionId, async () => {
    const current = await readTable(ctx, sessionId)
    if (!current.ok) return current
    const alreadyMarked = isDeleted(current.value, seq)
    // 幂等：状态没变就**不落盘**（与 draft.drop 同一套口径：没有变化就不产生副作用）。
    if (on === alreadyMarked) return redlineOk(current.value)
    // ⚠️ 取消删除必须走 `unmarkDeleted`（`docs/03` R4.8）：它只去掉删除标记、**保留编辑正文**，
    // 所以"改了一条 → 删除 → 取消删除"能回到改后的正文。`dropEdit` 的新语义是
    // 「已删除编辑稿 → 已删除原文」（清正文、留删除态），用在这里会变成"取消删除没生效"。
    const next = on
      ? putDeleted(current.value, seq, new Date().toISOString())
      : unmarkDeleted(current.value, seq)
    return await writeTable(ctx, sessionId, next)
  })
}

interface CarrierSourceAgentFace {
  readonly options?: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string; readonly maxTokens?: number }
  readonly session?: { readonly header?: { readonly cwd?: string; readonly agentPreset?: string } }
  readonly ctx?: Context
}

interface CarrierWorkspaceRegistryFace {
  resolveByPath?(path: string): Promise<{ readonly id: string; readonly path: string } | undefined>
}

interface CarrierPlanValue {
  readonly operationId: string
  readonly draftRevision: string
  readonly surfaceFingerprint: string
  readonly manifestFingerprint: string
  readonly items: readonly { readonly label: string; readonly text: string }[]
  readonly carriedSeqs: readonly number[]
  readonly excludedSeqs: readonly number[]
  readonly prompt: string | null
  readonly metrics: { readonly bytes: number; readonly lines: number; readonly edits: number } | null
  readonly refusal: { readonly code: string; readonly message: string } | null
}

function manifestCategory(candidate: CapturedEventSource): RowClass {
  return candidate.sourceRole === 'system' ? 'system' : candidate.sourceRole
}

interface CarrierConfirmationToken {
  readonly operationId: string
  readonly draftRevision: string
  readonly surfaceFingerprint: string
  readonly manifestFingerprint: string
  readonly taskFingerprint: string
}

function encodeCarrierConfirmation(value: CarrierConfirmationToken): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCarrierConfirmation(raw: unknown): CarrierConfirmationToken | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<CarrierConfirmationToken>
    return typeof value.operationId === 'string' && typeof value.draftRevision === 'string'
      && typeof value.surfaceFingerprint === 'string' && typeof value.manifestFingerprint === 'string'
      && typeof value.taskFingerprint === 'string'
      ? value as CarrierConfirmationToken : null
  } catch { return null }
}

function fixedCarrierIds(operationId: string) {
  const suffix = stableFingerprint(operationId)
  return {
    carrierId: `session-redline-${suffix.slice(0, 24)}`,
    promptRequestId: `redline-prompt-${suffix.slice(0, 24)}`,
    returnRequestId: `redline-return-${suffix.slice(24, 48)}`,
  }
}

function confirmedConfigOf(ctx: Context, agent: CarrierSourceAgentFace): CarrierConfirmedConfig | null {
  const provider = agent.options?.provider
  const model = agent.options?.model
  const presets = ctx.get('agentPresets') as { composedPreset?(agentCtx: Context): string | undefined } | undefined
  const preset = agent.session?.header?.agentPreset ?? (agent.ctx === undefined ? undefined : presets?.composedPreset?.(agent.ctx))
  if (provider === undefined || model === undefined || preset === undefined) return null
  return {
    agentPreset: preset,
    provider,
    model,
    reasoningEffort: agent.options?.reasoningEffort ?? 'not-specified',
    inheritedFrom: 'source-session-explicit-config',
  }
}

async function prepareCarrierPlan(
  ctx: Context,
  sessionId: string,
  humanTask: string,
  operationId = `redline-op-${randomUUID()}`,
): Promise<RedlineEnvelope<CarrierPlanValue & { readonly preview?: CarrierOperation }>> {
  const drafts = await readTable(ctx, sessionId)
  if (!drafts.ok) return drafts
  const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
  if (typeof query?.readSurface !== 'function') return fail(REDLINE_ERROR.notLive)
  let rawSurface: unknown
  try { rawSurface = await query.readSurface(sessionId) } catch (error) {
    return fail(REDLINE_ERROR.internal, `source surface read failed: ${messageOf(error)}`)
  }
  if (rawSurface === null || typeof rawSurface !== 'object') return fail(REDLINE_ERROR.internal, 'source surface is invalid')
  const surfaceBag = rawSurface as { session?: unknown; capturedThroughSeq?: unknown; events?: unknown }
  const sourceHeader = surfaceBag.session
  const sourceHeaderId = sourceHeader !== null && typeof sourceHeader === 'object' && typeof (sourceHeader as { id?: unknown }).id === 'string'
    ? (sourceHeader as { id: string }).id : sessionId
  if ((surfaceBag.capturedThroughSeq !== null
    && (!Number.isSafeInteger(surfaceBag.capturedThroughSeq) || (surfaceBag.capturedThroughSeq as number) < 0))
    || !Array.isArray(surfaceBag.events)) {
    return fail(REDLINE_ERROR.internal, 'source surface has no stable capture version')
  }
  const capturedThroughSeq = surfaceBag.capturedThroughSeq as number | null
  const surfaceEvents: unknown[] = surfaceBag.events
  let pairingEvents: readonly unknown[] = []
  const needsToolPairing = surfaceEvents.some(event => (
    event !== null && typeof event === 'object' && (event as { type?: unknown }).type === 'tool/result'
  ))
  if (needsToolPairing && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId)
      pairingEvents = snapshot.events.filter(event => (
        event !== null && typeof event === 'object' && (event as { type?: unknown }).type === 'tool/call'
      ))
    } catch (error) {
      return fail(REDLINE_ERROR.internal, `source log read failed: ${messageOf(error)}`)
    }
  }
  let capture
  try {
    capture = captureEventSourceSnapshot(sessionId, {
      sessionId: sourceHeaderId,
      capturedThroughSeq,
      events: [...pairingEvents, ...surfaceEvents] as SurfaceSnapshotEvent[],
    })
  } catch (error) {
    return fail(REDLINE_ERROR.internal, `source capture refused: ${messageOf(error)}`)
  }
  const candidates: ManifestCandidate[] = capture.candidates.map(candidate => ({
    sourceKey: candidate.sourceKey,
    cat: manifestCategory(candidate),
    sourceRole: candidate.sourceRole,
    order: candidate.order,
    text: candidate.text,
    ...(candidate.reasoning === undefined ? {} : { reasoning: candidate.reasoning }),
    ...(candidate.isError === undefined ? {} : { isError: candidate.isError }),
    ...(candidate.toolLink === undefined ? {} : { toolLink: candidate.toolLink }),
  }))
  const typeBySeq = new Map(capture.candidates.map(candidate => [candidate.sourceKey.seq, candidate.sourceKey.type]))
  const deletions = deletedSeqsOf(drafts.value).flatMap((seq) => {
    const type = typeBySeq.get(seq)
    return type === undefined ? [] : [eventSourceKeyOf({ kind: 'event', sourceSessionId: sessionId, seq, type })]
  })
  const manifest = buildManifest({
    sourceSessionId: sessionId,
    surfaceAsOfSeq: capture.capturedThroughSeq,
    surfaceFingerprint: capture.surfaceFingerprint,
    candidates,
    edits: drafts.value,
    deletions,
  })
  let prompt: string
  try { prompt = serializeManifestDelivery(humanTask, manifest.delivery) } catch {
    return redlineOk({
      operationId, draftRevision: draftRevisionOf(sessionId, drafts.value),
      surfaceFingerprint: capture.surfaceFingerprint, manifestFingerprint: manifest.manifestFingerprint,
      items: [], carriedSeqs: [], excludedSeqs: deletedSeqsOf(drafts.value), prompt: null, metrics: null,
      refusal: { code: REDLINE_ERROR.emptyTask, message: REDLINE_ERROR_MESSAGE[REDLINE_ERROR.emptyTask] },
    })
  }
  const agents = ctx.get('agents') as { get?: (id: string) => CarrierSourceAgentFace | undefined } | undefined
  const sourceAgent = agents?.get?.(sessionId)
  if (sourceAgent === undefined) return fail(REDLINE_ERROR.notLive)
  const config = confirmedConfigOf(ctx, sourceAgent)
  const cwd = sourceAgent.session?.header?.cwd
  if (config === null || cwd === undefined) return fail(REDLINE_ERROR.internal, 'source session configuration is incomplete')
  const registry = ctx.get('workspaceRegistry') as CarrierWorkspaceRegistryFace | undefined
  if (typeof registry?.resolveByPath !== 'function') return fail(REDLINE_ERROR.internal, 'workspace registry is unavailable')
  const workspace = await registry.resolveByPath(cwd)
  if (workspace === undefined) return fail(REDLINE_ERROR.internal, 'source workspace is unavailable')
  const ids = fixedCarrierIds(operationId)
  const executionInput: CarrierExecutionInput = {
    deliveryContent: prompt,
    contentFingerprint: stableFingerprint(prompt),
    workspaceId: workspace.id,
    cwd,
    confirmedConfig: config,
    returnConfig: config,
    returnConfigFingerprint: stableFingerprint(JSON.stringify(config)),
    attachments: [],
  }
  const task = humanTask.trim()
  const titleTask = task.replace(/\s+/g, ' ').slice(0, 48)
  const preview = createCarrierPreview({
    opId: operationId,
    carrierId: ids.carrierId,
    mainSessionId: sessionId,
    plannedTitle: `↳ ${sessionId.slice(-8)} · ${titleTask}`,
    surfaceAsOfSeq: capture.capturedThroughSeq,
    surfaceFingerprint: capture.surfaceFingerprint,
    manifestFingerprint: manifest.manifestFingerprint,
    promptRequestId: ids.promptRequestId,
    returnRequestId: ids.returnRequestId,
    previewExecutionInput: executionInput,
    previewDraftRevision: draftRevisionOf(sessionId, drafts.value),
  })
  const deleted = deletedSeqsOf(drafts.value)
  const items = [
    { label: '来源', text: `当前会话 ${sessionId}，捕获到 seq ${String(capture.capturedThroughSeq)}；确认前来源或草稿变化会要求重看。` },
    { label: '会带上的内容', text: `带 ${String(manifest.counts.carried)} 条；删除 ${String(manifest.counts.deleted)} 条；图片 ${String(capture.omittedImages)} 个未迁移。删除项和图片不会写进零历史新会话。` },
    { label: '第一句话（你来写）', text: task },
    { label: '新会话配置与回程', text: `工作区 ${workspace.id}；预设 ${config.agentPreset}；模型 ${config.provider}/${config.model}；任务结束后原样回到当前会话。` },
    { label: '取消', text: '取消就是什么都不发生：不建会话、不写任何会话日志。' },
  ]
  return redlineOk({
    operationId,
    draftRevision: preview.previewDraftRevision ?? '',
    surfaceFingerprint: capture.surfaceFingerprint,
    manifestFingerprint: manifest.manifestFingerprint,
    items,
    carriedSeqs: manifest.delivery.flatMap(entry => entry.sourceKey.kind === 'event' ? [entry.sourceKey.seq] : []),
    excludedSeqs: deleted,
    prompt,
    config: {
      agentPreset: config.agentPreset,
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort.startsWith('not-') ? {} : { reasoningEffort: config.reasoningEffort }),
    },
    metrics: firstTaskMetricsOf(prompt, manifest.counts.carried),
    refusal: null,
    preview,
  })
}

/**
 * Legacy read-only plan kept for clients that have not refreshed yet.
 */
const planChild: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null) return fail(REDLINE_ERROR.badRequest)
  const drafts = await readTable(ctx, sessionId)
  if (!drafts.ok) return drafts
  // `DraftTable` 是按 seq 键控的 Record（不是数组）⟹ 取值再按 seq 排序，顺序才稳定。
  // 带删除标记的记录**不投递**（`docs/03` R4.8：已编辑 + 已删除 ⟹ 正文仍保存、但不参与投递）；
  // 判据用 `isDeleted`（认 `deleted` 与旧镜像 `excluded`），不直接读裸字段。
  const carried = Object.values(drafts.value)
    .filter(entry => !isDeleted(drafts.value, entry.seq))
    .sort((a, b) => a.seq - b.seq)
  const edits = carried.map(entry => ({ seq: entry.seq, text: entry.text }))
  const excluded = deletedSeqsOf(drafts.value)
  const humanTask = typeof call.humanTask === 'string' ? call.humanTask : ''
  const first = buildFirstTask({ humanTask, edits, excluded })
  const position = '从最后聊完的那一轮开始'
  return redlineOk({
    items: forkConfirmItems({ position, humanTask, edits, excluded }),
    carriedSeqs: edits.map(e => e.seq),
    excludedSeqs: excluded,
    /** The exact local-draft set this confirmation reviewed; `child.start` rechecks it. */
    draftRevision: draftRevisionOf(sessionId, drafts.value),
    prompt: first.ok ? first.prompt : null,
    // M2-20：人点确认之前就该看得到这句话有多大（UTF-8 字节）与带了几条改动。
    metrics: first.ok ? firstTaskMetricsOf(first.prompt, edits.length) : null,
    refusal: first.ok ? null : { code: REDLINE_ERROR.emptyTask, message: first.message },
  })
}

/** Legacy fork write entry: stale clients must refresh and use `carrier.start`. */
const startChild: RedlineOpHandler = () => Promise.resolve(
  fail(REDLINE_ERROR.unknownOp, 'legacy child.start is retired; refresh and use carrier.start'),
)

function carrierControl(ctx: Context) {
  return redlineSessionControlFor(ctx)
}

/** Read-only ordinary-carrier preview. No session or ledger write occurs here. */
const planCarrier: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null) return fail(REDLINE_ERROR.badRequest)
  const turn = await turnStateOfSession(ctx, sessionId)
  if (!turn.known) return fail(REDLINE_ERROR.notLive)
  if (turn.open) return fail(REDLINE_ERROR.turnOpen)
  const humanTask = typeof call.humanTask === 'string' ? call.humanTask : ''
  const operationId = `redline-op-${randomUUID()}`
  const prepared = await prepareCarrierPlan(ctx, sessionId, humanTask, operationId)
  if (!prepared.ok) return prepared
  const { preview: _preview, ...wire } = prepared.value
  return redlineOk({
    ...wire,
    draftRevision: encodeCarrierConfirmation({
      operationId: wire.operationId,
      draftRevision: wire.draftRevision,
      surfaceFingerprint: wire.surfaceFingerprint,
      manifestFingerprint: wire.manifestFingerprint,
      taskFingerprint: stableFingerprint(typeof call.humanTask === 'string' ? call.humanTask.trim() : ''),
    }),
  })
}

async function advanceCarrierStore(
  store: ReturnType<typeof createRedlineCarrierStore>,
  opId: string,
  target: 'creating' | 'created' | 'prompted' | 'running',
): Promise<CarrierOperation> {
  return await store.mutate(opId, current => current.taskState === target ? current : transitionCarrierTask(current, target))
}

/** Confirm and execute the exact preview as one ordinary root session. */
const startCarrier: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  const confirmation = decodeCarrierConfirmation(call.confirmationToken)
  const humanTask = typeof call.humanTask === 'string' ? call.humanTask : ''
  if (sessionId === null || confirmation === null) return fail(REDLINE_ERROR.badRequest)
  const {
    operationId,
    draftRevision: expectedDraft,
    surfaceFingerprint: expectedSurface,
    manifestFingerprint: expectedManifest,
    taskFingerprint: expectedTask,
  } = confirmation
  if (humanTask.trim() === '') return fail(REDLINE_ERROR.emptyTask)
  if (stableFingerprint(humanTask.trim()) !== expectedTask) return fail(REDLINE_ERROR.draftsChanged)
  const turn = await turnStateOfSession(ctx, sessionId)
  if (!turn.known) return fail(REDLINE_ERROR.notLive)
  if (turn.open) return fail(REDLINE_ERROR.turnOpen)
  return await withSessionLock(sessionId, async () => {
    const store = createRedlineCarrierStore(ctx)
    const existing = await store.read(operationId)
    let operation: CarrierOperation
    let carriedSeqs: readonly number[] = []
    if (existing.ok && existing.operation.taskState !== 'previewed') {
      // Confirmation has crossed the atomic authorization boundary. Recovery/retry must replay those frozen bytes,
      // never re-read current drafts or demand that the source still matches.
      operation = existing.operation
      if (operation.mainSessionId !== sessionId || operation.manifestFingerprint !== expectedManifest) {
        return fail(REDLINE_ERROR.internal, 'carrier operation identity mismatch')
      }
    } else {
      const prepared = await prepareCarrierPlan(ctx, sessionId, humanTask, operationId)
      if (!prepared.ok) return prepared
      const freshPreview = prepared.value.preview
      if (freshPreview === undefined || freshPreview.previewExecutionInput === undefined) {
        return fail(REDLINE_ERROR.internal, 'carrier preview is incomplete')
      }
      if (prepared.value.draftRevision !== expectedDraft || prepared.value.surfaceFingerprint !== expectedSurface
        || prepared.value.manifestFingerprint !== expectedManifest) return fail(REDLINE_ERROR.draftsChanged)
      carriedSeqs = prepared.value.carriedSeqs
      const preview = existing.ok ? existing.operation : freshPreview
      if (!existing.ok) {
        if (existing.code !== 'missing') return fail(REDLINE_ERROR.internal, existing.message)
        await store.write(preview)
      }
      if (preview.previewExecutionInput === undefined) return fail(REDLINE_ERROR.internal, 'carrier preview input is missing')
      const requestedText = typeof call.finalText === 'string' ? call.finalText : preview.previewExecutionInput.deliveryContent
      if (requestedText.trim() === '') return fail(REDLINE_ERROR.emptyTask)
      const requestedConfig = call.config !== null && typeof call.config === 'object'
        ? call.config as Record<string, unknown>
        : null
      let confirmedConfig = preview.previewExecutionInput.confirmedConfig
      if (requestedConfig !== null) {
        const provider = typeof requestedConfig.provider === 'string' ? requestedConfig.provider.trim() : ''
        const model = typeof requestedConfig.model === 'string' ? requestedConfig.model.trim() : ''
        const reasoningEffort = typeof requestedConfig.reasoningEffort === 'string' ? requestedConfig.reasoningEffort.trim() : undefined
        if (provider === '' || model === '') return fail(REDLINE_ERROR.badRequest)
        const llm = ctx.get('llm') as CarrierLlmDirectoryFace | undefined
        if (llm === undefined) return fail(REDLINE_ERROR.internal, 'model directory is unavailable')
        let info: Awaited<ReturnType<CarrierLlmDirectoryFace['resolveModelInfo']>>
        try { info = await llm.resolveModelInfo(provider, model) } catch { return fail(REDLINE_ERROR.badRequest, 'selected model is unavailable') }
        if (reasoningEffort !== undefined && !info.reasoning?.efforts.some(level => level.id === reasoningEffort)) {
          return fail(REDLINE_ERROR.badRequest, 'selected reasoning effort is unavailable')
        }
        confirmedConfig = {
          ...confirmedConfig,
          provider,
          model,
          // “模型默认值” is resolved once and frozen, so post-create config verification compares exact values.
          reasoningEffort: reasoningEffort ?? info.reasoning?.defaultEffort ?? 'not-specified',
          inheritedFrom: 'confirmation-selection',
        }
      }
      const executionInput: CarrierExecutionInput = {
        ...preview.previewExecutionInput,
        deliveryContent: requestedText,
        contentFingerprint: stableFingerprint(requestedText),
        confirmedConfig,
      }
      operation = authorizeCarrier(preview, {
        userConfirmedAt: new Date().toISOString(),
        manifestFingerprint: preview.manifestFingerprint,
        configFingerprint: stableFingerprint(JSON.stringify(confirmedConfig)),
        sourceSessionId: sessionId,
        returnSessionId: sessionId,
      }, executionInput)
      await store.write(operation)
    }

    const input = operation.executionInput
    if (input === undefined) return fail(REDLINE_ERROR.internal, 'carrier execution input is missing')
    if (operation.taskState === 'authorized') operation = await advanceCarrierStore(store, operationId, 'creating')
    const request: CarrierSessionRequest = {
      carrierId: operation.carrierId,
      workspaceId: input.workspaceId,
      cwd: input.cwd ?? '',
      title: operation.plannedTitle,
      agentPreset: input.confirmedConfig.agentPreset,
      agentOptions: {
        provider: input.confirmedConfig.provider,
        model: input.confirmedConfig.model,
        ...(input.confirmedConfig.reasoningEffort.startsWith('not-') ? {} : { reasoningEffort: input.confirmedConfig.reasoningEffort }),
      },
      promptRequestId: operation.promptRequestId,
      promptText: input.deliveryContent,
    }
    if (request.cwd === '') return fail(REDLINE_ERROR.internal, 'carrier cwd is missing')
    const control = carrierControl(ctx)
    const result = await control.start(request)
    if (!result.ok) return fail(REDLINE_ERROR.internal, `carrier start held: ${result.cause}`)
    if (operation.titleStatus === 'pending') {
      operation = await store.mutate(operationId, current => setTitleStatus(current, result.titleStatus))
    }
    if (operation.taskState === 'creating') operation = await advanceCarrierStore(store, operationId, 'created')
    if (operation.taskState === 'created') operation = await advanceCarrierStore(store, operationId, 'prompted')
    if (operation.taskState === 'prompted') operation = await advanceCarrierStore(store, operationId, 'running')
    const owned = control.handles.get(operation.carrierId)?.agent
      ?? (ctx.get('agents') as { get?: (id: string) => { whenIdle?(): Promise<void> } | undefined } | undefined)?.get?.(operation.carrierId)
    if (owned !== undefined) {
      void runCarrierToReturn(ctx, operationId, owned, store, control)
        .catch((error: unknown) => { ctx.logger.warn('dsh-context-redline: carrier return failed (' + messageOf(error) + ')') })
    }
    return redlineOk({
      operationId,
      carrierId: operation.carrierId,
      label: operation.plannedTitle,
      prompt: input.deliveryContent,
      carriedSeqs,
      started: { sessionId: operation.carrierId, mode: result.mode, messageId: result.messageId },
      via: 'ordinary-session',
    })
  })
}

/**
 * M5-13 的分母：这台机器允许几个团队成员（`src/shared/redline-capacity.ts`）。
 *
 * **只读、且不做任何写入**：从活服务上防御性读 `config.maxMembers`（TS-private 的普通属性），
 * 读不到就如实答 `{known:false,max:null}` —— 界面那时只写 `活跃 N`，**绝不编一个分母**
 * （库默认是 16、本机 profile 配的是 8，写死哪个都会在另一种部署上变成假话，`docs/01` F31）。
 */
const readCapacity: RedlineOpHandler = ({ ctx }) =>
  Promise.resolve(redlineOk(capacityFromService(ctx.get('agentTeams'))))

interface CarrierLlmDirectoryFace {
  listProviders(): readonly { readonly id: string; readonly name: string }[]
  listModels(provider: string): Promise<readonly { readonly id: string; readonly name: string }[]>
  resolveModelInfo(provider: string, model: string): Promise<{
    readonly reasoning?: {
      readonly efforts: readonly { readonly id: string; readonly name: string }[]
      readonly defaultEffort?: string
    }
  }>
}

/** Read the live model catalog without changing any session or global default. */
const readCarrierModels: RedlineOpHandler = async ({ ctx }) => {
  const llm = ctx.get('llm') as CarrierLlmDirectoryFace | undefined
  if (llm === undefined) return fail(REDLINE_ERROR.internal, 'model directory is unavailable')
  const groups = await Promise.all(llm.listProviders().map(async (provider) => {
    let listed: readonly { readonly id: string; readonly name: string }[]
    try { listed = await llm.listModels(provider.id) } catch { return [] }
    return await Promise.all(listed.map(async (model) => {
      let reasoning: Awaited<ReturnType<CarrierLlmDirectoryFace['resolveModelInfo']>>['reasoning']
      try { reasoning = (await llm.resolveModelInfo(provider.id, model.id)).reasoning } catch { reasoning = undefined }
      return {
        provider: provider.id,
        providerName: provider.name,
        model: model.id,
        modelName: model.name,
        efforts: reasoning?.efforts ?? [],
        ...(reasoning?.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort }),
      }
    }))
  }))
  return redlineOk({ models: groups.flat() })
}

/** Ordinary carrier sessions opened from one source session, from our strict operation ledger. */
const readCarriers: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null) return fail(REDLINE_ERROR.badRequest)
  const store = createRedlineCarrierStore(ctx)
  const rows: { id: string; label: string; mode: 'continuable'; createdAt: number; via: 'ordinary-session' }[] = []
  for (const opId of await store.listOperationIds()) {
    const read = await store.read(opId)
    if (!read.ok || read.operation.mainSessionId !== sessionId
      || read.operation.taskState === 'previewed' || read.operation.taskState === 'authorized'
      || read.operation.taskState === 'creating') continue
    rows.push({
      id: read.operation.carrierId,
      label: read.operation.titleStatus === 'failed'
        ? `${read.operation.plannedTitle}（命名失败；左侧可能显示默认标题）`
        : read.operation.plannedTitle,
      mode: 'continuable',
      createdAt: Date.parse(read.operation.authorization?.userConfirmedAt ?? '') || 0,
      via: 'ordinary-session',
    })
  }
  rows.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
  return redlineOk({ rows })
}

/**
 * 我们自己那本"来源台账"（M5-12）。**只读**，只碰我们自己的数据目录。
 *
 * 三种诚实态（`src/shared/redline-origins.ts` 的注释里有完整理由）：
 * `{records: [...]}` = 台账可读 · `{records: []}` = 确实没在这条会话里开过 ·
 * `{records: null, error: <码>}` = **台账读不出来**（界面必须说"来源未知"，不许说"没记录"）。
 */
const readOrigins: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null) return fail(REDLINE_ERROR.badRequest)
  const dir = dataDirOf(ctx)
  if (dir === null) return fail(REDLINE_ERROR.internal, 'the harness home is not available')
  let raw: string | null = null
  try {
    raw = await readFile(join(dir, originsFileName(sessionId)), 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      return fail(REDLINE_ERROR.internal, error instanceof Error ? error.message : String(error))
    }
  }
  const parsed = parseOrigins(raw, sessionId)
  if (!parsed.ok) return redlineOk({ records: null, error: parsed.code })
  return redlineOk({ records: parsed.records })
}

/**
 * The op table. M2's entries; M3/M5 add theirs here and nowhere else.
 */
const OPS = new Map<string, RedlineOpHandler>([
  ['node.read', readRow],
  ['turnState', readTurnState],
  ['draft.list', listDrafts],
  ['draft.update', updateDraft],
  ['draft.drop', dropDraft],
  ['draft.exclude', excludeDraft],
  ['child.capacity', readCapacity],
  ['child.origins', readOrigins],
  ['child.plan', planChild],
  ['child.start', startChild],
  ['carrier.plan', planCarrier],
  ['carrier.start', startCarrier],
  ['carrier.list', readCarriers],
  ['carrier.models', readCarrierModels],
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
