import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { ANCHOR_BUDGET_BYTES, renderAnchor } from '../../src/host/goal-supervisor/anchor'
import { GUARD_SCHEMA_VERSION, type GuardState } from '../../src/host/goal-supervisor/schema'

function state(overrides: Partial<GuardState> = {}): GuardState {
  return {
    version: GUARD_SCHEMA_VERSION,
    runId: '20261124-demo',
    goal: '把目标漂移修好',
    acceptance: '所有任务 DONE',
    discipline: '主会话只规划/分派/审查',
    goalHash: '0123456789abcdef0123456789abcdef',
    tasks: [{
      id: 'T1',
      title: '状态落盘',
      status: 'IN_PROGRESS',
      scope: ['src/host/goal-supervisor'],
      dependsOn: [],
      acceptance: ['文件存在', '测试通过'],
      probes: ['P1'],
      requiredProbes: ['P1'],
      probeResults: {},
      evidence: [],
      attempts: [],
      scopeApprovedCount: 0,
      baselineDirty: {},
    }],
    activeTaskIds: ['T1'],
    parallel: 1,
    enforcement: 'warn-only',
    worktree: { enabled: false },
    milestoneEvery: 3,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('goal-supervisor anchor', () => {
  test('pins the task, scope, rules and stop conditions', () => {
    const text = renderAnchor(state())
    assert.match(text, /目标守卫 · 锚点/)
    assert.match(text, /当前任务：T1 \| 状态落盘/)
    assert.match(text, /本任务 scope：src\/host\/goal-supervisor/)
    assert.match(text, /硬规则：/)
    assert.match(text, /停止条件：/)
    assert.ok(text.includes('0123456789abcdef'))
  })

  test('stays within the byte budget and never drops the rules', () => {
    const long = state({
      goal: '很长的目标'.repeat(400),
      tasks: [{ ...state().tasks[0]!, title: '长标题'.repeat(200), acceptance: ['长验收'.repeat(300)] }],
    })
    const text = renderAnchor(long)
    assert.ok(Buffer.byteLength(text, 'utf8') <= ANCHOR_BUDGET_BYTES, String(Buffer.byteLength(text, 'utf8')))
    assert.match(text, /硬规则：/)
    assert.match(text, /停止条件：/)
  })

  test('says everything is done when no task remains', () => {
    const done = state({ tasks: [], activeTaskIds: [], status: 'completed' })
    assert.match(renderAnchor(done), /当前任务：（全部完成）/)
  })

  test('a parallel batch lists every running task with its own scope', async () => {
    const only = state().tasks[0]
    assert.ok(only !== undefined)
    const next = { ...only, id: 'T2', title: '并行第二条', scope: ['b.ts'] }
    const parallel = state({
      tasks: [{ ...only, status: 'IN_PROGRESS', scope: ['a.ts'] }, next],
      activeTaskIds: ['T1', 'T2'],
      parallel: 2,
    })
    const text = renderAnchor(parallel)
    assert.match(text, /并行在途 2 条：T1、T2/)
    assert.match(text, /- T1 .*scope：a\.ts/)
    assert.match(text, /- T2 .*scope：b\.ts/)
  })
})

describe('goal-supervisor anchor completion claims', () => {
  test('a run whose tasks are all BLOCKED is not reported as complete', () => {
    const blocked = state({
      tasks: [{
        ...state().tasks[0]!,
        status: 'BLOCKED',
        blocked: { reason: '探针一直失败', next: '回退后换个思路', remainingCandidates: [], at: 1 },
      }],
      activeTaskIds: [],
    })
    const text = renderAnchor(blocked)
    assert.ok(!text.includes('全部完成'), text)
    assert.match(text, /已阻塞，等待人工介入/)
    // The correction line is read straight off the ledger; a blocked task is
    // never in `runningTasks`, so collecting from there left it empty.
    assert.match(text, /纠正（T1）：探针一直失败 → 回退后换个思路/)
  })

  test('a half-finished run is not reported as complete either', () => {
    const first = state().tasks[0]!
    const half = state({
      tasks: [
        { ...first, status: 'DONE' },
        { ...first, id: 'T2', title: '还没做', status: 'TODO' },
      ],
      activeTaskIds: [],
    })
    const text = renderAnchor(half)
    assert.ok(!text.includes('全部完成'), text)
    assert.match(text, /进度：1\/2/)
  })

  test('a pending task declares its scope, and the rules forbid stopping to ask', () => {
    const only = state().tasks[0]
    assert.ok(only !== undefined)
    const pending = { ...only, id: 'T2', title: '后面那条', status: 'TODO' as const, scope: ['src/b.ts'] }
    const text = renderAnchor(state({ tasks: [{ ...only, scope: ['src/a.ts'] }, pending] }))
    // The running task may not write src/b.ts, and it can only know that if the
    // anchor says whose file it is.
    assert.match(text, /其他任务 scope（不是你的）：T2 src\/b\.ts/)
    // A finished task's scope is closed, not an invitation.
    const finished = { ...pending, status: 'DONE' as const }
    const afterDone = renderAnchor(state({ tasks: [{ ...only, scope: ['src/a.ts'] }, finished] }))
    assert.ok(!afterDone.includes('其他任务 scope'), 'a DONE scope is not listed')
    // The rule the user keeps asking for: no mid-run confirmation.
    assert.match(text, /不要中途向用户提问/)
  })
})
