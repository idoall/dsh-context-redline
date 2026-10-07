// M5-07 读半边：官方 `agentTeam` 投影的归一化 —— CLIENT-LOGIC lane（纯逻辑，不用浏览器）。
//
// 官方形状以安装树 `@deepseek-ai/dsh-experimental-agent-team` 的 `TeamProjection` 为准：
// `{ members: [{id,name,role,phase,error?}], tasks: [{id,revision,subject,status,ownerName?,ready}], failure? }`。
// 我们只读、不改、不猜；三件事在这条文件里逐个钉住：读不到就是 null；空队伍 ≠ 没数据；官方的 failure 必须透传。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { teamBoardOf } from '../../src/shared/redline-team'

describe('teamBoardOf —— 读官方那份团队数据', () => {
  test('读不到 → null（界面据此说"这台运行时没有这个数据"，而不是显示一个空队伍）', () => {
    for (const absent of [null, undefined, 42, 'agentTeam', [], {}]) {
      assert.equal(teamBoardOf(absent), null, String(absent))
    }
  })

  test('空队伍 ≠ 没有数据：两个数组都在、只是空的 → 空板（不是 null）', () => {
    const board = teamBoardOf({ members: [], tasks: [] })
    assert.notEqual(board, null)
    assert.deepEqual(board?.members, [])
    assert.deepEqual(board?.tasks, [])
    assert.equal(board?.failure, null)
  })

  test('成员/任务归一化：认不出的 role、phase、status 落 unknown，不硬猜', () => {
    const board = teamBoardOf({
      members: [
        { id: 's1', name: '我', role: 'lead', phase: 'active' },
        { id: 's2', name: '小王', role: 'teammate', phase: 'provisioning', error: '起不来' },
        { id: 's3', name: '?', role: 'boss', phase: 'zombie' },
        { name: '没有 id 的行' },
        'not-an-object',
      ],
      tasks: [
        { id: 't1', revision: 2, subject: '把测试补上', status: 'pending', ready: true },
        { id: 't2', revision: 1, subject: '写文档', status: 'in_progress', ownerName: '小王', ready: false },
        { subject: '没有 id' },
      ],
    })
    assert.equal(board?.members.length, 3, '没有 id 的行被丢掉（不编造身份）')
    assert.deepEqual(board?.members[0], { id: 's1', name: '我', role: 'lead', phase: 'active', error: null })
    assert.equal(board?.members[1].error, '起不来')
    assert.equal(board?.members[2].role, 'unknown')
    assert.equal(board?.members[2].phase, 'unknown')
    assert.equal(board?.tasks.length, 2)
    assert.deepEqual(board?.tasks[0], { id: 't1', revision: 2, subject: '把测试补上', status: 'pending', ownerName: null, ready: true })
    assert.equal(board?.tasks[1].ownerName, '小王')
  })

  test('官方的 failure 必须透传（它是"第一条被拒的团队记录"，静默掉就是骗人）', () => {
    const board = teamBoardOf({ members: [], tasks: [], failure: 'team/task 被拒：writeScopes 非法' })
    assert.equal(board?.failure, 'team/task 被拒：writeScopes 非法')
  })

  test('只给 members 或只给 tasks 也算有数据（另一个按空处理）', () => {
    const a = teamBoardOf({ members: [{ id: 's1', name: '我', role: 'lead', phase: 'active' }] })
    assert.equal(a?.members.length, 1)
    assert.deepEqual(a?.tasks, [])
    const b = teamBoardOf({ tasks: [{ id: 't1', subject: 'x', status: 'done', ready: true, revision: 1 }] })
    assert.deepEqual(b?.members, [])
    assert.equal(b?.tasks.length, 1)
  })
})
