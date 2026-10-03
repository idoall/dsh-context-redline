/**
 * Reading ONE event's complete content — the only source the editor may prefill or
 * commit from (`docs/01` F35, `docs/00` S3, `AGENTS.md` §2.3).
 *
 * Why this exists at all: the host's projection carries `firstText(blocks)` —
 * `text.replace(/\s+/g,' ').trim().slice(0,80)` — an **80-character, folded
 * preview**. The earlier attempt prefilled the editor from it and therefore
 * truncated a whole message the first time anyone pressed save. So the rule is
 * absolute: prefill/commit/compare all read the durable event.
 *
 * Joining rule (deliberate, and tested): consecutive non-empty `text` blocks are
 * joined with a BLANK LINE, and each block's own characters are preserved
 * exactly — no trimming, no whitespace folding, no ellipsis. A block boundary is
 * a paragraph boundary.
 *
 * ⚠️ We do NOT import `@deepseek-ai/dsh-session-query`'s `extractSessionEventText`,
 * which is the platform's own extractor for exactly this. Two measured reasons
 * (`docs/01` F41/F42): the package is not resolvable from a profile-installed
 * plugin (the profile layer ships only a handful of `@deepseek-ai` packages), and
 * the host bundle inlines everything that is not a declared production
 * dependency — so an import would either crash at load or duplicate the package.
 * This module is therefore self-contained, and pinned to the durable shapes by
 * the `fulltext` spec.
 *
 * Purity: no `node:*`, no DOM, no React — both halves may import it.
 */

/** The little of a durable event this module needs. Unsanitized input: this module is fed whatever the host hands over. */
export interface ReadableEvent {
  readonly type?: unknown
  readonly seq?: unknown
  readonly data?: unknown
}

/** Content-block carriers per durable event type (mirrors the host fold). */
function messageOf(data: Record<string, unknown>): Record<string, unknown> | null {
  const message = data.message
  return message !== null && typeof message === 'object' ? message as Record<string, unknown> : null
}

/** The block array holding the visible/reasoning text of THIS event type. */
function blocksOf(event: ReadableEvent | null | undefined): readonly unknown[] {
  if (event === null || event === undefined || typeof event !== 'object') return []
  const data = event.data
  if (data === null || data === undefined || typeof data !== 'object') return []
  const bag = data as Record<string, unknown>
  switch (event.type) {
    case 'user/message':
    case 'system/message':
      return Array.isArray(bag.content) ? bag.content as unknown[] : []
    case 'assistant/message':
    case 'tool/result': {
      const message = messageOf(bag)
      const content = message === null ? undefined : message.content
      return Array.isArray(content) ? content as unknown[] : []
    }
    default:
      return []
  }
}

/** Every non-empty `text` block of an event, in order, verbatim. */
export function textBlocksOf(event: ReadableEvent | null | undefined): string[] {
  const out: string[] = []
  for (const item of blocksOf(event)) {
    if (item === null || typeof item !== 'object') continue
    const block = item as { type?: unknown; text?: unknown }
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    if (block.text.trim() === '') continue
    out.push(block.text)
  }
  return out
}

/** Every non-empty `reasoning` block of an event, in order, verbatim. */
export function reasoningBlocksOf(event: ReadableEvent | null | undefined): string[] {
  const out: string[] = []
  for (const item of blocksOf(event)) {
    if (item === null || typeof item !== 'object') continue
    const block = item as { type?: unknown; text?: unknown }
    if (block.type !== 'reasoning' || typeof block.text !== 'string') continue
    if (block.text.trim() === '') continue
    out.push(block.text)
  }
  return out
}

/** The complete visible text. `''` for a non-readable or textless event. */
export function fullTextOf(event: ReadableEvent | null | undefined): string {
  return textBlocksOf(event).join('\n\n')
}

/** The complete thinking text, kept separate from the visible text. */
export function fullReasoningOf(event: ReadableEvent | null | undefined): string {
  return reasoningBlocksOf(event).join('\n\n')
}

/**
 * The event's error mark. Only `tool/result` carries one, and the host spells it
 * three ways (a top-level `error`, `message.isError`, or a nested block flag).
 */
export function isErrorOf(event: ReadableEvent | null | undefined): boolean {
  if (event === null || event === undefined || typeof event !== 'object' || event.type !== 'tool/result') return false
  const data = event.data
  if (data === null || data === undefined || typeof data !== 'object') return false
  const bag = data as Record<string, unknown>
  if (bag.error !== undefined && bag.error !== null && bag.error !== false && bag.error !== '') return true
  const message = messageOf(bag)
  if (message === null) return false
  if (message.isError === true) return true
  const content = message.content
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item !== null && typeof item === 'object' && (item as { isError?: unknown }).isError === true) return true
    }
  }
  return false
}

/** The event's seq, or null when it does not carry a usable one. */
export function seqOf(event: ReadableEvent | null | undefined): number | null {
  const seq = event === null || event === undefined ? undefined : event.seq
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : null
}

/** The event's durable type, or `''`. */
export function typeOf(event: ReadableEvent | null | undefined): string {
  if (event === null || event === undefined) return ''
  return typeof event.type === 'string' ? event.type : ''
}
