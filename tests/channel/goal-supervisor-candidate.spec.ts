// The evaluator candidate: what the supervisor tells the independent judge about
// the session it audited. The `antigravity` provider routes every external CLI
// activity through one `agy_tool` call, so a real `write_file` is invisible to a
// plain `write`/`edit` check — the judge then sees no `main_write_paths` at all.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { candidateOf } from '../../src/host/goal-supervisor/loop'

function ctxWith(events: readonly unknown[]): { get(name: string): unknown } {
  return {
    get(name: string) {
      if (name !== 'sessionQuery') return undefined
      return { readSession: async () => ({ events }) }
    },
  }
}

function toolCall(name: string, argumentsValue: unknown): unknown {
  return { type: 'tool/call', data: { name, arguments: JSON.stringify(argumentsValue) } }
}

describe('evaluator candidate evidence', () => {
  test('unwraps a replayed Antigravity write and keeps the ordinary write paths', async () => {
    const candidate = await candidateOf(ctxWith([
      toolCall('agy_tool', { run: 'r', step: 3, tool: 'write_file', input: { Path: '/repo/src/a.ts' } }),
      toolCall('agy_tool', { run: 'r', step: 4, tool: 'read_file', input: { Path: '/repo/src/b.ts' } }),
      toolCall('write', { file_path: 'src/c.ts' }),
    ]) as never, 'session-x')
    assert.deepEqual(candidate.writePaths, ['/repo/src/a.ts', 'src/c.ts'])
  })

  test('ignores an agy_tool call that only reads or runs a command', async () => {
    const candidate = await candidateOf(ctxWith([
      toolCall('agy_tool', { run: 'r', step: 5, tool: 'run_command', input: { CommandLine: 'ls -la' } }),
      toolCall('agy_tool', { run: 'r', step: 6, tool: 'read_file', input: { Path: 'docs/plan.md' } }),
    ]) as never, 'session-y')
    assert.deepEqual(candidate.writePaths, [])
  })
})
