/**
 * Where a Session actually works, as opposed to which project it belongs to.
 *
 * A Session header keeps the ORIGINAL project directory forever, and DSH groups
 * the sidebar by matching that header against a workspace path. A supervisor run
 * therefore enters its isolated worktree through the Host working-directory
 * service (`workspace-root/change`), not by rewriting the header — registering
 * the run directory as a workspace of its own is exactly what this plugin must
 * not do. Every reader that needs the ledger or the checkout root must ask for
 * the effective directory; the header alone would point at the source project,
 * where a worktree run has no ledger at all.
 */

export interface EffectiveCwdContext {
  get?(name: string): unknown
}

/**
 * Resolve the effective directory of one session.
 * @param ctx - host context carrying the optional `workingDirectory` service.
 * @param session - the Session whose directory is requested.
 * @param headerCwd - the header's original project directory (the fallback).
 * @returns the committed directory, or `headerCwd` when the service is absent,
 *          returns nothing, or throws (an older composition must keep working).
 */
export function effectiveCwdOf(ctx: EffectiveCwdContext, session: unknown, headerCwd: string): string {
  const face = ctx.get?.('workingDirectory') as { get?(session: unknown): unknown } | undefined
  if (face === undefined || typeof face.get !== 'function') return headerCwd
  try {
    const directory = face.get(session)
    return typeof directory === 'string' && directory !== '' ? directory : headerCwd
  } catch {
    return headerCwd
  }
}
