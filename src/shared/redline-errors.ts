/**
 * The stable error-code table shared by BOTH halves — the plugin's outward
 * contract (`docs/11-session-handoff.md` 实施共识 §5, `docs/02` §7).
 *
 * Why a frozen table instead of ad-hoc strings: the client maps a code to the
 * human wording of `docs/03` R4.7, and the tests assert the code (never the
 * message). A code that changes shape silently turns "这一条改不了，因为…" into
 * a raw provider error, which is exactly the failure this project exists to
 * avoid.
 *
 * The `redline/` prefix keeps these out of any host or upstream namespace.
 */

/** Every code the channel can answer with. */
export const REDLINE_ERROR = {
  /** The body was not JSON, or lacked a usable `op`/`sessionId`. */
  badRequest: 'redline/bad-request',
  /** The op is not in the channel's table (an older client, or a typo). */
  unknownOp: 'redline/unknown-op',
  /** The target session has no live Agent in this process (`docs/01` F9). */
  notLive: 'redline/not-live',
  /** The session has an open turn: edits must land on a turn boundary (`docs/01` F8). */
  turnOpen: 'redline/turn-open',
  /** No local draft exists for that seq. */
  noDraft: 'redline/no-draft',
  /** The draft is identical to the version already in effect. */
  noChange: 'redline/no-change',
  /** `assistant/message` cannot be rewritten on this platform (`docs/01` F7.2). */
  assistantImmutable: 'redline/assistant-immutable',
  /** The target is no longer a surface node (it was replaced) (`docs/01` F7). */
  shadowed: 'redline/shadowed',
  /** A range argument was half-given or reversed. */
  badRange: 'redline/bad-range',
  /** The full text of that version cannot be read back on this platform. */
  historyUnavailable: 'redline/history-unavailable',
  /** The underlying event type has no rewrite path at all. */
  unsupportedType: 'redline/unsupported-type',
  /** An op handler threw. Never a platform code — the message carries that. */
  internal: 'redline/internal',
} as const

export type RedlineErrorCode = (typeof REDLINE_ERROR)[keyof typeof REDLINE_ERROR]

/**
 * Short English wire text per code. Deliberately NOT the user-facing sentence:
 * the client owns the localized wording (`docs/03` R4.7), and a wire message
 * that reads like UI copy is how two different sentences for one condition get
 * shipped.
 */
export const REDLINE_ERROR_MESSAGE: Readonly<Record<RedlineErrorCode, string>> = {
  [REDLINE_ERROR.badRequest]: 'body is not a valid redline call',
  [REDLINE_ERROR.unknownOp]: 'unknown redline op',
  [REDLINE_ERROR.notLive]: 'session is not live in this process',
  [REDLINE_ERROR.turnOpen]: 'the session has an open turn',
  [REDLINE_ERROR.noDraft]: 'no local draft for that seq',
  [REDLINE_ERROR.noChange]: 'the draft does not change the effective text',
  [REDLINE_ERROR.assistantImmutable]: 'assistant/message cannot be rewritten',
  [REDLINE_ERROR.shadowed]: 'that seq is no longer a surface node',
  [REDLINE_ERROR.badRange]: 'bad void range',
  [REDLINE_ERROR.historyUnavailable]: 'the full text of that version is not readable',
  [REDLINE_ERROR.unsupportedType]: 'this event type has no rewrite path',
  [REDLINE_ERROR.internal]: 'the op handler failed',
}

/** Whether `code` is one of ours (used by the client to pick the R4.7 wording). */
export function isRedlineErrorCode(code: string): code is RedlineErrorCode {
  return Object.values(REDLINE_ERROR).includes(code as RedlineErrorCode)
}
