import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, test } from 'vitest'
import { prepareGuardRun } from '../../src/host/goal-supervisor/create'
import { GuardStore } from '../../src/host/goal-supervisor/store'
import { captureBlockedPatch } from '../../src/host/goal-supervisor/patch'
import {
  isBroadScopePath, isSafeScopePath, isSensitivePath, normalizeScopePath, processScopeRequests,
} from '../../src/host/goal-supervisor/scope'
import type { GuardState } from '../../src/host/goal-supervisor/schema'

const run = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guard-scope-'))
  roots.push(root)
  return root
}

async function prepared(cwd: string, scope: string[]): Promise<{ store: GuardStore; state: GuardState }> {
  const runId = (await prepareGuardRun(cwd, {
    goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 落盘 | 文件存在',
    scopes: { T1: scope },
  })).runId
  const store = new GuardStore(join(cwd, 'docs', 'guard', runId))
  const state = await store.readState()
  assert.ok(state !== null)
  return { store, state }
}

async function request(cwd: string, runId: string, id: string, paths: string[]): Promise<void> {
  await mkdir(join(cwd, 'docs', 'guard', runId, 'requests'), { recursive: true })
  await writeFile(join(cwd, 'docs', 'guard', runId, 'requests', `scope-T1-${id}.json`), JSON.stringify({
    version: 1, id, taskId: 'T1', requestedBy: 'main', reason: 'need types',
    addedPaths: paths, evidenceIds: [], requiresHuman: false, status: 'pending', createdAt: 1,
  }), 'utf8')
}

describe('goal-supervisor scope changes', () => {
  test('a normal business path is approved automatically', async () => {
    const cwd = await workspace()
    const { store, state } = await prepared(cwd, ['src/a.ts'])
    await request(cwd, state.runId, 'r1', ['src/b.ts'])
    const outcome = await processScopeRequests(store, state, state.tasks[0]!)
    assert.equal(outcome.pending.length, 0)
    assert.equal(outcome.approved.length, 1)
    assert.deepEqual(outcome.state.tasks[0]?.scope, ['src/a.ts', 'src/b.ts'])
    assert.equal(outcome.state.tasks[0]?.scopeApprovedCount, 1)
    assert.equal(outcome.events[0]?.type, 'scope.approved')
    const saved = JSON.parse(await readFile(join(cwd, 'docs', 'guard', state.runId, 'requests', 'scope-T1-r1.json'), 'utf8')) as { status: string }
    assert.equal(saved.status, 'approved')
  })

  test('sensitive paths wait for a human', async () => {
    const cwd = await workspace()
    const { store, state } = await prepared(cwd, ['src/a.ts'])
    await request(cwd, state.runId, 'r2', ['.github/workflows/ci.yml'])
    const outcome = await processScopeRequests(store, state, state.tasks[0]!)
    assert.equal(outcome.approved.length, 0)
    assert.equal(outcome.pending.length, 1)
    assert.equal(outcome.pending[0]?.requiresHuman, true)
    assert.equal(outcome.events[0]?.type, 'scope.request')
    assert.ok(isSensitivePath('.github/workflows/ci.yml'))
    assert.ok(!isSensitivePath('src/b.ts'))
  })

  test('more than three expansions wait for a human', async () => {
    const cwd = await workspace()
    const { store, state } = await prepared(cwd, ['src/a.ts'])
    const task = { ...state.tasks[0]!, scopeApprovedCount: 3 }
    const withCount = { ...state, tasks: [task] }
    await request(cwd, state.runId, 'r3', ['src/c.ts'])
    const outcome = await processScopeRequests(store, withCount, task)
    assert.equal(outcome.pending.length, 1)
    assert.equal(outcome.approved.length, 0)
  })
})

describe('goal-supervisor blocked patch', () => {
  test('captures tracked and untracked changes without clearing the worktree', async () => {
    const cwd = await workspace()
    await run('git', ['init', '-q'], { cwd })
    await run('git', ['config', 'user.email', 'g@test'], { cwd })
    await run('git', ['config', 'user.name', 'g'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'one')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'two')
    await writeFile(join(cwd, 'b.ts'), 'new')

    const runId = (await prepareGuardRun(cwd, { goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | t | e' })).runId
    const store = new GuardStore(join(cwd, 'docs', 'guard', runId))
    const capture = await captureBlockedPatch(cwd, store, 'T1', ['a.ts', 'b.ts'], 1)
    assert.ok(capture !== null)
    assert.deepEqual([...capture.coveredPaths].sort(), ['a.ts', 'b.ts'])
    const text = await readFile(capture.path, 'utf8')
    assert.match(text, /a\.ts/)
    assert.match(text, /b\.ts/)
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.match(status.stdout, /M a\.ts/)
    assert.match(status.stdout, /\?\? b\.ts/)
  })

  test('a STAGED change is captured too, not reported as an empty patch', async () => {
    const cwd = await workspace()
    await run('git', ['init', '-q'], { cwd })
    await run('git', ['config', 'user.email', 'g@test'], { cwd })
    await run('git', ['config', 'user.name', 'g'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'base')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'staged edit')
    await writeFile(join(cwd, 'brandnew.ts'), 'staged new file')
    // A subagent ran `git add`: `git diff` alone is empty, and the old capture
    // returned null — the rollback then reset these paths with no backup at all.
    await run('git', ['add', 'a.ts', 'brandnew.ts'], { cwd })

    const runId = (await prepareGuardRun(cwd, { goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | t | e' })).runId
    const store = new GuardStore(join(cwd, 'docs', 'guard', runId))
    const capture = await captureBlockedPatch(cwd, store, 'T1', ['a.ts', 'brandnew.ts'], 2)
    assert.ok(capture !== null, 'staged work must be backed up before it is cleared')
    const text = await readFile(capture.path, 'utf8')
    assert.match(text, /staged edit/)
    assert.match(text, /staged new file/)
    // The capture restores the caller's index exactly: still staged afterwards.
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.match(status.stdout, /^A  brandnew\.ts$/m)
  })

  test('a request id that is a path fragment is ignored, never used as a file name', async () => {
    const cwd = await workspace()
    const { store, state } = await prepared(cwd, ['src/a.ts'])
    const requests = join(cwd, 'docs', 'guard', state.runId, 'requests')
    await mkdir(requests, { recursive: true })
    await writeFile(join(requests, 'evil.json'), JSON.stringify({
      version: 1, id: '../../tasks', taskId: 'T1', requestedBy: 'main', reason: 'x',
      addedPaths: ['src/b.ts'], evidenceIds: [], requiresHuman: false, status: 'pending', createdAt: 1,
    }), 'utf8')
    const before = await readFile(join(cwd, 'docs', 'guard', state.runId, 'tasks.json'), 'utf8')
    const outcome = await processScopeRequests(store, state, state.tasks[0]!)
    assert.deepEqual(outcome.approved, [])
    assert.deepEqual(outcome.pending, [])
    assert.deepEqual(outcome.state.tasks[0]?.scope, ['src/a.ts'])
    // The ledger is byte-identical: nothing was written through the traversal.
    assert.equal(await readFile(join(cwd, 'docs', 'guard', state.runId, 'tasks.json'), 'utf8'), before)
  })

  test('a path with .. or an absolute path is ignored', async () => {
    const cwd = await workspace()
    const { store, state } = await prepared(cwd, ['src/a.ts'])
    await request(cwd, state.runId, 'r1', ['../outside.ts'])
    const traversal = await processScopeRequests(store, state, state.tasks[0]!)
    assert.deepEqual(traversal.approved, [])
    await request(cwd, state.runId, 'r2', ['/etc/passwd'])
    const absolute = await processScopeRequests(store, traversal.state, traversal.state.tasks[0]!)
    assert.deepEqual(absolute.approved, [])
    assert.deepEqual(absolute.state.tasks[0]?.scope, ['src/a.ts'])
  })

  test('a wildcard that would grant the whole workspace needs a human', async () => {
    const cwd = await workspace()
    // `'.'` and `'/'` fold to "no scope" and are refused outright by
    // `isSafeScopePath` (see the root-path hardening tests below), so the parkable
    // shapes are the explicit wildcards.
    for (const addedPaths of [['**'], ['*'], ['**/*.ts']]) {
      const { store, state } = await prepared(cwd, ['src/a.ts'])
      await request(cwd, state.runId, 'wide', addedPaths)
      const outcome = await processScopeRequests(store, state, state.tasks[0]!)
      assert.deepEqual(outcome.approved, [], `${addedPaths.join(',')} must not be auto-approved`)
      assert.equal(outcome.pending.length, 1)
      assert.match(outcome.pending[0]?.decisionNote ?? '', /人工批准/)
      assert.deepEqual(outcome.state.tasks[0]?.scope, ['src/a.ts'])
    }
  })

  test('an approval is written back to the file it came from, not a new name', async () => {
    const cwd = await workspace()
    const { store, state } = await prepared(cwd, ['src/a.ts'])
    const requests = join(cwd, 'docs', 'guard', state.runId, 'requests')
    await mkdir(requests, { recursive: true })
    await writeFile(join(requests, 'custom-name.json'), JSON.stringify({
      version: 1, id: 'r9', taskId: 'T1', requestedBy: 'main', reason: 'x',
      addedPaths: ['src/b.ts'], evidenceIds: [], requiresHuman: false, status: 'pending', createdAt: 1,
    }), 'utf8')
    const outcome = await processScopeRequests(store, state, state.tasks[0]!)
    assert.equal(outcome.approved.length, 1)
    assert.deepEqual(outcome.state.tasks[0]?.scope, ['src/a.ts', 'src/b.ts'])
    const names = await readdir(requests)
    assert.deepEqual(names, ['custom-name.json'], 'no duplicate request file is created')
    const stored = JSON.parse(await readFile(join(requests, 'custom-name.json'), 'utf8')) as { status: string }
    assert.equal(stored.status, 'approved')
  })

  test('a patch capture survives a deleted path and keeps the human index intact', async () => {
    const cwd = await workspace()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 落盘 | 文件存在',
    })).runId
    await run('git', ['init', '-q'], { cwd })
    await run('git', ['config', 'user.email', 'g@test'], { cwd })
    await run('git', ['config', 'user.name', 'g'], { cwd })
    await writeFile(join(cwd, 'keep.ts'), 'keep')
    await writeFile(join(cwd, 'gone.ts'), 'gone')
    await run('git', ['add', 'keep.ts', 'gone.ts'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await run('git', ['rm', '--quiet', 'gone.ts'], { cwd })
    // The human staged work of their own before the audit ran.
    await writeFile(join(cwd, 'keep.ts'), 'staged by human')
    await run('git', ['add', 'keep.ts'], { cwd })

    await writeFile(join(cwd, 'new.ts'), 'brand new')
    const store = new GuardStore(join(cwd, 'docs', 'guard', runId))
    const capture = await captureBlockedPatch(cwd, store, 'T1', ['gone.ts', 'new.ts'], 1)
    assert.ok(capture !== null, 'the deletion does not abort the capture of the new file')
    assert.deepEqual([...capture.coveredPaths].sort(), ['gone.ts', 'new.ts'], 'a tracked deletion is covered by the diff')
    const text = await readFile(capture.path, 'utf8')
    assert.match(text, /new\.ts/)
    // The human's staged content is untouched.
    const staged = await run('git', ['diff', '--cached', '--name-only'], { cwd })
    assert.match(staged.stdout, /keep\.ts/)
  })

  // Round-11 P2-1: `core.quotepath` (git's default) escapes a non-ASCII path as
  // octal, so the staged-name list never matched `中文.ts`. The capture then ran
  // `git add -N` on the human's staged file and the cleanup `git reset --` unstaged
  // it: their work silently disappeared from the index.
  test('a staged filename with non-ASCII characters keeps its staged content', async () => {
    const cwd = await workspace()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 落盘 | 文件存在',
    })).runId
    await run('git', ['init', '-q'], { cwd })
    await run('git', ['config', 'user.email', 'g@test'], { cwd })
    await run('git', ['config', 'user.name', 'g'], { cwd })
    await writeFile(join(cwd, 'keep.ts'), 'keep')
    await run('git', ['add', 'keep.ts'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await writeFile(join(cwd, '中文.ts'), 'staged by human')
    await run('git', ['add', '中文.ts'], { cwd })
    await writeFile(join(cwd, 'new.ts'), 'brand new')
    const store = new GuardStore(join(cwd, 'docs', 'guard', runId))
    // The task's own dirty set includes the staged Chinese file, exactly what the
    // audit passes into the capture.
    const capture = await captureBlockedPatch(cwd, store, 'T1', ['中文.ts', 'new.ts'], 1)
    assert.ok(capture !== null)
    const staged = await run('git', ['diff', '--cached', '--name-only', '-z'], { cwd })
    assert.ok(staged.stdout.split('\u0000').includes('中文.ts'), `the human staged work survives: ${JSON.stringify(staged.stdout)}`)
    const diff = await run('git', ['diff', '--cached', '--', '中文.ts'], { cwd })
    assert.match(diff.stdout, /staged by human/, 'its content is still the staged version')
  })

  // Round-12 P1-2: `existing()` used `access()`/`stat()`, which FOLLOW a symlink:
  // a dangling one reads as missing, so the patch never contained it while the
  // rollback still deleted it — the failure text then claimed a backup that did
  // not hold the path. `lstat` keeps the link and the diff records its target.
  test('a dangling symlink is captured in the patch, not silently skipped', async () => {
    const cwd = await workspace()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 落盘 | 文件存在',
    })).runId
    await run('git', ['init', '-q'], { cwd })
    await run('git', ['config', 'user.email', 'g@test'], { cwd })
    await run('git', ['config', 'user.name', 'g'], { cwd })
    await writeFile(join(cwd, 'keep.ts'), 'keep')
    await run('git', ['add', 'keep.ts'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    // HEAD has no f.ts, and the link target does not exist either.
    await symlink('/nonexistent/guard-target', join(cwd, 'f.ts'))
    await writeFile(join(cwd, 'other.ts'), 'unrelated dirty file')

    const store = new GuardStore(join(cwd, 'docs', 'guard', runId))
    const capture = await captureBlockedPatch(cwd, store, 'T1', ['f.ts', 'other.ts'], 1)
    assert.ok(capture !== null, 'a dangling symlink must not abort the capture')
    assert.equal(capture.coveredPaths.has('f.ts'), true, 'the link itself is covered')
    assert.equal(capture.coveredPaths.has('other.ts'), true)
    const text = await readFile(capture.path, 'utf8')
    assert.match(text, /f\.ts/)
    assert.match(text, /\/nonexistent\/guard-target/, 'the patch records the link target')
  })

  test('a top-level wildcard is a whole-workspace grant, and `src/..` escapes', () => {
    for (const broad of ['*/**', '*/*', '?/x', '././**', '/**', '**/x']) {
      assert.equal(isBroadScopePath(broad), true, `${broad} must reach a human`)
    }
    for (const narrow of ['src/**', 'src/*.ts', 'a.ts', 'docs/17-x.md']) {
      assert.equal(isBroadScopePath(narrow), false, `${narrow} is an anchored grant`)
    }
    for (const unsafe of ['src/..', '../x', './../x', '/etc/passwd', '..']) {
      assert.equal(isSafeScopePath(unsafe), false, `${unsafe} must be refused`)
    }
    for (const safe of ['./src/**', 'src/a.ts', 'docs/x.md']) {
      assert.equal(isSafeScopePath(safe), true, `${safe} stays allowed`)
    }
  })

  test('sensitive paths cannot be smuggled past the auto-approval gate', () => {
    // A bare directory name is a valid glob that matches everything below it.
    for (const path of ['infra', 'infra/', '.github', '.git', 'node_modules']) {
      assert.equal(isSensitivePath(path), true, `${path} must reach a human`)
    }
    // Wildcards can spell a sensitive target without containing its name.
    for (const path of ['config/.env*', 'src/package.jso*', '.github/**', 'infra/*.tf']) {
      assert.equal(isSensitivePath(path), true, `${path} must reach a human`)
    }
    // macOS resolves these to the same files.
    for (const path of ['.GITHUB/workflows/ci.yml', 'INFRA/prod.tf', 'src/Package.json', './infra/x.tf']) {
      assert.equal(isSensitivePath(path), true, `${path} is the same file in another case`)
    }
    // Ordinary source paths stay auto-approvable.
    for (const path of ['src/a.ts', 'src/**', 'docs/17-x.md']) {
      assert.equal(isSensitivePath(path), false, `${path} is normal work`)
    }
  })
})

// Round-9 fixes: the sensitive-path rule used to look at the static NAME prefix,
// which both missed leading wildcards (`config/?env`) and mis-flagged ordinary
// source work (`src/s*.ts` → "security"). The directory anchors now apply at any
// depth, and every producer stores the normalized scope form.
describe('goal-supervisor sensitive path hardening', () => {
  test('a leading wildcard cannot spell a sensitive file past the gate', () => {
    for (const path of [
      'src/?ackage.json', 'config/?env', 'config/*env*', 'src/*env*', 'docker-compose*', 'src/package.jso*',
      // A truncated DIRECTORY name is the same bypass one level up.
      'vend*', 'node_mod*', 'docs/g*',
    ]) {
      assert.equal(isSensitivePath(path), true, `${path} must reach a human`)
    }
  })

  test('sensitive directories are found at any depth, and the guard ledger is never granted', () => {
    for (const path of [
      'packages/app/node_modules/**', 'sub/.git/config', '.guard/**', 'docs/guard/other-run/**',
      'nested/infra/prod.tf', '.husky/pre-commit',
    ]) {
      assert.equal(isSensitivePath(path), true, `${path} must reach a human`)
    }
  })

  test('ordinary source globs are no longer mis-flagged as truncated names', () => {
    // `src/s*.ts` used to match the static prefix of `security`, `p*` of
    // `package.json` and `d*` of `docker-compose`: three false human gates.
    // `docs/**/*.md` stays a human gate on purpose: it can reach
    // `docs/SECURITY.md`, so only the file-shaped false positives are pinned.
    for (const path of ['src/s*.ts', 'src/p*.ts', 'src/d*.ts', 'src/**', 'src/*.ts', 'docs/**/*.txt']) {
      assert.equal(isSensitivePath(path), false, `${path} is normal work`)
    }
  })

  test('a prepared run stores every scope entry in normalized form', async () => {
    const cwd = await workspace()
    const runId = (await prepareGuardRun(cwd, {
      goal: 'g', acceptance: 'a', discipline: 'd', tasks: 'T1 | 落盘 | 文件存在',
      scopes: { T1: ['././src/a.ts', 'src\\b.ts', 'docs//c.md/', 'docs/./d.md'] },
    })).runId
    const state = JSON.parse(await readFile(join(cwd, 'docs', 'guard', runId, 'tasks.json'), 'utf8')) as GuardState
    // Empty segments and `/./` are folded: `docs//guard/x` used to bypass the
    // sensitive-directory rules while still matching the real path.
    assert.deepEqual(state.tasks[0]?.scope, ['src/a.ts', 'src/b.ts', 'docs/c.md', 'docs/d.md'])
  })

  test('an approved request is stored normalized, and a sensitive wildcard waits', async () => {
    const cwd = await workspace()
    const { store, state } = await prepared(cwd, ['src/a.ts'])
    await request(cwd, state.runId, 'n1', ['././src/b.ts'])
    const ok = await processScopeRequests(store, state, state.tasks[0]!)
    assert.deepEqual(ok.approved[0]?.addedPaths, ['src/b.ts'])
    assert.deepEqual(ok.state.tasks[0]?.scope, ['src/a.ts', 'src/b.ts'])

    await request(cwd, state.runId, 'n2', ['config/?env'])
    const guarded = await processScopeRequests(store, ok.state, ok.state.tasks[0]!)
    assert.equal(guarded.approved.length, 0)
    assert.equal(guarded.pending[0]?.requiresHuman, true)
  })

  test('a folded separator cannot hide a guarded directory from the gate', async () => {
    for (const path of [
      'docs//guard/other-run/tasks.json', 'docs/./guard/other-run/tasks.json',
      'docs/.//guard/x', 'sub//.git/config', 'sub/./infra/prod.tf',
    ]) {
      assert.equal(isSensitivePath(path), true, `${path} must reach a human`)
    }
  })
})

// Round-10 P1-1: the wildcard check looked only at the LAST segment and at a
// digit-free lowercase sample, so a wildcard in a middle directory segment (or a
// different case) still spelled a guarded path and was auto-approved.
describe('goal-supervisor round-10 wildcard hardening', () => {
  test('a wildcard in a directory segment cannot spell a guarded directory', () => {
    for (const path of [
      'docs/g*/**', 'docs/guar?/**', 'docs/g*/other-run/tasks.json',
      'packages/node_mod*/**', 'sub/.g*/**', 'sub/.g*/config', 'sub/inf*/prod.tf',
      // A bare `*` at a directory position can spell `.git` / `infra` just as well.
      'sub/*/config', '*/infra/x',
    ]) {
      assert.equal(isSensitivePath(path), true, `${path} must reach a human`)
    }
  })

  test('a differently cased filename still spells a guarded file on a case-insensitive disk', () => {
    for (const path of ['src/Package.jso*', 'src/PACKAGE.JSON', 'SRC/.ENV', 'Docs/Guard/x']) {
      assert.equal(isSensitivePath(path), true, `${path} must reach a human`)
    }
  })

  test('a plain directory grant and ordinary file globs stay auto-approvable', () => {
    // `docs/**/*.txt` and `src/**` are directory grants, not a truncated name:
    // making every `**` segment sensitive would gate all ordinary work.
    for (const path of ['src/**', 'docs/**', 'docs/**/*.txt', 'src/*.ts', 'src/s*.ts', 'docs/17-x.md']) {
      assert.equal(isSensitivePath(path), false, `${path} is normal work`)
    }
  })
})

// Round-11 P1-3: `/`, `///`, `/.` and `/.`-style inputs fold to an empty segment
// list, and the old `joined !== ''` guard dropped the leading slash — so the
// normalized form was `''`, which `isSafeScopePath` accepted. A request adding
// `/` was then written back as `addedPaths: ['']`, `matchesGlob(path, '')`
// accepted every path, and one mistaken approval granted the whole workspace.
describe('goal-supervisor root path hardening', () => {
  test('a root-only scope path keeps its leading slash and is never safe', () => {
    for (const path of ['/', '///', '/.', '/./']) {
      assert.equal(normalizeScopePath(path), '/', `${path} keeps the absolute root`)
      assert.equal(isSafeScopePath(path), false, `${path} is the workspace root`)
      assert.equal(isBroadScopePath(path), true, `${path} covers everything`)
    }
    // A dot-only path is not absolute, but it still grants everything; the
    // normalized form is empty and must never be accepted as a relative scope.
    for (const path of ['.', './']) {
      assert.equal(normalizeScopePath(path), '')
      assert.equal(isSafeScopePath(path), false, `${path} grants the workspace root`)
    }
    // Folding must not turn a safe relative path into a root one.
    assert.equal(isSafeScopePath('src/a.ts'), true)
    assert.equal(normalizeScopePath('docs//17-x.md'), 'docs/17-x.md')
  })

  // Round-12 P2-1: `normalizeScopePath('/')` returns `'/'`, but the sensitive
  // check only rejected `''`. The exported predicates then disagreed:
  // `isBroadScopePath('/') === true` while `isSensitivePath('/') === false`.
  test('a normalized root path is sensitive, not just broad', () => {
    for (const path of ['/', '//', '/.//']) {
      assert.equal(normalizeScopePath(path), '/', `${path} normalizes to the root`)
      assert.equal(isSensitivePath(path), true, `${path} is the workspace root`)
      assert.equal(isBroadScopePath(path), true, `${path} covers everything`)
    }
    assert.equal(isSensitivePath('.'), true, 'a dot path still is the root')
  })

  // Round-12 P2-2: `normalizeScopePath('C:/')` drops the trailing slash and
  // returns `'C:'`; the old `/^[A-Za-z]:\//` test no longer matched, so a
  // Windows drive ROOT was accepted as a safe relative scope.
  test('a Windows drive root is never a safe scope path', () => {
    for (const path of ['C:/', 'C:\\', 'C://', 'C:\\/']) {
      assert.equal(normalizeScopePath(path), 'C:', `${path} folds to the bare drive`)
      assert.equal(isSafeScopePath(path), false, `${path} is an absolute drive root`)
    }
    // Ordinary relative paths are unaffected.
    assert.equal(isSafeScopePath('src/a.ts'), true)
  })

  test('a request adding the root path is dropped, never parked for approval', async () => {
    const cwd = await workspace()
    const { store, state } = await prepared(cwd, ['src/a.ts'])
    for (const [id, path] of [['root', '/'], ['dot', '.']] as const) {
      await request(cwd, state.runId, id, [path])
      const outcome = await processScopeRequests(store, state, state.tasks[0]!)
      assert.deepEqual(outcome.approved, [], `${path} must never be auto-approved`)
      assert.deepEqual(outcome.pending, [], `${path} is refused, not parked as '${path}' waiting for a human`)
      assert.deepEqual(outcome.state.tasks[0]?.scope, ['src/a.ts'], `${path} does not grow the scope`)
    }
  })
})
