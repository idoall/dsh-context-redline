import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, test } from 'vitest'
import { commentRunIssue, createRunIssue, detectMirror, findCli, issueBody, remoteHost } from '../../src/host/goal-supervisor/mirror'
import { GUARD_SCHEMA_VERSION, type GuardState } from '../../src/host/goal-supervisor/schema'

const run = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guard-mirror-'))
  roots.push(root)
  return root
}

function state(): GuardState {
  return {
    version: GUARD_SCHEMA_VERSION, runId: '20261124-demo', goal: '目标', acceptance: '验收', discipline: '纪律',
    goalHash: 'hash', tasks: [
      { id: 'T1', title: '一条', status: 'DONE', scope: [], dependsOn: [], acceptance: [], probes: [], requiredProbes: [], probeResults: {}, evidence: [], attempts: [], scopeApprovedCount: 0, baselineDirty: {} },
      { id: 'T2', title: '两条', status: 'TODO', scope: [], dependsOn: [], acceptance: [], probes: [], requiredProbes: [], probeResults: {}, evidence: [], attempts: [], scopeApprovedCount: 0, baselineDirty: {} },
    ],
    activeTaskIds: [], parallel: 1, enforcement: 'warn-only', worktree: { enabled: false }, milestoneEvery: 3,
    status: 'active', createdAt: 1, updatedAt: 1,
  }
}

describe('goal-supervisor mirror', () => {
  test('finds a CLI on PATH before the common install dirs', async () => {
    const root = await workspace()
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'gh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(bin, 'gh'), 0o755)
    const previous = process.env.PATH
    process.env.PATH = `${bin}:${previous ?? ''}`
    try {
      assert.equal(await findCli('gh'), join(bin, 'gh'))
    } finally {
      process.env.PATH = previous
    }
  })

  test('reads the remote host from ssh and https remotes', async () => {
    const cwd = await workspace()
    await run('git', ['init', '-q'], { cwd })
    await run('git', ['remote', 'add', 'origin', 'ssh://git@gitlab.example.com:30006/ai/app.git'], { cwd })
    assert.equal(await remoteHost(cwd), 'gitlab.example.com')
    await run('git', ['remote', 'set-url', 'origin', 'https://github.com/idoall/app.git'], { cwd })
    assert.equal(await remoteHost(cwd), 'github.com')
  })

  test('creates one issue and parses its URL', async () => {
    const cwd = await workspace()
    const bin = join(cwd, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'gh'), '#!/bin/sh\necho same\n', { encoding: 'utf8' })
    await writeFile(join(bin, 'gh'), '#!/bin/sh\necho "https://github.com/idoall/app/issues/42"\n')
    await chmod(join(bin, 'gh'), 0o755)
    const previous = process.env.PATH
    process.env.PATH = `${bin}:${previous ?? ''}`
    try {
      const result = await createRunIssue({ mode: 'auto', provider: 'github', host: 'github.com', command: join(bin, 'gh') }, cwd, state(), 'docs/guard/20261124-demo')
      assert.equal(result.issueNumber, 42)
      assert.match(result.issueUrl ?? '', /issues\/42/)
    } finally {
      process.env.PATH = previous
    }
  })

  test('the issue body keeps the checklist and collapses completed tasks', () => {
    const body = issueBody(state(), 'docs/guard/20261124-demo')
    assert.match(body, /- \[ \] T2 两条/)
    assert.match(body, /已完成 1 条：T1/)
  })

  test('detectMirror degrades to local-only when the checkout has no remote', async () => {
    const cwd = await workspace()
    await run('git', ['init', '-q'], { cwd })
    const config = await detectMirror(cwd)
    assert.equal(config.mode, 'off')
    assert.match(config.reason ?? '', /remote/)
  })

  test('glab creation is non-interactive: it always passes --yes', async () => {
    const cwd = await workspace()
    const bin = join(cwd, 'bin')
    await mkdir(bin)
    const record = join(cwd, 'argv.txt')
    await writeFile(join(bin, 'glab'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${record}\necho "http://gitlab.example.com/ai/app/-/issues/7"\n`)
    await chmod(join(bin, 'glab'), 0o755)
    const config = { mode: 'auto' as const, provider: 'gitlab' as const, host: 'gitlab.example.com', command: join(bin, 'glab') }
    const issue = await createRunIssue(config, cwd, state(), 'docs/guard/run')
    assert.equal(issue.issueNumber, 7)
    const argv = (await readFile(record, 'utf8')).trim().split('\n')
    assert.deepEqual(argv.slice(0, 3), ['issue', 'create', '--title'])
    assert.ok(argv.includes('--yes'), 'glab must not wait for a confirmation prompt')
    assert.ok(argv.includes('--description'))
  })

  test('a hung CLI degrades to an error instead of blocking the audit', async () => {
    const cwd = await workspace()
    const bin = join(cwd, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'gh'), '#!/bin/sh\nsleep 5\n')
    await chmod(join(bin, 'gh'), 0o755)
    const config = { mode: 'auto' as const, provider: 'github' as const, host: 'github.com', command: join(bin, 'gh'), timeoutMs: 120 }
    const started = Date.now()
    const issue = await createRunIssue(config, cwd, state(), 'docs/guard/run')
    const elapsed = Date.now() - started
    assert.ok(elapsed < 3000, `returned in ${elapsed}ms instead of waiting for the CLI`)
    assert.match(issue.error ?? '', /timed out/)
    assert.equal(issue.issueNumber, undefined)
  })

  test('a timed-out comment is reported instead of swallowed', async () => {
    const cwd = await workspace()
    const bin = join(cwd, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'glab'), '#!/bin/sh\nsleep 5\n')
    await chmod(join(bin, 'glab'), 0o755)
    const config = { mode: 'auto' as const, provider: 'gitlab' as const, host: 'gitlab.example.com', command: join(bin, 'glab'), timeoutMs: 120 }
    const error = await commentRunIssue(config, cwd, 3, 'body')
    assert.match(error ?? '', /timed out/)
  })
})
