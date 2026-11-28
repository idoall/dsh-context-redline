/**
 * Deterministic probe execution for one supervisor run.
 *
 * Probes are run by the plugin, never by the model: a passing `tsc --noEmit`
 * or a present file cannot be faked by a subagent's prose. Every probe returns
 * one of three states; `unknown` (missing tool, timeout, unreadable file, a
 * `rg` that exited 2) is never treated as a pass.
 *
 * Three boundaries keep a confirmed command list from turning into a shell:
 *   - every declared path must stay inside the workspace;
 *   - the child process gets a scrubbed environment (drop variables matching
 *     the secret pattern, point the proxy variables at a dead port);
 *   - commands that reach the network are refused outright.
 */

import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ProbeDef, ProbeResult, ProbeSpec } from './schema'

export interface ProbeOutcome {
  readonly result: ProbeResult
  readonly detail: string
  readonly exitCode?: number
  readonly sha256?: string
  /** Clipped stdout+stderr, persisted as evidence by the loop. */
  readonly output?: string
}

const SECRET_ENV = /(TOKEN|KEY|SECRET|PASS|CREDENTIAL|COOKIE|DATABASE_URL)/i
const MAX_OUTPUT = 4 * 1024 * 1024
const MAX_DETAIL = 300
const MAX_EVIDENCE = 8192
/** A dead proxy makes best-effort network use fail fast instead of leaking. */
const BLACKHOLE_PROXY = 'http://127.0.0.1:1'
const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'ftp', 'telnet', 'rsync', 'ping', 'dig', 'nslookup', 'http', 'https',
])
const GIT_NETWORK_ARGS = new Set(['push', 'fetch', 'pull', 'clone', 'ls-remote', 'archive', 'submodule'])
const PACKAGE_NETWORK_ARGS = new Set(['install', 'add', 'update', 'upgrade', 'publish', 'i', 'ci'])
const PACKAGE_COMMANDS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx'])

/** Common install dirs the DSH process may not inherit (Homebrew, local bins). */
function toolchainDirs(): string[] {
  return ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), join(homedir(), 'bin')]
}

/** A scrubbed environment for probe commands: toolchains kept, secrets dropped, network dead. */
export function probeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    if (SECRET_ENV.test(name)) continue
    env[name] = value
  }
  const current = env.PATH ?? ''
  const seen = new Set(current.split(':').filter(part => part !== ''))
  const parts = [...seen]
  for (const dir of toolchainDirs()) {
    if (!seen.has(dir)) parts.push(dir)
  }
  env.PATH = parts.join(':')
  env.HTTP_PROXY = BLACKHOLE_PROXY
  env.HTTPS_PROXY = BLACKHOLE_PROXY
  env.ALL_PROXY = BLACKHOLE_PROXY
  env.http_proxy = BLACKHOLE_PROXY
  env.https_proxy = BLACKHOLE_PROXY
  env.all_proxy = BLACKHOLE_PROXY
  env.NO_PROXY = ''
  env.no_proxy = ''
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS = 'true'
  env.SSH_ASKPASS = 'true'
  return env
}

/** True when `cmd`/`args` would reach the network; used to refuse such probes. */
export function isNetworkUse(cmd: string, args: readonly string[]): boolean {
  const name = basename(cmd)
  if (NETWORK_COMMANDS.has(name)) return true
  if (name === 'git') return args.some(arg => GIT_NETWORK_ARGS.has(arg))
  if (PACKAGE_COMMANDS.has(name)) return args.some(arg => PACKAGE_NETWORK_ARGS.has(arg))
  return false
}

/**
 * The first probe argument that only makes sense to a SHELL, or `null`.
 *
 * A command probe is execFile-shaped: the line is split on whitespace and the
 * tokens reach the binary verbatim, with no quoting, no pipes, no redirection.
 * A human writing `grep -q "a b" file` gets the quotes kept as literal
 * characters — the probe then never matches and the task can never pass, with
 * nothing in the ledger saying why. Refuse it at creation time instead, where
 * the message can name the offending token and the fix.
 */
export function shellishProbeArg(args: readonly string[]): string | null {
  const QUOTES = ['"', "'", '`']
  for (const arg of args) {
    if (arg.includes('$(') || arg.includes('\n')) return arg
    // Redirection: `>`, `>>`, `<`, `2>`, `2>&1`, `&>`.
    if (/^\d?(?:>>?|<)$/.test(arg) || /^&>/.test(arg) || /^\d?>&\d$/.test(arg)) return arg
    // Command separators, including the bare pipe a shell pipeline leaves behind.
    if (arg === ';' || arg === '&&' || arg === '||' || arg === '|') return arg
    // Quoting is the subtle one: quotes INSIDE an argument are ordinary program
    // input (`node -e 'console.error("x")'` is valid JS), but a quote at either
    // EDGE — or an odd number of them — only happens when a shell was expected
    // to strip it. That argument then reaches the program with the quote kept.
    for (const quote of QUOTES) {
      const count = arg.split(quote).length - 1
      if (count === 0) continue
      if (arg.startsWith(quote) || arg.endsWith(quote) || count % 2 === 1) return arg
    }
  }
  return null
}

/**
 * Resolve a declared path inside `cwd`; `null` when it escapes the workspace.
 * Both `..` traversal and absolute paths outside the workspace are refused.
 *
 * The result is also checked after `realpath`: a symlink planted inside the
 * workspace must not let a probe read or execute something outside it.
 */
export function insideWorkspace(cwd: string, declared: string): string | null {
  // Compare against BOTH the named root and its real path: macOS `/tmp` is a
  // symlink, and a tool that reports the canonical `/private/tmp/...` path (or
  // the alias one) is naming the same file.
  const roots = [resolve(cwd)]
  try {
    const real = nativeRealpath(cwd)
    if (real !== roots[0]) roots.push(real)
  } catch { return null }
  for (const root of roots) {
    const absolute = isAbsolute(declared) ? resolve(declared) : resolve(root, declared)
    const path = relative(root, absolute)
    if (path === '') return '.'
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) continue
    const relativePart = path.split(sep).join('/')
    const real = realPathInside(root, absolute)
    if (real === null) return null
    if (real !== relativePart) return null
    return relativePart
  }
  return null
}

/** `realpathSync.native`, falling back to the portable form when unavailable. */
function nativeRealpath(path: string): string {
  const native = (realpathSync as unknown as { native?: (value: string) => string }).native
  return typeof native === 'function' ? native(path) : realpathSync(path)
}

/** Resolve `absolute`'s real location relative to the real `root`, or `null`. */
function realPathInside(root: string, absolute: string): string | null {
  let realRoot: string
  try {
    realRoot = nativeRealpath(root)
  } catch {
    return null
  }
  let probe = absolute
  const tail: string[] = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      // Native resolution: a differently cased spelling of an existing path is a
      // different string and must not take the innocent-looking name at face
      // value (APFS is case-insensitive by default).
      const real = nativeRealpath(probe)
      const resolved = tail.length === 0 ? real : join(real, ...tail.reverse())
      const rel = relative(realRoot, resolved)
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
      return rel.split(sep).join('/')
    } catch {
      // Only ENOENT means "does not exist yet". A dangling symlink also makes
      // `realpathSync` fail, and climbing to its parent resolved it to its own
      // innocent-looking name — a `write` (or probe) could then reach the target
      // outside the workspace by following the link at `O_CREAT` time.
      let code: string | undefined
      try {
        lstatSync(probe)
        return null
      } catch (statError) {
        code = (statError as NodeJS.ErrnoException).code
      }
      if (code !== 'ENOENT') return null
      const parent = dirname(probe)
      if (parent === probe) return null
      tail.push(basename(probe))
      probe = parent
    }
  }
  return null
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function clip(text: string): string {
  return text.trim().slice(0, MAX_DETAIL)
}

/** Evidence payload: both streams, clipped, with the exit code on its own line. */
function outputOf(outcome: Extract<CommandOutcome, { kind: 'ok' }>): string {
  const body = [outcome.stdout.trim(), outcome.stderr.trim()].filter(part => part !== '').join('\n--- stderr ---\n')
  return body.slice(0, MAX_EVIDENCE)
}

export type CommandOutcome =
  | { readonly kind: 'ok'; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'overflow' }
  | { readonly kind: 'failed'; readonly detail: string }

/** Run one command with the scrubbed environment; never throws and never guesses an exit code. */
export function runCommand(
  cmd: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandOutcome> {
  return new Promise((resolvePromise) => {
    execFile(cmd, [...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT,
      env: probeEnv(),
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolvePromise({ kind: 'ok', code: 0, stdout, stderr })
        return
      }
      const code = (error as { code?: unknown }).code
      if (code === 'ENOENT') { resolvePromise({ kind: 'missing' }); return }
      if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { resolvePromise({ kind: 'overflow' }); return }
      // `signal` is `null` on a plain non-zero exit and a string only when the
      // child was actually killed; treating `null` as a signal would turn every
      // ordinary failure into a timeout.
      const signal = (error as { signal?: unknown }).signal
      const killed = (error as { killed?: boolean }).killed === true
        || (typeof signal === 'string' && signal !== '')
        || code === 'ETIMEDOUT'
      if (killed) { resolvePromise({ kind: 'timeout' }); return }
      if (typeof code === 'number') {
        resolvePromise({ kind: 'ok', code, stdout, stderr })
        return
      }
      resolvePromise({ kind: 'failed', detail: clip(error.message) })
    })
  })
}

/** Shared classification for every command-shaped probe. */
function commandProblem(outcome: CommandOutcome, cmd: string): ProbeOutcome | null {
  switch (outcome.kind) {
    case 'ok': return null
    case 'missing': return { result: 'unknown', detail: `${basename(cmd)} is unavailable` }
    case 'timeout': return { result: 'unknown', detail: `${basename(cmd)} timed out` }
    case 'overflow': return { result: 'unknown', detail: `${basename(cmd)} output exceeded the buffer` }
    case 'failed': return { result: 'unknown', detail: `${basename(cmd)} failed: ${outcome.detail}` }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Execute one probe relative to `cwd`; never throws. */
export async function runProbe(cwd: string, probe: ProbeDef, timeoutMs = 120_000): Promise<ProbeOutcome> {
  if (!probe.enabled) return { result: 'unknown', detail: 'probe disabled' }
  try {
    return await runSpec(cwd, probe.spec, probe.timeoutMs ?? timeoutMs)
  } catch (error) {
    return { result: 'unknown', detail: clip(error instanceof Error ? error.message : String(error)) }
  }
}

async function readInside(cwd: string, declared: string): Promise<{ path: string; text: string } | null> {
  const path = insideWorkspace(cwd, declared)
  if (path === null) return null
  try {
    return { path, text: await readFile(join(cwd, path), 'utf8') }
  } catch {
    return null
  }
}

async function runSpec(cwd: string, spec: ProbeSpec, timeoutMs: number): Promise<ProbeOutcome> {
  switch (spec.kind) {
    case 'file_exists': {
      const path = insideWorkspace(cwd, spec.path)
      if (path === null) return { result: 'unknown', detail: `${spec.path} is outside the workspace` }
      const found = await exists(join(cwd, path))
      return found
        ? { result: 'pass', detail: `found ${path}` }
        : { result: 'fail', detail: `missing ${path}` }
    }
    case 'file_contains': {
      const file = await readInside(cwd, spec.path)
      if (file === null) {
        if (insideWorkspace(cwd, spec.path) === null) return { result: 'unknown', detail: `${spec.path} is outside the workspace` }
        return { result: 'fail', detail: `missing ${spec.path}` }
      }
      const matched = spec.flags === undefined
        ? file.text.includes(spec.pattern)
        : new RegExp(spec.pattern, spec.flags).test(file.text)
      return matched
        ? { result: 'pass', detail: `matched ${clip(spec.pattern)}`, sha256: digest(file.text) }
        : { result: 'fail', detail: `no match for ${clip(spec.pattern)}` }
    }
    case 'grep': {
      const paths: string[] = []
      for (const declared of spec.paths) {
        const path = insideWorkspace(cwd, declared)
        if (path === null) return { result: 'unknown', detail: `${declared} is outside the workspace` }
        paths.push(path)
      }
      const run = await runCommand('rg', ['-l', '--', spec.pattern, ...paths], cwd, timeoutMs)
      const problem = commandProblem(run, 'rg')
      if (problem !== null) return problem
      if (run.kind !== 'ok') return { result: 'unknown', detail: 'rg is unavailable' }
      // ripgrep: 0 = matches, 1 = no matches, 2+ = error (bad pattern, unreadable path).
      if (run.code !== 0 && run.code !== 1) {
        return { result: 'unknown', detail: `rg exited ${run.code}: ${clip(run.stderr) || 'invalid pattern or path'}` }
      }
      const hits = run.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
      const expected = spec.expect
      const matched = expected === 'match'
        ? hits.length > 0
        : expected === 'no_match'
          ? hits.length === 0
          : hits.length >= expected.minMatches
      return {
        result: matched ? 'pass' : 'fail',
        detail: matched ? `${hits.length} matching file(s)` : 'match expectation not met',
        ...(hits.length === 0 ? {} : { output: outputOf(run) }),
      }
    }
    case 'number_gte': {
      let raw = ''
      if (spec.source.type === 'file') {
        const file = await readInside(cwd, spec.source.path)
        if (file === null) {
          if (insideWorkspace(cwd, spec.source.path) === null) return { result: 'unknown', detail: `${spec.source.path} is outside the workspace` }
          return { result: 'fail', detail: `missing ${spec.source.path}` }
        }
        raw = spec.source.pattern === undefined
          ? file.text
          : (new RegExp(spec.source.pattern).exec(file.text)?.[1] ?? '')
      } else {
        if (isNetworkUse(spec.source.cmd, spec.source.args)) return { result: 'unknown', detail: 'network commands are not allowed in probes' }
        const run = await runCommand(spec.source.cmd, spec.source.args, cwd, timeoutMs)
        const problem = commandProblem(run, spec.source.cmd)
        if (problem !== null) return problem
        if (run.kind !== 'ok') return { result: 'unknown', detail: 'no numeric value' }
        if (run.code !== 0) return { result: 'unknown', detail: `command exited ${run.code}` }
        raw = run.stdout
      }
      const value = Number.parseFloat(raw.replace(/,/g, ''))
      if (!Number.isFinite(value)) return { result: 'unknown', detail: 'no numeric value' }
      return value >= spec.threshold
        ? { result: 'pass', detail: `${value} >= ${spec.threshold}` }
        : { result: 'fail', detail: `${value} < ${spec.threshold}` }
    }
    case 'command': {
      if (isNetworkUse(spec.cmd, spec.args)) return { result: 'unknown', detail: 'network commands are not allowed in probes' }
      let runCwd = cwd
      if (spec.cwd !== undefined) {
        const path = insideWorkspace(cwd, spec.cwd)
        if (path === null) return { result: 'unknown', detail: `${spec.cwd} is outside the workspace` }
        runCwd = join(cwd, path)
      }
      const run = await runCommand(spec.cmd, spec.args, runCwd, timeoutMs)
      const problem = commandProblem(run, spec.cmd)
      if (problem !== null) return problem
      if (run.kind !== 'ok') return { result: 'unknown', detail: `${spec.cmd} is unavailable` }
      const expected = spec.expectExit ?? 0
      return {
        result: run.code === expected ? 'pass' : 'fail',
        detail: `exit ${run.code} (expected ${expected})`,
        exitCode: run.code,
        sha256: digest(`${run.stdout}\n${run.stderr}`),
        output: outputOf(run),
      }
    }
    case 'scan': {
      const declared = spec.paths === undefined || spec.paths.length === 0 ? ['.'] : spec.paths
      const paths: string[] = []
      for (const raw of declared) {
        const path = insideWorkspace(cwd, raw)
        if (path === null) return { result: 'unknown', detail: `${raw} is outside the workspace` }
        paths.push(path)
      }
      const pattern = spec.scanKind === 'todo-tbd'
        ? 'TODO|TBD|FIXME'
        : spec.scanKind === 'inline-code-path'
          ? '`[^`]+\\.(ts|tsx|mjs|js|json|md)`'
          : '\\[[^\\]]+\\]\\([^)]+\\)'
      const run = await runCommand('rg', ['-l', '--', pattern, ...paths], cwd, timeoutMs)
      const problem = commandProblem(run, 'rg')
      if (problem !== null) return problem
      if (run.kind !== 'ok') return { result: 'unknown', detail: 'rg is unavailable' }
      // A scan that cannot run is `unknown`; an empty result file list would otherwise read as "clean".
      if (run.code !== 0 && run.code !== 1) {
        return { result: 'unknown', detail: `rg exited ${run.code}: ${clip(run.stderr) || 'invalid pattern or path'}` }
      }
      const hits = run.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
      return hits.length === 0
        ? { result: 'pass', detail: 'no findings' }
        : { result: 'fail', detail: `${hits.length} finding(s)`, sha256: digest(run.stdout), output: outputOf(run) }
    }
  }
}

/** Run a task's probes; returns the per-probe outcomes keyed by probe id. */
export async function runProbes(cwd: string, probes: readonly ProbeDef[]): Promise<Record<string, ProbeOutcome>> {
  const outcomes: Record<string, ProbeOutcome> = {}
  for (const probe of probes) outcomes[probe.id] = await runProbe(cwd, probe)
  return outcomes
}
