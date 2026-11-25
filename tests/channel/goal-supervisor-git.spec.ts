import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, test } from 'vitest'
import {
  changedPaths, changedPathsSince, commitPaths, globsOverlap, hasRef, headCommit, matchesGlob, normalizeScopePath,
  pathInScope, pluginCommitShas, resetPaths, restorePaths, restoreTrackedToHead, revertCommit, rollbackToCheckpoint,
  tagCheckpoint,
} from '../../src/host/goal-supervisor/git'

const run = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guard-git-'))
  roots.push(root)
  await run('git', ['init', '-q'], { cwd: root })
  await run('git', ['config', 'user.email', 'guard@test'], { cwd: root })
  await run('git', ['config', 'user.name', 'guard'], { cwd: root })
  return root
}

describe('goal-supervisor scope globs', () => {
  test('matches directory prefixes, star and double-star', () => {
    assert.ok(matchesGlob('src/a.ts', 'src'))
    assert.ok(matchesGlob('src/a.ts', 'src/**'))
    assert.ok(matchesGlob('src/a.ts', 'src/*.ts'))
    assert.ok(matchesGlob('src/deep/a.ts', 'src/**'))
    assert.ok(!matchesGlob('src/deep/a.ts', 'src/*.ts'))
    assert.ok(matchesGlob('a.ts', '?.ts'))
    assert.ok(!matchesGlob('docs/x.md', 'src'))
  })

  test('an empty scope accepts everything', () => {
    assert.ok(pathInScope('anything', []))
    assert.ok(pathInScope('src/a.ts', ['src/**', 'lib']))
    assert.ok(!pathInScope('docs/x.md', ['src/**']))
  })
})

describe('goal-supervisor git surface', () => {
  test('lists changes, commits only the given paths and tags a checkpoint', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'a')
    await writeFile(join(cwd, 'b.ts'), 'b')
    const paths = await changedPaths(cwd, 'docs/guard/run')
    assert.deepEqual(paths.sort(), ['a.ts', 'b.ts'])

    const commit = await commitPaths(cwd, ['a.ts'], 'guard: a')
    assert.equal(commit.created, true)
    assert.ok(commit.sha !== null)

    const after = await changedPaths(cwd, 'docs/guard/run')
    assert.deepEqual(after, ['b.ts'])
    assert.equal(await headCommit(cwd), commit.sha)

    await tagCheckpoint(cwd, 'guard/run/T1', 'T1')
    const tags = await run('git', ['tag', '-l', 'guard/run/*'], { cwd })
    assert.match(tags.stdout, /guard\/run\/T1/)

    await writeFile(join(cwd, 'a.ts'), 'a2')
    await run('git', ['add', 'a.ts'], { cwd })
    await resetPaths(cwd, ['a.ts'])
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.match(status.stdout, /^ M a\.ts$/m)
  })

  test('reverts commits after a checkpoint without rewriting history', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'one')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'T1'], { cwd })
    await run('git', ['tag', 'guard/run/T1'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'two')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'T2'], { cwd })
    assert.equal((await readFile(join(cwd, 'a.ts'), 'utf8')), 'two')

    const result = await rollbackToCheckpoint(cwd, 'guard/run/T1')
    assert.deepEqual(result.reverted, ['T2'])
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'one')
    const log = await run('git', ['log', '--oneline'], { cwd })
    assert.match(log.stdout, /Revert/)
  })

  test('an empty rollback range is a no-op, not an error', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'one')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'T1'], { cwd })
    await run('git', ['tag', 'guard/run/T1'], { cwd })
    const result = await rollbackToCheckpoint(cwd, 'guard/run/T1')
    assert.deepEqual(result.reverted, [])
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'one')
  })

  test('a second rollback is a no-op and never flips the previous revert', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'one')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'T1'], { cwd })
    await run('git', ['tag', 'guard/run/T1'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'two')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'T2'], { cwd })
    await rollbackToCheckpoint(cwd, 'guard/run/T1')
    // A second call is a no-op: the tree is already at the checkpoint and the
    // caller must still be able to reset the ledger.
    const again = await rollbackToCheckpoint(cwd, 'guard/run/T1')
    assert.deepEqual(again.reverted, [])
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'one', 'the revert is never undone')
  })

  test('refuses an unknown checkpoint instead of reverting everything', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'one')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'T1'], { cwd })
    await assert.rejects(() => rollbackToCheckpoint(cwd, 'guard/run/nope'), /does not exist/)
  })

  test('restores the given paths to a checkpoint and deletes the ones it did not contain', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'one')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'T1'], { cwd })
    await run('git', ['tag', 'guard/run/T1'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'half-finished')
    await writeFile(join(cwd, 'new.ts'), 'brand new')
    const result = await restorePaths(cwd, 'guard/run/T1', ['a.ts', 'new.ts'])
    assert.deepEqual(result.restored, ['a.ts'])
    assert.deepEqual(result.removed, ['new.ts'])
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'one')
    await assert.rejects(() => readFile(join(cwd, 'new.ts'), 'utf8'))
  })

  test('restore skips a path that escapes the workspace', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'one')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'T1'], { cwd })
    await run('git', ['tag', 'guard/run/T1'], { cwd })
    const result = await restorePaths(cwd, 'guard/run/T1', ['../outside.ts'])
    assert.deepEqual(result.skipped, ['../outside.ts'])
    assert.deepEqual(result.restored, [])
  })

  test('hasRef sees an annotated tag, and revertCommit undoes one commit', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'one')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'T1'], { cwd })
    await tagCheckpoint(cwd, 'guard/run/T1', 'T1')
    assert.equal(await hasRef(cwd, 'guard/run/T1'), true)
    assert.equal(await hasRef(cwd, 'guard/run/T2'), false)
    await writeFile(join(cwd, 'a.ts'), 'two')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'T2'], { cwd })
    const head = await headCommit(cwd)
    assert.ok(head !== null)
    assert.equal(await revertCommit(cwd, head), true)
    assert.equal(await readFile(join(cwd, 'a.ts'), 'utf8'), 'one')
  })

  test('excludes the guard directory from change detection', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'keep.txt'), 'x')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'init'], { cwd })
    await mkdir(join(cwd, 'docs/guard/run'), { recursive: true })
    await writeFile(join(cwd, 'docs/guard/run/tasks.json'), '{}')
    const paths = await changedPaths(cwd, 'docs/guard/run')
    assert.deepEqual(paths, [])
    assert.ok((await readFile(join(cwd, 'docs/guard/run/tasks.json'), 'utf8')).includes('{}'))
  })

  test('`**/` spans zero directories so a top-level file still matches', () => {
    assert.ok(matchesGlob('src/a.ts', 'src/**/*.ts'), 'src/**/*.ts must match the direct child')
    assert.ok(matchesGlob('src/deep/a.ts', 'src/**/*.ts'))
    assert.ok(matchesGlob('a.ts', '**/*.ts'), '**/ must match the root too')
    assert.ok(!matchesGlob('src/a.md', 'src/**/*.ts'))
    assert.ok(!matchesGlob('src/a.ts/extra', 'src/*.ts'), 'a file suffix is not a directory prefix')
  })

  test('a path staged and then deleted from the worktree does not poison the commit', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'base')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    // The model staged `ad.ts`, then removed it: `git status` reports `AD`, and a
    // later `git add -A -- ad.ts` DROPS the index entry entirely. Passing the
    // literal path to `git commit --` then fails with
    // "pathspec 'ad.ts' did not match any file(s) known to git" and the run is
    // bounced back to IN_PROGRESS although the ledger is the only real change.
    await writeFile(join(cwd, 'ad.ts'), 'new')
    await run('git', ['add', 'ad.ts'], { cwd })
    await rm(join(cwd, 'ad.ts'))
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const commit = await commitPaths(cwd, ['ad.ts', 'docs/guard/run'], 'guard: T1 DONE')
    assert.equal(commit.created, true, 'the ledger commit is still made')
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.equal(status.stdout.trim(), '', 'the ledger is committed and the dropped path is gone')
    const files = await run('git', ['show', '--pretty=format:', '--name-only', 'HEAD'], { cwd })
    assert.match(files.stdout, /docs\/guard\/run\/tasks\.json/)
    assert.ok(!files.stdout.includes('ad.ts'), 'the deleted staged path is not resurrected')
  })

  // Round-11 P1-1: a rename is TWO index records. Without `--no-renames` the
  // staged-name list only reported the destination, so the source was filtered
  // out of `git commit --` and the checkpoint kept BOTH files while the source
  // deletion stayed staged — every later task then read that as an out-of-scope
  // change and the whole run deadlocked.
  test('a same-content rename commits both sides and leaves no staged deletion', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'same content')
    await writeFile(join(cwd, 'keep.ts'), 'keep')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await run('git', ['mv', 'a.ts', 'b.ts'], { cwd })
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const commit = await commitPaths(cwd, ['a.ts', 'b.ts', 'docs/guard/run'], 'guard(r): T1 DONE')
    assert.equal(commit.created, true)
    // `--no-renames` on the INSPECTION side too: the checkpoint keeps a rename
    // pair only if the tree holds both halves, so read it as a delete plus an add.
    const names = await run('git', ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD'], { cwd })
    assert.match(names.stdout, /^D\ta\.ts$/m, `the source deletion is committed: ${names.stdout}`)
    assert.match(names.stdout, /^A\tb\.ts$/m, `the destination is committed: ${names.stdout}`)
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.equal(status.stdout.trim(), '', `nothing is left staged: ${status.stdout}`)
  })

  test('a `git rm` deletion is committed instead of failing the staging step', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'gone.ts'), 'gone')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    // `git rm` leaves the path in neither the worktree nor the INDEX (only in
    // HEAD), and `git add -A -- gone.ts` then fails with "pathspec did not match".
    await run('git', ['rm', '--quiet', 'gone.ts'], { cwd })
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const commit = await commitPaths(cwd, ['gone.ts', 'docs/guard/run'], 'guard(r): T1 DONE')
    assert.equal(commit.created, true)
    const names = await run('git', ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD'], { cwd })
    assert.match(names.stdout, /^D\tgone\.ts$/m, `the deletion is committed: ${names.stdout}`)
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.equal(status.stdout.trim(), '', `nothing is left staged: ${status.stdout}`)
  })

  test('a staged index deletion with a real edit on disk is still staged', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'kept.ts'), 'original')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    // The INDEX says "deleted" but the file is back on disk with new content:
    // skipping `git add` because of the staged deletion alone would commit a
    // deletion and silently drop the edit.
    await run('git', ['rm', '--cached', '--quiet', 'kept.ts'], { cwd })
    await writeFile(join(cwd, 'kept.ts'), 'edited after the index removal')
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const commit = await commitPaths(cwd, ['kept.ts', 'docs/guard/run'], 'guard(r): T1 DONE')
    assert.equal(commit.created, true)
    const names = await run('git', ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD'], { cwd })
    assert.match(names.stdout, /^M\tkept\.ts$/m, `the edit is committed: ${names.stdout}`)
    const shown = await run('git', ['show', 'HEAD:kept.ts'], { cwd })
    assert.equal(shown.stdout.trim(), 'edited after the index removal')
  })

  // Round-12 P1-1: on a case-insensitive filesystem (APFS default,
  // `core.ignorecase=true`) `git mv a.ts A.ts` stages `D a.ts` + `A A.ts`, but
  // `lstat('a.ts')` resolves to `A.ts`, so the old code kept `a.ts` in the
  // pathspec. `git commit -- a.ts A.ts` builds a temporary index from HEAD and
  // then fails with "will not add file alias 'a.ts' ('A.ts' already exists in
  // index)" — no argument order helps. The task bounced back to IN_PROGRESS on
  // every turn.
  test('a case-only rename writes one side of the alias pair and commits both', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'same content')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await run('git', ['mv', 'a.ts', 'A.ts'], { cwd })
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const commit = await commitPaths(cwd, ['a.ts', 'A.ts', 'docs/guard/run'], 'guard(r): T1 DONE')
    assert.equal(commit.created, true)
    const names = await run('git', ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD'], { cwd })
    assert.match(names.stdout, /^D\ta\.ts$/m, `the old spelling is deleted: ${names.stdout}`)
    assert.match(names.stdout, /^A\tA\.ts$/m, `the new spelling is added: ${names.stdout}`)
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.equal(status.stdout.trim(), '', `nothing is left staged: ${status.stdout}`)
    const files = await run('git', ['ls-tree', '--name-only', 'HEAD'], { cwd })
    assert.deepEqual(files.stdout.trim().split('\n').sort(), ['A.ts', 'docs'], 'only one spelling exists in the tree')
  })

  // Round-12 P1-1 (second shape): a tracked file is `git rm`-ed and a DIRECTORY
  // of the same name takes its place. `lstat('a.ts')` reports the directory, so
  // the path stayed in `git commit --`; git then failed with
  // "error: 'a.ts' does not have a commit checked out / fatal: updating files
  // failed". The deletion and the children must land in ONE commit.
  test('a tracked file replaced by a same-name directory commits both sides', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'was a file')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await run('git', ['rm', '--quiet', 'a.ts'], { cwd })
    await mkdir(join(cwd, 'a.ts'), { recursive: true })
    await writeFile(join(cwd, 'a.ts', 'sub.ts'), 'now a child')
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')
    const changed = await changedPaths(cwd, 'docs/guard/run')
    assert.deepEqual(changed.sort(), ['a.ts', 'a.ts/sub.ts'], 'git reports the replaced path and its child')

    const commit = await commitPaths(cwd, [...changed, 'docs/guard/run'], 'guard(r): T1 DONE')
    assert.equal(commit.created, true)
    const names = await run('git', ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD'], { cwd })
    assert.match(names.stdout, /^D\ta\.ts$/m, `the replaced file is deleted: ${names.stdout}`)
    assert.match(names.stdout, /^A\ta\.ts\/sub\.ts$/m, `the child is added: ${names.stdout}`)
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.equal(status.stdout.trim(), '', `nothing is left staged: ${status.stdout}`)
  })

  // The same replacement without `git rm`: the deletion is still in the worktree
  // only, so the path cannot be skipped by the staged-deletion rule — the commit
  // must work purely through the index/`--only` avoidance.
  test('an unstaged file-to-directory replacement also commits both sides', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'was a file')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await rm(join(cwd, 'a.ts'))
    await mkdir(join(cwd, 'a.ts'), { recursive: true })
    await writeFile(join(cwd, 'a.ts', 'sub.ts'), 'now a child')
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const commit = await commitPaths(cwd, ['a.ts', 'a.ts/sub.ts', 'docs/guard/run'], 'guard(r): T1 DONE')
    assert.equal(commit.created, true)
    const names = await run('git', ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD'], { cwd })
    assert.match(names.stdout, /^D\ta\.ts$/m, `the replaced file is deleted: ${names.stdout}`)
    assert.match(names.stdout, /^A\ta\.ts\/sub\.ts$/m, `the child is added: ${names.stdout}`)
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.equal(status.stdout.trim(), '', `nothing is left staged: ${status.stdout}`)
  })

  // `presentInIndex` accepts a directory target written with a trailing slash, so
  // `ownedByTarget` must agree on what that target means. Otherwise the task's own
  // ledger was classified as "unrelated" and reset out of the temporary index,
  // producing a checkpoint without `tasks.json`.
  test('a directory target with a trailing slash still owns its children', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'a')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'task work')
    await writeFile(join(cwd, 'other.ts'), 'human staged')
    await run('git', ['add', 'other.ts'], { cwd })
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const commit = await commitPaths(cwd, ['a.ts', 'docs/guard/run/'], 'guard(r): T1 DONE')
    assert.equal(commit.created, true)
    const names = await run('git', ['show', '--pretty=format:', '--name-only', 'HEAD'], { cwd })
    assert.match(names.stdout, /^docs\/guard\/run\/tasks\.json$/m, `the ledger is committed: ${names.stdout}`)
    assert.ok(!names.stdout.includes('other.ts'), `the unrelated entry stays staged only: ${names.stdout}`)
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.match(status.stdout, /^A  other\.ts$/m, `the human's staged work survives: ${status.stdout}`)
  })

  // Round-14 P0-1: a checked-out submodule is ALWAYS a directory in the worktree
  // while HEAD records a GITLINK (`160000` / `commit`), not a file. The old
  // `trackedFileAt()` read that shape as "tracked file replaced by a same-name
  // directory" and `commitPaths()` skipped `git add` for `git update-index
  // --force-remove`, silently committing `D sub` — deleting the whole submodule
  // and leaving an untracked `sub/` behind. No network and no `.gitmodules`:
  // `update-index --cacheinfo` writes the exact index entry `git submodule add`
  // would create, so the shape is identical and CI-stable.
  test('advancing a tracked submodule commits M sub, never D sub', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'a')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    const sub = join(cwd, 'sub')
    await mkdir(sub)
    await run('git', ['init', '-q'], { cwd: sub })
    await run('git', ['config', 'user.email', 'guard@test'], { cwd: sub })
    await run('git', ['config', 'user.name', 'guard'], { cwd: sub })
    await writeFile(join(sub, 'f.ts'), 'one')
    await run('git', ['add', 'f.ts'], { cwd: sub })
    await run('git', ['commit', '-qm', 'one'], { cwd: sub })
    const first = (await run('git', ['rev-parse', 'HEAD'], { cwd: sub })).stdout.trim()
    await run('git', ['update-index', '--add', '--cacheinfo', `160000,${first},sub`], { cwd })
    await run('git', ['commit', '-qm', 'add sub'], { cwd })
    // Advance the submodule inside its own repository, exactly like a task that
    // runs `git submodule update` or commits inside `sub/`.
    await writeFile(join(sub, 'f.ts'), 'two')
    await run('git', ['add', 'f.ts'], { cwd: sub })
    await run('git', ['commit', '-qm', 'two'], { cwd: sub })

    assert.deepEqual(await changedPaths(cwd, 'docs/guard/run'), ['sub'])
    const commit = await commitPaths(cwd, ['sub'], 'guard(r1): T1 DONE')
    assert.equal(commit.created, true)
    const names = await run('git', ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD'], { cwd })
    assert.match(names.stdout, /^M\tsub$/m, `the gitlink is advanced, not deleted: ${names.stdout}`)
    assert.doesNotMatch(names.stdout, /^D\tsub$/m, `the submodule is never removed: ${names.stdout}`)
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.equal(status.stdout.trim(), '', `the worktree is clean afterwards: ${status.stdout}`)
  })

  // The index fallback of `trackedFileAt` (no HEAD yet) must apply the same
  // gitlink exclusion: a first commit may legitimately carry a submodule entry,
  // and treating it as a replaced file made `commitPaths` drop it from the index
  // and return "nothing to commit".
  test('an unborn branch does not mistake a staged gitlink for a replaced file', async () => {
    const cwd = await repo()
    const sub = join(cwd, 'sub')
    await mkdir(sub)
    await run('git', ['init', '-q'], { cwd: sub })
    await run('git', ['config', 'user.email', 'guard@test'], { cwd: sub })
    await run('git', ['config', 'user.name', 'guard'], { cwd: sub })
    await writeFile(join(sub, 'f.ts'), 'sub')
    await run('git', ['add', 'f.ts'], { cwd: sub })
    await run('git', ['commit', '-qm', 'sub'], { cwd: sub })
    const sha = (await run('git', ['rev-parse', 'HEAD'], { cwd: sub })).stdout.trim()
    await run('git', ['update-index', '--add', '--cacheinfo', `160000,${sha},sub`], { cwd })
    assert.equal(await headCommit(cwd), null, 'the branch is unborn, so only the index knows the entry')

    const commit = await commitPaths(cwd, ['sub'], 'guard(r1): T1 DONE')
    assert.equal(commit.created, true, 'the staged gitlink is committed, not removed')
    const names = await run('git', ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD'], { cwd })
    assert.match(names.stdout, /^A\tsub$/m, `the submodule entry is added: ${names.stdout}`)
    assert.doesNotMatch(names.stdout, /^D\tsub$/m)
  })

  // The other side of the same predicate: a COMMITTED directory is a tree, not a
  // replaced file. `ls-tree` must not answer "blob" for it, or the task's own
  // directory target would be force-removed from the index and committed as a
  // deletion while its files stay dirty in the worktree.
  test('a committed directory target is not a replaced file', async () => {
    const cwd = await repo()
    await mkdir(join(cwd, 'pkg'))
    await writeFile(join(cwd, 'pkg', 'one.ts'), 'base')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await writeFile(join(cwd, 'pkg', 'one.ts'), 'task work')
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const commit = await commitPaths(cwd, ['pkg', 'docs/guard/run'], 'guard(r1): T1 DONE')
    assert.equal(commit.created, true)
    const names = await run('git', ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD'], { cwd })
    assert.match(names.stdout, /^M\tpkg\/one\.ts$/m, `the directory's file is modified: ${names.stdout}`)
    assert.doesNotMatch(names.stdout, /^D\tpkg/m, `the committed directory is never removed: ${names.stdout}`)
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.equal(status.stdout.trim(), '', `the worktree is clean afterwards: ${status.stdout}`)
  })

  // Round-14 P1-1: `changedPaths` reports an untracked nested repository as
  // `nested/` (WITH a trailing slash) while `git add -A` stages that repository
  // as the gitlink `nested` (without one). `presentInIndex` compared the literal
  // forms only, filtered `nested/` out before `commitTargets`, and the guard
  // commit then took just `tasks.json`, leaving `A nested` staged forever — and
  // `enforce` blaming every later task for it.
  test('an untracked nested repository reported with a trailing slash is committed', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'base.ts'), 'base')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    const nested = join(cwd, 'nested')
    await mkdir(nested)
    await run('git', ['init', '-q'], { cwd: nested })
    await run('git', ['config', 'user.email', 'guard@test'], { cwd: nested })
    await run('git', ['config', 'user.name', 'guard'], { cwd: nested })
    await writeFile(join(nested, 'f.ts'), 'nested')
    await run('git', ['add', 'f.ts'], { cwd: nested })
    await run('git', ['commit', '-qm', 'nested'], { cwd: nested })
    await writeFile(join(cwd, 'other.ts'), 'human staged')
    await run('git', ['add', 'other.ts'], { cwd })
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const paths = await changedPaths(cwd, 'docs/guard/run')
    assert.deepEqual(paths.sort(), ['nested/', 'other.ts'], `git spells the nested repo with a slash: ${JSON.stringify(paths)}`)

    const commit = await commitPaths(cwd, ['nested/', 'docs/guard/run'], 'guard(r1): T1 DONE')
    assert.equal(commit.created, true, 'the task-owned paths are committed')
    const names = await run('git', ['show', '--pretty=format:', '--name-only', '--no-renames', 'HEAD'], { cwd })
    assert.match(names.stdout, /^nested$/m, `the nested repository is committed as a gitlink: ${names.stdout}`)
    assert.match(names.stdout, /^docs\/guard\/run\/tasks\.json$/m, `the ledger is committed: ${names.stdout}`)
    assert.ok(!names.stdout.includes('other.ts'), `the unrelated staged file stays out: ${names.stdout}`)
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.equal(status.stdout.trim(), 'A  other.ts', `nothing but the human's entry is left staged: ${status.stdout}`)
  })

  // Round-13 P1-1: the replacement directory may hold a file the task never
  // declared (a human's pre-staged work, a sibling task's file, a baseline-dirty
  // file). `git add -A -- a.ts` stages the WHOLE directory recursively, and the
  // old `ownedByTarget` then read the file-deletion entry `a.ts` as a directory
  // prefix and committed the undeclared child. A file-to-directory replacement is
  // a deletion target, never a directory target.
  test('a staged file-to-directory replacement never commits an undeclared child', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'was a file')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await run('git', ['rm', '--quiet', 'a.ts'], { cwd })
    await mkdir(join(cwd, 'a.ts'), { recursive: true })
    await writeFile(join(cwd, 'a.ts', 'sub.ts'), 'declared child')
    // Never listed in `paths`: the human staged it, so the checkpoint must not
    // take it over.
    await writeFile(join(cwd, 'a.ts', 'secret.ts'), 'human staged child')
    await run('git', ['add', 'a.ts/secret.ts'], { cwd })
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const commit = await commitPaths(cwd, ['a.ts', 'a.ts/sub.ts', 'docs/guard/run'], 'guard(r): T1 DONE')
    assert.equal(commit.created, true)
    const names = await run('git', ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD'], { cwd })
    assert.match(names.stdout, /^D\ta\.ts$/m, `the replaced file is deleted: ${names.stdout}`)
    assert.match(names.stdout, /^A\ta\.ts\/sub\.ts$/m, `the declared child is added: ${names.stdout}`)
    assert.ok(!names.stdout.includes('a.ts/secret.ts'), `the undeclared child is NOT committed: ${names.stdout}`)
    const status = await run('git', ['status', '--porcelain', '--', 'a.ts/secret.ts'], { cwd })
    assert.equal(status.stdout.trim(), 'A  a.ts/secret.ts', `the human's staged child keeps its staged state: ${status.stdout}`)
    assert.equal(await readFile(join(cwd, 'a.ts', 'secret.ts'), 'utf8'), 'human staged child')
  })

  test('a staged file-to-directory replacement never stages an untracked child', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'was a file')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await run('git', ['rm', '--quiet', 'a.ts'], { cwd })
    await mkdir(join(cwd, 'a.ts'), { recursive: true })
    await writeFile(join(cwd, 'a.ts', 'sub.ts'), 'declared child')
    await writeFile(join(cwd, 'a.ts', 'secret.ts'), 'not mine')
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const commit = await commitPaths(cwd, ['a.ts', 'a.ts/sub.ts', 'docs/guard/run'], 'guard(r): T1 DONE')
    assert.equal(commit.created, true)
    const names = await run('git', ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD'], { cwd })
    assert.match(names.stdout, /^D\ta\.ts$/m, `the replaced file is deleted: ${names.stdout}`)
    assert.match(names.stdout, /^A\ta\.ts\/sub\.ts$/m, `the declared child is added: ${names.stdout}`)
    assert.ok(!names.stdout.includes('a.ts/secret.ts'), `the undeclared child is NOT committed: ${names.stdout}`)
    // `git add -A -- a.ts` (the mutation this test kills) stages the child even
    // when the commit later filters it out; the worktree state must stay
    // exactly as it was.
    const status = await run('git', ['status', '--porcelain', '--', 'a.ts/secret.ts'], { cwd })
    assert.equal(status.stdout.trim(), '?? a.ts/secret.ts', `the undeclared child stays untracked: ${status.stdout}`)
    assert.equal(await readFile(join(cwd, 'a.ts', 'secret.ts'), 'utf8'), 'not mine')
  })

  test('an unstaged file-to-directory replacement never stages an undeclared child', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'was a file')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    // No `git rm`: the deletion lives in the worktree only, so the path is not in
    // `stagedDeletions` and used to reach `git add -A` as a directory target.
    await rm(join(cwd, 'a.ts'))
    await mkdir(join(cwd, 'a.ts'), { recursive: true })
    await writeFile(join(cwd, 'a.ts', 'sub.ts'), 'declared child')
    await writeFile(join(cwd, 'a.ts', 'secret.ts'), 'not mine')
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const commit = await commitPaths(cwd, ['a.ts', 'a.ts/sub.ts', 'docs/guard/run'], 'guard(r): T1 DONE')
    assert.equal(commit.created, true)
    const names = await run('git', ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD'], { cwd })
    assert.match(names.stdout, /^D\ta\.ts$/m, `the replaced file is deleted: ${names.stdout}`)
    assert.match(names.stdout, /^A\ta\.ts\/sub\.ts$/m, `the declared child is added: ${names.stdout}`)
    assert.ok(!names.stdout.includes('a.ts/secret.ts'), `the undeclared child is NOT committed: ${names.stdout}`)
    const status = await run('git', ['status', '--porcelain', '--', 'a.ts/secret.ts'], { cwd })
    assert.equal(status.stdout.trim(), '?? a.ts/secret.ts', `the undeclared child stays untracked: ${status.stdout}`)
  })

  // The alias pair cannot be split: if the recorded change set names only the
  // destination, committing it without the source deletion would leave a tree
  // that holds both spellings (uncheckoutable) or lose the file entirely. On a
  // case-insensitive checkout an index entry differing only in case is ours.
  test('a case-only rename commits both sides even when only the new spelling is listed', async () => {
    const cwd = await repo()
    // The alias pair only exists on a case-insensitive checkout (APFS/Windows).
    // On a case-sensitive filesystem `a.ts` and `A.ts` are different files and
    // committing only the declared destination must not take the other one over.
    const ignoreCase = (await run('git', ['config', '--get', 'core.ignorecase'], { cwd })).stdout.trim()
    if (ignoreCase !== 'true') return
    await writeFile(join(cwd, 'a.ts'), 'same content')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await run('git', ['mv', 'a.ts', 'A.ts'], { cwd })
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const commit = await commitPaths(cwd, ['A.ts', 'docs/guard/run'], 'guard(r): T1 DONE')
    assert.equal(commit.created, true)
    const names = await run('git', ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD'], { cwd })
    assert.match(names.stdout, /^D\ta\.ts$/m, `the source deletion is still committed: ${names.stdout}`)
    assert.match(names.stdout, /^A\tA\.ts$/m, `the destination is committed: ${names.stdout}`)
    const files = await run('git', ['ls-tree', '--name-only', 'HEAD'], { cwd })
    assert.deepEqual(files.stdout.trim().split('\n').sort(), ['A.ts', 'docs'], 'the tree holds only one spelling')
  })

  // Round-12 P1-1 commit strategy: `git commit` without a pathspec commits the
  // whole index, so an unrelated entry the human staged must keep its staged
  // state. The temporary-index path commits only the task's own entries — also
  // on an unborn branch, where the unrelated entry has no HEAD version to reset.
  test('an unborn repository commits only the task paths and keeps the human staged entry', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'task work')
    await writeFile(join(cwd, 'other.ts'), 'human staged')
    await run('git', ['add', 'other.ts'], { cwd })
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const commit = await commitPaths(cwd, ['a.ts', 'docs/guard/run'], 'guard(r): T1 DONE')
    assert.equal(commit.created, true)
    const names = await run('git', ['show', '--pretty=format:', '--name-only', 'HEAD'], { cwd })
    assert.match(names.stdout, /^a\.ts$/m)
    assert.match(names.stdout, /docs\/guard\/run\/tasks\.json/)
    assert.ok(!names.stdout.includes('other.ts'), `the unrelated entry is not committed: ${names.stdout}`)
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.match(status.stdout, /^A  other\.ts$/m, `the human's staged work survives: ${status.stdout}`)
  })

  test('an unrelated staged entry survives a commit that omits the pathspec', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'base')
    await writeFile(join(cwd, 'other.ts'), 'base')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'task work')
    await writeFile(join(cwd, 'other.ts'), 'human staged')
    await run('git', ['add', 'other.ts'], { cwd })
    await mkdir(join(cwd, 'docs', 'guard', 'run'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'guard', 'run', 'tasks.json'), '{}')

    const commit = await commitPaths(cwd, ['a.ts', 'docs/guard/run'], 'guard(r): T1 DONE')
    assert.equal(commit.created, true)
    const shown = await run('git', ['show', 'HEAD:a.ts'], { cwd })
    assert.equal(shown.stdout.trim(), 'task work', 'the task path is committed')
    const other = await run('git', ['show', 'HEAD:other.ts'], { cwd })
    assert.equal(other.stdout.trim(), 'base', 'the unrelated staged entry is NOT committed')
    const status = await run('git', ['status', '--porcelain'], { cwd })
    assert.match(status.stdout, /^M  other\.ts$/m, `the human's staged work is untouched: ${status.stdout}`)
  })

  // Round-13 P2-2: once `unrelated.length > 0` proves the index holds someone
  // else's staged work, a pathless commit would sweep it in. The temporary-index
  // route is the only safe one, so an unlocatable index must FAIL the commit —
  // never silently fall back to the pathless form.
  test('a commit never falls back to a pathless commit when the index cannot be located', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'base')
    await writeFile(join(cwd, 'other.ts'), 'base')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    const base = await headCommit(cwd)
    await writeFile(join(cwd, 'a.ts'), 'task work')
    await run('git', ['add', 'a.ts'], { cwd })
    await writeFile(join(cwd, 'other.ts'), 'human staged')
    await run('git', ['add', 'other.ts'], { cwd })

    const realGit = (await run('sh', ['-c', 'command -v git'])).stdout.trim()
    assert.ok(realGit !== '', 'the real git binary is resolvable')
    const bin = await mkdtemp(join(tmpdir(), 'guard-fakebin-'))
    roots.push(bin)
    const originalPath = process.env.PATH ?? ''
    try {
      // Both shapes of the same bug: a non-zero `rev-parse` and a silent empty
      // answer. Each gets its own wrapper directory because `execFile` resolves
      // the literal name `git` through PATH.
      for (const mode of ['fail', 'empty']) {
        const dir = join(bin, mode)
        await mkdir(dir)
        const branch = mode === 'fail'
          ? '  echo "simulated index location failure" >&2\n  exit 129\n'
          : '  exit 0\n'
        // Only `rev-parse --git-path index` is intercepted; every other call is
        // the real git, so the rest of the commit machinery stays genuine.
        await writeFile(
          join(dir, 'git'),
          `#!/bin/sh\nif [ "$1" = "rev-parse" ] && [ "$2" = "--git-path" ] && [ "$3" = "index" ]; then\n${branch}fi\nexec "${realGit}" "$@"\n`,
          'utf8',
        )
        await chmod(join(dir, 'git'), 0o755)
        process.env.PATH = `${dir}:${originalPath}`
        await assert.rejects(
          () => commitPaths(cwd, ['a.ts'], 'guard(r): T1 DONE'),
          /git commit failed|unable to locate git index/,
          `${mode}: an unlocatable index must fail, not commit the whole index`,
        )
        process.env.PATH = originalPath
        assert.equal(await headCommit(cwd), base, `${mode}: no commit was created`)
        const status = await run('git', ['status', '--porcelain'], { cwd })
        assert.match(status.stdout, /^M  other\.ts$/m, `${mode}: the unrelated staged entry is untouched: ${status.stdout}`)
        assert.match(status.stdout, /^M  a\.ts$/m, `${mode}: the task path is still staged: ${status.stdout}`)
      }
    } finally {
      process.env.PATH = originalPath
    }
  })
})

describe('goal-supervisor changed paths', () => {
  async function seeded(): Promise<string> {
    const cwd = await repo()
    await writeFile(join(cwd, 'README.md'), 'readme')
    await writeFile(join(cwd, 'a.ts'), 'a')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    return cwd
  }

  test('a rename reports both the destination and the removed source', async () => {
    const cwd = await seeded()
    await run('git', ['mv', 'README.md', 'docs.md'], { cwd })
    const paths = await changedPaths(cwd, 'docs/guard/run')
    assert.ok(paths.includes('docs.md'), 'the destination is a change')
    assert.ok(paths.includes('README.md'), 'moving the file away deletes the original path')
  })

  test('a rename into the ledger directory does not corrupt the next entry', async () => {
    const cwd = await seeded()
    await mkdir(join(cwd, 'docs/guard/run'), { recursive: true })
    await run('git', ['mv', 'a.ts', 'docs/guard/run/a.ts'], { cwd })
    await writeFile(join(cwd, 'zeta.ts'), 'z')
    const paths = await changedPaths(cwd, 'docs/guard/run')
    assert.ok(!paths.includes('docs/guard/run/a.ts'), 'the ledger stays invisible')
    assert.ok(paths.includes('a.ts'), 'the removed source is still reported')
    assert.ok(paths.includes('zeta.ts'), 'the following entry is parsed intact')
  })

  test('a committed change is still attributed to the task', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'one')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    const start = await headCommit(cwd)
    assert.ok(start !== null)
    // A subagent runs `git commit` itself: the worktree is clean afterwards.
    await writeFile(join(cwd, 'outside.ts'), 'sneaky')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'subagent commit'], { cwd })
    assert.deepEqual(await changedPaths(cwd, 'docs/guard/run'), [])
    const since = await changedPathsSince(cwd, start, 'docs/guard/run')
    assert.deepEqual(since, ['outside.ts'], 'the commit range is audited, not just the worktree')
  })

  test('a copy entry does not lose its own source, and never corrupts the next one', async () => {
    const cwd = await seeded()
    // Git only emits a `C` pair when the source is part of the same diff, so the
    // fixture modifies it too — otherwise `status` prints a plain `A` entry and
    // the parser branch under test never runs.
    const body = 'export const one = 1\n'.repeat(20)
    await writeFile(join(cwd, 'a.ts'), body)
    await run('git', ['add', 'a.ts'], { cwd })
    await run('git', ['commit', '-qm', 'grow a.ts'], { cwd })
    // `{ cwd }` on EVERY git call: a bare `git config` would rewrite this
    // checkout's own `.git/config` (worktrees share it).
    await run('git', ['config', 'status.renames', 'copies'], { cwd })
    await run('cp', ['a.ts', 'a-copy.ts'], { cwd })
    await run('git', ['add', 'a-copy.ts'], { cwd })
    await writeFile(join(cwd, 'a.ts'), `${body}export const two = 2\n`)
    await run('git', ['add', 'a.ts'], { cwd })
    await writeFile(join(cwd, 'zeta.ts'), 'z')
    const raw = await run('git', ['status', '--porcelain', '-z'], { cwd })
    assert.ok(raw.stdout.includes('C  a-copy.ts\u0000a.ts\u0000'), `the fixture really is a copy entry: ${JSON.stringify(raw.stdout)}`)

    const paths = await changedPaths(cwd, 'docs/guard/run')
    assert.ok(paths.includes('a-copy.ts'), 'the new copy is a change')
    assert.ok(paths.includes('a.ts'), 'the modified source keeps its own entry')
    assert.ok(paths.includes('zeta.ts'), 'the entry after the pair is parsed intact')
    assert.equal(paths.filter(path => path === 'a.ts').length, 1, 'no duplicates from the pair')
  })

  test('restorePaths refuses a missing ref instead of deleting every path', async () => {
    const cwd = await seeded()
    const path = join(cwd, 'a.ts')
    assert.equal(await readFile(path, 'utf8'), 'a')
    const outcome = await restorePaths(cwd, 'guard/run/missing', ['a.ts'])
    assert.deepEqual(outcome.restored, [])
    assert.deepEqual(outcome.removed, [], 'a missing ref is not an order to delete')
    assert.deepEqual(outcome.skipped, ['a.ts'])
    assert.equal(await readFile(path, 'utf8'), 'a', 'the file survives')
  })

  test('a reverted out-of-scope commit is not blamed again', async () => {
    const cwd = await seeded()
    const base = (await headCommit(cwd)) as string
    // A subagent commits an out-of-scope file, then the rollback reverts it.
    await writeFile(join(cwd, 'outside.ts'), 'bad')
    await run('git', ['add', 'outside.ts'], { cwd })
    await run('git', ['commit', '-qm', 'subagent sneaky'], { cwd })
    const sneaky = (await headCommit(cwd)) as string
    await run('git', ['revert', '--no-edit', sneaky], { cwd })
    assert.ok(!existsSync(join(cwd, 'outside.ts')), 'the revert removed the file')
    const paths = await changedPathsSince(cwd, base, 'docs/guard/run', { runId: 'r1', taskId: 'T1' })
    assert.deepEqual(paths, [], 'the reverted path is no longer a change')
  })
})

// Round-12 P1-2: `restoreTrackedToHead` used to delete every HEAD-absent dirty
// copy whenever ANY patch had been captured. The patch is built from the whole
// dirty set, so an unrelated dirty file made the boolean true while the path
// being deleted was not in the patch at all — the reason text then claimed a
// backup that did not exist. Coverage is now per path.
describe('goal-supervisor restore tracked to head', () => {
  test('only a path the patch covers may be deleted; the rest are kept', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'keep.ts'), 'keep')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    // Neither path exists at HEAD. A patch covers `a.ts` only.
    await writeFile(join(cwd, 'a.ts'), 'covered')
    await writeFile(join(cwd, 'b.ts'), 'not covered')

    const result = await restoreTrackedToHead(cwd, ['a.ts', 'b.ts'], {
      backedUpPaths: new Set(['a.ts']),
    })
    assert.deepEqual(result.reset, [], 'neither path exists at HEAD, so nothing was reset to HEAD')
    assert.deepEqual(result.removed, ['a.ts'], 'the covered copy is removed')
    assert.deepEqual(result.refused, ['b.ts'], 'the uncovered copy is refused, not silently deleted')
    assert.equal(existsSync(join(cwd, 'b.ts')), true, 'the uncovered copy is still on disk')
    assert.equal(existsSync(join(cwd, 'a.ts')), false)
  })

  test('without any coverage every HEAD-absent copy is refused', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'keep.ts'), 'keep')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'dirty')

    const result = await restoreTrackedToHead(cwd, ['a.ts'])
    assert.deepEqual(result.reset, [])
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.refused, ['a.ts'])
    assert.equal(existsSync(join(cwd, 'a.ts')), true)
  })

  // Round-13 P2-1: the caller used to announce every dirty scoped path as
  // "reset to HEAD", including the HEAD-absent ones it had just refused (or
  // deleted). `reset` names exactly the paths a successful `checkout HEAD`
  // brought back, so the failure text can stop contradicting itself.
  test('only a successful checkout counts as reset to HEAD', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'tracked.ts'), 'base')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await writeFile(join(cwd, 'tracked.ts'), 'dirty edit')
    await writeFile(join(cwd, 'new.ts'), 'staged addition')
    await run('git', ['add', 'new.ts'], { cwd })

    const result = await restoreTrackedToHead(cwd, ['tracked.ts', 'new.ts'], {
      backedUpPaths: new Set(['new.ts']),
    })
    assert.deepEqual(result.reset, ['tracked.ts'], 'only the tracked path is checked out from HEAD')
    assert.deepEqual(result.removed, ['new.ts'], 'the covered HEAD-absent copy is deleted, not reset')
    assert.deepEqual(result.refused, [])
    assert.equal(await readFile(join(cwd, 'tracked.ts'), 'utf8'), 'base')
    assert.equal(existsSync(join(cwd, 'new.ts')), false)
  })

  // Round-14 P2-1: a path that EXISTS at HEAD but whose `checkout HEAD` fails
  // (a locked file, a permission error) used to be dropped from every bucket:
  // not reset, not removed, not refused. The caller then reported "no dirty file
  // in this task's scope to reset" while a dirty file was in fact still there.
  // The failure is simulated by intercepting only that one checkout, so the
  // assertion does not depend on file permissions or on running as non-root.
  test('a failed checkout is reported instead of being silently dropped', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'locked.ts'), 'base')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await writeFile(join(cwd, 'locked.ts'), 'dirty edit')

    const realGit = (await run('sh', ['-c', 'command -v git'])).stdout.trim()
    assert.ok(realGit !== '', 'the real git binary is resolvable')
    const bin = await mkdtemp(join(tmpdir(), 'guard-fakebin-'))
    roots.push(bin)
    await writeFile(
      join(bin, 'git'),
      `#!/bin/sh\nif [ "$1" = "checkout" ] && [ "$2" = "HEAD" ] && [ "$3" = "--" ] && [ "$4" = "locked.ts" ]; then\n  echo "simulated checkout failure" >&2\n  exit 1\nfi\nexec "${realGit}" "$@"\n`,
      'utf8',
    )
    await chmod(join(bin, 'git'), 0o755)
    const originalPath = process.env.PATH ?? ''
    try {
      process.env.PATH = `${bin}:${originalPath}`
      const result = await restoreTrackedToHead(cwd, ['locked.ts'])
      assert.deepEqual(result.reset, [], 'a failed checkout is never reported as reset')
      assert.deepEqual(result.failed, ['locked.ts'], 'the failed path is reported, not dropped')
      assert.deepEqual(result.removed, [])
      assert.deepEqual(result.refused, [])
      assert.equal(await readFile(join(cwd, 'locked.ts'), 'utf8'), 'dirty edit', 'the dirty copy is untouched')
    } finally {
      process.env.PATH = originalPath
    }
  })
})

describe('goal-supervisor plugin commit authorship', () => {
  test('a forged plugin subject is not skipped; the plugin checkpoint tag is proof', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'a')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    const start = (await headCommit(cwd)) as string
    // The subagent can read the run id and forge the plugin's commit message.
    await writeFile(join(cwd, 'outside.ts'), 'sneaky')
    await run('git', ['add', 'outside.ts'], { cwd })
    await run('git', ['commit', '-qm', 'guard(r1): T2 DONE'], { cwd })
    const forged = await changedPathsSince(cwd, start, 'docs/guard/run', { runId: 'r1', taskId: 'T1' })
    assert.deepEqual(forged, ['outside.ts'], 'a subject alone must never hide a commit')

    // The annotated tag only the plugin writes makes the same commit a sibling's.
    await run('git', ['tag', '-a', 'guard/r1/T2', '-m', 'T2'], { cwd })
    const tagged = await changedPathsSince(cwd, start, 'docs/guard/run', { runId: 'r1', taskId: 'T1' })
    assert.deepEqual(tagged, [], 'the checkpoint tag proves whose commit it is')
  })

  test('a merge commit brings its own files into the audit', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'a')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    const start = (await headCommit(cwd)) as string
    const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim()
    await run('git', ['checkout', '-q', '-b', 'feature'], { cwd })
    await writeFile(join(cwd, 'feature.ts'), 'feature')
    await run('git', ['add', 'feature.ts'], { cwd })
    await run('git', ['commit', '-qm', 'feature work'], { cwd })
    await run('git', ['checkout', '-q', branch], { cwd })
    await writeFile(join(cwd, 'main.ts'), 'main')
    await run('git', ['add', 'main.ts'], { cwd })
    await run('git', ['commit', '-qm', 'main work'], { cwd })
    // An "evil merge": a file that exists in NO side commit, only in the merge.
    await run('git', ['merge', '--no-ff', '--no-commit', 'feature'], { cwd })
    await writeFile(join(cwd, 'merge-only.ts'), 'smuggled')
    await run('git', ['add', 'merge-only.ts'], { cwd })
    await run('git', ['commit', '-qm', 'merge feature'], { cwd })

    const paths = await changedPathsSince(cwd, start, 'docs/guard/run', { runId: 'r1', taskId: 'T1' })
    assert.ok(paths.includes('merge-only.ts'), `the merge diff is inspected: ${JSON.stringify(paths)}`)
  })
})

// Round-9 fixes: attribution must not depend on the commit message form, the
// plugin's tag lookup must sanitize its run id, and every scope producer must
// store the same normalized path form the matcher compares against.
describe('goal-supervisor attribution edge cases', () => {
  test('a commit with an empty message is still audited', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'a')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    const start = (await headCommit(cwd)) as string
    // `--allow-empty-message` produces `sha\t` in `git log --format=%H%x09%s`.
    // Skipping the empty subject made every path of this commit invisible.
    await writeFile(join(cwd, 'sneaky.ts'), 'sneaky')
    await run('git', ['add', 'sneaky.ts'], { cwd })
    await run('git', ['commit', '--allow-empty-message', '-m', ''], { cwd })
    const paths = await changedPathsSince(cwd, start, 'docs/guard/run', { runId: 'r1', taskId: 'T1' })
    assert.ok(paths.includes('sneaky.ts'), `the empty-subject commit is audited: ${JSON.stringify(paths)}`)
  })

  test('a run id that needs sanitizing still finds its own checkpoint tags', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'a')
    await run('git', ['add', '.'], { cwd })
    await run('git', ['commit', '-qm', 'base'], { cwd })
    await writeFile(join(cwd, 'b.ts'), 'b')
    await run('git', ['add', 'b.ts'], { cwd })
    await run('git', ['commit', '-qm', 'guard: done'], { cwd })
    const sha = (await headCommit(cwd)) as string
    // The checkout names the tag `guard/my-run/T1` (ref-safe segment), so a raw
    // `my--run` prefix found nothing and blamed the commit on the audited task.
    await run('git', ['tag', '-a', 'guard/my-run/T1', '-m', 'T1'], { cwd })
    const shas = await pluginCommitShas(cwd, 'my--run')
    assert.equal(shas.size, 1, JSON.stringify([...shas]))
    assert.ok(shas.has(sha))
  })

  test('scope normalization is shared by the matcher and the overlap test', () => {
    assert.equal(matchesGlob('src/a.ts', '././src/a.ts'), true)
    assert.equal(matchesGlob('src/a.ts', 'src\\a.ts'), true)
    assert.equal(matchesGlob('src/deep/a.ts', './src/**'), true)
    assert.equal(globsOverlap('././src/a.ts', 'src/a.ts'), true)
    assert.equal(globsOverlap('src\\a.ts', 'src/a.ts'), true)
    assert.equal(globsOverlap('././src/a.ts', 'src/b.ts'), false)
  })

  test('a root-only path keeps its leading slash and is never empty', () => {
    // `'/'`, `'///'`, `'/.`'` and `'/./'` all fold to an empty segment list; the
    // old `joined !== ''` guard dropped the leading slash and returned `''`,
    // which read as "no scope" (`matchesGlob(path, '')` accepts everything).
    for (const path of ['/', '///', '/.', '/./']) {
      assert.equal(normalizeScopePath(path), '/', `${path} keeps the absolute root`)
    }
    assert.equal(normalizeScopePath('//etc/passwd'), '/etc/passwd', 'a double leading slash is still absolute')
    assert.equal(normalizeScopePath('.'), '')
    assert.equal(normalizeScopePath('./'), '')
  })
})
