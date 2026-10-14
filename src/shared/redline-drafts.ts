/**
 * Local edits — the plugin's own store, and the WHOLE of what a "save" does
 * (`docs/11` D15, `AGENTS.md` §1: every save is temporary).
 *
 * The hard constraint, in one sentence: pressing save writes a JSON file under
 * our data directory and **nothing else** — the session log is untouched, so the
 * current session's model sees exactly what it saw before. The one and only write
 * point is opening a child session (M5), which carries these edits verbatim into
 * the new session's first message.
 *
 * Facts this module owns:
 *   · ONE local edit per row. Saving again OVERWRITES it (never stacks), and the
 *     latest version is the one that would be carried forward.
 *   · The version in effect is what the row DISPLAYS, what the editor PREFILLS and
 *     what the "no substantive change" check compares against (`docs/11` D16).
 *     That is why editing again after a save shows your saved text, and why
 *     editing back to the original counts as a change.
 *   · A corrupt file is an explicit error, never a silently empty table (E13).
 *
 * ── Why this lives in `src/shared/**` and not in `src/redline/**` ──────────
 * The BROWSER needs these rules too: it DISPLAYS the version in effect, PREFILLS
 * the editor from it, and labels a row `已改（本地）` — all three must use the same
 * answer the host uses when it decides "no substantive change". Two copies of
 * "what is in effect" is precisely how a UI starts disagreeing with the gate that
 * refuses the save.
 *
 * The bundle-purity gate (`docs/02` §4, `docs/05` A13, `namespace-contract` face 9,
 * plus tsdown's client-bundle purity plugin) forbids `src/client/**` from importing
 * `src/redline/**` at runtime — reverse-verified, same as `redline-ability.ts`.
 *
 * Purity: no `node:*` — the host half owns the file system and passes text in/out.
 */

import { REDLINE_ERROR } from './redline-errors'
import { REDLINE_DATA_DIR_NAME } from './redline-paths'

/** Our on-disk format version. Only bumped with a migration; there is none yet. */
export const REDLINE_DRAFT_SCHEMA_VERSION = 1

/** One row's local edit. `text` is the complete replacement body (never a preview). */
export interface LocalEdit {
  readonly seq: number
  readonly text: string
  readonly reasoning: string
  readonly isError: boolean
  /** When this version was saved (ISO-8601). The client formats it. */
  readonly updatedAt: string
  /** Display context: the row's category and tool/file name, when known. */
  readonly cat?: string
  readonly name?: string
  /**
   * 「删除」标记（`docs/03` R4.8 / `docs/13` §7）：这一条**不写进新会话**。
   *
   * ⚠️ 与编辑正文**独立存储** —— 删一条**不清空**它的编辑稿，取消删除要能原样恢复整条记录。
   * 旧实现（`excluded`）是"整条覆盖 + 清空正文"，那种互斥语义**已作废**。
   */
  readonly deleted?: boolean
  /**
   * 旧名字的**兼容镜像**：与 `deleted` 同写同清（历史草稿与尚未改名的调用方仍按这个字段名过滤）。
   * ⚠️ 不是"废弃 API"的注解写法 —— 命名空间契约的 lint 禁止仓库内**使用**被标 `@deprecated` 的成员，
   * 而这个镜像在被调用方改名（归 C3/C6）之前必须在本文件里读写。退役时把两处一起删。
   */
  readonly excluded?: boolean
  /**
   * 旧实现**先清空正文**再写删除标记 ⟹ 那条"删除前的编辑"已经不可能恢复。
   * 迁移时如实置位，让界面能说"这条旧标记无法恢复删除前的编辑"（R4.8 硬要求 5），
   * 而不是伪造一份正文、也不是静默丢掉标记。用户重新编辑后此位清除。
   */
  readonly legacyBodyLost?: true
}

/** All local edits of one session, keyed by `String(seq)`. */
export type DraftTable = Readonly<Record<string, LocalEdit>>

/** The minimal surface row this module needs: the FULL text plus its error mark. */
export interface SurfaceRowText {
  readonly seq: number
  readonly text: string
  readonly reasoning?: string
  readonly isError?: boolean
}

/**
 * Why a save was refused. Derived from the ONE code table (`redline-errors.ts`)
 * rather than re-spelled here: a second spelling of a wire code is how the client
 * ends up with a case it cannot map.
 */
/**
 * 一条记录是否**带编辑正文**。
 *
 * 判据用"正文或思考文本非空"，而不是另加一个布尔字段：保存路径的 `checkChange` 会拒绝
 * `text === '' && reasoning === ''`（`empty-content`），所以**能存下来的编辑一定有正文**，
 * 而"空正文"只能来自删除墓碑。这样"已删除原文 / 已删除编辑稿"两态天然可分。
 */
export function hasEditBody(edit: LocalEdit): boolean {
  return edit.text !== '' || edit.reasoning !== ''
}

/** 按固定字段顺序重建一条记录（保证序列化与 revision 稳定，不带上游对象的键序）。 */
function withMarks(entry: LocalEdit, deleted: boolean, legacyBodyLost: boolean): LocalEdit {
  return {
    seq: entry.seq,
    text: entry.text,
    reasoning: entry.reasoning,
    isError: entry.isError,
    updatedAt: entry.updatedAt,
    ...entry.cat === undefined ? {} : { cat: entry.cat },
    ...entry.name === undefined ? {} : { name: entry.name },
    ...deleted ? { deleted: true, excluded: true } : {},
    ...legacyBodyLost ? { legacyBodyLost: true } : {},
  }
}

/**
 * 把某一行标为**删除**：这一条不写进新会话（`docs/03` R4.8 / `docs/13` §7）。
 *
 * ⚠️ **保留**该行已有的编辑正文与显示元数据 —— 取消删除要能原样恢复整条记录。
 * 只写我们自己这份表；当前会话一个字都不写（硬约束，`docs/11` D15）。
 */
export function putDeleted(table: DraftTable, seq: number, updatedAt: string): DraftTable {
  const key = String(seq)
  // `Readonly<Record<string, LocalEdit>>` 把索引类型成 `LocalEdit`（不是 `| undefined`）⟹ 只能
  // 用 `Object.hasOwn` 问"到底有没有这条"，`=== undefined` 会既骗读者又被 lint 抓（同 dropEdit 的口径）。
  const existing: LocalEdit | undefined = Object.hasOwn(table, key) ? table[key] : undefined
  const base: LocalEdit = existing ?? { seq, text: '', reasoning: '', isError: false, updatedAt }
  return { ...table, [key]: withMarks(base, true, existing?.legacyBodyLost === true) }
}

/**
 * 取消删除：**回到删除之前的状态**（R4.8 关键转换）。
 * 有编辑正文 ⟹ 回到"已编辑"（正文原样）；没有正文 ⟹ 回到"原文"（整条记录去掉）。
 */
export function unmarkDeleted(table: DraftTable, seq: number): DraftTable {
  const key = String(seq)
  if (!Object.hasOwn(table, key)) return table
  const existing = table[key]
  if (!hasEditBody(existing)) {
    // 没有正文可留 ⟹ 就是"原文"。
    return Object.fromEntries(Object.entries(table).filter(([k]) => k !== key))
  }
  return { ...table, [key]: withMarks(existing, false, false) }
}

/** 被删除的 seq，升序。 */
export function deletedSeqsOf(table: DraftTable): number[] {
  return Object.values(table).filter(entry => isDeleted(table, entry.seq)).map(entry => entry.seq).sort((a, b) => a - b)
}

/** Whether a row carries the delete mark (`deleted`, or the compat mirror `excluded`). */
export function isDeleted(table: DraftTable, seq: number): boolean {
  const key = String(seq)
  if (!Object.hasOwn(table, key)) return false
  const entry = table[key]
  return entry.deleted === true || entry.excluded === true
}

/**
 * 旧名字（`putExcluded`）。语义**已改变**：不再清空正文（R4.8 硬要求 3 作废了互斥）。
 * 委托给 `putDeleted`；调用方改名归 C3/C6。
 * ⚠️ 不写 `@deprecated` 注解：lint 会因此拒绝任何**使用**它的调用方，而唯一剩下的使用者是
 * 尚未获准改动的那几个文件。退役时连名字一起删。
 */
export function putExcluded(table: DraftTable, seq: number, updatedAt: string): DraftTable {
  return putDeleted(table, seq, updatedAt)
}

/** 旧名字（`deletedSeqsOf`）——同一口径的委托；宿主已改用新名字，退役归 C3/C6。 */
export function excludedSeqsOf(table: DraftTable): number[] {
  return deletedSeqsOf(table)
}

export type ChangeRefusal = typeof REDLINE_ERROR.emptyContent | typeof REDLINE_ERROR.noChange

export type ChangeVerdict = { readonly ok: true } | { readonly ok: false; readonly code: ChangeRefusal }

export function emptyDrafts(): DraftTable {
  return {}
}

/**
 * A session id → a file-name-safe key.
 *
 * ⚠️ 只做百分号编码是不够的（Code Review P2）：
 *   · macOS 默认**大小写不敏感** ⟹ `Session-A` 与 `session-a` 会落到同一个文件（串档）；
 *   · 超长 id 会撞 255 字节的文件名上限 ⟹ `ENAMETOOLONG` ⟹ 保存直接失败。
 * 所以先做一次稳定的短哈希（FNV-1a 32 位，纯函数、无 `node:*`：宿主半边与测试都能用），
 * 再把可读前缀拼上 —— 既不会串档，也绝不会超长。可读前缀只为排障时认得出是哪个会话。
 */
export function stableKeyOf(sessionId: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < sessionId.length; i += 1) {
    hash ^= sessionId.charCodeAt(i)
    // FNV 质数 16777619，用移位避免大整数精度问题。
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** The on-disk name of one session's draft file. */
export function draftFileName(sessionId: string): string {
  const readable = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)
  return `redline-drafts-${readable}-${stableKeyOf(sessionId)}.json`
}

/** Our data directory's name, re-exported so the host has one source for it. */
export { REDLINE_DATA_DIR_NAME }

/** The edit for a row, if any. */
export function editOf(table: DraftTable, seq: number): LocalEdit | undefined {
  const entry = Object.values(table).find(candidate => candidate.seq === seq)
  // ⚠️ 判据是"**有没有编辑正文**"，不是"有没有删除标记"（`docs/03` R4.8）：
  //   · 删除墓碑（没有正文）不是编辑 —— 若当成编辑返回，`effectiveText` 会给出空串，行渲染成空白；
  //   · 「已删除编辑稿」（有正文 + 有删除标记）**是**编辑 —— 取消删除后要原样恢复它。
  return entry === undefined || !hasEditBody(entry) ? undefined : entry
}

/**
 * 旧名字（`isDeleted`）——同一口径，含 `deleted` 与兼容镜像字段。
 * 客户端 `browser.tsx` 还在用它（那个文件不在本卡允许改清单里）⟹ 退役归 C3/C6。
 */
export function isExcluded(table: DraftTable, seq: number): boolean {
  return isDeleted(table, seq)
}

/** Whether a row carries a local edit. */
export function hasLocalEdit(table: DraftTable, seq: number): boolean {
  return editOf(table, seq) !== undefined
}

/**
 * Insert or OVERWRITE the edit for one row. One row, one edit — never two.
 *
 * ⚠️ 覆盖**不解除删除标记**（`docs/03` R4.8 硬要求 3：互斥已作废）⟹ 编辑一条已删除的行
 * 得到的仍是"已删除编辑稿"。同时清掉 `legacyBodyLost`：用户给了新正文，那条"旧编辑已丢失"
 * 的提示不再适用（继续显示会说假话）。
 */
export function putEdit(table: DraftTable, edit: LocalEdit): DraftTable {
  const key = String(edit.seq)
  if (!Object.hasOwn(table, key) || !isDeleted(table, edit.seq)) {
    return { ...table, [key]: edit }
  }
  return { ...table, [key]: withMarks(edit, true, false) }
}

/** Forget one row's edit — but a **deleted** row keeps its tombstone (R4.8). */
export function dropEdit(table: DraftTable, seq: number): DraftTable {
  const key = String(seq)
  // Existence, not value: a `Record<string, T>` indexes as `T`, so `=== undefined`
  // is both a lie to the reader and a lint error. `Object.hasOwn` is the honest check.
  if (!Object.hasOwn(table, key)) return table
  const existing = table[key]
  if (isDeleted(table, seq)) {
    // 「已删除编辑稿 ──丢弃这条改动──▶ 已删除原文」：只清正文，**保持删除态**。
    return { ...table, [key]: withMarks({ ...existing, text: '', reasoning: '', isError: false }, true, false) }
  }
  // Built immutably (no `delete` on a computed key), so callers can diff by identity.
  return Object.fromEntries(Object.entries(table).filter(([k]) => k !== key))
}

/** The text in effect for a row: the local edit if there is one, else the original. */
export function effectiveText(row: SurfaceRowText, table: DraftTable): string {
  const edit = editOf(table, row.seq)
  return edit === undefined ? row.text : edit.text
}

/** The thinking text in effect (an edit that empties it stays empty). */
export function effectiveReasoning(row: SurfaceRowText, table: DraftTable): string {
  const edit = editOf(table, row.seq)
  return edit === undefined ? (row.reasoning ?? '') : edit.reasoning
}

/** The error mark in effect. */
export function effectiveIsError(row: SurfaceRowText, table: DraftTable): boolean {
  const edit = editOf(table, row.seq)
  return edit === undefined ? (row.isError ?? false) : edit.isError
}

/**
 * Decide whether a proposed edit is a substantive change — the demo's rule
 * (`demo/demo.js` `submitEditor`), locked by the `drafts` spec:
 *   · both the visible text and the thinking text empty → `empty-content`;
 *   · identical to the version IN EFFECT (text, thinking text and error mark all
 *     equal) → `no-change`;
 *   · otherwise it is a change — including "change it back to the original",
 *     because after a save the version in effect IS the saved one.
 */
export function checkChange(
  row: SurfaceRowText,
  table: DraftTable,
  next: { readonly text: string; readonly reasoning: string; readonly isError: boolean },
): ChangeVerdict {
  if (next.text === '' && next.reasoning === '') return { ok: false, code: REDLINE_ERROR.emptyContent }
  if (
    next.text === effectiveText(row, table)
    && next.reasoning === effectiveReasoning(row, table)
    && next.isError === effectiveIsError(row, table)
  ) {
    return { ok: false, code: REDLINE_ERROR.noChange }
  }
  return { ok: true }
}

/** The wire form of one draft file. */
export interface DraftFile {
  readonly schemaVersion: number
  readonly sessionId: string
  readonly edits: readonly LocalEdit[]
}

/** Serialize a table for disk: deterministic (sorted by seq), newline-terminated. */
export function serializeDrafts(sessionId: string, table: DraftTable): string {
  const edits = Object.values(table).sort((a, b) => a.seq - b.seq)
  const file: DraftFile = { schemaVersion: REDLINE_DRAFT_SCHEMA_VERSION, sessionId, edits }
  return `${JSON.stringify(file, null, 2)}\n`
}

/**
 * A deterministic version token for the exact draft set a child-confirmation dialog
 * reviewed. It is a stale-confirmation guard, not an authorization mechanism: the
 * route remains authenticated by the harness. The canonical serialization means
 * record order cannot change the version, while any carried field can.
 */
export function draftRevisionOf(sessionId: string, table: DraftTable): string {
  const source = serializeDrafts(sessionId, table)
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return `d1-${hash.toString(16).padStart(8, '0')}`
}

export type ParseResult =
  | { readonly ok: true; readonly table: DraftTable }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** A missing/empty file is an empty table; anything unreadable is a loud refusal. */
export function parseDrafts(raw: string | null | undefined, expectedSessionId?: string): ParseResult {
  if (raw === null || raw === undefined || raw.trim() === '') return { ok: true, table: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: REDLINE_ERROR.draftCorrupt, message: 'the draft file is not valid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: REDLINE_ERROR.draftCorrupt, message: 'the draft file is not an object' }
  }
  const file = parsed as Partial<DraftFile>
  // 串档防线（Code Review P2）：文件里记着它是哪个会话的草稿。文件名被改过、或
  // 两个会话的 id 在文件系统上收敛到同一个名字时，这里必须**拒绝**而不是当成本会话的草稿。
  if (expectedSessionId !== undefined && file.sessionId !== expectedSessionId) {
    return {
      ok: false,
      code: REDLINE_ERROR.draftCorrupt,
      message: `the draft file belongs to another session (${String(file.sessionId)})`,
    }
  }
  if (file.schemaVersion !== REDLINE_DRAFT_SCHEMA_VERSION) {
    return {
      ok: false,
      code: REDLINE_ERROR.draftSchema,
      message: `unsupported draft schemaVersion: ${String(file.schemaVersion)}`,
    }
  }
  if (!Array.isArray(file.edits)) {
    return { ok: false, code: REDLINE_ERROR.draftCorrupt, message: 'the draft file has no edits array' }
  }
  const table: Record<string, LocalEdit> = {}
  for (const entry of file.edits) {
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, code: REDLINE_ERROR.draftCorrupt, message: 'a draft entry is not an object' }
    }
    const edit = entry as Partial<LocalEdit>
    if (typeof edit.seq !== 'number' || !Number.isInteger(edit.seq) || edit.seq < 0) {
      return { ok: false, code: REDLINE_ERROR.draftCorrupt, message: 'a draft entry has no usable seq' }
    }
    if (typeof edit.text !== 'string' || typeof edit.reasoning !== 'string' || typeof edit.isError !== 'boolean') {
      return { ok: false, code: REDLINE_ERROR.draftCorrupt, message: `draft #${edit.seq} has ill-typed fields` }
    }
    if (edit.excluded !== undefined && typeof edit.excluded !== 'boolean') {
      return { ok: false, code: REDLINE_ERROR.draftCorrupt, message: `draft #${edit.seq} has a non-boolean excluded` }
    }
    if (edit.deleted !== undefined && typeof edit.deleted !== 'boolean') {
      return { ok: false, code: REDLINE_ERROR.draftCorrupt, message: `draft #${edit.seq} has a non-boolean deleted` }
    }
    // 旧实现**先清空正文**才写 `excluded`（没有 `deleted` 字段）⟹ 那条"删除前的编辑"已经不可能恢复。
    // 迁移到 `deleted` 的同时如实置 `legacyBodyLost`：标记不丢、也不伪造正文（R4.8 硬要求 5）。
    const legacyOnly = edit.deleted === undefined && edit.excluded === true
    const deleted = edit.deleted === true || edit.excluded === true
    const body = { seq: edit.seq, text: edit.text, reasoning: edit.reasoning, isError: edit.isError }
    table[String(edit.seq)] = withMarks(
      {
        ...body,
        updatedAt: typeof edit.updatedAt === 'string' ? edit.updatedAt : '',
        ...(typeof edit.cat === 'string' ? { cat: edit.cat } : {}),
        ...(typeof edit.name === 'string' ? { name: edit.name } : {}),
      },
      deleted,
      legacyOnly && !hasEditBody({ ...body, updatedAt: '', seq: edit.seq }),
    )
  }
  return { ok: true, table }
}
