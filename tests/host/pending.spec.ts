// 结果回流：fold 把父会话日志里的 `subagent-settled` 通知收下来，并在 head 上出 `pending`
// （`docs/06` §3.3 / `docs/10` M5-18）。
//
// 锁三件事：
//   ① 通知**单独存**（不塞进会被 retention 裁掉的 `events`）—— 否则老通知会悄悄消失；
//   ② 证据是"**最新一条请求的 seq 在通知之后**" ⟹ `continued`（父会话自己又跑了）；
//      没有后续请求 ⟹ `unseen`（还没人管）；
//   ③ 无关的注入事件（别的 plugin 来源）**不会**被误认成结算通知。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { assistantMessage, userMessage } from './helpers/events'
import { driveTimeline } from './helpers/projection'

const text = (t: string) => [{ type: 'text', text: t }]
const notice = (childId: string, summary = 'Background subagent finished') => ({ kind: 'subagent-settled', form: 'notice', summary, senderSessionId: childId })

describe('结果回流（fold 的 pending）', () => {
  test('收到结算通知、父会话**还没**再跑 ⟹ unseen，且 id/摘要原样带上', () => {
    const { view, state } = driveTimeline([
      userMessage(1, text('干活'), { kind: 'user' }),
      userMessage(2, text('…'), notice('child-abc-1234', '凌晨跑的，已经结束')),
    ])
    assert.equal(view.pending?.length, 1)
    assert.equal(view.pending?.[0].notice.childId, 'child-abc-1234')
    assert.equal(view.pending?.[0].notice.seq, 2)
    assert.equal(view.pending?.[0].notice.summary, '凌晨跑的，已经结束')
    assert.equal(typeof view.pending?.[0].notice.at, 'number', '时刻原样带上（具体值由宿主时钟决定）')
    assert.equal(view.pending?.[0].state, 'unseen')
    assert.equal(state.settled?.length, 1, '通知单独存在状态里（不靠 events）')
  })

  test('通知**之后**父会话又跑了一轮 ⟹ continued', () => {
    const { view } = driveTimeline([
      userMessage(1, text('干活'), { kind: 'user' }),
      userMessage(2, text('…'), notice('child-abc-1234')),
      assistantMessage(3, { content: text('接着做'), usage: { inputTokens: 5 } }),
    ])
    assert.equal(view.pending?.length, 1)
    assert.equal(view.pending?.[0].state, 'continued', '有更晚的请求 ⟹ 已经被人接着做了')
  })

  test('**没有**通知时 head 上不出现 pending（线型保持瘦）', () => {
    const { view } = driveTimeline([userMessage(1, text('干活'), { kind: 'user' })])
    assert.equal(view.pending, undefined)
  })

  test('别的 plugin 注入不带 senderSessionId ⟹ 不当作结算通知', () => {
    const { view } = driveTimeline([
      userMessage(1, text('注入'), { kind: 'plugin', form: 'notice', plugin: 'some-plugin', summary: '别的插件' }),
    ])
    assert.equal(view.pending, undefined)
    assert.equal(view.events?.length, 1, '但它仍是一条普通的注入事件')
  })

  test('多条通知按 seq 升序，且各判各的', () => {
    const { view } = driveTimeline([
      userMessage(1, text('a'), notice('child-1')),
      userMessage(2, text('b'), notice('child-2')),
      assistantMessage(3, { content: text('跑'), usage: { inputTokens: 5 } }),
      userMessage(4, text('c'), notice('child-3')),
    ])
    assert.deepEqual(view.pending?.map(r => [r.notice.childId, r.notice.seq, r.state]), [
      ['child-1', 1, 'continued'],
      ['child-2', 2, 'continued'],
      ['child-3', 4, 'unseen'],
    ])
  })
})
