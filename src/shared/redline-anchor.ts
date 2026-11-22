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

/** One-line title for the new session, derived from the goal (no generic prefix). */
export function anchorTitle(draft: AnchorDraft): string {
  const goal = draft.goal.trim().replace(/\s+/g, ' ').slice(0, 48)
  const task = draft.task.trim().replace(/\s+/g, ' ').slice(0, 48)
  return goal || task || '未命名会话'
}
