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
export type ChangeRefusal = typeof REDLINE_ERROR.emptyContent | typeof REDLINE_ERROR.noChange

export type ChangeVerdict = { readonly ok: true } | { readonly ok: false; readonly code: ChangeRefusal }

export function emptyDrafts(): DraftTable {
  return {}
}

/**
 * Make a session id safe to use as a file name. Everything outside
 * `[A-Za-z0-9_-]` is percent-encoded, which keeps distinct ids distinct (`a/b`
 * and `a-b` are different files) and makes path traversal impossible (`..` and
 * a leading `.` cannot survive, since `.` is encoded).
 */
export function safeSessionId(sessionId: string): string {
  let out = ''
  for (const ch of sessionId) {
    const codePoint = ch.codePointAt(0) ?? 0
    out += /[A-Za-z0-9_-]/.test(ch) ? ch : `%${codePoint.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out === '' ? '_' : out
}

/** Our per-session draft file name (docs/02 §6). */
export function draftFileName(sessionId: string): string {
  return `redline-drafts-${safeSessionId(sessionId)}.json`
}

/** Our data directory's name, re-exported so the host has one source for it. */
export { REDLINE_DATA_DIR_NAME }

/** The edit for a row, if any. */
export function editOf(table: DraftTable, seq: number): LocalEdit | undefined {
  return table[String(seq)]
}

/** Whether a row carries a local edit. */
export function hasLocalEdit(table: DraftTable, seq: number): boolean {
  return editOf(table, seq) !== undefined
}

/** Insert or OVERWRITE the edit for one row. One row, one edit — never two. */
export function putEdit(table: DraftTable, edit: LocalEdit): DraftTable {
  return { ...table, [String(edit.seq)]: edit }
}

/** Forget one row's edit. Dropping a row that has none is a no-op. */
export function dropEdit(table: DraftTable, seq: number): DraftTable {
  const key = String(seq)
  // Existence, not value: a `Record<string, T>` indexes as `T`, so `=== undefined`
  // is both a lie to the reader and a lint error. `Object.hasOwn` is the honest check.
  if (!Object.hasOwn(table, key)) return table
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

export type ParseResult =
  | { readonly ok: true; readonly table: DraftTable }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** A missing/empty file is an empty table; anything unreadable is a loud refusal. */
export function parseDrafts(raw: string | null | undefined): ParseResult {
  if (raw === null || raw === undefined || raw.trim() === '') return { ok: true, table: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'redline/draft-corrupt', message: 'the draft file is not valid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'redline/draft-corrupt', message: 'the draft file is not an object' }
  }
  const file = parsed as Partial<DraftFile>
  if (file.schemaVersion !== REDLINE_DRAFT_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'redline/draft-schema',
      message: `unsupported draft schemaVersion: ${String(file.schemaVersion)}`,
    }
  }
  if (!Array.isArray(file.edits)) {
    return { ok: false, code: 'redline/draft-corrupt', message: 'the draft file has no edits array' }
  }
  const table: Record<string, LocalEdit> = {}
  for (const entry of file.edits) {
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, code: 'redline/draft-corrupt', message: 'a draft entry is not an object' }
    }
    const edit = entry as Partial<LocalEdit>
    if (typeof edit.seq !== 'number' || !Number.isInteger(edit.seq) || edit.seq < 0) {
      return { ok: false, code: 'redline/draft-corrupt', message: 'a draft entry has no usable seq' }
    }
    if (typeof edit.text !== 'string' || typeof edit.reasoning !== 'string' || typeof edit.isError !== 'boolean') {
      return { ok: false, code: 'redline/draft-corrupt', message: `draft #${edit.seq} has ill-typed fields` }
    }
    table[String(edit.seq)] = {
      seq: edit.seq,
      text: edit.text,
      reasoning: edit.reasoning,
      isError: edit.isError,
      updatedAt: typeof edit.updatedAt === 'string' ? edit.updatedAt : '',
      ...(typeof edit.cat === 'string' ? { cat: edit.cat } : {}),
      ...(typeof edit.name === 'string' ? { name: edit.name } : {}),
    }
  }
  return { ok: true, table }
}
