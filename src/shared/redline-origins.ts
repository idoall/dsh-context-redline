/**
 * 「这条子会话是不是**在这个面板里**开的」—— 我们自己的一本台账（`docs/10` **M5-12**）。
 *
 * 为什么必须自己记，而不是从平台读：
 *   官方 `subagentCatalog` 投影的条目里**只有** `childId` / `childCreatedAt` / `version` /
 *   `mode` / `label` —— **没有来源字段**（2026-10-07 安装树实测，`docs/01` **F59**）。
 *   所以"本项目发起 / 来自 Agent Teams"这件事，平台侧答不出来。
 *
 * 三种**诚实**态（界面按这三态说话，不许含糊）：
 *   ① 台账里有这条 ⟹ **本项目发起**，并写明走的是"官方成员"还是"裸子会话"（那是我们真知道的，
 *      因为 `child.start` 的返回里就带着 `via`）；
 *   ② 台账里没有这条 ⟹ **不是在这儿开的**（**不猜**是谁开的：可能是官方团队自己的工具、
 *      也可能是别的会话 —— 我们不去读官方名册，那块界面已按用户裁定撤下）；
 *   ③ 台账**读不出来** ⟹ **来源未知**并**大声**报错（`redline/origin-corrupt` /
 *      `redline/origin-schema`），绝不假装成"没有记录"（那会把②说成一个我们没证据的结论）。
 *
 * 只写我们自己的数据目录；**不写任何会话**（`AGENTS.md` §1）。
 */

import { REDLINE_ERROR } from './redline-errors'
import { stableKeyOf } from './redline-drafts'

/** 这条子会话是走哪条路开的（`child.start` 的返回里那个 `via`）。 */
export type OriginVia = 'official-member' | 'bare-child'

/** 一条台账记录。`childId` 对官方成员就是 `TeamMemberView.id`（类型是 `SessionId`）。 */
export interface OriginRecord {
  readonly childId: string
  readonly via: OriginVia
  readonly at: number
}

/** 台账文件形状（带自己的 schemaVersion，串档/旧版要认得出）。 */
export interface OriginFile {
  readonly schemaVersion: number
  readonly sessionId: string
  readonly records: readonly OriginRecord[]
}

/** 台账文件的 schema 版本。 */
export const ORIGIN_LEDGER_SCHEMA_VERSION = 1

/** 一本台账最多留多少条（老的先丢；子会话数量远小于这个数）。 */
export const ORIGIN_LEDGER_CAP = 200

/** 一条会话的台账文件名（与草稿同一套命名：可读前缀 + 稳定短哈希）。 */
export function originsFileName(sessionId: string): string {
  const readable = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)
  return `redline-origins-${readable}-${stableKeyOf(sessionId)}.json`
}

/** 解析结果：`ok:false` 一定带一个**稳定错误码**，界面就按它说人话。 */
export type OriginParseResult =
  | { readonly ok: true; readonly records: readonly OriginRecord[] }
  | { readonly ok: false; readonly code: string; readonly message: string }

const VIA_VALUES: readonly string[] = ['official-member', 'bare-child']

function recordOf(raw: unknown): OriginRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const childId = row.childId
  const via = row.via
  if (typeof childId !== 'string' || childId === '') return null
  if (typeof via !== 'string' || !VIA_VALUES.includes(via)) return null
  const at = typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0
  return { childId, via: via as OriginVia, at }
}

/**
 * 缺文件 = 空台账（我们确实没在这条会话里开过子会话）；
 * 文件在但读不出来 = **大声拒绝**（不许把③说成②）。
 *
 * @param raw - 文件内容（`null` = 文件不存在）。
 * @param expectedSessionId - 给了就校验串档（台账上写的会话必须就是这条）。
 */
export function parseOrigins(raw: string | null | undefined, expectedSessionId?: string): OriginParseResult {
  if (raw === null || raw === undefined || raw.trim() === '') return { ok: true, records: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: REDLINE_ERROR.originCorrupt, message: 'the origin ledger is not valid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: REDLINE_ERROR.originCorrupt, message: 'the origin ledger is not an object' }
  }
  const file = parsed as Record<string, unknown>
  if (file.schemaVersion !== ORIGIN_LEDGER_SCHEMA_VERSION) {
    return { ok: false, code: REDLINE_ERROR.originSchema, message: 'the origin ledger has an unsupported schema version' }
  }
  if (typeof file.sessionId !== 'string' || file.sessionId === '') {
    return { ok: false, code: REDLINE_ERROR.originCorrupt, message: 'the origin ledger has no session id' }
  }
  if (expectedSessionId !== undefined && file.sessionId !== expectedSessionId) {
    return { ok: false, code: REDLINE_ERROR.originCorrupt, message: 'the origin ledger belongs to another session' }
  }
  if (!Array.isArray(file.records)) {
    return { ok: false, code: REDLINE_ERROR.originCorrupt, message: 'the origin ledger has no records array' }
  }
  const records: OriginRecord[] = []
  for (const entry of file.records) {
    const record = recordOf(entry)
    // 坏条目**丢**（不是整份拒绝）：一条垃圾不该让整本台账变成"来源未知"。
    if (record !== null && !records.some(one => one.childId === record.childId)) records.push(record)
  }
  return { ok: true, records }
}

/** 写盘用的确定性序列化（新的在前）。 */
export function serializeOrigins(sessionId: string, records: readonly OriginRecord[]): string {
  const file: OriginFile = { schemaVersion: ORIGIN_LEDGER_SCHEMA_VERSION, sessionId, records }
  return `${JSON.stringify(file, null, 2)}\n`
}

/** 记一条（按 `childId` 幂等：同一条子会话只留最新那次），超出上限丢最老的。 */
export function putOrigin(records: readonly OriginRecord[], record: OriginRecord): OriginRecord[] {
  const next = [record, ...records.filter(one => one.childId !== record.childId)]
  return next.length > ORIGIN_LEDGER_CAP ? next.slice(0, ORIGIN_LEDGER_CAP) : next
}

/** 这条子会话是不是在这儿开的；是就顺带说清走的是哪条路。 */
export function viaOf(records: readonly OriginRecord[], childId: string): OriginVia | null {
  return records.find(one => one.childId === childId)?.via ?? null
}
