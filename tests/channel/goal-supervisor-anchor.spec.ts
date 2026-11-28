import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { ANCHOR_BUDGET_BYTES, renderAnchor, renderAnchorDetailed, renderAnchorUnclipped } from '../../src/host/goal-supervisor/anchor'
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

describe('goal-supervisor anchor budget priority', () => {
  /** A ledger with a long future-task scope list, one blocked sibling and one running task. */
  function crowded(goalLength = 6): GuardState {
    const only = state().tasks[0]!
    const upcoming = Array.from({ length: 12 }, (_, index) => ({
      ...only,
      id: `T${index + 2}`,
      title: `未来任务 ${index + 2}`,
      status: 'TODO' as const,
      scope: [`very/long/declared/scope/segment-${index}`, 'another/long/declared/path', 'third/long/declared/path'],
      dependsOn: [],
    }))
    const blocked = {
      ...only,
      id: 'B1',
      title: '被阻塞的兄弟',
      status: 'BLOCKED' as const,
      scope: ['src/blocked'],
      blocked: { reason: '探针一直失败', next: '回退后换个思路', remainingCandidates: [], at: 1 },
    }
    return state({
      goal: '很长的目标描述。'.repeat(goalLength),
      tasks: [{ ...only, scope: ['src/task-one'] }, ...upcoming, blocked],
      activeTaskIds: ['T1'],
      status: 'active',
    })
  }

  test('a crowded ledger keeps the running task, progress and correction; only other-task scopes give way', () => {
    const text = renderAnchor(crowded())
    assert.ok(Buffer.byteLength(text, 'utf8') <= ANCHOR_BUDGET_BYTES, String(Buffer.byteLength(text, 'utf8')))
    assert.match(text, /当前任务：T1/)
    assert.match(text, /本任务 scope：src\/task-one/)
    assert.match(text, /进度：0\/14/)
    assert.match(text, /状态：active/)
    assert.match(text, /纠正（B1）：探针一直失败 → 回退后换个思路/)
    assert.match(text, /目标：/)
    assert.match(text, /硬规则：/)
    assert.match(text, /停止条件：/)
  })

  test('reports the true untruncated size instead of clamping the accounting to the budget', () => {
    const ledger = crowded(80)
    const full = renderAnchorUnclipped(ledger)
    const rendered = renderAnchorDetailed(ledger)
    assert.ok(rendered.truncated, 'the crowded ledger must be reported as truncated')
    assert.equal(
      rendered.originalBytes,
      Buffer.byteLength(full, 'utf8'),
      'originalBytes is the size of the untruncated rendering',
    )
    assert.ok(rendered.originalBytes > ANCHOR_BUDGET_BYTES + 200, `original=${rendered.originalBytes}`)
    assert.equal(rendered.keptBytes, Buffer.byteLength(rendered.text, 'utf8'))
    assert.ok(rendered.keptBytes <= ANCHOR_BUDGET_BYTES)
  })

  test('a rendering that fits reports no truncation and equal byte counts', () => {
    const rendered = renderAnchorDetailed(state())
    assert.equal(rendered.truncated, false)
    assert.equal(rendered.originalBytes, rendered.keptBytes)
    assert.equal(rendered.text, renderAnchorUnclipped(state()))
  })
})

describe('goal-supervisor anchor after the run completes', () => {
  /** A run whose tasks are all DONE: the guard must stop being a supervisor. */
  function completed(): GuardState {
    const only = state().tasks[0]!
    return state({
      tasks: [
        { ...only, status: 'DONE', checkpointRef: 'guard/20261124-demo/T1' },
        { ...only, id: 'T2', title: '第二条', status: 'DONE', checkpointRef: 'guard/20261124-demo/T2' },
      ],
      activeTaskIds: [],
      status: 'completed',
    })
  }

  test('stops imposing scope and completion-claim rules and lets new work run normally', () => {
    const text = renderAnchor(completed(), { cwd: '/repo' })
    assert.match(text, /全部完成 2\/2/)
    assert.match(text, /已收口/)
    assert.match(text, /普通会话/)
    assert.match(text, /可以直接改文件/)
    // The run-scoped rules must be gone, or the model refuses the next request.
    assert.ok(!text.includes('只改本任务 scope 内的文件'), text)
    assert.ok(!text.includes('不得让子会话代写'), text)
    assert.ok(!text.includes('工具守卫已硬拦'), text)
    assert.ok(!text.includes('写入后立刻结束本回合'), text)
    assert.ok(Buffer.byteLength(text, 'utf8') <= ANCHOR_BUDGET_BYTES)
  })

  test('a blocked run still carries the task rules and the correction', () => {
    const only = state().tasks[0]!
    const blocked = state({
      tasks: [{ ...only, status: 'BLOCKED', blocked: { reason: '探针失败', next: '回退重试', remainingCandidates: [], at: 1 } }],
      activeTaskIds: [],
      status: 'blocked',
    })
    const text = renderAnchor(blocked)
    assert.match(text, /纠正（T1）：探针失败 → 回退重试/)
    assert.match(text, /只改本任务 scope 内的文件/)
    assert.ok(!text.includes('已收口'))
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

  test('does not list the currently starting TODO task under other tasks scope', () => {
    const first = state().tasks[0]!
    const turnOne = state({
      tasks: [
        { ...first, id: 'T1', status: 'TODO', scope: ['src/a.ts'] },
        { ...first, id: 'T2', title: '后面那条', status: 'TODO', scope: ['src/b.ts'] },
      ],
      activeTaskIds: [],
    })
    const textOne = renderAnchor(turnOne)
    assert.match(textOne, /当前任务：T1/)
    assert.match(textOne, /本任务 scope：src\/a\.ts/)
    assert.match(textOne, /其他任务 scope（不是你的）：T2 src\/b\.ts/)
    assert.ok(!/其他任务 scope（不是你的）：[^\n]*T1/.test(textOne), `T1 must not be listed as another task: ${textOne}`)

    const transition = state({
      tasks: [
        { ...first, id: 'T1', status: 'DONE', scope: ['src/a.ts'] },
        { ...first, id: 'T2', title: '后面那条', status: 'TODO', scope: ['src/b.ts'] },
      ],
      activeTaskIds: [],
    })
    const textTwo = renderAnchor(transition)
    assert.match(textTwo, /当前任务：T2/)
    assert.ok(!textTwo.includes('其他任务 scope'), `T2 is the active task, not another task: ${textTwo}`)
  })

  test('states the turn-boundary protocol and adapts rules to enforcement without overriding milestone discipline', () => {
    const warnText = renderAnchor(state({ enforcement: 'warn-only' }))
    assert.match(warnText, /## 完成声明/)
    assert.match(warnText, /立刻结束本回合/)
    assert.match(warnText, /提醒模式/)
    assert.ok(!warnText.includes('工具守卫已硬拦'), 'warn-only must not claim shell calls are hard-blocked')
    assert.match(warnText, /若目标或纪律明确要求/)

    const enforceText = renderAnchor(state({ enforcement: 'enforce' }))
    assert.match(enforceText, /立刻结束本回合/)
    assert.match(enforceText, /工具守卫已硬拦/)
    assert.ok(Buffer.byteLength(enforceText, 'utf8') <= ANCHOR_BUDGET_BYTES)
  })

  test('requires the main session to write the completion claim after review and forbids subagents from doing so', () => {
    for (const enforcement of ['warn-only', 'enforce'] as const) {
      const text = renderAnchor(state({ enforcement }), { cwd: '/tmp/demo' })
      assert.match(text, /主会话审查/)
      assert.match(text, /亲自写入/)
      assert.match(text, /不得让子会话代写/)
      assert.ok(Buffer.byteLength(text, 'utf8') <= ANCHOR_BUDGET_BYTES)
    }
  })

  test('names the run directory the probes execute in and forbids leaving the workspace', () => {
    const cwd = '/Volumes/SSD/Home/lionm4/my_project/_AI/x9Copy'
    const text = renderAnchor(state(), { cwd })
    assert.match(text, /运行目录：/)
    assert.ok(text.includes(cwd), `the anchor must name the run directory: ${text}`)
    assert.match(text, /只限运行目录/)
    assert.match(text, /跨工作区/)
    assert.ok(Buffer.byteLength(text, 'utf8') <= ANCHOR_BUDGET_BYTES)
    // Backwards compatibility: callers that cannot name a directory render the
    // same block as before instead of a half-empty "运行目录：" line.
    assert.ok(!renderAnchor(state()).includes('运行目录：'))
  })

  test('a long run directory is clipped and never squeezes out the task or the rules', () => {
    const text = renderAnchor(state(), { cwd: `/very/${'long/'.repeat(80)}workspace` })
    assert.ok(Buffer.byteLength(text, 'utf8') <= ANCHOR_BUDGET_BYTES, String(Buffer.byteLength(text, 'utf8')))
    assert.match(text, /运行目录：/)
    assert.match(text, /当前任务：T1/)
    assert.match(text, /硬规则：/)
    assert.match(text, /停止条件：/)
  })
})

// 长跑的两个失败面：条目卡住空转却不自知，以及主会话因为“不改 docs/guard/**”
// 而不敢写完成声明。锚点必须把这两件事说清楚。
describe('goal-supervisor anchor — long run guidance', () => {
  test('an idle task is told exactly how to stop spinning', () => {
    const text = renderAnchor(state({
      tasks: [{ ...state().tasks[0]!, idleStreak: 2 }],
    }))
    assert.match(text, /待验收（T1）/)
    assert.match(text, /连续 2 轮/)
    assert.match(text, /docs\/guard\/20261124-demo\/tasks\/T1\/notes\.md/)
  })

  test('the completion declaration names its path and the ledger exception', () => {
    const text = renderAnchorUnclipped(state())
    assert.match(text, /docs\/guard\/20261124-demo\/tasks\/<ID>\/notes\.md/)
    assert.match(text, /例外/)
  })
})
