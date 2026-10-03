/**
 * Where 上下文批改 keeps its OWN files. Nothing here is model-visible: the
 * whole point of the product is that an edit stays local until the human opens
 * a child session with it (`docs/11` D15, `AGENTS.md` §1).
 *
 * The data directory is `$DSH_HOME/<REDLINE_DATA_DIR_NAME>` (`docs/02` §6).
 * This module is the ONLY place allowed to spell that name: the host half joins
 * it onto the harness home, and the namespace contract asserts that the joined
 * directory is ours and not upstream's (`docs/01` F4).
 *
 * Purity note: this file is imported by BOTH halves, so it must stay
 * dependency-free — no `node:path`, no DOM. The host half does the joining.
 */

/**
 * The data directory's name under the harness home. Namespaced, because two
 * plugins writing one directory would silently overwrite each other's drafts
 * (the collision upstream cannot have — it never writes anything).
 */
export const REDLINE_DATA_DIR_NAME = 'dsh-context-redline'
