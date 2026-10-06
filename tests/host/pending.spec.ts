// 结果回流：fold 把父会话日志里的 `subagent-settled` 通知收下来，并在 head 上出 `pending`
// （`docs/06` §3.3 / `docs/10` M5-18）。
//
// 锁三件事（fold 只报**事实**；三态判定在 `src/shared/redline-pending.ts`，由客户端叠加"已查看"标记后算）：
//   ① 通知**单独存**（不塞进会被 retention 裁掉的 `events`）—— 否则老通知会悄悄消失；
//   ② head 上的 `notices` 原样带上 seq / childId / summary；
//   ③ 无关的注入事件（别的 plugin 来源）**不会**被误认成结算通知。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { assistantMessage, userMessage } from './helpers/events'
import { driveTimeline } from './helpers/projection'

const text = (t: string) => [{ type: 'text', text: t }]
const notice = (childId: string, summary = 'Background subagent finished') => ({ kind: 'subagent-settled', form: 'notice', summary, senderSessionId: childId })

describe('结果回流（fold 的 pending）', () => {
  test('收到结算通知：id / seq / 摘要原样带上 head', () => {
    const { view, state } = driveTimeline([
      userMessage(1, text('干活'), { kind: 'user' }),
      userMessage(2, text('…'), notice('child-abc-1234', '凌晨跑的，已经结束')),
    ])
    assert.equal(view.notices?.length, 1)
    assert.equal(view.notices?.[0].childId, 'child-abc-1234')
    assert.equal(view.notices?.[0].seq, 2)
    assert.equal(view.notices?.[0].summary, '凌晨跑的，已经结束')
    assert.equal(typeof view.notices?.[0].at, 'number', '时刻原样带上（具体值由宿主时钟决定）')
    assert.equal(state.settled?.length, 1, '通知单独存在状态里（不靠 events）')
  })

  test('后续轮次不影响 fold 报的事实（判定归客户端：它还会叠"已查看"）', () => {
    const { view } = driveTimeline([
      userMessage(1, text('干活'), { kind: 'user' }),
      userMessage(2, text('…'), notice('child-abc-1234')),
      assistantMessage(3, { content: text('接着做'), usage: { inputTokens: 5 } }),
    ])
    assert.equal(view.notices?.length, 1, '通知还在')
    assert.equal(view.lastRequestSeq, 3, '客户端拿 `lastRequestSeq` 当"父会话又跑了"的证据（瘦/胖两条线都有）')
  })

  test('**没有**通知时 head 上不出现 notices（线型保持瘦）', () => {
    const { view } = driveTimeline([userMessage(1, text('干活'), { kind: 'user' })])
    assert.equal(view.notices, undefined)
  })

  test('别的 plugin 注入不带 senderSessionId ⟹ 不当作结算通知', () => {
    const { view } = driveTimeline([
      userMessage(1, text('注入'), { kind: 'plugin', form: 'notice', plugin: 'some-plugin', summary: '别的插件' }),
    ])
    assert.equal(view.notices, undefined)
    assert.equal(view.events?.length, 1, '但它仍是一条普通的注入事件')
  })

  test('多条通知按 seq 升序原样列出', () => {
    const { view } = driveTimeline([
      userMessage(1, text('a'), notice('child-1')),
      userMessage(2, text('b'), notice('child-2')),
      assistantMessage(3, { content: text('跑'), usage: { inputTokens: 5 } }),
      userMessage(4, text('c'), notice('child-3')),
    ])
    assert.deepEqual(view.notices?.map(n => [n.childId, n.seq]), [['child-1', 1], ['child-2', 2], ['child-3', 4]])
  })
})
