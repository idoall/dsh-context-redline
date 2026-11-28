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

import { access, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { currentModelSelection, type RedlineModelAgent } from './redline-model-selection'
import { REDLINE_ERROR, REDLINE_ERROR_MESSAGE, isRedlineErrorCode } from '../shared/redline-errors'
import type { SupervisorSummary } from '../shared/redline-supervisor'
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
import { anchorRequestFingerprint, anchorTitle, composeAnchor, type AnchorDraft } from '../shared/redline-anchor'
import { markFirstMessageDelivered, prepareGuardRun, recordActiveExecutor } from './goal-supervisor/create'
import { effectiveCwdOf } from './effective-cwd'
import { repoFacts } from './goal-supervisor/git'
import { SAFE_RUN_ID as SAFE_RUN_ID_OF_RUN } from './goal-supervisor/run-id'
import { routeLabel } from './goal-supervisor/evaluator'
import { findSupervisorRun, recallSupervisorRun } from './goal-supervisor/status'
import { rollbackRun } from './goal-supervisor/rollback'
import { canResume, resumeBlockedRun } from './goal-supervisor/loop'
import { GuardStore } from './goal-supervisor/store'
import { isBroadScopePath, isSafeScopePath, normalizeScopePath } from './goal-supervisor/scope'
import { attachedSupervisorFor, resumeSupervisorGoal, type SupervisorAgent } from './goal-supervisor/attach'
import type { ProbeDef } from './goal-supervisor/schema'
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

/** The supervisor mount index directory, or null when the harness home is absent. */
function supervisorIndexDirOf(ctx: Context): string | null {
  const dir = dataDirOf(ctx)
  return dir === null ? null : join(dir, 'supervisor')
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

interface CarrierSourceAgentFace extends RedlineModelAgent {
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


/** Optional human-written anchor: kept short, trimmed, and mirrored head+tail. */
const CARRIER_ANCHOR_LIMIT = 2000

/** A supervisor run id becomes a path segment; shared with the module that mints them. */
const SAFE_RUN_ID = SAFE_RUN_ID_OF_RUN

/** True for a run id the ledger and the filesystem can both accept. */
function isSafeRunId(value: string): boolean {
  return value !== '' && value.length <= 50 && SAFE_RUN_ID.test(value)
}

/** Read the optional anchor; `null` means an unusable value (bad request). */
/** Deterministic identities for one anchored conversation request. */
function anchoredIds(operationId: string) {
  const suffix = stableFingerprint(operationId)
  return {
    sessionId: `session-anchor-${suffix.slice(0, 24)}`,
    promptRequestId: `anchor-prompt-${suffix.slice(24, 48)}`,
  }
}

/** Read the four human-written fields; `null` means a non-string arrived. */
function anchorDraftOf(call: RedlineCall): AnchorDraft | null {
  const values: string[] = []
  for (const key of ['task', 'goal', 'acceptance', 'discipline'] as const) {
    const value = call[key]
    if (typeof value !== 'string') return null
    values.push(value)
  }
  return { task: values[0] ?? '', goal: values[1] ?? '', acceptance: values[2] ?? '', discipline: values[3] ?? '' }
}

interface AnchorSource {
  readonly agent: CarrierSourceAgentFace
  readonly cwd: string
  readonly workspaceId: string
  readonly config: CarrierConfirmedConfig
}

/** True when `cwd` points at one of this plugin's ungrouped supervisor worktrees. */
function isSupervisorWorktreeCwd(cwd: string): boolean {
  return /[\\/]\.guard[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(cwd)
}

/** Fail clearly when the source session has no registered DSH workspace. */
function missingSourceWorkspaceError(cwd: string): RedlineEnvelope<never> {
  if (isSupervisorWorktreeCwd(cwd)) {
    return fail(
      REDLINE_ERROR.badRequest,
      'source session runs in an ungrouped worktree; switch to the main workspace session to start a new conversation',
    )
  }
  return fail(REDLINE_ERROR.internal, 'source workspace is unavailable')
}

/** Resolve the source session's config/workspace without reading or writing its context. */
async function resolveAnchorSource(
  ctx: Context,
  sessionId: string,
): Promise<{ ok: true; source: AnchorSource } | { ok: false; envelope: RedlineEnvelope<never> }> {
  const agents = ctx.get('agents') as { get?: (id: string) => CarrierSourceAgentFace | undefined } | undefined
  const agent = agents?.get?.(sessionId)
  if (agent === undefined) return { ok: false, envelope: fail(REDLINE_ERROR.notLive) }
  const config = confirmedConfigOf(ctx, agent)
  const cwd = agent.session?.header?.cwd
  if (config === null || cwd === undefined) {
    return { ok: false, envelope: fail(REDLINE_ERROR.internal, 'source session configuration is incomplete') }
  }
  const registry = ctx.get('workspaceRegistry') as CarrierWorkspaceRegistryFace | undefined
  if (typeof registry?.resolveByPath !== 'function') {
    return { ok: false, envelope: fail(REDLINE_ERROR.internal, 'workspace registry is unavailable') }
  }
  const workspace = await registry.resolveByPath(cwd)
  if (workspace === undefined) return { ok: false, envelope: missingSourceWorkspaceError(cwd) }
  return { ok: true, source: { agent, cwd, workspaceId: workspace.id, config } }
}

/** Turn gate shared by the read-only plan and the write. */
async function anchorGate(ctx: Context, sessionId: string): Promise<RedlineEnvelope<never> | null> {
  const turn = await turnStateOfSession(ctx, sessionId)
  if (!turn.known) return fail(REDLINE_ERROR.notLive)
  if (turn.open) return fail(REDLINE_ERROR.turnOpen)
  return null
}

/**
 * Refuse a guard write whose run record belongs to another session.
 *
 * `guard.rollback` already checked this; `continue` / `switch` did not, so a
 * mistyped run id let one session edit another session's ledger while acting on
 * its own agent and goal. Called INSIDE the session lock: the record can be
 * bound between the outer read and the write.
 */
async function ownershipGate(store: GuardStore, sessionId: string): Promise<RedlineEnvelope<never> | null> {
  let meta: Awaited<ReturnType<GuardStore['readMeta']>>
  try {
    meta = await store.readMeta()
  } catch (error) {
    return fail(REDLINE_ERROR.internal, error instanceof Error ? error.message : 'run meta is unreadable')
  }
  // A missing record is NOT "no owner": the caller is about to write a ledger
  // it cannot attribute. Passing here let `guard.switch` persist a route into a
  // run whose mount record was gone.
  if (meta === null) {
    return fail(REDLINE_ERROR.badRequest, '运行记录缺失：run.json 不存在或已被删除，已拒绝写入')
  }
  if (meta.sessionId !== undefined && meta.sessionId !== sessionId) {
    return fail(REDLINE_ERROR.badRequest, '归属不符：该 run 属于另一个会话，已拒绝写入')
  }
  return null
}

/** Read-only anchored-conversation preview; no session or ledger write. */
const anchorPlan: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null) return fail(REDLINE_ERROR.badRequest)
  const gate = await anchorGate(ctx, sessionId)
  if (gate !== null) return gate
  const draft = anchorDraftOf(call)
  if (draft === null) return fail(REDLINE_ERROR.badRequest)
  let composed
  try { composed = composeAnchor(draft) } catch { return fail(REDLINE_ERROR.badRequest, 'anchor fields are incomplete') }
  const resolved = await resolveAnchorSource(ctx, sessionId)
  if (!resolved.ok) return resolved.envelope
  const { config, cwd, workspaceId } = resolved.source
  return redlineOk({
    snapshot: composed.text,
    snapshotFingerprint: composed.fingerprint,
    requestFingerprint: anchorRequestFingerprint(draft),
    title: anchorTitle(draft),
    workspaceId,
    // The dialog shows this read-only: the probes and every relative path of
    // the new run resolve against it, so a handoff written for another repo is
    // visible before the human confirms instead of after the first probe fails.
    cwd,
    config: {
      agentPreset: config.agentPreset,
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort.startsWith('not-') ? {} : { reasoningEffort: config.reasoningEffort }),
    },
  })
}

/** Create one ordinary root conversation with the frozen runtime snapshot; no return path. */
const anchorStart: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  const operationId = typeof call.operationId === 'string' ? call.operationId.trim() : ''
  if (sessionId === null || operationId === '' || operationId.length > 200) return fail(REDLINE_ERROR.badRequest)
  const gate = await anchorGate(ctx, sessionId)
  if (gate !== null) return gate
  const draft = anchorDraftOf(call)
  if (draft === null) return fail(REDLINE_ERROR.badRequest)
  let composed
  try { composed = composeAnchor(draft) } catch { return fail(REDLINE_ERROR.badRequest, 'anchor fields are incomplete') }
  if (call.snapshotFingerprint !== composed.fingerprint
    || call.requestFingerprint !== anchorRequestFingerprint(draft)) return fail(REDLINE_ERROR.draftsChanged)
  const resolved = await resolveAnchorSource(ctx, sessionId)
  if (!resolved.ok) return resolved.envelope
  const { config: baseConfig, cwd: sourceCwd, workspaceId: sourceWorkspaceId } = resolved.source
  const guardRunId = typeof call.guardRunId === 'string' ? call.guardRunId.trim() : ''
  if (guardRunId !== '' && !isSafeRunId(guardRunId)) {
    return fail(REDLINE_ERROR.badRequest, 'run id is invalid')
  }
  const requestedWorktree = typeof call.guardWorktreePath === 'string' ? call.guardWorktreePath.trim() : ''
  let runCwd = ''
  if (requestedWorktree !== '') {
    if (guardRunId === '') return fail(REDLINE_ERROR.badRequest, 'worktree requires a supervisor run id')
    // Only this run's own worktree, compared after `realpath`, so neither `..`
    // nor a symlink can point the new session at an unrelated checkout.
    const expected = join(sourceCwd, '.guard', 'worktrees', guardRunId)
    try {
      const resolvedWorktree = await realpath(requestedWorktree)
      const resolvedExpected = await realpath(expected)
      if (resolvedWorktree !== resolvedExpected) {
        return fail(REDLINE_ERROR.badRequest, 'worktree does not belong to this run')
      }
      await access(join(resolvedWorktree, '.git'))
      await access(join(resolvedWorktree, 'docs', 'guard', guardRunId))
    } catch {
      return fail(REDLINE_ERROR.badRequest, 'worktree is unavailable')
    }
    // Always store the canonical path under `sourceCwd` rather than raw client spelling.
    runCwd = expected
  }
  const rawPermission = call.permissionPreset
  if (rawPermission !== undefined && rawPermission !== 'danger-full-access') {
    return fail(REDLINE_ERROR.badRequest, 'permission preset is invalid')
  }
  const permissionPreset = rawPermission === 'danger-full-access' ? rawPermission : undefined
  // A worktree run keeps its own checkout. It never gets a workspace of its own:
  // the header stays on the source project (which is what DSH groups the sidebar
  // by) and only the effective directory moves — see the `projectCwd` field.
  if (runCwd === '' && guardRunId !== '') {
    // Check both checkout roots when `guardWorktreePath` is omitted: a stale
    // worktree must never silently hijack a main-workspace run, and a fallback
    // candidate must pass the same `.git` + realpath boundary check.
    let hasSourceLedger = true
    try { await access(join(sourceCwd, 'docs', 'guard', guardRunId)) } catch { hasSourceLedger = false }
    const worktreesRoot = join(sourceCwd, '.guard', 'worktrees')
    const candidate = join(worktreesRoot, guardRunId)
    let hasWorktreeLedger = false
    try {
      const resolvedRoot = await realpath(worktreesRoot)
      const resolvedCandidate = await realpath(candidate)
      if (resolvedCandidate === join(resolvedRoot, guardRunId)) {
        await access(join(resolvedCandidate, '.git'))
        await access(join(resolvedCandidate, 'docs', 'guard', guardRunId))
        hasWorktreeLedger = true
      }
    } catch { /* not a valid worktree run */ }
    if (hasSourceLedger && hasWorktreeLedger) {
      return fail(REDLINE_ERROR.badRequest, 'supervisor run exists in both workspace and worktree; specify guardWorktreePath')
    }
    if (!hasSourceLedger && !hasWorktreeLedger) {
      return fail(REDLINE_ERROR.badRequest, 'supervisor run is missing')
    }
    if (hasWorktreeLedger) runCwd = candidate
  }
  const cwd = runCwd === '' ? sourceCwd : runCwd
  // A worktree run keeps the SOURCE project as its header directory: DSH groups
  // the sidebar by `header.cwd === workspace.path`, and the plugin must never
  // register the run directory as a workspace of its own. The session is moved
  // into the checkout through the Host working-directory service instead, so it
  // stays grouped under the project the run belongs to.
  const workspaceId = sourceWorkspaceId
  let config = baseConfig
  const requested = call.config !== null && typeof call.config === 'object'
    ? call.config as Record<string, unknown>
    : null
  if (requested !== null) {
    const provider = typeof requested.provider === 'string' ? requested.provider.trim() : ''
    const model = typeof requested.model === 'string' ? requested.model.trim() : ''
    const reasoningEffort = typeof requested.reasoningEffort === 'string' ? requested.reasoningEffort.trim() : undefined
    if (provider === '' || model === '') return fail(REDLINE_ERROR.badRequest)
    const llm = ctx.get('llm') as CarrierLlmDirectoryFace | undefined
    if (llm === undefined) return fail(REDLINE_ERROR.internal, 'model directory is unavailable')
    let info: Awaited<ReturnType<CarrierLlmDirectoryFace['resolveModelInfo']>>
    try { info = await llm.resolveModelInfo(provider, model) } catch { return fail(REDLINE_ERROR.badRequest, 'selected model is unavailable') }
    if (reasoningEffort !== undefined && !info.reasoning?.efforts.some(level => level.id === reasoningEffort)) {
      return fail(REDLINE_ERROR.badRequest, 'selected reasoning effort is unavailable')
    }
    config = {
      ...config,
      provider,
      model,
      reasoningEffort: reasoningEffort ?? info.reasoning?.defaultEffort ?? 'not-specified',
      inheritedFrom: 'confirmation-selection',
    }
  }
  const ids = anchoredIds(operationId)
  const title = anchorTitle(draft)
  const control = carrierControl(ctx)
  if (guardRunId !== '') {
    // Validate the run BEFORE touching its ledger: a missing record, a run
    // already mounted by another session, or a finished run must not have its
    // `activeExecutor` rewritten by a start that will then fail (or by a second
    // start reusing the id). A retry of THIS operation is allowed: its
    // deterministic carrier id is exactly what the run was bound to.
    const store = new GuardStore(join(cwd, 'docs', 'guard', guardRunId))
    let meta: Awaited<ReturnType<GuardStore['readMeta']>>
    try {
      meta = await store.readMeta()
    } catch (error) {
      return fail(REDLINE_ERROR.internal, error instanceof Error ? error.message : 'run meta is unreadable')
    }
    if (meta === null) return fail(REDLINE_ERROR.badRequest, 'supervisor run is missing')
    if (meta.sessionId !== undefined && meta.sessionId !== ids.sessionId) {
      return fail(REDLINE_ERROR.badRequest, 'supervisor run is already mounted by another session; refusing to reuse it')
    }
    if (meta.sessionId === undefined && meta.phase !== 'ready' && meta.phase !== 'setup-failed') {
      return fail(REDLINE_ERROR.badRequest, `supervisor run is not startable (phase: ${meta.phase})`)
    }
    // Freeze the route BEFORE the session exists. The first turn's audit reads
    // `run.json` and writes the ledger back; recording this after `start()`
    // raced that audit, which could erase `activeExecutor` with its own snapshot.
    await recordActiveExecutor(cwd, guardRunId, {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort.startsWith('not-') ? {} : { reasoningEffort: config.reasoningEffort }),
    }).catch(() => undefined)
  }
  const result = await control.start({
    carrierId: ids.sessionId,
    cwd,
    agentPreset: config.agentPreset,
    agentOptions: {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort.startsWith('not-') ? {} : { reasoningEffort: config.reasoningEffort }),
    },
    workspaceId,
    ...(runCwd === '' ? {} : { projectCwd: sourceCwd }),
    title,
    promptRequestId: ids.promptRequestId,
    promptText: draft.task.trim(),
    runtimeAnchor: composed.text,
    ...(guardRunId === '' ? {} : { guardRunId }),
    ...(permissionPreset === undefined ? {} : { permissionPreset }),
  })
  if (!result.ok) return fail(REDLINE_ERROR.internal, `anchor start held: ${result.cause}`)
  if (guardRunId !== '') {
    // The supervisor ledger says whether the first task ever arrived; a fire-and-
    // forget write keeps the response fast while still recording it.
    await markFirstMessageDelivered(cwd, guardRunId).catch(() => undefined)
  }
  return redlineOk({
    sessionId: ids.sessionId,
    title,
    mode: result.mode,
    delivery: result.delivery,
    messageId: result.messageId,
  })
}

function carrierAnchorOf(call: RedlineCall): string | null {
  const raw = call.anchor
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > CARRIER_ANCHOR_LIMIT ? null : trimmed
}

/** Optional anchor delivery mode: inside the first message, or as a runtime rule. */
type CarrierAnchorMode = 'message' | 'runtime'

/** Read the optional mode; `null` means an unusable value. Defaults to the first message. */
function carrierAnchorModeOf(call: RedlineCall): CarrierAnchorMode | null {
  const raw = call.anchorMode
  if (raw === undefined || raw === null) return 'message'
  return raw === 'message' || raw === 'runtime' ? raw : null
}

/** Confirmation fingerprint over the task, anchor and delivery mode. */
function carrierTaskFingerprint(task: string, anchor: string, mode: CarrierAnchorMode = 'message'): string {
  if (mode === 'runtime') return stableFingerprint(`${task}\u0000runtime\u0000${anchor}`)
  return stableFingerprint(anchor === '' ? task : `${task}\u0000${anchor}`)
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
  const selection = currentModelSelection(agent)
  const provider = selection?.provider
  const model = selection?.model
  const presets = ctx.get('agentPresets') as {
    presetForSession?(session: unknown): string | null
    composedPreset?(agentCtx: Context): string | undefined
  } | undefined
  const preset = typeof presets?.presetForSession === 'function' && agent.session !== undefined
    ? presets.presetForSession(agent.session)
    : agent.ctx !== undefined && typeof presets?.composedPreset === 'function'
      ? presets.composedPreset(agent.ctx)
      : agent.session?.header?.agentPreset
  if (provider === undefined || model === undefined || preset === undefined || preset === null) return null
  return {
    agentPreset: preset,
    provider,
    model,
    reasoningEffort: selection?.reasoningEffort ?? 'not-specified',
    inheritedFrom: 'source-session-explicit-config',
  }
}

async function prepareCarrierPlan(
  ctx: Context,
  sessionId: string,
  humanTask: string,
  operationId = `redline-op-${randomUUID()}`,
  anchor = '',
  anchorMode: CarrierAnchorMode = 'message',
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
  try { prompt = serializeManifestDelivery(humanTask, manifest.delivery, anchorMode === 'runtime' ? '' : anchor) } catch {
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
  if (workspace === undefined) return missingSourceWorkspaceError(cwd)
  const ids = fixedCarrierIds(operationId)
  const executionInput: CarrierExecutionInput = {
    deliveryContent: prompt,
    contentFingerprint: stableFingerprint(prompt),
    workspaceId: workspace.id,
    cwd,
    confirmedConfig: config,
    returnConfig: config,
    returnConfigFingerprint: stableFingerprint(JSON.stringify(config)),
    ...(anchorMode === 'runtime' ? { runtimeAnchor: anchor, runtimeAnchorFingerprint: stableFingerprint(anchor) } : {}),
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
    ...(anchor === ''
      ? []
      : anchorMode === 'runtime'
        ? [{ label: '运行时规则（每次请求前提供）', text: anchor }]
        : [{ label: '锚点（首尾各一次）', text: anchor }]),
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
  const anchor = carrierAnchorOf(call)
  const anchorMode = carrierAnchorModeOf(call)
  if (anchor === null || anchorMode === null) return fail(REDLINE_ERROR.badRequest, 'anchor is too long')
  if (anchorMode === 'runtime' && anchor === '') return fail(REDLINE_ERROR.badRequest, 'runtime anchor is empty')
  const operationId = `redline-op-${randomUUID()}`
  const prepared = await prepareCarrierPlan(ctx, sessionId, humanTask, operationId, anchor, anchorMode)
  if (!prepared.ok) return prepared
  const { preview: _preview, ...wire } = prepared.value
  return redlineOk({
    ...wire,
    draftRevision: encodeCarrierConfirmation({
      operationId: wire.operationId,
      draftRevision: wire.draftRevision,
      surfaceFingerprint: wire.surfaceFingerprint,
      manifestFingerprint: wire.manifestFingerprint,
      taskFingerprint: carrierTaskFingerprint(typeof call.humanTask === 'string' ? call.humanTask.trim() : '', anchor, anchorMode),
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
  const anchor = carrierAnchorOf(call)
  const anchorMode = carrierAnchorModeOf(call)
  if (sessionId === null || confirmation === null || anchor === null || anchorMode === null) return fail(REDLINE_ERROR.badRequest)
  if (anchorMode === 'runtime' && anchor === '') return fail(REDLINE_ERROR.badRequest, 'runtime anchor is empty')
  const {
    operationId,
    draftRevision: expectedDraft,
    surfaceFingerprint: expectedSurface,
    manifestFingerprint: expectedManifest,
    taskFingerprint: expectedTask,
  } = confirmation
  if (humanTask.trim() === '') return fail(REDLINE_ERROR.emptyTask)
  if (carrierTaskFingerprint(humanTask.trim(), anchor, anchorMode) !== expectedTask) return fail(REDLINE_ERROR.draftsChanged)
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
      const prepared = await prepareCarrierPlan(ctx, sessionId, humanTask, operationId, anchor, anchorMode)
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
      ...(input.runtimeAnchor === undefined ? {} : { runtimeAnchor: input.runtimeAnchor }),
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
    /** Declared input modalities; absent means "unknown", not "text only". */
    readonly inputModalities?: readonly string[]
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


/** Validate an optional dedicated evaluator model route `{ provider, model, reasoningEffort? }`. */
function evaluatorOf(
  raw: unknown,
): { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const bag = raw as { readonly provider?: unknown; readonly model?: unknown; readonly reasoningEffort?: unknown }
  const provider = typeof bag.provider === 'string' ? bag.provider.trim() : ''
  const model = typeof bag.model === 'string' ? bag.model.trim() : ''
  if (provider === '' || model === '' || provider.length > 120 || model.length > 200) return null
  if (bag.reasoningEffort !== undefined && typeof bag.reasoningEffort !== 'string') return null
  const reasoningEffort = typeof bag.reasoningEffort === 'string' ? bag.reasoningEffort.trim() : ''
  if (reasoningEffort.length > 64) return null
  return {
    provider,
    model,
    ...(reasoningEffort === '' ? {} : { reasoningEffort }),
  }
}

/** Read the supervisor-prepare fields; `null` means unusable. */
function prepareInputOf(call: RedlineCall, draft: AnchorDraft) {
  const tasks = typeof call.tasks === 'string' ? call.tasks : ''
  if (tasks.trim() === '') return null
  const parallel = typeof call.parallel === 'number' && Number.isFinite(call.parallel) ? call.parallel : undefined
  const milestoneEvery = typeof call.milestoneEvery === 'number' && Number.isFinite(call.milestoneEvery)
    ? call.milestoneEvery
    : undefined
  const runId = typeof call.runId === 'string' && call.runId.trim() !== '' ? call.runId.trim() : undefined
  const scopes = scopesOf(call.scopes)
  if (call.scopes !== undefined && scopes === undefined) return null
  const probes = probesOf(call.probes)
  if (call.probes !== undefined && probes === undefined) return null
  const evaluator = evaluatorOf(call.evaluator)
  if (evaluator === null) return null
  const evaluatorFallback = evaluatorOf(call.evaluatorFallback)
  if (evaluatorFallback === null) return null
  const executor = evaluatorOf(call.executor)
  if (executor === null) return null
  const executorFallback = evaluatorOf(call.executorFallback)
  if (executorFallback === null) return null
  const visual = visualOf(call.visual)
  if (visual === null) return null
  return {
    goal: draft.goal,
    acceptance: draft.acceptance,
    discipline: draft.discipline,
    tasks,
    ...(parallel === undefined ? {} : { parallel }),
    ...(call.enforcement === 'enforce' ? { enforcement: 'enforce' as const } : {}),
    ...(milestoneEvery === undefined ? {} : { milestoneEvery }),
    ...(runId === undefined ? {} : { runId }),
    ...(scopes === undefined ? {} : { scopes }),
    ...(probes === undefined ? {} : { probes }),
    ...(evaluator === undefined ? {} : { evaluator }),
    ...(evaluatorFallback === undefined ? {} : { evaluatorFallback }),
    ...(executor === undefined ? {} : { executor }),
    ...(executorFallback === undefined ? {} : { executorFallback }),
    ...(visual === undefined ? {} : { visual }),
    ...(call.worktree === true ? { worktree: true } : {}),
  }
}

/** One validated route the user chose in the dialog. */
type RouteChoice = { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }

/** Visual-evidence config from the dialog; `null` means unusable. */
function visualOf(raw: unknown): { enabled: true; route?: RouteChoice; fallback?: RouteChoice } | undefined | null {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const bag = raw as { readonly enabled?: unknown; readonly route?: unknown; readonly fallback?: unknown }
  if (bag.enabled !== true) return undefined
  const route = evaluatorOf(bag.route)
  if (route === null) return null
  const fallback = evaluatorOf(bag.fallback)
  if (fallback === null) return null
  return {
    enabled: true,
    ...(route === undefined ? {} : { route }),
    ...(fallback === undefined ? {} : { fallback }),
  }
}

const PROBE_KINDS = new Set(['file_exists', 'file_contains', 'grep', 'number_gte', 'command', 'scan'])
/** Probe ids become an evidence file name, so they must be a safe segment. */
const PROBE_ID = /^[A-Za-z0-9_-]{1,40}$/

/** Validate the per-task scope map: `{ TASK: string[] }` with safe path entries. */
function scopesOf(raw: unknown): Record<string, readonly string[]> | undefined {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const scopes: Record<string, readonly string[]> = {}
  for (const [taskId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) return undefined
    if (!Array.isArray(value)) return undefined
    const paths: string[] = []
    for (const entry of value) {
      // The same rules the ledger applies later: relative, no `..`, and never a
      // blanket grant that would silently equal "no scope".
      if (!isSafeScopePath(entry) || isBroadScopePath(entry) || entry.trim().length > 300) return undefined
      // Persist the normalized form: the matcher compares against git-reported
      // paths, and `././src/a.ts` / `src\\a.ts` never matched one.
      paths.push(normalizeScopePath(entry))
    }
    scopes[taskId] = paths
  }
  return scopes
}

/** Required fields per probe kind; a probe that cannot run is refused up front. */
function specOf(kind: string, spec: Record<string, unknown>): boolean {
  const str = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''
  const strList = (value: unknown): boolean => Array.isArray(value)
    && value.length > 0 && value.every(entry => typeof entry === 'string' && entry.trim() !== '')
  switch (kind) {
    case 'file_exists': return str(spec.path)
    case 'file_contains':
      // `flags` feeds a RegExp; a number there would silently change the match.
      return str(spec.path) && str(spec.pattern)
        && (spec.flags === undefined || typeof spec.flags === 'string')
    case 'grep': {
      const expect = spec.expect
      const minMatches = (expect as { minMatches?: unknown } | null)?.minMatches
      const expectOk = expect === 'match' || expect === 'no_match'
        || (expect !== null && typeof expect === 'object'
          && typeof minMatches === 'number' && Number.isFinite(minMatches))
      return str(spec.pattern) && strList(spec.paths) && expectOk
    }
    case 'number_gte': {
      const source = spec.source
      if (source === null || typeof source !== 'object') return false
      const bag = source as Record<string, unknown>
      const str2 = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''
      const argsOk = Array.isArray(bag.args)
        && (bag.args as unknown[]).every(entry => typeof entry === 'string')
      const sourceOk = bag.type === 'file'
        ? str2(bag.path) && (bag.pattern === undefined || typeof bag.pattern === 'string')
        : bag.type === 'command' && str2(bag.cmd) && argsOk
      return sourceOk && typeof spec.threshold === 'number' && Number.isFinite(spec.threshold)
    }
    case 'command':
      return str(spec.cmd) && Array.isArray(spec.args)
        && (spec.args as unknown[]).every(entry => typeof entry === 'string')
        && (spec.cwd === undefined || (typeof spec.cwd === 'string' && !spec.cwd.startsWith('/')))
        && (spec.expectExit === undefined || Number.isInteger(spec.expectExit))
    case 'scan': {
      const paths = spec.paths
      // `paths` is optional, but a bare string would be iterated character by
      // character by the scanner instead of being rejected here.
      if (paths !== undefined && (!Array.isArray(paths) || !paths.every(entry => typeof entry === 'string'))) return false
      return spec.scanKind === 'doclinks' || spec.scanKind === 'todo-tbd' || spec.scanKind === 'inline-code-path'
    }
    default: return false
  }
}

/**
 * Validate the probe list at the channel boundary.
 *
 * The dialog builds these objects, so a malformed entry means a version skew or
 * a hand-written call. Rejecting the whole list beats writing half a probe file
 * that a later audit would silently trust.
 */
function probesOf(raw: unknown): ProbeDef[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return undefined
  const probes: ProbeDef[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return undefined
    const bag = item as Record<string, unknown>
    if (typeof bag.id !== 'string' || !PROBE_ID.test(bag.id.trim())) return undefined
    if (typeof bag.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(bag.taskId.trim())) return undefined
    if (bag.weight !== 'light' && bag.weight !== 'heavy') return undefined
    if (bag.spec === null || typeof bag.spec !== 'object') return undefined
    const spec = bag.spec as Record<string, unknown>
    const kind = spec.kind
    if (typeof kind !== 'string' || !PROBE_KINDS.has(kind)) return undefined
    if (!specOf(kind, spec)) return undefined
    // A zero or negative timeout means "no timeout" to `execFile`; refuse it.
    const timeoutMs = typeof bag.timeoutMs === 'number' && Number.isFinite(bag.timeoutMs) && bag.timeoutMs >= 100
      ? Math.min(bag.timeoutMs, 600_000)
      : undefined
    probes.push({
      id: bag.id.trim(),
      taskId: bag.taskId.trim(),
      weight: bag.weight,
      spec: bag.spec as ProbeDef['spec'],
      enabled: bag.enabled !== false,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })
  }
  return probes
}

/** Validate every model route the prepare payload names; `null` means OK. */
async function validatePrepareRoutes(ctx: Context, input: {
  readonly evaluator?: RouteChoice
  readonly evaluatorFallback?: RouteChoice
  readonly executor?: RouteChoice
  readonly executorFallback?: RouteChoice
  readonly visual?: { readonly route?: RouteChoice; readonly fallback?: RouteChoice }
}, sessionRoute?: RouteChoice): Promise<string | null> {
  const llm = ctx.get('llm') as CarrierLlmDirectoryFace | undefined
  if (typeof llm?.resolveModelInfo !== 'function') return null
  // The witness follows the evaluator unless it names its own route, and the
  // evaluator itself follows the executor when unset — which, when the dialog
  // named neither, is the SOURCE SESSION's model. The effective route is what
  // must declare image input; skipping the session arm let a text-only session
  // model be chosen as an imageless witness.
  const visualPrimary = input.visual?.route ?? input.evaluator ?? input.executor ?? sessionRoute
  const visualFallback = input.visual?.fallback
  const routes: {
    readonly label: string
    readonly route?: RouteChoice
    readonly image?: boolean
  }[] = [
    { label: 'evaluator', route: input.evaluator },
    { label: 'evaluator fallback', route: input.evaluatorFallback },
    { label: 'executor', route: input.executor },
    { label: 'executor fallback', route: input.executorFallback },
    ...(input.visual === undefined ? [] : [
      { label: 'visual witness', route: visualPrimary, image: true },
      { label: 'visual witness fallback', route: visualFallback, image: true },
    ]),
  ]
  for (const entry of routes) {
    if (entry.route === undefined) continue
    let info: Awaited<ReturnType<CarrierLlmDirectoryFace['resolveModelInfo']>>
    try {
      info = await llm.resolveModelInfo(entry.route.provider, entry.route.model)
    } catch {
      return `selected ${entry.label} model is unavailable`
    }
    const effort = entry.route.reasoningEffort
    if (effort !== undefined && !info.reasoning?.efforts.some(level => level.id === effort)) {
      return `selected ${entry.label} reasoning effort is unavailable`
    }
    // Declared modalities are authoritative when the adapter lists them: a
    // text-only witness would fail at request time with UNSUPPORTED_CONTENT.
    if (entry.image === true && info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      return 'selected visual witness model does not declare image input'
    }
  }
  return null
}

/** Step two of the anchor dialog: prepare the run directory before a session exists. */
const guardPrepare: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null) return fail(REDLINE_ERROR.badRequest)
  const gate = await anchorGate(ctx, sessionId)
  if (gate !== null) return gate
  const draft = anchorDraftOf(call)
  if (draft === null) return fail(REDLINE_ERROR.badRequest)
  const input = prepareInputOf(call, draft)
  if (input === null) return fail(REDLINE_ERROR.badRequest, 'prepare fields are invalid')
  const resolved = await resolveAnchorSource(ctx, sessionId)
  if (!resolved.ok) return resolved.envelope
  // The source session's own model is the witness's last fallback, so it must
  // be resolved BEFORE validation: the modality check has to see it.
  const sourceConfig = resolved.source.config
  const sessionRoute: RouteChoice = {
    provider: sourceConfig.provider,
    model: sourceConfig.model,
    ...(sourceConfig.reasoningEffort.startsWith('not-') ? {} : { reasoningEffort: sourceConfig.reasoningEffort }),
  }
  // Every configured route is validated up front: a wrong provider, model or
  // reasoning level must fail in the dialog, not on the first audit turn.
  const invalid = await validatePrepareRoutes(ctx, input, sessionRoute)
  if (invalid !== null) return fail(REDLINE_ERROR.badRequest, invalid)
  try {
    const prepared = await withSessionLock(sessionId, async () => await prepareGuardRun(resolved.source.cwd, input))
    return redlineOk({
      runId: prepared.runId,
      root: prepared.root,
      files: prepared.files,
      ...(prepared.worktreePath === undefined ? {} : { worktreePath: prepared.worktreePath }),
    })
  } catch (error) {
    return fail(REDLINE_ERROR.badRequest, error instanceof Error ? error.message : 'run creation failed')
  }
}

/** Roll one run back to its last checkpoint; requires an explicit confirm. */
const guardRollback: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null || call.confirm !== 'rollback') return fail(REDLINE_ERROR.badRequest)
  const runId = typeof call.runId === 'string' ? call.runId.trim() : ''
  if (!isSafeRunId(runId)) return fail(REDLINE_ERROR.badRequest)
  // Rolling back while a turn is open would race the in-flight tool writes and
  // the audit that owns the same ledger.
  const gate = await anchorGate(ctx, sessionId)
  if (gate !== null) return gate
  const agents = ctx.get('agents') as { get?(id: string): SupervisorAgent | undefined } | undefined
  const agent = agents?.get?.(sessionId)
  const headerCwd = agent?.session?.header?.cwd
  if (agent === undefined || headerCwd === undefined) return fail(REDLINE_ERROR.notLive)
  // The ledger lives in the directory the run actually works in; for a worktree
  // run the header still names the source project, which holds no ledger at all.
  const cwd = effectiveCwdOf(ctx, agent.session, headerCwd)
  // The whole read → git → write-back transaction is serialized: two tabs (or a
  // fast double retry) would otherwise run `git revert` and `store.update`
  // concurrently and fight over `.git/index.lock` and the ledger.
  const answer = await withSessionLock(sessionId, async () => {
    // The outer gate ran before this call queued behind another write; a new
    // turn can open while it waits. Re-check under the lock (as `guard.switch`
    // already did), or the rollback would race a live turn's tool writes.
    const gateInside = await anchorGate(ctx, sessionId)
    if (gateInside !== null) return gateInside
    const owner = await ownershipGate(new GuardStore(join(cwd, 'docs', 'guard', runId)), sessionId)
    if (owner !== null) return owner
    const outcome = await rollbackRun({ cwd, runId, sessionId })
    if (!outcome.ok) return fail(REDLINE_ERROR.badRequest, outcome.reason)
    // The live attachment holds its own copy of the ledger; refresh it so the
    // anchors and the tool guard see the reopened task immediately.
    await attachedSupervisorFor(sessionId, runId)?.refresh().catch(() => undefined)
    // Only a ledger that actually came back `active` may wake the host goal. A
    // sibling-only rollback keeps the milestone gate (`status:'blocked'` +
    // `goalBlocked`), and resuming there would drive turns that `auditTurn`
    // refuses to supervise. That case also gets NO `goalResumed` field: the gate
    // is deliberate, so a `false` here would paint a fake "not resumed" warning.
    const rolledBack = await new GuardStore(join(cwd, 'docs', 'guard', runId)).readState()
    const resumable = rolledBack !== null && rolledBack.status === 'active' && rolledBack.goalBlocked === undefined
    //
    // The registry's EXACT live object is required: the goal service compares by
    // reference (`ctx.agents.get(agent.id) !== agent`) and rejects a copy with
    // GOAL_AGENT_NOT_LIVE, which would also flip the run to `setup-failed`.
    const goalResumed = resumable
      ? await resumeSupervisorGoal({ ctx, agent, cwd, runId }).catch(() => false)
      : undefined
    const summary = await findSupervisorRun(cwd, sessionId)
    // The same answer `guard.continue` gives: a reopened ledger whose host goal
    // could not be re-armed must say so, or the card shows "in progress" while
    // nothing drives the next turn.
    const hostGoal = hostGoalOf(ctx, agent)
    return redlineOk(summary === null
      ? null
      : { ...summary, ...(goalResumed === undefined ? {} : { goalResumed }), ...(hostGoal === undefined ? {} : { hostGoal }) })
  })
  return answer
}

/**
 * Read-only repository facts for the anchor dialog.
 *
 * The dialog offers「在独立 worktree 中运行」, and a run that commits on the
 * default branch (or inside a GitLab project) is exactly what the checked mode
 * exists to prevent — so the dialog needs to know whether this workspace is a
 * repository before the human picks. Nothing here writes, creates a run, or
 * touches the session; a missing service simply answers `isGit: false`.
 */
const readGuardRepo: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null) return fail(REDLINE_ERROR.badRequest)
  const agents = ctx.get('agents') as { get?(id: string): SupervisorAgent | undefined } | undefined
  const agent = agents?.get?.(sessionId)
  const headerCwd = agent?.session?.header?.cwd
  if (agent === undefined || headerCwd === undefined) return fail(REDLINE_ERROR.notLive)
  const cwd = effectiveCwdOf(ctx, agent.session, headerCwd)
  try {
    return redlineOk(await repoFacts(cwd))
  } catch (error) {
    return fail(REDLINE_ERROR.internal, `repository probe failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Clear a blocked run and let it continue, without a rollback.
 *
 * An evaluator outage blocks the run's goal, which is correct (a judge that
 * cannot judge must not pass anything) but it must not cost the task's
 * progress: this clears the block flag and the outage streak, keeps every
 * attempt and `baseCommit`, and re-arms the goal so the next turn retries the
 * same task. A rollback would reopen the task and restore its scope instead.
 */
const resumeSupervisor: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null) return fail(REDLINE_ERROR.badRequest)
  const runId = typeof call.runId === 'string' ? call.runId.trim() : ''
  if (!isSafeRunId(runId)) return fail(REDLINE_ERROR.badRequest)
  const gate = await anchorGate(ctx, sessionId)
  if (gate !== null) return gate
  const agents = ctx.get('agents') as { get?(id: string): SupervisorAgent | undefined } | undefined
  const agent = agents?.get?.(sessionId)
  const headerCwd = agent?.session?.header?.cwd
  if (agent === undefined || headerCwd === undefined) return fail(REDLINE_ERROR.notLive)
  const cwd = effectiveCwdOf(ctx, agent.session, headerCwd)
  const answer = await withSessionLock(sessionId, async () => {
    const gateInside = await anchorGate(ctx, sessionId)
    if (gateInside !== null) return gateInside
    const store = new GuardStore(join(cwd, 'docs', 'guard', runId))
    const owner = await ownershipGate(store, sessionId)
    if (owner !== null) return owner
    const outcome = await resumeBlockedRun(store)
    const hostGoal = hostGoalOf(ctx, agent)
    // The ledger and the host goal can disagree. A run whose tasks are all open
    // but whose goal stopped on its own (round limit, or the session-start
    // disarm) is NOT "not blocked": the driver is gone, and clicking 继续 is
    // exactly how a human repairs it. Anything else keeps the old refusal.
    const hostStopped = hostGoal !== undefined
      && (hostGoal.phase !== 'active' || hostGoal.activation !== 'armed')
    if (!outcome.ok) {
      const ledger = await store.readState()
      const shouldRearm = outcome.code === 'not-blocked'
        && hostStopped
        && ledger !== null
        && ledger.status === 'active'
        && ledger.goalBlocked === undefined
      if (!shouldRearm) return fail(REDLINE_ERROR.badRequest, outcome.reason)
      // Clearing the idle counters gives the reopened task a full chance; the
      // event keeps the reason auditable even though no task was BLOCKED.
      await store.mutate(current => ({
        state: {
          ...current,
          tasks: current.tasks.map(task => ({ ...task, idleStreak: undefined })),
          updatedAt: Date.now(),
        },
        events: [{ type: 'run.resumed' as const, at: Date.now(), reason: '人工继续：重新激活宿主目标' }],
      }))
    }
    // The live attachment holds its own copy of the ledger: refresh it so the
    // anchors and the tool guard see the reopened task immediately.
    await attachedSupervisorFor(sessionId, runId)?.refresh().catch(() => undefined)
    // Re-arming is what actually lets the next turn run; a completed goal is
    // not recreated here because completion is a different (and final) state.
    const goalResumed = await resumeSupervisorGoal({ ctx, agent, cwd, runId }).catch(() => false)
    const summary = await findSupervisorRun(cwd, sessionId)
    const refreshedHostGoal = hostGoalOf(ctx, agent)
    // A cleared ledger whose host goal could not be re-armed must say so: the
    // card would otherwise look resumed while nothing drives the next turn.
    return redlineOk(summary === null
      ? null
      : { ...summary, goalResumed, ...(refreshedHostGoal === undefined ? {} : { hostGoal: refreshedHostGoal }) })
  })
  return answer
}

/** Resolve a role's route from the request or from the configured fallback. */
function switchRouteOf(
  call: RedlineCall,
  state: {
    readonly evaluator?: RouteChoice
    readonly evaluatorFallback?: RouteChoice
    readonly executor?: RouteChoice
    readonly executorFallback?: RouteChoice
    readonly activeExecutor?: RouteChoice
  },
  role: 'executor' | 'evaluator',
): RouteChoice | null {
  const explicit = evaluatorOf(call.route)
  if (explicit === null) return null
  if (explicit !== undefined) return explicit
  const configured = role === 'executor'
    ? (state.executorFallback ?? state.activeExecutor ?? state.executor)
    : (state.evaluatorFallback ?? state.evaluator)
  return configured === undefined ? null : { ...configured }
}

/**
 * Switch the model of one role, optionally clearing a block at the same time.
 *
 * The execution route belongs to the session, so it is changed through the
 * agent's own `model.select`; the ledger keeps `executor` frozen and records the
 * new route as `activeExecutor`. The evaluator route lives in the ledger. Either
 * way the change is a ledger event, and `resume` is a separate decision: a
 * failed switch must never look like a resumed run.
 */
const switchSupervisorModel: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null) return fail(REDLINE_ERROR.badRequest)
  const runId = typeof call.runId === 'string' ? call.runId.trim() : ''
  if (!isSafeRunId(runId)) return fail(REDLINE_ERROR.badRequest)
  const role = call.role
  if (role !== 'executor' && role !== 'evaluator') return fail(REDLINE_ERROR.badRequest)
  const gate = await anchorGate(ctx, sessionId)
  if (gate !== null) return gate
  const agents = ctx.get('agents') as {
    get?(id: string): (SupervisorAgent & { readonly model?: { select?(selection: Record<string, unknown>): void } }) | undefined
  } | undefined
  const agent = agents?.get?.(sessionId)
  const headerCwd = agent?.session?.header?.cwd
  if (agent === undefined || headerCwd === undefined) return fail(REDLINE_ERROR.notLive)
  const cwd = effectiveCwdOf(ctx, agent.session, headerCwd)
  const store = new GuardStore(join(cwd, 'docs', 'guard', runId))
  const llm = ctx.get('llm') as CarrierLlmDirectoryFace | undefined
  // Every read, validation and write happens under the session lock: reading the
  // ledger (or the agent's model) outside it and writing a stale snapshot back
  // would silently drop a concurrent audit/switch.
  const answer = await withSessionLock(sessionId, async () => {
    // The outer gate ran before the lock was granted. A new turn can open while
    // this call waits behind another write; re-checking here is what keeps the
    // session's model from being switched under a live turn.
    const gateInside = await anchorGate(ctx, sessionId)
    if (gateInside !== null) return gateInside
    const owner = await ownershipGate(store, sessionId)
    if (owner !== null) return owner
    const state = await store.readState()
    if (state === null) return fail(REDLINE_ERROR.badRequest, 'run ledger is missing')
    // A resume that cannot succeed is refused BEFORE any side effect. Without
    // this preflight the op selected the session model and persisted the route,
    // then refused the resume — the reply said "switch failed" while the ledger
    // and the model had already changed and the live snapshot still showed the
    // old route.
    if (call.resume === true) {
      const eligibility = canResume(state)
      if (!eligibility.ok && eligibility.code === 'milestone-pending') {
        return fail(REDLINE_ERROR.badRequest, eligibility.reason)
      }
    }
    const route = switchRouteOf(call, state, role)
    if (route === null) return fail(REDLINE_ERROR.badRequest, 'no target model route')
    if (typeof llm?.resolveModelInfo === 'function') {
      let info: Awaited<ReturnType<CarrierLlmDirectoryFace['resolveModelInfo']>>
      try {
        info = await llm.resolveModelInfo(route.provider, route.model)
      } catch {
        return fail(REDLINE_ERROR.badRequest, `selected ${role} model is unavailable`)
      }
      if (route.reasoningEffort !== undefined
        && !info.reasoning?.efforts.some(level => level.id === route.reasoningEffort)) {
        return fail(REDLINE_ERROR.badRequest, `selected ${role} reasoning effort is unavailable`)
      }
      // A text-only judge would make the visual witness silently receive a text
      // placeholder instead of the screenshots, so its observation would be
      // fabricated. Refuse before the switch is persisted. The same holds for an
      // EXECUTOR switch when no dedicated evaluator exists: the witness follows
      // the evaluator, which follows the session model this switch just changed.
      const witnessFollowsRoute = state.visual?.enabled === true && state.visual.route === undefined
      const judgeFollowsExecutor = role === 'executor' && state.evaluator === undefined
      if (witnessFollowsRoute && (role === 'evaluator' || judgeFollowsExecutor)
        && info.inputModalities !== undefined
        && !info.inputModalities.includes('image')) {
        return fail(
          REDLINE_ERROR.badRequest,
          role === 'executor'
            ? '视觉取证跟随执行模型（评估模型未单独配置）：该模型未声明图片输入。请为这次运行配置 visual.route，或换一个支持图片输入的模型。'
            : '视觉取证跟随评估模型：该模型未声明图片输入。请为这次运行配置 visual.route，或换一个支持图片输入的评估模型。',
        )
      }
    }
    if (role === 'executor' && typeof agent.model?.select !== 'function') {
      return fail(REDLINE_ERROR.internal, 'session model switching is unavailable')
    }
    if (role === 'executor') {
      // The execution route is owned by the session; the judge route is not.
      try {
        agent.model?.select?.({
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return fail(REDLINE_ERROR.internal, `model switch failed: ${message}`)
      }
    }
    const from = role === 'executor' ? (state.activeExecutor ?? state.executor) : state.evaluator
    const previous = from === undefined ? '（未设置）' : routeLabel(from)
    const switched = await store.mutate(current => ({
      state: role === 'executor'
        ? { ...current, activeExecutor: route, updatedAt: Date.now() }
        : { ...current, evaluator: route, updatedAt: Date.now() },
      events: [{
        type: role === 'executor' ? 'executor.switched' as const : 'evaluator.switched' as const,
        at: Date.now(), from: previous, to: routeLabel(route), reason: '人工切换',
      }],
    }))
    if (switched === null) return fail(REDLINE_ERROR.badRequest, 'run ledger is missing')
    // Switching models and clearing a block are separate decisions: only an
    // explicit resume may wake a paused/blocked goal — and only when a block was
    // actually cleared. A goal the human paused by hand must not be woken just
    // because a model switch was submitted with `resume: true`.
    let goalResumed: boolean | undefined
    let resumeRefused: string | undefined
    let failure: string | undefined
    if (call.resume === true) {
      const resumed = await resumeBlockedRun(store)
      if (resumed.ok) {
        goalResumed = await resumeSupervisorGoal({ ctx, agent, cwd, runId }).catch(() => false)
      } else if (resumed.code === 'milestone-pending') {
        // The preflight above already refused this from the in-lock snapshot.
        // Reaching here means an audit wrote a failing review in between: the
        // route switch DID commit, so the reply must say the resume was refused
        // instead of pretending the whole switch failed.
        resumeRefused = resumed.reason
      } else if (resumed.code !== 'not-blocked' && resumed.code !== 'completed') {
        failure = resumed.reason
      }
    }
    // Refresh even when the resume was refused: this op may already have
    // committed a route change, and the live attachment must stop showing the
    // old snapshot.
    await attachedSupervisorFor(sessionId, runId)?.refresh().catch(() => undefined)
    if (failure !== undefined) return fail(REDLINE_ERROR.badRequest, failure)
    const summary = await findSupervisorRun(cwd, sessionId)
    const hostGoal = hostGoalOf(ctx, agent)
    return redlineOk(summary === null
      ? null
      : {
        ...summary,
        ...(goalResumed === undefined ? {} : { goalResumed }),
        ...(resumeRefused === undefined ? {} : { resumeRefused }),
        ...(hostGoal === undefined ? {} : { hostGoal }),
      })
  })
  return answer
}

interface HostGoalView {
  readonly phase?: string
  readonly activation?: string
  readonly roundsStarted?: number
  readonly maxGoalRounds?: number
  readonly blockedReason?: { readonly code?: string; readonly message?: string }
}

/**
 * The host goal's live view, or `undefined` when the host cannot answer.
 *
 * Never guesses: a missing service, a detached agent or a host that omits a
 * field all answer `undefined`, and the card falls back to the ledger alone.
 */
function hostGoalOf(
  ctx: { get(name: string): unknown },
  agent: unknown,
): SupervisorSummary['hostGoal'] | undefined {
  if (agent === undefined) return undefined
  const goals = ctx.get('goals') as { get?(target: unknown): HostGoalView | undefined } | undefined
  if (goals?.get === undefined) return undefined
  let view: HostGoalView | undefined
  try {
    view = goals.get(agent)
  } catch {
    return undefined
  }
  if (view === undefined) return undefined
  const phase = view.phase === 'paused' || view.phase === 'blocked' || view.phase === 'complete'
    ? view.phase
    : 'active'
  return {
    phase,
    activation: view.activation === 'disarmed' ? 'disarmed' : 'armed',
    ...(typeof view.roundsStarted === 'number' ? { roundsStarted: view.roundsStarted } : {}),
    ...(typeof view.maxGoalRounds === 'number' ? { maxGoalRounds: view.maxGoalRounds } : {}),
    ...(view.blockedReason?.code === undefined ? {} : { blockedCode: view.blockedReason.code }),
    ...(view.blockedReason?.message === undefined ? {} : { blockedMessage: view.blockedReason.message }),
  }
}

/** Read-only supervisor summary for one session (null when it has no run). */
const readSupervisor: RedlineOpHandler = async ({ ctx, call }) => {
  const sessionId = sessionIdOf(call)
  if (sessionId === null) return fail(REDLINE_ERROR.badRequest)
  const agents = ctx.get('agents') as { get?(id: string): { readonly session?: { readonly header?: { readonly cwd?: string } } } | undefined } | undefined
  const agent = agents?.get?.(sessionId)
  const headerCwd = agent?.session?.header?.cwd
  if (agent !== undefined && headerCwd !== undefined) {
    // Read the run where it actually works: a supervisor worktree run keeps its
    // header on the source project, so the header alone answers "no run".
    const summary = await findSupervisorRun(effectiveCwdOf(ctx, agent.session, headerCwd), sessionId)
    const hostGoal = hostGoalOf(ctx, agent)
    return redlineOk(summary === null
      ? null
      : { ...summary, agentLive: true, ...(hostGoal === undefined ? {} : { hostGoal }) })
  }
  // The agent is gone (tab closed, or the process restarted and has not
  // re-attached this session yet). The run may still be on disk: answering
  // `notLive` here made the whole card vanish with no explanation, which reads
  // as "my run disappeared" even though the ledger was intact. Read the
  // remembered mount instead and mark the card read-only.
  const remembered = await recallSupervisorRun(supervisorIndexDirOf(ctx), sessionId)
  if (remembered === null) return fail(REDLINE_ERROR.notLive)
  const summary = await findSupervisorRun(remembered.cwd, sessionId)
  if (summary === null) return fail(REDLINE_ERROR.notLive)
  return redlineOk({ ...summary, agentLive: false })
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
  ['anchor.plan', anchorPlan],
  ['anchor.start', anchorStart],
  ['guard.repo', readGuardRepo],
  ['guard.prepare', guardPrepare],
  ['guard.supervisor', readSupervisor],
  ['guard.continue', resumeSupervisor],
  ['guard.switch', switchSupervisorModel],
  ['guard.rollback', guardRollback],
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
