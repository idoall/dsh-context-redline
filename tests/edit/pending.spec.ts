// 结果回流的三态判定（`docs/10` M5-19，规格 `docs/06` §3.3「结果回流」）—— 纯逻辑，`edit` 门禁 lane。
//
// 为什么要它：父会话日志里会出现运行时自己的结算通知（`source.kind === 'subagent-settled'`），
// 我们**只做可见性**（不自动汇总、不代替用户看）。三态的语义固定为：
//   · `continued` —— 这条通知**之后**父会话又开了新轮次 ⟹ 它已经被"接着做"过了（最强的证据）
//   · `seen`      —— 用户在我们自己的本地表里标过"已查看"（**不写会话**）
//   · `unseen`    —— 收到通知但既没被接着做、也没被标过 ⟹ 界面要能一眼看出"这条还没人管"
// 判定必须**按 seq 比较**（通知与 turn/start 都在同一会话的日志里，seq 是唯一可靠次序）。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { pendingRowsOf, type SettleNotice, type TurnStart } from '../../src/shared/redline-pending'

const notice = (seq: number, childId = 'child-a', summary = 'finished'): SettleNotice => ({ seq, childId, summary, at: seq * 100 })
const turn = (seq: number): TurnStart => ({ seq, at: seq * 100 })

describe('结果回流三态（pendingRowsOf）', () => {
  test('通知之后有 turn/start ⟹ continued（父会话自己已经接着做了）', () => {
    const rows = pendingRowsOf([notice(10)], [], [turn(12)])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'continued')
    assert.equal(rows[0].notice.childId, 'child-a')
  })

  test('没有后续轮次、也没标过已查看 ⟹ unseen', () => {
    assert.equal(pendingRowsOf([notice(10)], [], [])[0].state, 'unseen')
    // 更早的轮次不算"后续"
    assert.equal(pendingRowsOf([notice(10)], [], [turn(9), turn(3)])[0].state, 'unseen')
  })

  test('标过已查看、但没有后续轮次 ⟹ seen', () => {
    assert.equal(pendingRowsOf([notice(10)], [10], [])[0].state, 'seen')
  })

  test('边界：同一 seq 的 turn/start **不算**"之后"（严格大于才是后续）', () => {
    // 契约意义：判定写成 `>=` 时这条会红（日志里 seq 唯一、同 seq 不会真发生，
    // 但纯函数的契约要钉死 —— 这正是反向验证②抓出来的缺口）。
    assert.equal(pendingRowsOf([notice(10)], [], [turn(10)])[0].state, 'unseen')
  })

  test('既有后续轮次又标过 ⟹ continued 更硬（它已经真的被接着做了）', () => {
    assert.equal(pendingRowsOf([notice(10)], [10], [turn(11)])[0].state, 'continued')
  })

  test('一条通知只对应一行；多条按 seq 升序（与日志同向）', () => {
    const rows = pendingRowsOf([notice(30, 'c'), notice(10, 'a'), notice(20, 'b')], [], [turn(15)])
    assert.deepEqual(rows.map(r => r.notice.seq), [10, 20, 30])
    assert.deepEqual(rows.map(r => r.state), ['continued', 'unseen', 'unseen'], '只有 10 之后有轮次')
  })

  test('总数与标记都要如实报：同一子会话结算多次也算多条', () => {
    const rows = pendingRowsOf([notice(10), notice(40)], [40], [])
    assert.equal(rows.length, 2, '结算两次就是两条通知，不合并')
    assert.deepEqual(rows.map(r => r.state), ['unseen', 'seen'])
  })

  test('三个输入全都不是数组时也不许炸（宿主给错形状 ⟹ 当"没有证据"）', () => {
    const rows = pendingRowsOf(undefined as unknown as SettleNotice[], undefined as unknown as number[], undefined as unknown as TurnStart[])
    assert.deepEqual(rows, [])
  })

  test('坏数据不许炸：seq 不是数字 / 结构不对的通知与轮次一律丢掉', () => {
    const rows = pendingRowsOf(
      [{ seq: 'x', childId: 'a', summary: 's', at: 0 } as unknown as SettleNotice, notice(10)],
      [Number.NaN as unknown as number],
      [{ seq: null } as unknown as TurnStart],
    )
    assert.equal(rows.length, 1, '只有合法的那条成为行')
    assert.equal(rows[0].state, 'unseen')
  })
})
