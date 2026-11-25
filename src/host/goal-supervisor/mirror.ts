/**
 * Optional one-way mirror to GitHub/GitLab.
 *
 * Local `tasks.json` stays authoritative: the mirror only creates one issue per
 * run and appends a comment on DONE/BLOCKED/milestone. No token is stored here;
 * `gh`/`glab` own authentication. Any failure degrades to local-only.
 */

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GuardState } from './schema'

export interface MirrorConfig {
  readonly mode: 'auto' | 'off'
  readonly provider?: 'github' | 'gitlab'
  readonly host?: string
  readonly command?: string
  readonly reason?: string
  /** Per-call ceiling; a hung CLI must degrade to local-only, never block a turn. */
  readonly timeoutMs?: number
}

/**
 * Ceiling for one mirror call.
 *
 * The mirror runs inside the turn-stopping audit, so a CLI that waits for a TTY
 * (or a prompt, or a network black hole) would freeze the session's turn end.
 * The CLI is therefore always non-interactive and always time-boxed.
 */
const DEFAULT_TIMEOUT_MS = 60_000

function run(
  cwd: string,
  cmd: string,
  args: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, [...args], {
      cwd,
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', NO_COLOR: '1' },
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
      const signal = (error as { signal?: unknown } | null)?.signal
      const timedOut = (error as { killed?: boolean } | null)?.killed === true || (typeof signal === 'string' && signal !== '')
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch { return false }
}

/** Find a CLI on PATH, then in the common install dirs the host may not inherit. */
export async function findCli(name: 'gh' | 'glab', env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const dirs = [
    ...(env.PATH ?? '').split(':').filter(part => part !== ''),
    '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), join(homedir(), 'bin'),
  ]
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (await executable(candidate)) return candidate
  }
  return null
}

/** Derive provider/host from `git remote get-url origin`. */
export async function remoteHost(cwd: string): Promise<string | null> {
  const result = await run(cwd, 'git', ['remote', 'get-url', 'origin'])
  if (result.code !== 0) return null
  const url = result.stdout.trim()
  const ssh = /^ssh:\/\/[^@]+@([^/:]+)(?::\d+)?\//.exec(url)
  if (ssh?.[1] !== undefined) return ssh[1]
  const scp = /^[^@]+@([^:]+):/.exec(url)
  if (scp?.[1] !== undefined) return scp[1]
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

export async function detectMirror(cwd: string): Promise<MirrorConfig> {
  const host = await remoteHost(cwd)
  if (host === null) return { mode: 'off', reason: 'no git remote' }
  const provider = host === 'github.com' ? 'github' : 'gitlab'
  const cli = provider === 'github' ? 'gh' : 'glab'
  const command = await findCli(cli)
  if (command === null) return { mode: 'off', provider, host, reason: `${cli} not installed` }
  const auth = await run(cwd, command, ['auth', 'status', '--hostname', host])
  if (auth.code !== 0) return { mode: 'off', provider, host, reason: `${cli} is not authenticated for ${host}` }
  return { mode: 'auto', provider, host, command }
}

/** The issue body: goal, run id and the task checklist (completed tasks collapsed). */
export function issueBody(state: GuardState, runDir: string): string {
  const done = state.tasks.filter(task => task.status === 'DONE')
  const open = state.tasks.filter(task => task.status !== 'DONE')
  const lines = [
    `目标 hash：\`${state.goalHash}\``,
    `记录目录：\`${runDir}\``,
    '',
    '## 任务',
    ...open.map(task => `- [ ] ${task.id} ${task.title}（${task.status}）`),
    ...(done.length === 0 ? [] : [`- 已完成 ${done.length} 条：${done.map(task => task.id).join('、')}`]),
  ]
  return lines.join('\n').slice(0, 60_000)
}

export interface IssueResult {
  readonly issueNumber?: number
  readonly issueUrl?: string
  readonly error?: string
}

/** Create the run's single issue; returns the URL/number parsed from the CLI. */
export async function createRunIssue(config: MirrorConfig, cwd: string, state: GuardState, runDir: string): Promise<IssueResult> {
  if (config.mode !== 'auto' || config.command === undefined || config.provider === undefined) {
    return { error: config.reason ?? 'mirror disabled' }
  }
  const title = `[guard] ${state.runId} · ${state.goal.split(/\r?\n/)[0]?.slice(0, 80) ?? ''}`
  const args = config.provider === 'github'
    ? ['issue', 'create', '--title', title, '--body', issueBody(state, runDir)]
    // `--yes` keeps glab non-interactive: without it, a TTY run waits for a
    // confirmation prompt and the turn-stopping audit never returns.
    : ['issue', 'create', '--title', title, '--description', issueBody(state, runDir), '--yes']
  const result = await run(cwd, config.command, args, config.timeoutMs)
  if (result.timedOut) return { error: `${config.provider} CLI timed out after ${config.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` }
  if (result.code !== 0) return { error: result.stderr.trim() || `exit ${result.code}` }
  const url = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^https?:\/\//.test(line)).at(-1)
  const number = url === undefined ? undefined : Number.parseInt(url.split('/').at(-1) ?? '', 10)
  return {
    ...(url === undefined ? {} : { issueUrl: url }),
    ...(number === undefined || Number.isNaN(number) ? {} : { issueNumber: number }),
  }
}

/** Append a status comment; best-effort and throttled by the caller. */
export async function commentRunIssue(
  config: MirrorConfig,
  cwd: string,
  issueNumber: number,
  body: string,
): Promise<string | null> {
  if (config.mode !== 'auto' || config.command === undefined || config.provider === undefined) return null
  const args = config.provider === 'github'
    ? ['issue', 'comment', String(issueNumber), '--body', body]
    : ['issue', 'note', String(issueNumber), '--message', body]
  const result = await run(cwd, config.command, args, config.timeoutMs)
  if (result.timedOut) return `${config.provider} CLI timed out after ${config.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
  return result.code === 0 ? null : (result.stderr.trim() || `exit ${result.code}`)
}
