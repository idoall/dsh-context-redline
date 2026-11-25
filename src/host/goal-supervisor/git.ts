/**
 * Small, explicit git surface for the supervisor.
 *
 * The plugin only ever touches the paths the current task declared (plus its
 * own `docs/guard/<run-id>/` records); it never switches branches, never resets
 * the whole worktree, and treats a missing git repository as "no checkpoints".
 */

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { sanitizeRefSegment } from './run-id'

export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function run(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', [...args], {
      cwd,
      maxBuffer: 1024 * 1024,
      ...(env === undefined ? {} : { env }),
    }, (error, stdout, stderr) => {
      const code = error === null
        ? 0
        : typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : 1
      resolve({ code, stdout, stderr })
    })
  })
}

/** True when `cwd` is inside a git work tree. */
export async function hasGit(cwd: string): Promise<boolean> {
  const result = await run(cwd, ['rev-parse', '--is-inside-work-tree'])
  return result.code === 0 && result.stdout.trim() === 'true'
}

/** Current commit, or `null` for a repository without any commit yet. */
export async function headCommit(cwd: string): Promise<string | null> {
  const result = await run(cwd, ['rev-parse', 'HEAD'])
  return result.code === 0 ? result.stdout.trim() : null
}

/** True when the path belongs to the run's own ledger directory. */
function inGuardDir(path: string, guardDir: string): boolean {
  return path === guardDir || path.startsWith(`${guardDir}/`)
}

/**
 * Changed and untracked paths, excluding the run's own ledger directory.
 *
 * `git status -z` emits rename/copy entries as TWO NUL-separated records: the
 * destination followed by the source. The source is consumed first (whatever it
 * turns out to be), and a rename contributes BOTH paths — otherwise moving a
 * file out of the task's scope looked like a clean tree.
 */
export async function changedPaths(cwd: string, guardDir: string): Promise<string[]> {
  const result = await run(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])
  if (result.code !== 0) return []
  const entries = result.stdout.split('\u0000').filter(entry => entry !== '')
  const paths: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? ''
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    const paired = status.includes('R') || status.includes('C')
    // Always consume the paired source record, even when the destination is
    // filtered out below, or the next entry would be parsed as a status line.
    const source = paired ? entries[++index] : undefined
    if (!inGuardDir(path, guardDir)) paths.push(path)
    // Only a RENAME removes the original. A COPY leaves it in place — and git
    // only reports a copy pair when the source is ALSO modified, which gives it
    // its own entry anyway — so the copy's source is never a change by itself.
    if (status.includes('R') && source !== undefined && source !== '' && !inGuardDir(source, guardDir)) paths.push(source)
  }
  return [...new Set(paths)]
}

/**
 * Everything this run changed since `baseCommit`: the committed delta plus the
 * still-uncommitted working tree.
 *
 * A subagent can `git commit` its own work through `bash`. Looking only at
 * `git status` would then report a clean tree and let an out-of-scope commit
 * through the `enforce` gate, so the audit also walks the commit range.
 */
export interface ChangedSinceOptions {
  /** Run id whose own `guard(<runId>): <task> DONE` commits belong to siblings. */
  readonly runId: string
  /** Task being audited; a commit for this task is not a sibling's. */
  readonly taskId: string
}

/** `guard(<runId>): <task> DONE` — the plugin's own per-task commit subject. */
function ownCommitSubject(runId: string, taskId: string): string {
  return `guard(${runId}): ${taskId} DONE`
}

/**
 * Everything this task changed since `baseCommit`: its own commits plus the
 * still-uncommitted working tree.
 *
 * Two sources, and both are needed:
 *   - a subagent can `git commit` its own work through `bash`, which leaves a
 *     clean `git status` and would hide an out-of-scope write from `enforce`;
 *   - a parallel sibling that finished in an EARLIER turn also committed inside
 *     this range, and its files are not this task's business. The plugin's own
 *     commit subject names the task, so those commits are skipped unless they
 *     belong to the task being audited.
 */
/**
 * Paths committed in `baseCommit..HEAD` (net), excluding sibling plugin commits.
 *
 * Kept separate from `changedPathsSince` so callers can tell committed changes
 * from uncommitted worktree edits: a future `TODO` task's file committed during
 * an earlier task would land below that task's `baseCommit` and break its audit
 * and rollback, so it must never receive the uncommitted-worktree exemption.
 */
export async function committedPathsSince(
  cwd: string,
  baseCommit: string,
  guardDir: string,
  options?: ChangedSinceOptions,
): Promise<string[]> {
  const paths = new Set<string>()
  if (options === undefined) {
    const committed = await run(cwd, ['diff', '--name-only', '-z', '--no-renames', `${baseCommit}..HEAD`])
    if (committed.code === 0) {
      for (const path of committed.stdout.split('\u0000').filter(entry => entry !== '')) {
        if (!inGuardDir(path, guardDir)) paths.add(path)
      }
    }
    return [...paths]
  }
  const ownSubject = ownCommitSubject(options.runId, options.taskId)
  // Real proof of authorship: the tags this plugin created, not the message.
  const ownShas = await pluginCommitShas(cwd, options.runId)
  // What the range actually changed, net. Per-commit attribution alone would
  // keep blaming a file that a rollback already reverted: the original commit
  // and its `Revert` both mention it, yet nothing in HEAD differs any more.
  const net = new Set<string>()
  const netDiff = await run(cwd, ['diff', '--name-only', '-z', '--no-renames', `${baseCommit}..HEAD`])
  if (netDiff.code !== 0) return []
  for (const path of netDiff.stdout.split('\u0000').filter(entry => entry !== '')) {
    if (!inGuardDir(path, guardDir)) net.add(path)
  }
  const log = await run(cwd, ['log', '--format=%H%x09%s', `${baseCommit}..HEAD`])
  if (log.code !== 0) {
    for (const path of net) paths.add(path)
    return [...paths]
  }
  for (const line of log.stdout.split('\n')) {
    const [sha = '', subject = ''] = line.split('\t')
    // Only a missing sha skips a commit. An empty SUBJECT is a commit with
    // `--allow-empty-message`, and skipping it hid every path it changed from
    // the `enforce` audit entirely.
    if (sha === '') continue
    // The plugin's own commit for a different task is a sibling's work. A commit
    // counts only when its tag says so: a matching message alone is forgeable.
    if (sha !== '' && ownShas.has(sha) && subject !== ownSubject) continue
    // `-m` also lists a merge commit's own changes; without it a merge brings in
    // files that no ordinary `show` ever reports.
    const files = await run(cwd, ['show', '--pretty=format:', '--name-only', '-z', '--no-renames', '-m', '--first-parent', sha])
    if (files.code !== 0) continue
    for (const path of files.stdout.split('\u0000').filter(entry => entry !== '')) {
      // Only a path this range still differs in counts; a reverted one does not.
      if (!inGuardDir(path, guardDir) && net.has(path)) paths.add(path)
    }
  }
  return [...paths]
}

export async function changedPathsSince(
  cwd: string,
  baseCommit: string,
  guardDir: string,
  options?: ChangedSinceOptions,
): Promise<string[]> {
  const paths = new Set(await changedPaths(cwd, guardDir))
  for (const path of await committedPathsSince(cwd, baseCommit, guardDir, options)) {
    paths.add(path)
  }
  return [...paths]
}

function clipUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const suffix = '\n…(truncated)'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'))
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > budget) break
    out += char
    used += size
  }
  return `${out}${suffix}`
}

/**
 * Bounded excerpt of the task's in-scope changes for the independent evaluator.
 *
 * Uses `git diff` against `baseCommit` (or `HEAD`) for tracked edits and falls
 * back to bounded file reads for untracked or non-git files. Never throws.
 */
export async function scopeDiffExcerpt(
  cwd: string,
  baseCommit: string | undefined,
  paths: readonly string[],
  maxBytes = 4000,
): Promise<string> {
  if (paths.length === 0 || maxBytes <= 0) return ''
  const target = paths.slice(0, 20)
  const sections: string[] = []
  const covered = new Set<string>()
  if (await hasGit(cwd)) {
    const base = baseCommit ?? (await headCommit(cwd))
    if (base !== null) {
      const diff = await run(cwd, ['diff', '--no-color', '--no-ext-diff', base, '--', ...target])
      if (diff.code === 0 && diff.stdout.trim() !== '') {
        sections.push(diff.stdout.trim())
        for (const line of diff.stdout.split('\n')) {
          const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
          if (match?.[2] !== undefined) covered.add(match[2])
        }
      }
    }
  }
  for (const path of target) {
    if (covered.has(path)) continue
    try {
      const raw = await readFile(join(cwd, path))
      if (raw.includes(0)) continue
      const text = raw.toString('utf8').trimEnd()
      if (text !== '') sections.push(`--- ${path} (untracked/new)\n${clipUtf8(text, 1500)}`)
    } catch { /* deleted or unreadable */ }
  }
  return sections.length === 0 ? '' : clipUtf8(sections.join('\n\n'), maxBytes)
}

/**
 * Content hash of every path dirty right now, excluding the run's own ledger.
 *
 * Captured ONCE at run creation: it is the only honest "was already dirty"
 * baseline. Capturing it later would bake the model's own first-turn writes into
 * the baseline and hide them from every later scope check.
 */
export async function dirtyHashes(cwd: string, guardDir: string, limit = 200): Promise<Record<string, string>> {
  const paths = (await changedPaths(cwd, guardDir)).slice(0, limit)
  const hashes: Record<string, string> = {}
  for (const path of paths) {
    try {
      hashes[path] = createHash('sha256').update(await readFile(join(cwd, path))).digest('hex')
    } catch {
      hashes[path] = 'deleted'
    }
  }
  return hashes
}

/** Content hash of one workspace path; `'deleted'` when it cannot be read. */
export async function hashPath(cwd: string, path: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(join(cwd, path))).digest('hex')
  } catch {
    return 'deleted'
  }
}

/** True when `path` still matches the hash captured for it at run creation. */
export async function matchesBaseline(
  cwd: string,
  baseline: Readonly<Record<string, string>>,
  path: string,
): Promise<boolean> {
  if (!Object.hasOwn(baseline, path)) return false
  return baseline[path] === await hashPath(cwd, path)
}

/**
 * One normalization for every scope decision: trim, backslashes, empty
 * segments, `.` segments, leading/trailing slashes.
 *
 * It lives here, next to the matcher, and every producer (`create`, the channel,
 * the scope adjudicator) stores its result: a scope saved as `././src/a.ts` or
 * `src\a.ts` would otherwise never match the worktree-relative paths `git
 * status` reports, and would not even be seen as overlapping the same path
 * declared another way.
 *
 * Empty and `.` segments are folded too: `docs//guard/x` and `docs/./guard/x`
 * address exactly the same file, yet the sensitive-directory rules run on the
 * literal string — two separators used to make a guarded path look ordinary.
 * A leading separator is preserved, so an absolute path stays recognizably
 * absolute for `isSafeScopePath`.
 */
export function normalizeScopePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/')
  const absolute = trimmed.startsWith('/')
  const segments = trimmed.split('/').filter(segment => segment !== '' && segment !== '.')
  const joined = segments.join('/')
  // The root itself has no segments. Dropping the separator turned `/`, `///` and
  // `/.` into `''`, which every caller read as "no scope": `isSafeScopePath('')`
  // accepted it, `matchesGlob(path, '')` matched everything, and a request adding
  // `/` was parked as an innocuous empty scope. Keep the root recognizable.
  return absolute ? `/${joined}` : joined
}

/** A glob matcher sufficient for scope declarations (`*`, `?`, `**`). */
export function matchesGlob(path: string, glob: string): boolean {
  const normalized = normalizeScopePath(glob)
  if (normalized === '' || normalized === '.') return true
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // `**/` spans zero or more directories: `src/**/*.ts` must match `src/a.ts`.
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0000/g, '.*')
  // A pattern that already names a file suffix must not also accept `x.ts/sub`.
  // A dot DIRECTORY (`.github`, `v1.0`) is not a suffix: only a final segment that
  // looks like `name.ext` counts, so `src/v1.0` still matches below itself.
  const last = normalized.split('/').at(-1) ?? ''
  const suffix = /^[^./][^/]*\.[A-Za-z0-9]+$/.test(last)
  const branches = /[^/]$/.test(escaped) && suffix ? '' : '(?:/.*)?'
  const pattern = `^${escaped}${branches}$`
  return new RegExp(pattern).test(path)
}

export function pathInScope(path: string, scope: readonly string[]): boolean {
  return scope.length === 0 || scope.some(glob => matchesGlob(path, glob))
}

/* Scope-overlap helpers shared by the batch selector and the scope adjudicator. */

const GLOB_CHARS = /[*?]/

function hasGlob(value: string): boolean {
  return GLOB_CHARS.test(value)
}

/** Everything before the first wildcard, trimmed to its directory. */
function staticPrefix(glob: string): string {
  const index = glob.search(GLOB_CHARS)
  if (index < 0) return glob
  const prefix = glob.slice(0, index)
  const slash = prefix.lastIndexOf('/')
  return slash < 0 ? '' : prefix.slice(0, slash)
}

/**
 * Conservative overlap test between two declared scopes.
 *
 * A literal path that contains another is an overlap; a wildcard overlaps when
 * the static directory prefixes share a root, which is the only safe answer
 * without expanding the glob against a live tree.
 */
export function globsOverlap(left: string, right: string): boolean {
  const a = normalizeScopePath(left)
  const b = normalizeScopePath(right)
  if (a === '' || b === '' || a === '.' || b === '.') return true
  if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true
  if (!hasGlob(a) && !hasGlob(b)) return false
  const sa = staticPrefix(a)
  const sb = staticPrefix(b)
  if (sa === '' || sb === '') return true
  return sa === sb || sa.startsWith(`${sb}/`) || sb.startsWith(`${sa}/`)
}

export function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return true
  return left.some(a => right.some(b => globsOverlap(a, b)))
}

export interface CommitResult {
  readonly created: boolean
  readonly sha: string | null
}

/** Index entries (relative paths) staged right now; `null` when git refused. */
async function stagedNames(cwd: string): Promise<Set<string> | null> {
  // `--no-renames` is load-bearing: with rename detection ON, `git mv a.ts b.ts`
  // is reported as ONE destination, the source is filtered out of the commit
  // pathspec and the checkpoint keeps both files while `D a.ts` stays staged.
  const result = await run(cwd, ['diff', '--cached', '--name-only', '--no-renames', '-z'])
  if (result.code !== 0) return null
  return new Set(result.stdout.split('\u0000').filter(entry => entry !== ''))
}

/** Index paths staged for DELETION right now; `null` when git refused. */
async function stagedDeletions(cwd: string): Promise<Set<string> | null> {
  const result = await run(cwd, ['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=D', '-z'])
  if (result.code !== 0) return null
  return new Set(result.stdout.split('\u0000').filter(entry => entry !== ''))
}

/**
 * True when anything (file, directory or SYMLINK) exists at `path`.
 *
 * `lstat`, not `access`: following a symlink reports a dangling one as missing,
 * and `git add` would then be skipped for a path the worktree really holds.
 */
async function existsAt(cwd: string, path: string): Promise<boolean> {
  try {
    await lstat(join(cwd, path))
    return true
  } catch {
    return false
  }
}

/** What the worktree holds under EXACTLY this spelling. */
interface WorktreeEntry {
  readonly exists: boolean
  readonly exactCase: boolean
  readonly directory: boolean
}

/**
 * Exact-case, file-versus-directory view of one worktree path.
 *
 * `lstat` alone cannot answer either question on a case-insensitive filesystem
 * (macOS APFS with `core.ignorecase=true`, Windows): `lstat('a.ts')` resolves to
 * the disk's `A.ts`. Walking the segments and comparing `readdir` output pins the
 * real spelling, and `isDirectory` separates a file from a same-name directory —
 * exactly the two shapes that made `git mv a.ts A.ts` and a `git rm`-ed file
 * replaced by a directory of the same name fail at commit time.
 */
async function inspectEntry(cwd: string, path: string): Promise<WorktreeEntry> {
  let directory: boolean
  try {
    directory = (await lstat(join(cwd, path))).isDirectory()
  } catch {
    return { exists: false, exactCase: false, directory: false }
  }
  return { exists: true, exactCase: await spelledExactly(cwd, path), directory }
}

/** True when every segment of `path` is spelled the way the disk spells it. */
async function spelledExactly(cwd: string, path: string): Promise<boolean> {
  let current = cwd
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    let entries: string[]
    try {
      entries = await readdir(current)
    } catch {
      return false
    }
    if (!entries.includes(segment)) return false
    current = join(current, segment)
  }
  return true
}

/** True when `path` is an index entry or a directory that holds one. */
function presentInIndex(index: ReadonlySet<string>, path: string): boolean {
  // A directory target may be spelled with a trailing slash (`nested/` from
  // `git status`), while git stores the entry without one (`nested` for an
  // untracked nested repository staged as a gitlink). Compare both forms before
  // falling back to the child prefix, or the task's own target is filtered out
  // and its staged entry is left behind in the real index.
  const base = path.endsWith('/') ? path.slice(0, -1) : path
  if (index.has(path) || (base !== '' && index.has(base))) return true
  const prefix = base === '' ? '' : `${base}/`
  if (prefix === '') return false
  for (const entry of index) {
    if (entry.startsWith(prefix)) return true
  }
  return false
}

/** True when the repository treats the worktree as case-insensitive. */
async function ignoresCase(cwd: string): Promise<boolean> {
  const result = await run(cwd, ['config', '--bool', '--get', 'core.ignorecase'])
  return result.code === 0 && result.stdout.trim() === 'true'
}

/**
 * True when git tracks EXACTLY this path as a regular file or symlink BLOB.
 *
 * A directory now occupying the name of a tracked file is a file-to-directory
 * REPLACEMENT: HEAD still holds a blob there, or — in a repository without a
 * commit yet — the index holds an exact blob entry. A committed directory
 * resolves to a tree, which is not a file.
 *
 * A checked-out submodule is the other routine directory shape: HEAD records a
 * GITLINK (`160000` / `commit`) while the worktree copy is always a directory.
 * `git cat-file -t HEAD:<path>` is unsafe for it (the submodule commit lives in
 * the SUBMODULE's object database, so the lookup fails; when it happens to be
 * present it answers `commit`), and `git ls-files` lists the gitlink by name, so
 * the old test said "tracked file replaced by a directory" for every submodule
 * update. `commitPaths()` then skipped `git add` for `git update-index
 * --force-remove`, silently committing `D sub` — deleting the whole submodule —
 * and leaving an untracked `sub/` behind. Only a blob is a file; a tree or a
 * gitlink is never a replacement.
 */
async function trackedFileAt(cwd: string, path: string): Promise<boolean> {
  // `ls-tree` never walks into the submodule's object database, which is what
  // made `cat-file -t` unreliable here.
  const head = await run(cwd, ['ls-tree', '-z', 'HEAD', '--', path])
  if (head.code === 0) {
    for (const entry of head.stdout.split('\u0000')) {
      if (entry === '') continue
      const tab = entry.indexOf('\t')
      if (tab < 0 || entry.slice(tab + 1) !== path) continue
      const [mode = '', type = ''] = entry.slice(0, tab).split(' ')
      if (type === 'commit' || mode === '160000') return false
      return type === 'blob' || mode === '100644' || mode === '100755' || mode === '120000'
    }
  }
  // No HEAD yet (unborn branch), or this exact path is not in HEAD: the index is
  // the only record left. A gitlink entry is a submodule, not a file.
  const listed = await run(cwd, ['ls-files', '-s', '-z', '--', path])
  if (listed.code !== 0) return false
  for (const entry of listed.stdout.split('\u0000')) {
    if (entry === '') continue
    const tab = entry.indexOf('\t')
    if (tab < 0 || entry.slice(tab + 1) !== path) continue
    const [mode = ''] = entry.slice(0, tab).split(' ')
    if (mode === '160000') return false
    return true
  }
  return false
}

/**
 * True when a staged entry belongs to the set this commit owns.
 *
 * A case-only rename stages `D a.ts` + `A A.ts`. On a case-insensitive checkout
 * those are the same worktree entry, so an index entry that differs only in case
 * is still ours.
 *
 * `exactTargets` (a path staged as a DELETION) may only match itself: a deleted
 * `a.ts` is a FILE, not a directory prefix. Expanding it to `a.ts/…` made a
 * file-to-directory replacement commit undeclared children of the replacement
 * directory. A genuine directory target still expands, and a trailing slash is
 * accepted so `presentInIndex` and this matcher agree on what a target means.
 */
function ownedByTarget(
  name: string,
  targets: readonly string[],
  ignoreCase: boolean,
  exactTargets: ReadonlySet<string> = new Set<string>(),
): boolean {
  const lowerName = name.toLowerCase()
  return targets.some((target) => {
    const base = target.endsWith('/') ? target.slice(0, -1) : target
    if (name === target || name === base) return true
    if (exactTargets.has(target) || exactTargets.has(base)) {
      return ignoreCase && (lowerName === target.toLowerCase() || lowerName === base.toLowerCase())
    }
    if (base !== '' && name.startsWith(`${base}/`)) return true
    if (!ignoreCase) return false
    const lowerTarget = base.toLowerCase()
    return lowerName === lowerTarget || (base !== '' && lowerName.startsWith(`${lowerTarget}/`))
  })
}

/**
 * Commit the index as it stands.
 *
 * NO pathspec is load-bearing. `git commit -m msg -- <path>` implies `--only`:
 * git builds a temporary index from HEAD and re-adds the worktree entries for the
 * pathspec. That rescan fails on a case-only rename ("will not add file alias
 * 'a.ts' ('A.ts' already exists in index)") and on a file replaced by a
 * same-name directory ("error: 'a.ts' does not have a commit checked out"), no
 * matter the argument order. A pathless commit uses the index directly.
 */
async function commitIndex(cwd: string, message: string, env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return await run(cwd, ['commit', '-m', message], env)
}

/**
 * Commit ONLY the entries this task owns, even when unrelated work is staged.
 *
 * When the index holds nothing but our own entries, a pathless commit is already
 * exact. When the human has staged something else, the real index is copied to a
 * temporary one, the unrelated entries are restored to HEAD in that copy, and the
 * copy is committed — the human's staged work stays staged in the real index.
 */
async function commitTargets(
  cwd: string,
  targets: readonly string[],
  message: string,
  index: ReadonlySet<string> | null,
  exactTargets: ReadonlySet<string>,
): Promise<GitResult> {
  if (index === null) return await run(cwd, ['commit', '-m', message, '--', ...targets])
  const ignoreCase = await ignoresCase(cwd)
  const unrelated = [...index].filter(name => !ownedByTarget(name, targets, ignoreCase, exactTargets))
  if (unrelated.length === 0) return await commitIndex(cwd, message)
  const indexLocation = await run(cwd, ['rev-parse', '--git-path', 'index'])
  const raw = indexLocation.stdout.trim()
  // Round-13 P2-2: the index is KNOWN to hold someone else's staged entry here,
  // so the pathless fallback would commit it. Without a temporary index there is
  // no way to commit only our targets: fail and let the caller bounce the task
  // back to IN_PROGRESS instead.
  if (indexLocation.code !== 0 || raw === '') {
    return indexLocation.code !== 0
      ? indexLocation
      : { code: 1, stdout: '', stderr: 'unable to locate git index' }
  }
  const temporary = join(tmpdir(), `dsh-guard-index-${randomUUID()}`)
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: temporary }
  try {
    await copyFile(isAbsolute(raw) ? raw : join(cwd, raw), temporary)
    // Restore the unrelated entries to HEAD in the COPY. `git reset HEAD -- path`
    // needs a HEAD; an unborn branch can only drop them from the temporary index.
    const head = await headCommit(cwd)
    const restore = head === null
      ? await run(cwd, ['update-index', '--force-remove', '--', ...unrelated], env)
      : await run(cwd, ['reset', '-q', 'HEAD', '--', ...unrelated], env)
    if (restore.code !== 0) return restore
    return await commitIndex(cwd, message, env)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Stage and commit exactly the given paths; unrelated index entries stay untouched. */
export async function commitPaths(cwd: string, paths: readonly string[], message: string): Promise<CommitResult> {
  if (paths.length === 0) return { created: false, sha: await headCommit(cwd) }
  // A path staged as a DELETION (`git mv a.ts b.ts`, `git rm a.ts`) is in neither
  // the worktree nor the index, only in HEAD. `git add -A -- a.ts` then aborts the
  // whole commit with "fatal: pathspec 'a.ts' did not match any files", the task
  // is bounced back to IN_PROGRESS and the retry falls into the rename bug above.
  // Leave an already-staged deletion exactly as it is; anything the worktree still
  // holds (including a re-created file whose index deletion is staged) is staged.
  const deletions = await stagedDeletions(cwd)
  // Paths that are a tracked FILE replaced by a same-name directory. They are
  // staged as deletions only and are never directory targets (see below).
  const fileDeletions = new Set<string>()
  const stageable: string[] = []
  for (const path of paths) {
    const entry = await inspectEntry(cwd, path)
    // A tracked file replaced by a same-name directory is a file DELETION plus
    // children, not a directory target. `git add -A -- a.ts` recursively stages
    // every child of the replacement directory — including files this task never
    // declared (a human's staged work, a sibling task's file, a baseline-dirty
    // file) — and the commit then swept them in. Stage only the deletion.
    const fileReplacement = entry.exists && entry.directory && await trackedFileAt(cwd, path)
    if (fileReplacement) fileDeletions.add(path)
    const stagedDeletion = deletions !== null && deletions.has(path)
    if (!stagedDeletion && !fileReplacement) {
      stageable.push(path)
      continue
    }
    // This path is a file DELETION target. The worktree copy may still be a file
    // under the same spelling (a `git rm --cached` plus a real edit): that one is
    // staged. A missing path is already staged as the deletion, a case-alias hit
    // must not be re-added, and a directory now occupying the name is the
    // replacement itself — its children are staged by their own declared paths,
    // while the deletion is staged here without ever naming the directory in
    // `git add`.
    if (!entry.exists || entry.directory || !entry.exactCase) {
      if (fileReplacement && !stagedDeletion) {
        const removal = await run(cwd, ['update-index', '--force-remove', '--', path])
        if (removal.code !== 0) throw new Error(`git update-index failed: ${removal.stderr.trim()}`)
      }
      continue
    }
    stageable.push(path)
  }
  if (stageable.length > 0) {
    const add = await run(cwd, ['add', '-A', '--', ...stageable])
    if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`)
  }
  // `git commit -- <path>` resolves its pathspec against the worktree, so a path
  // that was staged (`A`) and then deleted from disk (`status` = `AD`) makes the
  // commit fail with "pathspec ... did not match any file(s) known to git" — and
  // `git add -A` may already have dropped that index entry entirely. Commit the
  // names that actually exist in the index (plus any requested directory that
  // holds them), never a literal path git no longer knows.
  const index = await stagedNames(cwd)
  const targets = index === null ? [...paths] : paths.filter(path => presentInIndex(index, path))
  if (targets.length === 0) return { created: false, sha: await headCommit(cwd) }
  // A deletion target names a FILE even when the index also holds `a.ts/…`
  // children (a replacement directory), so it may only match itself.
  const exactTargets = new Set<string>([...(deletions ?? []), ...fileDeletions])
  const commit = await commitTargets(cwd, targets, message, index, exactTargets)
  if (commit.code !== 0) {
    const dirty = await run(cwd, ['status', '--porcelain', '--', ...targets])
    if (dirty.code === 0 && dirty.stdout.trim() === '') return { created: false, sha: await headCommit(cwd) }
    throw new Error(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`)
  }
  return { created: true, sha: await headCommit(cwd) }
}

/** Annotated checkpoint tag; fails loudly if the ref already exists. */
export async function tagCheckpoint(cwd: string, name: string, message: string): Promise<void> {
  const result = await run(cwd, ['tag', '-a', name, '-m', message])
  if (result.code !== 0) throw new Error(`git tag failed: ${result.stderr.trim()}`)
}

/** True when the exact ref already exists in this repository. */
export async function hasRef(cwd: string, ref: string): Promise<boolean> {
  const result = await run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return result.code === 0
}

/**
 * Delete a local checkpoint tag.
 *
 * Used only when a rollback reopens the task that owned it: a task that is no
 * longer DONE must not keep a ref that would make its next completion fail with
 * "tag already exists".
 */
export async function deleteRef(cwd: string, ref: string): Promise<boolean> {
  const result = await run(cwd, ['tag', '-d', ref])
  return result.code === 0
}

/** Commit sha a ref points at; `null` when the ref is unknown. */
export async function refCommit(cwd: string, ref: string): Promise<string | null> {
  const result = await run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return result.code === 0 ? result.stdout.trim() : null
}

/** True when `ancestor` is reachable from `descendant` (equal commits count). */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await run(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
  return result.code === 0
}

/**
 * Blob sha of `path` at HEAD, or the literal sentinel `'absent'`.
 *
 * A rollback residue has to remember what HEAD held when the residue was
 * recorded: a later commit (or a re-checkout) can make the worktree content
 * match the old hash again while HEAD moved on, which is how a residue record
 * used to excuse a genuinely out-of-scope deletion.
 */
export async function headBlob(cwd: string, path: string): Promise<string> {
  return await blobAt(cwd, 'HEAD', path)
}

/** Object id of `path` at `ref`, or the literal sentinel `'absent'`. */
export async function blobAt(cwd: string, ref: string, path: string): Promise<string> {
  const result = await run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}:${path}`])
  const sha = result.stdout.trim()
  return result.code === 0 && sha !== '' ? sha : 'absent'
}

/** Revert one commit, keeping git's own message for the caller's error. */
async function revertOne(cwd: string, sha: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const result = await run(cwd, ['revert', '--no-edit', sha === '' ? 'HEAD' : sha])
  if (result.code === 0) return { ok: true }
  await run(cwd, ['revert', '--abort'])
  // The raw stderr is what tells a dirty worktree (retryable) apart from a merge
  // conflict (never retryable): never collapse it into one generic sentence.
  return { ok: false, detail: (result.stderr.trim() || result.stdout.trim()).slice(0, 800) }
}

/** Revert one commit (used when a checkpoint tag could not be written). */
export async function revertCommit(cwd: string, sha: string): Promise<boolean> {
  return (await revertOne(cwd, sha)).ok
}

export interface RestoreResult {
  /** Paths brought back from the checkpoint. */
  readonly restored: readonly string[]
  /** Paths that did not exist at the checkpoint and were deleted. */
  readonly removed: readonly string[]
  /** Paths skipped because they escape the workspace or the checkout failed. */
  readonly skipped: readonly string[]
}

/**
 * Restore exactly these paths to their state at `ref`, deleting the ones that
 * did not exist there.
 *
 * Only paths the caller already narrowed (one task's declared scope) are
 * touched; a path that escapes the workspace is skipped, never followed.
 */
export async function restorePaths(cwd: string, ref: string, paths: readonly string[]): Promise<RestoreResult> {
  const restored: string[] = []
  const removed: string[] = []
  const skipped: string[] = []
  // A missing ref makes every `cat-file -e` fail, which would read as "the file
  // did not exist at ref" and DELETE the whole scope. Refuse before touching
  // anything: an unresolved checkpoint is a caller bug, not a deletion order.
  if (!(await hasRef(cwd, ref))) return { restored: [], removed: [], skipped: [...paths] }
  for (const path of paths) {
    // Segment level: `src/../../outside.ts` traverses just as surely as `../x`.
    if (path === '' || isAbsolute(path) || path.split('/').includes('..')) { skipped.push(path); continue }
    const atRef = await run(cwd, ['cat-file', '-e', `${ref}:${path}`])
    if (atRef.code === 0) {
      const checkout = await run(cwd, ['checkout', ref, '--', path])
      if (checkout.code === 0) restored.push(path)
      else skipped.push(path)
      continue
    }
    try {
      await rm(join(cwd, path), { recursive: true, force: true })
      removed.push(path)
    } catch {
      skipped.push(path)
    }
  }
  return { restored, removed, skipped }
}

export interface RestoreTrackedResult {
  /** Paths actually checked out from HEAD (index and worktree brought back). */
  readonly reset: readonly string[]
  /** Paths whose dirty worktree copy was deleted (they do not exist at HEAD). */
  readonly removed: readonly string[]
  /** Paths deliberately left on disk because no backup covered them. */
  readonly refused: readonly string[]
  /**
   * Paths that exist at HEAD but whose `checkout HEAD` FAILED (a locked file, a
   * permission error, a directory occupying the name). They are neither reset
   * nor refused, and dropping them silently would let the caller claim there
   * was nothing dirty to restore.
   */
  readonly failed?: readonly string[]
}

/**
 * Reset these dirty paths so a retried `git revert` can run.
 *
 * `git revert` refuses to run while a file it must patch is modified, and it also
 * refuses to CHECK OUT a path whose name is taken by an untracked file. Restoring
 * the dirty paths to the *checkpoint* does not clear the first refusal (the index
 * then disagrees with HEAD), so the retry resets them to HEAD instead; the
 * half-finished edit is already captured as a patch before the first attempt.
 *
 * A path that does not exist at HEAD is the hard case: a staged addition, or a
 * file re-created in the worktree after a commit deleted it. Unstaging it is not
 * enough — the leftover worktree copy keeps blocking the checkout that restoring
 * the deletion needs, so the retry failed with the exact same "untracked working
 * tree files would be overwritten" every time. The copy is only removed when the
 * CAPTURED PATCH ITSELF covers this exact path; otherwise the path is reported in
 * `refused` and left alone.
 *
 * Per path, never per run: the patch is built from the whole dirty set, so an
 * unrelated dirty file used to make a single `backupCaptured` boolean true while
 * the path being deleted was not in the patch at all (a dangling symlink was the
 * classic case — `access`/`stat` followed the link and skipped it).
 */
export async function restoreTrackedToHead(
  cwd: string,
  paths: readonly string[],
  options: { readonly backedUpPaths?: ReadonlySet<string> } = {},
): Promise<RestoreTrackedResult> {
  const reset: string[] = []
  const removed: string[] = []
  const refused: string[] = []
  const failed: string[] = []
  for (const path of paths) {
    if (path === '' || isAbsolute(path) || path.split('/').includes('..')) continue
    const atHead = await run(cwd, ['cat-file', '-e', `HEAD:${path}`])
    if (atHead.code !== 0) {
      // A STAGED ADDITION has no HEAD entry: `git revert` still refuses to run
      // with a non-empty index ("your local changes would be overwritten"), so
      // the old `continue` made the retry fail identically forever. Unstage it
      // first, then decide about the copy.
      await run(cwd, ['reset', '--', path])
      if (!(await existsAt(cwd, path))) continue
      if (!(options.backedUpPaths?.has(path) ?? false)) {
        refused.push(path)
        continue
      }
      await rm(join(cwd, path), { recursive: true, force: true })
      removed.push(path)
      continue
    }
    // Only a SUCCESSFUL checkout may be reported as "reset to HEAD": a path the
    // checkout refused (a directory occupying the name, a permission error) was
    // not restored, and the caller's failure text must not claim it was. It is
    // recorded as `failed` instead of being dropped, so "nothing was reset" can
    // never be said while a dirty path is still on disk.
    const checkout = await run(cwd, ['checkout', 'HEAD', '--', path])
    if (checkout.code === 0) reset.push(path)
    else failed.push(path)
  }
  return { reset, removed, refused, failed }
}

/** Undo only the index entries of the given paths after a failed commit. */
export async function resetPaths(cwd: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  await run(cwd, ['reset', '--', ...paths])
}

/**
 * Paths changed by the plugin's own commits for OTHER tasks inside `from..to`.
 *
 * A checkpoint inherited by a later ref may carry a reopened task's own abandoned
 * blob; restoring that task to the inherited ref would resurrect it. Only another
 * task's TAGGED commit is proof that a path belongs to somebody else's newer work
 * — a bare subject could be forged by the subagent being audited.
 */
export async function foreignPluginCommitPaths(
  cwd: string,
  from: string,
  to: string,
  options: ChangedSinceOptions,
): Promise<Set<string>> {
  const paths = new Set<string>()
  const ownShas = await pluginCommitShas(cwd, options.runId)
  if (ownShas.size === 0) return paths
  const log = await run(cwd, ['log', '--format=%H%x09%s', `${from}..${to}`])
  if (log.code !== 0) return paths
  const ownSubject = ownCommitSubject(options.runId, options.taskId)
  for (const line of log.stdout.split('\n')) {
    const [sha = '', subject = ''] = line.split('\t')
    if (sha === '' || !ownShas.has(sha) || subject === ownSubject) continue
    const files = await run(cwd, ['show', '--pretty=format:', '--name-only', '-z', '--no-renames', '-m', '--first-parent', sha])
    if (files.code !== 0) continue
    for (const path of files.stdout.split('\u0000').filter(entry => entry !== '')) paths.add(path)
  }
  return paths
}

/** Commit subjects in `ref..HEAD` as `sha\tsubject`, NEWEST first (git log order). */
export async function commitsAfter(cwd: string, ref: string): Promise<string[]> {
  const result = await run(cwd, ['log', '--format=%H%x09%s', `${ref}..HEAD`])
  if (result.code !== 0) return []
  return result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
}

export interface RollbackResult {
  /** Commit subjects that were reverted, newest first. Empty when HEAD already equals the checkpoint. */
  readonly reverted: readonly string[]
}

const REVERT_SUBJECT = /^Revert "/

/** True when this subject is a revert commit this module itself created. */
export function isRevertSubject(subject: string): boolean {
  return REVERT_SUBJECT.test(subject)
}

/**
 * Revert these commits individually, in the order given; throws on the first
 * failure.
 *
 * Callers pass `commitsAfter()` output, which `git log` emits NEWEST first — the
 * only order that works: reverting an older commit while a newer one still
 * depends on it conflicts.
 */
export interface RevertProgressResult {
  /** Subjects of the commits actually reverted, in the order they were applied. */
  readonly reverted: readonly string[]
  /** SHAs not reverted: the failed commit and everything after it. */
  readonly remaining: readonly string[]
  /** git's own failure text; `undefined` when every commit was reverted. */
  readonly failure?: string
}

/**
 * Revert these commits one by one, REPORTING partial progress instead of throwing.
 *
 * Each successful `git revert` commits immediately, so a failure halfway leaves
 * the earlier commits reverted for real. Callers must know exactly which SHAs
 * still need undoing: recomputing the range afterwards would see the revert
 * commit on top and mistake a partial rollback for a finished one.
 */
export async function revertCommitsProgress(cwd: string, shas: readonly string[]): Promise<RevertProgressResult> {
  const reverted: string[] = []
  for (let index = 0; index < shas.length; index += 1) {
    const sha = shas[index] ?? ''
    if (sha === '') continue
    const outcome = await revertOne(cwd, sha)
    if (!outcome.ok) {
      return {
        reverted,
        remaining: shas.slice(index).filter(item => item !== ''),
        failure: `git revert ${sha.slice(0, 8)} failed: ${outcome.detail}`,
      }
    }
    const subject = await run(cwd, ['log', '-1', '--format=%s', sha])
    reverted.push(subject.code === 0 ? subject.stdout.trim() : sha.slice(0, 8))
  }
  return { reverted, remaining: [] }
}

export async function revertCommits(cwd: string, shas: readonly string[]): Promise<RollbackResult> {
  const progress = await revertCommitsProgress(cwd, shas)
  if (progress.failure !== undefined) throw new Error(progress.failure)
  return { reverted: progress.reverted }
}

/**
 * Undo every commit after `ref` without rewriting history.
 *
 * An empty range is a no-op instead of an error: a task that was blocked before
 * it ever committed must still be able to reset its ledger. A range that already
 * holds a revert commit is also a no-op — the code is already back at the
 * checkpoint, and reverting the revert would restore it. Only a MIXED range (a
 * revert plus newer work) is refused, because there is no safe blanket answer.
 */
export async function rollbackToCheckpoint(cwd: string, ref: string): Promise<RollbackResult> {
  if (!(await hasRef(cwd, ref))) throw new Error(`checkpoint ${ref} does not exist`)
  const subjects = await commitsAfter(cwd, ref)
  if (subjects.length === 0) return { reverted: [] }
  const names = subjects.map(subject => subject.split('\t')[1] ?? '')
  // `git log` is newest-first: a revert on top means the last rollback already
  // restored the tree, so this call is a no-op rather than an error (a second
  // click must still be able to reset the ledger and reopen the task).
  if (REVERT_SUBJECT.test(names[0] ?? '')) return { reverted: [] }
  if (names.some(subject => REVERT_SUBJECT.test(subject))) {
    throw new Error('the commit range mixes a rollback with newer work; resolve it by hand')
  }
  const revert = await run(cwd, ['revert', '--no-edit', `${ref}..HEAD`])
  if (revert.code !== 0) {
    await run(cwd, ['revert', '--abort'])
    throw new Error(`git revert failed: ${revert.stderr.trim()}`)
  }
  return { reverted: names }
}

/**
 * True when this subject LOOKS like one of the plugin's own per-task commits.
 *
 * A subject alone is not proof: a subagent can read the run id and write
 * `guard(<runId>): FAKE DONE` into its own commit. Callers that must be certain
 * check the commit against the checkpoint tags instead (see `pluginCommitShas`).
 */
export function isOwnCommitSubject(subject: string, runId: string): boolean {
  return subject.startsWith(`guard(${runId}): `) && subject.endsWith(' DONE')
}

/**
 * SHAs of the commits the plugin itself created for this run.
 *
 * Each task's commit is the target of its annotated `guard/<runId>/<task>` tag,
 * which only the plugin writes. Membership here is therefore evidence, not a
 * string the model can forge.
 */
export async function pluginCommitShas(cwd: string, runId: string): Promise<Set<string>> {
  const shas = new Set<string>()
  // The tags are created as `guard/<sanitizeRefSegment(runId)>/<task>`, so the
  // QUERY must apply the same normalization: a ledger run id such as `my--run`
  // stores its tags under `guard/my-run/` and a raw prefix would find none of
  // its own commits (they would then be blamed on the audited task).
  const segment = sanitizeRefSegment(runId, 50)
  // `%(objectname)` is the TAG object for an annotated tag; the commit it points
  // at is `%(*objectname)`. Tags created by `tagCheckpoint` are annotated.
  const refs = await run(cwd, [
    'for-each-ref', '--format=%(objectname) %(*objectname) %(refname)', `refs/tags/guard/${segment}/`,
  ])
  if (refs.code !== 0) return shas
  for (const line of refs.stdout.split('\n')) {
    const [tagSha = '', commitSha = ''] = line.trim().split(' ')
    const sha = commitSha === '' ? tagSha : commitSha
    if (sha !== '') shas.add(sha)
  }
  return shas
}


/** Create a per-run worktree on its own branch; no-op when the branch exists. */
export async function createRunWorktree(cwd: string, path: string, branch: string): Promise<void> {
  const existing = await run(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  const add = existing.code === 0
    ? await run(cwd, ['worktree', 'add', path, branch])
    : await run(cwd, ['worktree', 'add', '-b', branch, path, 'HEAD'])
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`)
  const exclude = await run(cwd, ['rev-parse', '--git-path', 'info/exclude'])
  if (exclude.code === 0) {
    const raw = exclude.stdout.trim()
    const file = isAbsolute(raw) ? raw : join(cwd, raw)
    await mkdir(dirname(file), { recursive: true })
    const current = await readFile(file, 'utf8').catch(() => '')
    if (!current.split(/\r?\n/).includes('.guard/')) {
      await writeFile(file, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}.guard/\n`, 'utf8')
    }
  }
}

/** Remove a worktree (used only by explicit cleanup, never during a run). */
export async function removeRunWorktree(cwd: string, path: string): Promise<void> {
  await run(cwd, ['worktree', 'remove', '--force', path])
}
