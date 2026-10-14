/**
 * The 上下文批改 RPC surface shared by BOTH halves — the single source of truth
 * for the route path, request/response envelope, and operation vocabulary.
 * This is the only place allowed to spell the path: duplicating it risks a
 * silent Client/Host drift into 404s.
 *
 * Namespacing is a HARD constraint, not a preference: the connection registry
 * THROWS on a duplicate exact path (`exact Fetch route "…" is already
 * registered`), and the panel coexists with `dsh-context@0.60.0`, which owns
 * `/api/dsh-context/*` (`docs/01` F1, `UPSTREAM.md` §3.1 row 1).
 */

/** Our authenticated `/api` prefix. Everything below hangs off it. */
export const REDLINE_API_PREFIX = '/api/dsh-context-redline'

/**
 * The edit-surface channel: ONE endpoint with an `op` discriminator
 * (`docs/02` §5.2), so adding an op never adds a route.
 */
export const REDLINE_CHANNEL_ROUTE = `${REDLINE_API_PREFIX}/redline`

/** Upstream's on-demand timeline detail route, renamed (M1-04). */
export const REDLINE_DETAIL_ROUTE = `${REDLINE_API_PREFIX}/detail`

/** Upstream's platform-balance route, renamed (M1-04). */
export const REDLINE_BALANCE_ROUTE = `${REDLINE_API_PREFIX}/balance`

/** Upstream's cold-history warm-up route, renamed (M1-04). */
export const REDLINE_BACKFILL_ROUTE = `${REDLINE_API_PREFIX}/backfill`

/** Every route this plugin registers, for the namespace contract and tests. */
export const REDLINE_ROUTES: readonly string[] = [
  REDLINE_CHANNEL_ROUTE,
  REDLINE_DETAIL_ROUTE,
  REDLINE_BALANCE_ROUTE,
  REDLINE_BACKFILL_ROUTE,
]

/** Success envelope (`docs/02` §5.1). */
export interface RedlineOk<T> {
  readonly ok: true
  readonly value: T
}

/** Failure envelope: a STABLE machine code plus a short wire message. */
export interface RedlineFailure {
  readonly ok: false
  readonly error: {
    /** One of `REDLINE_ERROR` (`src/shared/redline-errors.ts`). */
    readonly code: string
    /** Short English wire text. The user-facing wording is the client's i18n. */
    readonly message: string
  }
}

export type RedlineEnvelope<T> = RedlineOk<T> | RedlineFailure

/**
 * One call on the channel. `op` is the discriminator; every other field is
 * op-specific. The vocabulary itself is declared with its handlers in
 * `src/host/redline-channel.ts` (M2 fills the table).
 */
export interface RedlineCall {
  readonly op: string
  readonly sessionId?: string
  readonly [field: string]: unknown
}

/** The success half of the envelope. */
export function redlineOk<T>(value: T): RedlineOk<T> {
  return { ok: true, value }
}

/** The failure half of the envelope. */
export function redlineFailure(code: string, message: string): RedlineFailure {
  return { ok: false, error: { code, message } }
}

/**
 * Narrow an untrusted JSON body to a {@link RedlineCall}. Returns null for
 * anything that is not an object with a non-empty string `op`.
 */
export function asRedlineCall(body: unknown): RedlineCall | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const op = (body as { op?: unknown }).op
  if (typeof op !== 'string' || op === '') return null
  return body as RedlineCall
}
