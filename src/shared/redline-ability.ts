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
  /** The "advanced" class: `Edit` is hidden behind the advanced switch (`docs/03` R2.5). */
  readonly advancedOnly: boolean
  /** Present exactly when `canRewrite` is false — including inert rows, which still need a reason line. */
  readonly blockReason?: BlockReason
}

/** One row's actions. `drop` appears only when a local edit exists. */
export type RowAction = 'edit' | 'drop'

export function ability(row: SurfaceRow): Ability {
  const inert = row.cat === 'system' || row.cat === 'tools'
  const canRewrite = !inert && !row.shadowed && row.type !== 'assistant/message' && !row.compacted
  return {
    canRewrite,
    inert,
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
        blockReason: inert
          ? 'system-head'
          : row.type === 'assistant/message'
            ? 'assistant-immutable'
            : row.shadowed ? 'shadowed' : 'compacted',
      }),
  }
}

/** The actions a row offers, given whether it carries a local edit. */
export function rowActions(a: Ability, hasLocalEdit: boolean): readonly RowAction[] {
  if (!a.canRewrite) return []
  return hasLocalEdit ? ['edit', 'drop'] : ['edit']
}
