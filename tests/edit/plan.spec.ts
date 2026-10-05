import { describe, test, assert } from 'vitest'
import { planNext } from '../../src/redline/plan'

const base = { turnOpen: false, draftCount: 0, appliedEdits: 0, child: null, pendingSettled: 0 }

describe('plan.next（docs/06 §6 的机器判定）', () => {
  test('轮次未闭合压过一切 —— 连"有草稿"都不提', () => {
    const d = planNext({ ...base, turnOpen: true, draftCount: 3, pendingSettled: 2 })
    assert.equal(d.kind, 'waitTurn')
    assert.equal(d.needsConfirm, false, '这一条不需要确认框：它只是把话说清楚')
  })

  test('有草稿 → applyDrafts，且理由必须写明"草稿不会跟过去"', () => {
    const d = planNext({ ...base, draftCount: 2 })
    assert.equal(d.kind, 'applyDrafts')
    assert.equal(d.needsConfirm, true)
    assert.ok(d.reason.includes('不会自己跟过去'), `理由要讲清种子来自日志：${d.reason}`)
    assert.ok(d.reason.includes('2'), '理由要报出条数')
  })

  test('没有 pinInvariants 这一步 —— 固定块/不变量那层已删（docs/11 D14）', () => {
    // 任何输入都不该给出一个"钉住不变量"的判定：那会让界面出现一个永远为假的步骤。
    for (const input of [
      { ...base },
      { ...base, draftCount: 1 },
      { ...base, child: { exists: true, idle: true, historyLong: false } },
    ]) {
      const kind: string = planNext(input).kind
      assert.notEqual(kind, 'pinInvariants')
    }
  })

  test('草稿提交完、还没子会话 → startChild（可续接）', () => {
    const d = planNext({ ...base, appliedEdits: 1, child: { exists: false, idle: false, historyLong: false } })
    assert.equal(d.kind, 'startChild')
    assert.equal(d.needsConfirm, true)
  })

  test('子会话在跑（不空闲）→ 不提议压缩', () => {
    const d = planNext({ ...base, child: { exists: true, idle: false, historyLong: true } })
    assert.equal(d.kind, 'idle')
  })

  test('子会话空闲且历史长 → compactChild', () => {
    const d = planNext({ ...base, child: { exists: true, idle: true, historyLong: true } })
    assert.equal(d.kind, 'compactChild')
    assert.equal(d.needsConfirm, true)
  })

  test('有未处理的结算通知 → reviewChild，且压过 idle', () => {
    const d = planNext({ ...base, child: { exists: true, idle: true, historyLong: false }, pendingSettled: 2 })
    assert.equal(d.kind, 'reviewChild')
    assert.ok(d.reason.includes('2'), '理由要报出条数')
  })

  test('历史长且有待看结果时，压缩优先于"看结果"（先让它喘得过来）', () => {
    const d = planNext({ ...base, child: { exists: true, idle: true, historyLong: true }, pendingSettled: 1 })
    assert.equal(d.kind, 'compactChild')
  })

  test('没改过、也没子会话 → idle（不该提议开子会话）', () => {
    const d = planNext(base)
    assert.equal(d.kind, 'idle')
    assert.equal(d.needsConfirm, false)
  })

  test('都没有 → idle，且不需要确认框', () => {
    const d = planNext({ ...base, appliedEdits: 1 })
    assert.equal(d.kind, 'startChild')
  })

  test('次序是不变量：同一份输入永远给同一个判定', () => {
    const input = { turnOpen: false, draftCount: 1, appliedEdits: 1, child: null, pendingSettled: 3 }
    assert.deepEqual(planNext(input), planNext(input))
  })
})
