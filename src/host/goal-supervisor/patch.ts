/**
 * BLOCKED evidence: capture the task's dirty state as a patch without touching
 * the working tree, so a stuck task can be inspected or restored later.
 *
 * Two things this must not do: fail because one of the paths is a deletion
 * (`git add -N` refuses a missing path and used to abort the whole capture), and
 * unstage work the human had already staged. Both are handled by only touching
 * paths that exist and by restoring exactly the index state we found.
 */

import { execFile } from 'node:child_process'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { GuardStore } from './store'

function run(cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', [...args], { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
      resolve({ code, stdout, stderr })
    })
  })
}

/**
 * Paths that exist on disk; `git add -N` rejects the missing ones.
 *
 * `lstat`, not `access`/`stat`: both FOLLOW a symlink, so a dangling one read as
 * missing and never reached the patch — while the rollback still deleted the
 * worktree entry and its failure text claimed it had been saved. `git add -N`
 * accepts the link itself (mode 120000) and `git diff` records its target.
 */
async function existing(cwd: string, paths: readonly string[]): Promise<string[]> {
  const kept: string[] = []
  for (const path of paths) {
    try {
      await lstat(join(cwd, path))
      kept.push(path)
    } catch { /* a deleted path contributes through `git diff` only if tracked; skip it */ }
  }
  return kept
}

/**
 * Paths already staged before this capture, so they can be restored afterwards.
 *
 * `-z` and `--no-renames` are both required: with `core.quotepath` (the default)
 * git escapes a non-ASCII name as octal, so `中文.ts` never matched and the
 * capture ran `git add -N` on the human's staged file. The cleanup `git reset --`
 * then unstaged their work — a silent index change the user never asked for.
 */
async function stagedBefore(cwd: string): Promise<Set<string>> {
  const result = await run(cwd, ['diff', '--cached', '--name-only', '--no-renames', '-z'])
  if (result.code !== 0) return new Set()
  return new Set(result.stdout.split('\u0000').filter(entry => entry !== ''))
}

export interface BlockedPatch {
  /** Evidence file the captured diff was written to. */
  readonly path: string
  /**
   * Paths the written diff actually covers.
   *
   * A caller must never delete a path on the strength of a DIFFERENT path's
   * backup: the patch is built from the whole dirty set, so one unrelated dirty
   * file used to turn a single global "a patch exists" boolean into a licence to
   * remove every HEAD-absent scoped copy — including ones the diff never held.
   */
  readonly coveredPaths: ReadonlySet<string>
}

/** Save `git diff` (including untracked files) into the task's evidence directory. */
export async function captureBlockedPatch(
  cwd: string,
  store: GuardStore,
  taskId: string,
  paths: readonly string[],
  index: number,
): Promise<BlockedPatch | null> {
  if (paths.length === 0) return null
  const present = await existing(cwd, paths)
  const staged = await stagedBefore(cwd)
  const added: string[] = []
  for (const path of present) {
    // A path the human already staged keeps its content; `add -N` would reset it
    // to intent-to-add and silently unstage their work.
    if (staged.has(path)) continue
    const result = await run(cwd, ['add', '-N', '--', path])
    if (result.code === 0) added.push(path)
  }
  try {
    // `git diff` alone compares worktree against INDEX, so a change a subagent
    // already staged produced an empty patch and the rollback then cleared it
    // with no backup at all. `git diff HEAD` includes staged work; a repository
    // without a commit yet has no HEAD, and falls back to the index view.
    const head = await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    const diff = head.code === 0
      ? await run(cwd, ['diff', 'HEAD', '--binary', '--', ...paths])
      : await run(cwd, ['diff', '--binary', '--', ...paths])
    if (diff.code !== 0) return null
    if (diff.stdout.trim() === '') return null
    // Read the covered paths from the SAME diff range and path list. Parsing the
    // binary patch headers would be fragile (a file may contain "diff --git"
    // lines); a second `--name-only` query answers exactly what the diff held.
    const names = head.code === 0
      ? await run(cwd, ['diff', 'HEAD', '--name-only', '--no-renames', '-z', '--', ...paths])
      : await run(cwd, ['diff', '--name-only', '--no-renames', '-z', '--', ...paths])
    if (names.code !== 0) return null
    const coveredPaths = new Set(names.stdout.split('\u0000').filter(entry => entry !== ''))
    const target = join(store.root, 'tasks', taskId, 'evidence', `blocked-${index}.patch`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, diff.stdout, 'utf8')
    return { path: target, coveredPaths }
  } finally {
    // Unstage only what this capture introduced; a human's staged work survives.
    if (added.length > 0) await run(cwd, ['reset', '--', ...added])
  }
}
