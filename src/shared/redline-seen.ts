/**
 * The "seen" marks of result flow-back — our own store, on disk, and NOTHING in
 * a session (`docs/06` §3.3: "已处理记在我们自己的 sqlite（`pending_results`）…
 * 不写会话、不改子会话状态").
 *
 * Why a separate file per session, next to the drafts: the marks are the third
 * input of the flow-back judgement (`src/shared/redline-pending.ts`), the one
 * that cannot ride a projection. A projection is a fold over the session's log
 * and must stay replay-deterministic; a human ticking "I have seen this" is
 * neither in the log nor a function of it. So the host serves the marks over the
 * channel and the client merges them, which keeps the judgement in ONE place.
 *
 * Facts this module owns:
 *   · Marks are keyed by the NOTICE's seq — the log position of the settle
 *     notice, which is the notice's only stable identity.
 *   · A missing file is an empty mark set (that is the normal first run); an
 *     unreadable one is a loud refusal (same rule as the drafts, E13), and the
 *     message says deleting it is safe — the file is ours alone.
 *   · Marks never expire on their own. Unmarking is an explicit action.
 *
 * Purity: no `node:*` — the host half owns the file system and passes text in/out,
 * exactly like `redline-drafts.ts` (whose serialization shape this mirrors so the
 * two files are read and audited the same way).
 */

import { REDLINE_ERROR } from './redline-errors'

/** Our on-disk format version. Only bumped with a migration; there is none yet. */
export const REDLINE_SEEN_SCHEMA_VERSION = 1

/** The on-disk shape of one session's seen-marks file. */
interface SeenFile {
  schemaVersion: number
  sessionId: string
  /** Notice seqs the human has marked seen, ascending. */
  seen: number[]
}

/**
 * A stable, readable hash of the session id. Deliberately the same scheme the
 * draft file name uses (FNV-1a, 32-bit, hex): two sessions whose readable
 * prefixes collide must not share one file, and the recorded `sessionId` inside
 * is the second line of defence.
 */
function stableKeyOf(sessionId: string): string {
  let hash = 2166136261
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** The on-disk name of one session's seen-marks file. */
export function seenFileName(sessionId: string): string {
  const readable = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)
  return `redline-seen-${readable}-${stableKeyOf(sessionId)}.json`
}

/** Sorted, duplicate-free copy — the only shape this module ever hands out. */
function normalize(seqs: readonly number[]): number[] {
  return [...new Set(seqs.filter(seq => Number.isInteger(seq) && seq >= 0))].sort((a, b) => a - b)
}

/** Mark one notice seen (idempotent) — returns the new sorted list. */
export function putSeen(seqs: readonly number[], seq: number): number[] {
  return normalize([...seqs, seq])
}

/** Forget one notice's mark (idempotent) — returns the new sorted list. */
export function dropSeen(seqs: readonly number[], seq: number): number[] {
  return normalize(seqs.filter(one => one !== seq))
}

/** Whether a notice seq is currently marked seen. */
export function hasSeen(seqs: readonly number[], seq: number): boolean {
  return seqs.includes(seq)
}

/** Serialize one session's marks. Written atomically by the host (`.tmp` + rename). */
export function serializeSeen(sessionId: string, seqs: readonly number[]): string {
  const file: SeenFile = { schemaVersion: REDLINE_SEEN_SCHEMA_VERSION, sessionId, seen: normalize(seqs) }
  return `${JSON.stringify(file, null, 2)}\n`
}

export type SeenParseResult =
  | { readonly ok: true; readonly seen: number[] }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** A missing/empty file is an empty mark set; anything unreadable is a loud refusal. */
export function parseSeen(raw: string | null | undefined, expectedSessionId?: string): SeenParseResult {
  if (raw === null || raw === undefined || raw.trim() === '') return { ok: true, seen: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: REDLINE_ERROR.seenCorrupt, message: 'the seen file is not valid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: REDLINE_ERROR.seenCorrupt, message: 'the seen file is not an object' }
  }
  const file = parsed as Partial<SeenFile>
  // The same cross-session defence the draft file carries: if the name was
  // reused, refuse instead of attributing another session's marks to this one.
  if (expectedSessionId !== undefined && file.sessionId !== expectedSessionId) {
    return {
      ok: false,
      code: REDLINE_ERROR.seenCorrupt,
      message: `the seen file belongs to another session (${String(file.sessionId)})`,
    }
  }
  if (file.schemaVersion !== REDLINE_SEEN_SCHEMA_VERSION) {
    return {
      ok: false,
      code: REDLINE_ERROR.seenSchema,
      message: `unsupported seen schemaVersion: ${String(file.schemaVersion)}`,
    }
  }
  if (!Array.isArray(file.seen)) {
    return { ok: false, code: REDLINE_ERROR.seenCorrupt, message: 'the seen file has no seen array' }
  }
  for (const seq of file.seen) {
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
      return { ok: false, code: REDLINE_ERROR.seenCorrupt, message: 'the seen file has an unusable seq' }
    }
  }
  return { ok: true, seen: normalize(file.seen) }
}
