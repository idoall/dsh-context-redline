import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import type { ProbeDef } from '../../src/host/goal-supervisor/schema'
import { insideWorkspace, isNetworkUse, probeEnv, runProbe } from '../../src/host/goal-supervisor/probes'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guard-probe-'))
  roots.push(root)
  return root
}

function probe(spec: ProbeDef['spec'], overrides: Partial<ProbeDef> = {}): ProbeDef {
  return { id: 'P1', taskId: 'T1', weight: 'light', spec, enabled: true, ...overrides }
}

describe('goal-supervisor probes', () => {
  test('file_exists reports pass and fail; disabled is unknown', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'a.ts'), 'ok')
    assert.equal((await runProbe(cwd, probe({ kind: 'file_exists', path: 'a.ts' }))).result, 'pass')
    assert.equal((await runProbe(cwd, probe({ kind: 'file_exists', path: 'b.ts' }))).result, 'fail')
    assert.equal((await runProbe(cwd, probe({ kind: 'file_exists', path: 'a.ts' }, { enabled: false }))).result, 'unknown')
  })

  test('file_contains supports plain and regex patterns', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'a.ts'), 'export const answer = 42\n')
    assert.equal((await runProbe(cwd, probe({ kind: 'file_contains', path: 'a.ts', pattern: 'answer' }))).result, 'pass')
    assert.equal((await runProbe(cwd, probe({ kind: 'file_contains', path: 'a.ts', pattern: 'ANSWER', flags: 'i' }))).result, 'pass')
    assert.equal((await runProbe(cwd, probe({ kind: 'file_contains', path: 'a.ts', pattern: 'missing' }))).result, 'fail')
    assert.equal((await runProbe(cwd, probe({ kind: 'file_contains', path: 'gone.ts', pattern: 'x' }))).result, 'fail')
  })

  test('number_gte reads a captured number from a file', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'counts.txt'), 'samples: 42\n')
    const read = probe({ kind: 'number_gte', source: { type: 'file', path: 'counts.txt', pattern: 'samples:\\s*(\\d+)' }, threshold: 40 })
    assert.equal((await runProbe(cwd, read)).result, 'pass')
    const high = probe({ kind: 'number_gte', source: { type: 'file', path: 'counts.txt', pattern: 'samples:\\s*(\\d+)' }, threshold: 50 })
    assert.equal((await runProbe(cwd, high)).result, 'fail')
  })

  test('command probes report exit codes and treat a missing binary as unknown', async () => {
    const cwd = await workspace()
    const ok = probe({ kind: 'command', cmd: process.execPath, args: ['-e', 'process.exit(0)'] })
    assert.equal((await runProbe(cwd, ok)).result, 'pass')
    const bad = probe({ kind: 'command', cmd: process.execPath, args: ['-e', 'process.exit(2)'] })
    const failed = await runProbe(cwd, bad)
    assert.equal(failed.result, 'fail')
    assert.equal(failed.exitCode, 2)
    const missing = probe({ kind: 'command', cmd: 'definitely-not-a-real-binary-xyz', args: [] })
    assert.equal((await runProbe(cwd, missing)).result, 'unknown')
  })

  test('probe commands never inherit secret-looking environment variables', async () => {
    const previous = process.env.GUARD_TEST_TOKEN
    process.env.GUARD_TEST_TOKEN = 'leak'
    try {
      const cwd = await workspace()
      const probeDef = probe({
        kind: 'command',
        cmd: process.execPath,
        args: ['-e', 'process.exit(process.env.GUARD_TEST_TOKEN ? 3 : 0)'],
      })
      assert.equal((await runProbe(cwd, probeDef)).result, 'pass')
      assert.equal(probeEnv({ GUARD_TEST_TOKEN: 'x', PATH: '/bin' }).GUARD_TEST_TOKEN, undefined)
      assert.match(probeEnv({ GUARD_TEST_TOKEN: 'x', PATH: '/bin' }).PATH ?? '', /^\/bin:/)
      assert.match(probeEnv({ GUARD_TEST_TOKEN: 'x', PATH: '/bin' }).PATH ?? '', /\/opt\/homebrew\/bin/)
    } finally {
      if (previous === undefined) delete process.env.GUARD_TEST_TOKEN
      else process.env.GUARD_TEST_TOKEN = previous
    }
  })

  test('a scan fails on TODO markers and passes on a clean tree', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'clean.md'), '# clean\n')
    const scan = probe({ kind: 'scan', scanKind: 'todo-tbd', paths: ['clean.md'] })
    assert.equal((await runProbe(cwd, scan)).result, 'pass')
    await writeFile(join(cwd, 'dirty.md'), '- TODO: fix\n')
    const dirtyScan = probe({ kind: 'scan', scanKind: 'todo-tbd', paths: ['.'] })
    assert.equal((await runProbe(cwd, dirtyScan)).result, 'fail')
  })

  test('rg exit 2 (bad pattern or missing path) is unknown, never a silent pass', async () => {
    const cwd = await workspace()
    // A deliberately invalid regular expression makes ripgrep exit 2 with no stdout.
    const broken = probe({ kind: 'grep', pattern: '([', paths: ['a.ts'], expect: 'no_match' })
    const brokenResult = await runProbe(cwd, broken)
    assert.notEqual(brokenResult.result, 'pass')
    const brokenScan = probe({ kind: 'scan', scanKind: 'todo-tbd', paths: ['no-such-dir'] })
    const missingPath = await runProbe(cwd, brokenScan)
    assert.notEqual(missingPath.result, 'pass')
  })

  test('a command that exceeds its timeout is unknown, not a pass and not exit 127', async () => {
    const cwd = await workspace()
    const slow = probe({ kind: 'command', cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'], expectExit: 0 })
    const result = await runProbe(cwd, slow, 60)
    assert.equal(result.result, 'unknown')
    assert.match(result.detail, /timed out/)
  })

  test('declared paths may not escape the workspace', async () => {
    const cwd = await workspace()
    assert.equal(insideWorkspace(cwd, 'a.ts'), 'a.ts')
    assert.equal(insideWorkspace(cwd, '../outside.ts'), null)
    assert.equal(insideWorkspace(cwd, '/etc/passwd'), null)
    assert.equal((await runProbe(cwd, probe({ kind: 'file_exists', path: '../outside.ts' }))).result, 'unknown')
    assert.equal((await runProbe(cwd, probe({ kind: 'file_contains', path: '/etc/passwd', pattern: 'root' }))).result, 'unknown')
    assert.equal((await runProbe(cwd, probe({ kind: 'scan', scanKind: 'todo-tbd', paths: ['..'] }))).result, 'unknown')
  })

  test('network commands are refused instead of reaching the internet', async () => {
    const cwd = await workspace()
    assert.equal(isNetworkUse('curl', ['https://example.com']), true)
    assert.equal(isNetworkUse('git', ['push', 'origin', 'main']), true)
    assert.equal(isNetworkUse('pnpm', ['add', 'left-pad']), true)
    assert.equal(isNetworkUse('git', ['status']), false)
    assert.equal(isNetworkUse('tsc', ['--noEmit']), false)
    const result = await runProbe(cwd, probe({ kind: 'command', cmd: 'curl', args: ['https://example.com'] }))
    assert.equal(result.result, 'unknown')
    assert.match(result.detail, /network/)
  })

  test('the probe environment points the proxy at a dead port', () => {
    const env = probeEnv({ PATH: '/bin' })
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:1')
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1')
    assert.equal(env.GIT_TERMINAL_PROMPT, '0')
    assert.equal(env.NO_PROXY, '')
  })
})

// Round-9 fixes: a probe may not follow a dangling symlink out of the workspace,
// and a symlinked workspace must accept the canonical absolute path of a file
// that lives inside it.
describe('goal-supervisor probe path hardening', () => {
  test('a dangling symlink is outside the workspace, not a missing file', async () => {
    const cwd = await workspace()
    await symlink('../escaped-target.txt', join(cwd, 'escape.txt'))
    assert.equal(insideWorkspace(cwd, 'escape.txt'), null)
    assert.equal((await runProbe(cwd, probe({ kind: 'file_exists', path: 'escape.txt' }))).result, 'unknown')
  })

  test('the canonical absolute path of a symlinked workspace is accepted', async () => {
    const real = await workspace()
    const holder = await workspace()
    const alias = join(holder, 'ws-link')
    await symlink(real, alias)
    const canonical = realpathSync(alias)
    assert.notEqual(canonical, alias, 'the fixture really is reached through a symlink')
    assert.equal(insideWorkspace(alias, join(canonical, 'src', 'a.ts')), 'src/a.ts')
    assert.equal(insideWorkspace(alias, '../outside.ts'), null)
  })

  test('a differently cased path inside a case-insensitive workspace is refused', async () => {
    const cwd = await workspace()
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src', 'a.ts'), 'ok')
    // On APFS `SRC/a.ts` names the very same file while the declared spelling
    // differs. `realpathSync` echoes the caller's case, so the "real path equals
    // the declared path" rule never fired; the probe could then read a file its
    // declared path does not name.
    let sameFile = true
    try {
      await access(join(cwd, 'SRC', 'a.ts'))
    } catch {
      sameFile = false
    }
    if (!sameFile) return
    assert.equal(insideWorkspace(cwd, 'SRC/a.ts'), null)
    assert.equal((await runProbe(cwd, probe({ kind: 'file_exists', path: 'SRC/a.ts' }))).result, 'unknown')
  })
})
