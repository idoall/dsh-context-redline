import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  ANCHOR_FIELD_LIMIT,
  anchorRequestFingerprint,
  composeAnchor,
  type AnchorDraft,
} from '../../src/shared/redline-anchor'

const draft: AnchorDraft = {
  task: '把设置页改成深色模式，并补齐移动端断点。',
  goal: '把设置页改成深色模式',
  acceptance: '375/430 无横向溢出；深色对比度达标；有头 UAT 通过。',
  discipline: '出错时修正并复验，继续原目标；完成前不换目标。',
}

describe('锚定会话的三段式快照（0.4.0）', () => {
  test('快照只含目标/验收/纪律，格式固定且逐字保留', () => {
    const composed = composeAnchor(draft)
    assert.equal(composed.text, [
      '目标：把设置页改成深色模式',
      '验收：375/430 无横向溢出；深色对比度达标；有头 UAT 通过。',
      '纪律：出错时修正并复验，继续原目标；完成前不换目标。',
    ].join('\n\n'))
    assert.equal(composed.text.includes(draft.task), false, '首条任务不进运行时快照')
    assert.match(composed.fingerprint, /^[0-9a-f]{64}$/)
  })

  test('四段输入都去首尾空白', () => {
    const composed = composeAnchor({
      task: `  ${draft.task}  `,
      goal: `  ${draft.goal}  `,
      acceptance: `  ${draft.acceptance}  `,
      discipline: `  ${draft.discipline}  `,
    })
    assert.equal(composed.text, composeAnchor(draft).text)
    assert.equal(anchorRequestFingerprint({ ...draft, task: `  ${draft.task}  ` }), anchorRequestFingerprint(draft))
  })

  test('任一字段为空或超长都拒绝，不生成半截快照', () => {
    for (const key of ['task', 'goal', 'acceptance', 'discipline'] as const) {
      assert.throws(() => composeAnchor({ ...draft, [key]: '   ' }), /anchor field is empty/)
      assert.throws(() => composeAnchor({ ...draft, [key]: 'x'.repeat(ANCHOR_FIELD_LIMIT + 1) }), /anchor field is too long/)
    }
  })

  test('任务也进入请求指纹：只改任务也会让旧确认失效', () => {
    assert.notEqual(anchorRequestFingerprint(draft), anchorRequestFingerprint({ ...draft, task: '另一个任务' }))
    assert.equal(composeAnchor(draft).fingerprint, composeAnchor({ ...draft, task: '另一个任务' }).fingerprint)
  })
})
