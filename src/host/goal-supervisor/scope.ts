/**
 * Scope-change requests: the only legal way for a task to grow its write scope.
 *
 * A request lives in `requests/<file>.json`. Normal business paths are approved
 * deterministically (no human round-trip in an unattended run); sensitive paths,
 * a scope that would grant the whole workspace, or a task that already expanded
 * three times wait for a human.
 *
 * Two properties matter here because the request files are writable by the model:
 *   - a request is only ever written back to the file it was read from, and its
 *     `id` never becomes a path segment (the old code did `scope-${taskId}-${id}`,
 *     so `id: "../../tasks"` escaped the directory);
 *   - a wildcard that would cover everything (`**`, `*`, `.`, empty) is treated
 *     as sensitive, so it can never be auto-approved into a blanket grant.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { matchesGlob, normalizeScopePath, scopesOverlap } from './git'
import { GUARD_SCHEMA_VERSION } from './schema'
import type { GuardEvent, GuardState, GuardTask, ScopeChangeRequest } from './schema'
import type { GuardStore } from './store'

/**
 * Directories that must never be granted automatically, matched case-insensitively.
 *
 * The leading `(?:^|\/)` matters: `packages/app/node_modules/**` and
 * `sub/.git/config` reach a guarded tree from a subdirectory, which an anchored
 * `^node_modules` pattern missed. `docs/guard` is separate because it is two
 * segments: granting it would let a task edit another run's ledger.
 */
const SENSITIVE_DIRS: readonly RegExp[] = [
  /(?:^|\/)(?:\.github|\.git|\.guard|infra|vendor|node_modules|\.husky)(?:\/|$)/i,
  /(?:^|\/)docs\/guard(?:\/|$)/i,
]
const SENSITIVE_FILES: readonly RegExp[] = [
  /(?:^|\/)\.env(?:\..*)?$/i,
  /(?:^|\/)docker-compose[^/]*$/i,
  /(?:^|\/)package(?:-lock)?\.json$/i,
  /(?:^|\/)SECURITY[^/]*$/i,
  /(?:^|\/)\.npmrc$/i,
  /(?:^|\/)\.gitlab-ci\.yml$/i,
]

/**
 * Representative guarded names a wildcard would have to reach.
 *
 * Testing the static NAME PREFIX was both too narrow (`config/?env` and
 * `config/*env*` have an empty prefix) and too wide (`src/s*.ts` was read as a
 * truncated `security`, so ordinary source work waited for a human). Matching
 * the glob against real names answers the only question that matters: can it
 * spell one of them?
 */
const SENSITIVE_SAMPLES: readonly string[] = [
  '.env', '.env.local', '.npmrc', 'package.json', 'package-lock.json',
  'docker-compose.yml', 'SECURITY.md', '.gitlab-ci.yml',
]

/**
 * Representative guarded DIRECTORIES, expressed as one file below each.
 *
 * A wildcard can also TRUNCATE a directory name (`vend*`, `node_mod*`), and a
 * trailing wildcard matches everything below itself, so the literal directory
 * rules are not enough on their own.
 */
const SENSITIVE_DIR_SAMPLES: readonly string[] = [
  '.github/x', '.git/config', '.guard/x', 'infra/x', 'vendor/x', 'node_modules/x', '.husky/x', 'docs/guard/x',
]

/** Single-segment guarded directory names, matched case-insensitively. */
const SENSITIVE_DIR_NAMES: readonly string[] = [
  '.github', '.git', '.guard', 'infra', 'vendor', 'node_modules', '.husky',
]

/** Request and task ids are opaque labels, never path fragments. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * One normalization for every scope decision; it lives in `git.ts` next to the
 * matcher so the sensitive check, the matcher and the ledger cannot disagree.
 */
export { normalizeScopePath }

/**
 * True when one glob SEGMENT can spell one guarded directory name.
 *
 * macOS's default filesystem is case-insensitive, so the comparison is too:
 * `sub/.G*` + `/config` reaches `sub/.git/config` exactly like the lowercase form.
 */
function segmentSpellsName(segment: string, name: string): boolean {
  return matchesGlob(name.toLowerCase(), segment.toLowerCase())
}

/**
 * True when a DIRECTORY segment of `glob` can spell a guarded directory.
 *
 * The old check looked at the last segment only (and returned early for a
 * trailing `**`), so `docs/g*` + `/**`, `sub/.g*` + `/config` and
 * `packages/node_mod*` + `/**` were all auto-approved: `git status` then
 * reported paths under `.git`, `node_modules` or another run's `docs/guard`. A
 * trailing `**` is still a directory GRANT, not a truncated name, so
 * `docs/**` + `/*.txt` stays ordinary work; the segments BEFORE it are
 * inspected like any other.
 */
function directorySegmentSpellsGuarded(segments: readonly string[]): boolean {
  const dirs = [...segments]
  const last = dirs.at(-1) ?? ''
  // A final `name.ext` segment is a filename pattern, not a directory name.
  if (/^[^./][^/]*\.[A-Za-z0-9]+$/.test(last)) dirs.pop()
  for (let index = 0; index < dirs.length; index += 1) {
    const segment = dirs[index] ?? ''
    if (!/[*?]/.test(segment)) continue
    // `**` is a directory grant, not a name that happens to be empty.
    if (segment === '**') continue
    if (SENSITIVE_DIR_NAMES.some(name => segmentSpellsName(segment, name))) return true
    // `docs` + the NEXT segment is a two-segment guarded name (`docs/guard`).
    if (index > 0 && (dirs[index - 1] ?? '').toLowerCase() === 'docs'
      && segmentSpellsName(segment, 'guard')) return true
  }
  return false
}

/** True when a wildcard entry can spell a guarded file or directory name. */
function wildcardHitsSensitivePath(glob: string): boolean {
  const segments = glob.split('/')
  const last = segments.at(-1) ?? ''
  // Inspect the directory segments FIRST: `docs/g*/**` is a directory grant whose
  // own name still spells `docs/guard`, which the old early return skipped.
  if (directorySegmentSpellsGuarded(segments)) return true
  // A trailing `**` is a directory grant, not a file name pattern: `src/**`
  // stays auto-approvable (`src/.env` itself is still caught by SENSITIVE_FILES).
  if (last === '**') return false
  const slash = glob.lastIndexOf('/')
  const dir = slash < 0 ? '' : glob.slice(0, slash + 1)
  // Case-insensitive on BOTH sides: `src/Package.jso*` names `package.json` on
  // the same case-insensitive disks that made the directory bypass possible.
  const lowerGlob = glob.toLowerCase()
  const hits = (sample: string): boolean => matchesGlob(sample.toLowerCase(), lowerGlob)
    || (dir !== '' && matchesGlob(`${dir}${sample}`.toLowerCase(), lowerGlob))
  return SENSITIVE_SAMPLES.some(hits) || SENSITIVE_DIR_SAMPLES.some(hits)
}

export function isSensitivePath(path: string): boolean {
  const normalized = normalizeScopePath(path)
  // The root keeps its leading slash now (it is no longer folded to `''`), so
  // the empty-string check alone left `isSensitivePath('/')` false while
  // `isBroadScopePath('/')` was already true. Every absolute path reaches the
  // filesystem root; none of them may be auto-approved.
  if (normalized === '' || normalized === '/' || isAbsolute(normalized)) return true
  // A glob can spell a sensitive target without containing its name
  // (`config/.env*`, `src/package.jso*`, `src/?ackage.json`), so any wildcard is
  // checked against representative names and the directory rules.
  if (/[*?]/.test(normalized)) {
    if (SENSITIVE_DIRS.some(pattern => pattern.test(normalized))) return true
    if (wildcardHitsSensitivePath(normalized)) return true
    const asLiteral = normalizeScopePath(normalized.replace(/[*?]+/g, ''))
    if (SENSITIVE_DIRS.some(pattern => pattern.test(asLiteral))) return true
    if (SENSITIVE_FILES.some(pattern => pattern.test(asLiteral))) return true
    return false
  }
  return SENSITIVE_DIRS.some(pattern => pattern.test(normalized))
    || SENSITIVE_FILES.some(pattern => pattern.test(normalized))
}

/**
 * A scope entry that would grant the whole workspace.
 *
 * `src/**` is a directory grant and stays auto-approvable; `**`, `*`, `.`, an
 * empty string, or a wildcard in the FIRST segment (a star followed by a slash)
 * would cover everything and must reach a human. The last case matters: such a
 * pattern also matches `.github/workflows/ci.yml`, `.git/config` and
 * `infra/prod.tf` in one entry.
 */
export function isBroadScopePath(path: string): boolean {
  const normalized = normalizeScopePath(path)
  if (normalized === '' || normalized === '.') return true
  if (normalized.startsWith('**')) return true
  const head = normalized.split('/')[0] ?? ''
  // A wildcard at the top level is no anchor at all.
  if (head === '' || head === '.' || head === '..' || /[*?]/.test(head)) return true
  // Without a separator the glob has no directory anchor: `*`, `?.ts`, `**/*.yml`.
  return !normalized.includes('/') && /[*?]/.test(normalized)
}

/** A declared path must be relative, non-empty and free of `..` segments. */
export function isSafeScopePath(path: unknown): path is string {
  if (typeof path !== 'string') return false
  const trimmed = path.trim()
  if (trimmed === '') return false
  const normalized = normalizeScopePath(trimmed)
  // `.` and `./` fold to an empty segment list. An empty scope is not a harmless
  // no-op: `matchesGlob(path, '')` accepts every path, so accepting it here would
  // turn a dot request into a whole-workspace grant. The absolute root (`/`)
  // keeps its leading slash and is refused by `isAbsolute` below.
  if (normalized === '') return false
  // `normalizeScopePath('C:/')` drops the trailing separator and returns `'C:'`,
  // which the old `/^[A-Za-z]:\//` test no longer matched — so a Windows drive
  // ROOT was accepted as a safe relative scope. Match the bare drive too.
  if (isAbsolute(normalized) || /^[A-Za-z]:(?:\/|$)/.test(normalized)) return false
  // Segment-level check: `src/..` escapes exactly like `../src` does.
  if (normalized.split('/').includes('..')) return false
  return true
}

interface PendingEntry {
  /** File name inside `requests/`; the only name ever written back. */
  readonly file: string
  readonly request: ScopeChangeRequest
}

/** Read one request file; `null` when it is malformed or unsafe. */
function parseRequest(raw: string, taskId: string): ScopeChangeRequest | null {
  let parsed: Partial<ScopeChangeRequest>
  try {
    parsed = JSON.parse(raw) as Partial<ScopeChangeRequest>
  } catch {
    return null
  }
  if (parsed.status !== 'pending' || parsed.taskId !== taskId) return null
  if (parsed.version !== GUARD_SCHEMA_VERSION) return null
  if (typeof parsed.id !== 'string' || !SAFE_ID.test(parsed.id)) return null
  if (!Array.isArray(parsed.addedPaths)) return null
  if (!parsed.addedPaths.every(isSafeScopePath)) return null
  if (parsed.addedPaths.length === 0) return null
  // Store and decide on the normalized form only: `././src/a.ts` and `src\a.ts`
  // used to be approved verbatim and then never match a git-reported path.
  return { ...parsed, addedPaths: [...new Set(parsed.addedPaths.map(normalizeScopePath))] } as ScopeChangeRequest
}

async function readPendingEntries(store: GuardStore, taskId: string): Promise<PendingEntry[]> {
  const dir = join(store.root, 'requests')
  let entries: string[] = []
  try { entries = await readdir(dir) } catch { return [] }
  const found: PendingEntry[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const file = basename(entry)
    try {
      const request = parseRequest(await readFile(join(dir, file), 'utf8'), taskId)
      if (request !== null) found.push({ file, request })
    } catch { /* a malformed request is ignored, never trusted */ }
  }
  return found
}

export async function readPendingRequests(store: GuardStore, taskId: string): Promise<ScopeChangeRequest[]> {
  return (await readPendingEntries(store, taskId)).map(entry => entry.request)
}

/** Write a decided request back to the file it came from. */
async function writeRequest(store: GuardStore, entry: PendingEntry, request: ScopeChangeRequest): Promise<void> {
  const file = basename(entry.file)
  if (!file.endsWith('.json')) return
  await writeFile(join(store.root, 'requests', file), `${JSON.stringify(request, null, 2)}\n`, 'utf8')
}

export interface ScopeOutcome {
  readonly state: GuardState
  readonly events: GuardEvent[]
  readonly pending: readonly ScopeChangeRequest[]
  readonly approved: readonly ScopeChangeRequest[]
}

/**
 * Decide pending requests for one task; never touches files outside the request
 * files.
 *
 * `siblings` carries the scopes of tasks audited in the same turn: an approval
 * that intersects another in-flight task would let the first finisher commit a
 * sibling's half-finished file, so such a request goes to a human instead.
 */
export async function processScopeRequests(
  store: GuardStore,
  state: GuardState,
  task: GuardTask,
  siblings: readonly (readonly string[])[] = [],
): Promise<ScopeOutcome> {
  const pending = await readPendingEntries(store, task.id)
  if (pending.length === 0) return { state, events: [], pending: [], approved: [] }
  const events: GuardEvent[] = []
  const approved: ScopeChangeRequest[] = []
  const waiting: ScopeChangeRequest[] = []
  // Re-normalize the existing entries too: a ledger written before the shared
  // normalizer existed may still hold `./x` forms that never matched.
  let scope = [...new Set(task.scope.map(normalizeScopePath))]
  let approvedCount = task.scopeApprovedCount
  for (const entry of pending) {
    const { request } = entry
    const sensitive = request.addedPaths.some(path => isSensitivePath(path) || isBroadScopePath(path))
    const conflicts = siblings.some(scope => scopesOverlap(request.addedPaths, scope))
    const needsHuman = sensitive || conflicts || approvedCount >= 3
    const at = Date.now()
    if (needsHuman) {
      const updated: ScopeChangeRequest = {
        ...request,
        requiresHuman: true,
        decisionNote: sensitive
          ? '敏感路径或整仓通配需要人工批准'
          : conflicts ? '与同批并行任务的 scope 相交，等待人工批准' : '扩范围次数已达 3 次',
      }
      await writeRequest(store, entry, updated)
      waiting.push(updated)
      events.push({ type: 'scope.request', at, requestId: request.id, taskId: task.id, paths: [...request.addedPaths] })
      continue
    }
    const updated: ScopeChangeRequest = {
      ...request, requiresHuman: false, status: 'approved', decidedBy: 'adjudicator',
      decisionNote: '常规业务路径，自动批准', decidedAt: at,
    }
    await writeRequest(store, entry, updated)
    approved.push(updated)
    scope = [...new Set([...scope, ...request.addedPaths])]
    approvedCount += 1
    events.push({ type: 'scope.approved', at, requestId: request.id, taskId: task.id, paths: [...request.addedPaths], by: 'adjudicator' })
  }
  // Apply onto the CURRENT task row, not the snapshot the caller captured: the
  // caller may have refreshed status/probe fields in between.
  const current = state.tasks.find(item => item.id === task.id) ?? task
  const tasks = state.tasks.map(item => item.id === task.id
    ? { ...current, scope, scopeApprovedCount: approvedCount }
    : item)
  return { state: { ...state, tasks, updatedAt: Date.now() }, events, pending: waiting, approved }
}
