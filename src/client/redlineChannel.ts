/**
 * The panel's transport to OUR route (`REDLINE_CHANNEL_ROUTE`) — the only way the
 * browser half talks to the editing layer.
 *
 * Two contracts this file exists to keep:
 *
 * 1. **One path, shared with the host.** The URL is `REDLINE_CHANNEL_ROUTE` from
 *    `src/shared/redline-route.ts`, never a literal. A hand-written path on either
 *    side is how "前缀/形状不成对" turns into a silent 404 (`docs/01` F1,
 *    `docs/05` A12) — the `channel` lane asserts the host REGISTERS that constant,
 *    and `tests/client-logic/redline-channel.spec.ts` asserts the client POSTS it.
 *
 * 2. **Failures are values, never exceptions.** Every outcome is either
 *    `{ok:true, value}` or `{ok:false, code, message}` with a STABLE code, because
 *    the editor must show the reason while keeping the user's input
 *    (`docs/03` R3.5). An exception escaping here would blank the row instead.
 *
 * Reads the FULL text: `node.read` answers the durable event's complete body, not
 * the list preview (`docs/01` F35) — the editor prefills from exactly this.
 */

import { REDLINE_ERROR } from '../shared/redline-errors'
import { REDLINE_CHANNEL_ROUTE, type RedlineEnvelope } from '../shared/redline-route'
import type { ChildCapacity } from '../shared/redline-capacity'
import type { OriginRecord } from '../shared/redline-origins'
import type { DraftTable } from '../shared/redline-drafts'
import type { TurnState } from '../shared/redline-turn'

/** One row's complete content, as `node.read` answers it. */
export interface RedlineRow {
  readonly seq: number
  /** The durable event type (`docs/03` R3.2 keys the editor fields off it). */
  readonly type: string
  readonly text: string
  readonly reasoning: string
  readonly isError: boolean
}

/** The edit the editor submits. `reasoning`/`isError` are only meaningful per type. */
export interface DraftEdit {
  readonly text: string
  readonly reasoning: string
  readonly isError: boolean
}

/** The transport's outcome: a value, or a stable code the UI turns into a sentence. */
export type RedlineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Narrow an untrusted body to our envelope. */
function envelopeOf(body: unknown): RedlineEnvelope<unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const bag = body as { ok?: unknown; value?: unknown; error?: unknown }
  if (bag.ok === true) return { ok: true, value: bag.value }
  if (bag.ok === false) {
    const error = bag.error
    if (error === null || typeof error !== 'object') return null
    const { code, message } = error as { code?: unknown; message?: unknown }
    if (typeof code !== 'string') return null
    return { ok: false, error: { code, message: typeof message === 'string' ? message : code } }
  }
  return null
}

/** POST one op and normalize every possible outcome into a {@link RedlineResult}. */
async function call<T>(body: Record<string, unknown>): Promise<RedlineResult<T>> {
  let response: Response
  try {
    response = await fetch(REDLINE_CHANNEL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The route is `no-store` on the host side too; a cached refusal would be a
      // lie the user cannot get rid of by saving again.
      cache: 'no-store',
      body: JSON.stringify(body),
    })
  } catch (error) {
    return { ok: false, code: REDLINE_ERROR.transport, message: error instanceof Error ? error.message : String(error) }
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch (error) {
    return {
      ok: false,
      code: REDLINE_ERROR.transport,
      message: `${REDLINE_ERROR.transport}: HTTP ${String(response.status)} ${error instanceof Error ? error.message : ''}`.trim(),
    }
  }
  const envelope = envelopeOf(parsed)
  if (envelope === null) {
    return { ok: false, code: REDLINE_ERROR.transport, message: `${REDLINE_ERROR.transport}: HTTP ${String(response.status)}` }
  }
  if (!envelope.ok) return { ok: false, code: envelope.error.code, message: envelope.error.message }
  return { ok: true, value: envelope.value as T }
}

/** One row's COMPLETE content — the editor's only prefill source. */
export async function readRow(sessionId: string, seq: number): Promise<RedlineResult<RedlineRow>> {
  return await call<RedlineRow>({ op: 'node.read', sessionId, seq })
}

/**
 * Whether this session can be edited right now (`docs/03` R4.3). Asked BEFORE the
 * editor opens, because the demo blocks editing entirely mid-turn / on a session
 * this process does not host — a save button that fails after the click is a
 * worse experience than one that is disabled with the reason beside it.
 */
export async function readTurnState(sessionId: string): Promise<RedlineResult<TurnState>> {
  return await call<TurnState>({ op: 'turnState', sessionId })
}

/** Every local edit of this session (the row markers and the prefill read this). */
export async function listDrafts(sessionId: string): Promise<RedlineResult<DraftTable>> {
  return await call<DraftTable>({ op: 'draft.list', sessionId })
}

/**
 * Save one row's local edit. Refusals are expected values: `redline/no-change`
 * (identical to the version in effect) and `redline/empty-content`.
 */
export async function saveDraft(sessionId: string, seq: number, edit: DraftEdit): Promise<RedlineResult<DraftTable>> {
  return await call<DraftTable>({ op: 'draft.update', sessionId, seq, edit })
}

/** Forget one row's local edit (the row goes back to its original). */
/**
 * 标为「不要」（`excluded: true`）或取消标记（`false`）。**只写插件本地** ——
 * 当前会话一个字都不写；开启子会话时由首条任务逐字声明这几条作废（`docs/11` D65）。
 */
export async function excludeDraft(sessionId: string, seq: number, excluded: boolean): Promise<RedlineResult<DraftTable>> {
  return await call<DraftTable>({ op: 'draft.exclude', sessionId, seq, excluded })
}

export async function dropDraft(sessionId: string, seq: number): Promise<RedlineResult<DraftTable>> {
  return await call<DraftTable>({ op: 'draft.drop', sessionId, seq })
}

/** 确认框五项 + 组装好的首条任务（开子会话**之前**能问的全部事实；只读）。 */
export interface ChildPlan {
  /** 恰好五项：从哪儿开始 / 会带上的改动 / 第一句话由人写 / 会带什么不带什么 / 取消。 */
  items: readonly { label: string; text: string }[]
  /** 会逐字带过去的本地改动（按 seq）。 */
  carriedSeqs: readonly number[]
  /** 被标为「不要」、会在首条任务里声明作废的 seq（`docs/11` D65）。 */
  excludedSeqs: readonly number[]
  /** Exact local-draft set reviewed by this plan; required by `child.start`. */
  draftRevision: string
  /** 组装好的首条任务；被拒绝时为 `null`。 */
  prompt: string | null
  /** 首条任务的读数（M2-20）：UTF-8 字节 / 行 / 带了几条改动；被拒绝时为 `null`。 */
  metrics: { bytes: number; lines: number; edits: number } | null
  /** 被拒绝时给一句人话（例如"第一句话必须你自己写"）。 */
  refusal: { code: string; message: string } | null
}

/** 开子会话之前问事实（只读，绝不写任何东西）。 */
export async function planChild(sessionId: string, humanTask: string): Promise<RedlineResult<ChildPlan>> {
  return await call<ChildPlan>({ op: 'child.plan', sessionId, humanTask })
}

/** 开子会话成功后的回执。 */
export interface ChildStarted {
  /**
   * 走的是哪条路：`'official-member'`（官方团队成员）/ `'bare-child'`（裸子会话）。
   * 界面必须如实标出来 —— 两者的可管理性完全不同（官方那份能在官方团队视图里看到）。
   */
  via?: string
  label: string
  prompt: string
  carriedSeqs: readonly number[]
  /** 平台给的子会话回执（`childId` / `messageId`）。 */
  started: unknown
}

/**
 * **开子会话** —— 全插件唯一的写入点。
 *
 * 只在人**明确点了确认**之后调用；`humanTask` 是人写的第一句话（空着会被宿主拒绝）。
 * 拒绝一律以稳定的 code + 一句人话回来（transport 从不抛），界面照它显示就行。
 */
export async function startChild(sessionId: string, humanTask: string, draftRevision: string): Promise<RedlineResult<ChildStarted>> {
  return await call<ChildStarted>({ op: 'child.start', sessionId, humanTask, draftRevision })
}

/** `child.origins` 的回答：`records: null` = 我们那本台账**读不出来**（界面必须说"来源未知"）。 */
export interface OriginAnswer {
  readonly records: readonly OriginRecord[] | null
  readonly error?: string
}

/**
 * M5-12 的来源台账：问宿主"这些子会话里，哪些**是在这个面板里**开的"。
 * 只读；`records: null` 表示**读不出来**（与"空台账"是两件事，界面话术不同）。
 */
export async function readOrigins(sessionId: string): Promise<RedlineResult<OriginAnswer>> {
  return await call<OriginAnswer>({ op: 'child.origins', sessionId })
}

/**
 * M5-13 的分母：问宿主"这台机器允许几个团队成员"。
 * 只读；形状不可信 ⟹ 调用方要用 `capacityOf()` re-prove 一遍再进渲染。
 */
export async function readCapacity(): Promise<RedlineResult<ChildCapacity>> {
  return await call<ChildCapacity>({ op: 'child.capacity' })
}
