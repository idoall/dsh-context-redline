/**
 * Capability judgement — WHICH action a row gets, decided by the UNDERLYING EVENT
 * TYPE, never by the display category (`AGENTS.md` §2.3.1, `docs/01` F7/F7.2,
 * `docs/05` A17).
 *
 * Why it must be by event type: the category is a presentation grouping (injected
 * content and skill injection are both `user/message` underneath), while the
 * platform's rewrite rules are stated per event type. Judging by category is how
 * the earlier attempt shipped an assistant-rewrite branch that could only fail at
 * runtime — the UI must never offer a button that is guaranteed to error.
 *
 * The four "no action, with a reason" cases, and the one that matters most:
 *   · `system/message` / tool definitions — the host protects node 0 → `inert`
 *     (no action BAR at all, not an empty one);
 *   · `assistant/message` — replace requires `sourceEventSeqs` covering the
 *     shadowed node, but an assistant message is FORBIDDEN to carry it. The two
 *     rules are mutually exclusive, so there is no working write at all;
 *   · a shadowed original — no longer a surface node, so it cannot be a target;
 *   · a compacted-away row — out of reach.
 *
 * And the rule that makes repeat editing work: the REPLACEMENT body is a current
 * surface node, so it stays editable. `shadowed` therefore means "superseded by a
 * later replacement", not "is a replacement".
 *
 * ── Why this lives in `src/shared/**` and not in `src/redline/**` ──────────
 * The BROWSER needs this rule too (it decides which action a row renders), and the
 * client bundle must not import `src/redline/**` — that is the bundle-purity gate
 * (`docs/02` §4, `docs/05` A13), enforced mechanically by
 * `scripts/namespace-contract.mjs` face 9 and by the tsdown client-bundle purity
 * plugin. Proved by reverse verification: a temporary `import { ability } from
 * '../redline/eligibility'` in `src/client/services.ts` reddens face 9 immediately.
 * `src/shared/**` is the documented home for logic BOTH halves run, so the rule
 * lives here once — never duplicated per half (a duplicated button rule is exactly
 * how the earlier attempt shipped an assistant-rewrite branch that could only fail).
 *
 * Purity: no `node:*`, no DOM, no React.
 */

/** The seven row classes the panel groups by (`docs/03` §2). */
export type RowClass = 'system' | 'tools' | 'user' | 'inject' | 'skill' | 'assistant' | 'tool'

/**
 * The stable reason keys. The client maps each to the sentence of `docs/03` R4.7 —
 * the host never ships user-facing prose for a refusal.
 */
export type BlockReason = 'system-head' | 'shadowed' | 'assistant-immutable' | 'compacted'

/** One row, as far as capability judgement is concerned. */
export interface SurfaceRow {
  readonly seq: number
  /** The durable event type (`user/message`, `assistant/message`, `tool/result`, `system/message`…). */
  readonly type: string
  readonly cat: RowClass
  /** Superseded by a later replacement → no longer on the surface. */
  readonly shadowed: boolean
  /** Is itself a replacement body (a current surface node). */
  readonly isReplacement: boolean
  /** Buried by compaction. */
  readonly compacted: boolean
}

/** The judgement for one row. */
export interface Ability {
  /** May this row's content be rewritten at all? */
  readonly canRewrite: boolean
  /** Host-protected: render NO action area (`docs/03` R2.1). */
  readonly inert: boolean
  readonly shadowed: boolean
  readonly isReplacement: boolean
  /** 被压缩埋掉（够不到，既不能编辑也不能作废）。 */
  readonly compacted: boolean
  /** The "advanced" class: `Edit` is hidden behind the advanced switch (`docs/03` R2.5). */
  readonly advancedOnly: boolean
  /**
   * 能不能把这一条标为「不要」（`docs/11` D65，用户 2026-10-08 选 A）。
   * 判据与"能不能编辑"**不同**：助手消息**改不了但可以作废** —— 那正是它唯一的处置手段。
   * 宿主保护的两类、已被接替的、被压缩埋掉的：不给（与"不能编辑"同一批）。
   */
  readonly canExclude: boolean
  /** Present exactly when `canRewrite` is false — including inert rows, which still need a reason line. */
  readonly blockReason?: BlockReason
}

/**
 * One row's actions.
 *   · `drop`      —— 丢弃这一条的本地改动（有改动时才出现）；
 *   · `exclude`   —— 标为「不要」（作废，开启子会话时逐字声明）；
 *   · `unexclude` —— 取消作废标记。
 * `exclude` 与 `edit` **互斥**（同一条记录只有一份，标了就清掉改动）。
 */
export type RowAction = 'edit' | 'drop' | 'exclude' | 'unexclude'

export function ability(row: SurfaceRow): Ability {
  const inert = row.cat === 'system' || row.cat === 'tools'
  // New carriers are zero-history sessions: editing assistant text changes only the migration copy, never the old log.
  const canRewrite = !inert && !row.shadowed && !row.compacted
  const canExclude = !inert && !row.shadowed && !row.compacted
  return {
    canRewrite,
    canExclude,
    inert,
    compacted: row.compacted,
    shadowed: row.shadowed,
    isReplacement: row.isReplacement,
    advancedOnly: row.cat === 'tool',
    // docs/11 实施共识 §6: when two reasons apply, the assistant rule wins (the
    // sentences differ, the action set does not). Inert rows keep a reason too —
    // "no action bar" is the layout, and the reason is the explanation the row
    // still owes the reader.
    ...(canRewrite
      ? {}
      : {
        blockReason: inert ? 'system-head' : row.shadowed ? 'shadowed' : 'compacted',
      }),
  }
}

/**
 * Which durable types each presentation bucket can hold, per the host fold
 * (`src/host/fold.ts` `categoryOf` + the header-epoch rows for `system`/`tools`).
 *
 * WHY a bucket needs a list rather than one type: `skill` holds BOTH a skill
 * injection (`user/message`) and a skill LOAD, which the fold reclassifies into
 * the skill bucket "but stays a tool result". So the bucket cannot name one type.
 *
 * WHY that is still safe for the BUTTON SET: the action rule is invariant across
 * every type a bucket can hold (proved by `tests/edit/ability-buckets.spec.ts`:
 * for each bucket, all its listed types yield the same `canRewrite` / `inert` /
 * `advancedOnly` / `blockReason`). The row's category therefore decides the
 * actions, and the ONLY thing that needs the exact type — the editor's fields
 * (`docs/03` R3.2: a tool result edits result-text + `isError`, a user message
 * edits 正文 + thinking text) — is taken from `node.read`, which answers the real
 * durable type when the editor opens. No guessing anywhere.
 */
export const TYPES_BY_BUCKET: Readonly<Record<RowClass, readonly string[]>> = {
  system: ['system/message'],
  tools: ['request/header'],
  user: ['user/message'],
  inject: ['user/message'],
  skill: ['user/message', 'tool/result'],
  assistant: ['assistant/message'],
  tool: ['tool/result'],
}

/**
 * The representative durable type of a bucket — for callers that need SOMETHING
 * to feed {@link ability} when the exact type is not at hand. It is safe to use
 * for the action set (the buckets are action-invariant) and **unfit for the
 * editor's fields** — use the type `node.read` returns for that.
 */
export function durableTypeOf(cat: RowClass): string {
  return TYPES_BY_BUCKET[cat][0] ?? 'user/message'
}

/**
 * The actions a row offers.
 *
 * ⚠️ 2026-10-09（`docs/03` R4.8）：**删除与编辑不再互斥** —— 旧口径"标了就清掉改动 /
 * 改了就把标记清掉"已作废，删除标记与编辑正文是两个独立字段。
 * 删除态仍给「丢弃这条改动」：那对应「已删除编辑稿 ──丢弃这条改动──▶ 已删除原文」
 * （只清正文、保持删除态），所以它只属于**可编辑且有改稿**的行。
 */
export function rowActions(a: Ability, hasLocalEdit: boolean, deleted = false): readonly RowAction[] {
  if (a.inert) return []
  if (deleted) {
    const kept: RowAction[] = ['unexclude']
    if (a.canRewrite && hasLocalEdit) kept.push('drop')
    return kept
  }
  if (a.shadowed || a.compacted) return []
  const actions: RowAction[] = []
  if (a.canRewrite) actions.push('edit')
  if (a.canExclude) actions.push('exclude')
  // 「丢弃这条改动」只属于**可编辑**的行（不能编辑的行根本不该有本地改动；这里有防守意义）。
  if (a.canRewrite && hasLocalEdit) actions.push('drop')
  return actions
}
