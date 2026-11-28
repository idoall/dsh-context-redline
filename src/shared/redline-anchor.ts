/** Pure anchors for a plain root conversation: goal, acceptance and discipline. */

import { carrierContentFingerprint } from './redline-carrier'

/** Per-field bound; keeps one accidental paste from becoming the whole prompt. */
export const ANCHOR_FIELD_LIMIT = 4000

export interface AnchorDraft {
  /** First user message; becomes the conversation's opening task. */
  readonly task: string
  /** The goal kept in the runtime snapshot. */
  readonly goal: string
  /** What counts as done; completion gate. */
  readonly acceptance: string
  /** Operating discipline, including the "fix errors, do not change the goal" rule. */
  readonly discipline: string
}

export interface AnchorComposition {
  /** Exact runtime-context snapshot registered on the new carrier session. */
  readonly text: string
  /** Fingerprint of that exact snapshot. */
  readonly fingerprint: string
}

function fieldsOf(draft: AnchorDraft): readonly string[] {
  return [draft.task, draft.goal, draft.acceptance, draft.discipline].map(value => value.trim())
}

/**
 * Compose the exact runtime snapshot for one anchored conversation.
 *
 * The task stays out of the snapshot: it is the first user message. The three
 * remaining fields are the durable target the runtime context re-declares after
 * compaction.
 *
 * @param draft - human-written task, goal, acceptance and discipline.
 * @returns exact snapshot text and its content fingerprint.
 */
export function composeAnchor(draft: AnchorDraft): AnchorComposition {
  const [task, goal, acceptance, discipline] = fieldsOf(draft)
  for (const value of [task, goal, acceptance, discipline]) {
    if (value === '') throw new Error('anchor field is empty')
    if (value.length > ANCHOR_FIELD_LIMIT) throw new Error('anchor field is too long')
  }
  const text = `目标：${goal}\n\n验收：${acceptance}\n\n纪律：${discipline}`
  return { text, fingerprint: carrierContentFingerprint(text) }
}

/** Confirmation fingerprint over every field, including the first task. */
export function anchorRequestFingerprint(draft: AnchorDraft): string {
  const [task, goal, acceptance, discipline] = fieldsOf(draft)
  return carrierContentFingerprint(JSON.stringify({ task, goal, acceptance, discipline }))
}

/** Longest session title we keep; anything longer is cut at a natural boundary. */
const TITLE_MAX = 48
/** A boundary earlier than this would leave a title too short to identify anything. */
const TITLE_BOUNDARY_MIN = 8
/** A sentence end inside the window is a title by itself: keep it, no ellipsis. */
const SENTENCE_END = /[。！？!?]/
/** A clause break is a decent cut, but the title must say that it was cut. */
const CLAUSE_BREAK = /[，、；：,;:]/

function titleOf(raw: string): string {
  const flat = raw.trim().replace(/\s+/g, ' ')
  if (flat.length <= TITLE_MAX) return flat
  const head = flat.slice(0, TITLE_MAX)
  for (let index = head.length - 1; index >= TITLE_BOUNDARY_MIN; index -= 1) {
    if (SENTENCE_END.test(head[index] ?? '')) return head.slice(0, index + 1)
  }
  for (let index = head.length - 1; index >= TITLE_BOUNDARY_MIN; index -= 1) {
    if (CLAUSE_BREAK.test(head[index] ?? '')) return `${head.slice(0, index).trimEnd()}…`
  }
  // No punctuation at all: a hard cut, but leave room for the ellipsis so the
  // title never exceeds the cap.
  return `${flat.slice(0, TITLE_MAX - 1)}…`
}

/** One-line title for the new session, derived from the goal (no generic prefix). */
export function anchorTitle(draft: AnchorDraft): string {
  const goal = titleOf(draft.goal)
  const task = titleOf(draft.task)
  return goal || task || '未命名会话'
}
