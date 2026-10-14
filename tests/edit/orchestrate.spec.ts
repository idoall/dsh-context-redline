import { describe, test, assert } from 'vitest'
import { buildFirstTask, CARRIED_HEADING, forkConfirmItems } from '../../src/redline/orchestrate'

describe('首条任务组装（M5-04 / docs/06 §3.3）', () => {
  test('人写的任务为空或纯空白 → 拒绝，并说清为什么', () => {
    for (const empty of ['', '   ', '\n\t ']) {
      const r = buildFirstTask({ humanTask: empty, edits: [{ seq: 1, text: '改后的正文' }] })
      assert.equal(r.ok, false, JSON.stringify(empty))
      if (!r.ok) {
        assert.equal(r.code, 'empty-task')
        assert.ok(r.message.includes('自己写'), r.message)
      }
    }
  })

  test('没有改动时，首条任务就是人写的那句话', () => {
    const r = buildFirstTask({ humanTask: ' 接着把测试补上 ', edits: [] })
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.prompt, '接着把测试补上')
  })

  test('有改动时**逐字**带入（不截断、不改字、不摘要），并写明这是改好的上下文', () => {
    const text = '第一段：把默认档位改成按轮次。\n\n第二段：跑测试要贴原始输出。'
    const r = buildFirstTask({ humanTask: '按改好的上下文继续', edits: [{ seq: 3358, text }] })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.ok(r.prompt.includes(text), '改后正文必须原样出现')
      assert.ok(r.prompt.includes('#3358'), '要标出行号，人和模型都能对上')
      assert.ok(r.prompt.includes(CARRIED_HEADING), '要说明这段是"改好的上下文"')
      assert.ok(r.prompt.startsWith('按改好的上下文继续'), '人写的话在最前面')
    }
  })

  test('多条改动：顺序稳定、各自成段', () => {
    const r = buildFirstTask({ humanTask: '继续', edits: [{ seq: 10, text: 'A' }, { seq: 12, text: 'B' }] })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.ok(r.prompt.indexOf('#10') < r.prompt.indexOf('#12'), '按传入顺序')
      assert.ok(r.prompt.includes('#10】\nA'))
      assert.ok(r.prompt.includes('#12】\nB'))
    }
  })
})

describe('确认框五项（M5-05 / docs/06 §4.1）', () => {
  const items = forkConfirmItems({ position: '从最后聊完的那一轮开始', humanTask: '接着做', edits: [{ seq: 7, text: 'X' }] })

  test('恰好五项，且每项都有标题与内容', () => {
    assert.equal(items.length, 5)
    for (const it of items) {
      assert.ok(it.label.length > 0)
      assert.ok(it.text.length > 0)
    }
  })

  test('必列：逐字带入的条数、取消=什么都不发生、以及"比这条记录更晚的改动也会一起进去"那句实话', () => {
    const all = items.map(i => i.text).join('\n')
    assert.ok(all.includes('#7'), '要报出带哪几条')
    assert.ok(all.includes('逐字'))
    assert.ok(all.includes('什么都不发生'), '取消的语义必须写出来')
    assert.ok(all.includes('比你想的更晚'), '起点那句实话（F38）不能省')
    assert.ok(all.includes('不自动回到这边') || all.includes('不会自动回到这边'), '要说清不带什么')
  })

  test('首条任务空着时，确认框如实说"空着不能开"（不静默通过）', () => {
    const empty = forkConfirmItems({ position: 'P', humanTask: '  ', edits: [] })
    const task = empty.find(i => i.label.includes('第一句话'))
    assert.ok(task !== undefined)
    assert.ok(task.text.includes('不能开'), task.text)
  })

  test('文案里不出现内部词（provider / 种子 / 切点 / 继承范围）', () => {
    const all = items.map(i => i.label + i.text).join('\n')
    for (const bad of ['provider', '种子', '切点', '继承范围', 'fork']) {
      assert.ok(!all.includes(bad), `不该出现内部词：${bad}`)
    }
  })
})

// ── 「删除」怎么进新会话（`docs/03` R4.8 / `docs/13` §7，2026-10-09）──────────────
// 删除 = 这一条**不写进新会话**。新会话是**零历史** ⟹ 不带的条目就是不在 ——
// 旧载体那句"历史里仍带着原文，请不要采用"的声明**整段作废**（`docs/13` §7 的 `EXCLUDED_HEADING`）。
describe('被删除的条目：不进首条任务（零历史，不需要声明）', () => {
  test('只有删除、没有改动时，首条任务就是人写那句话（不再出现声明段）', () => {
    assert.deepEqual(buildFirstTask({ humanTask: '继续', edits: [], excluded: [41, 7] }), { ok: true, prompt: '继续' })
  })

  test('被删的条目连编号都不出现，也不出现任何"作废/不要采用"的话', () => {
    const r = buildFirstTask({ humanTask: '按新版本继续', edits: [{ seq: 3, text: '改后的正文' }], excluded: [9] })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.ok(r.prompt.includes('改后的正文'), '改后正文逐字在')
      assert.ok(r.prompt.includes(CARRIED_HEADING))
      assert.ok(!r.prompt.includes('#9'), '被删的条目连编号都不该出现')
      assert.ok(!/不要采用|作废/.test(r.prompt), '作废声明整段作废')
    }
  })

  test('没有删除、没有改动时输出逐字节不变', () => {
    assert.deepEqual(buildFirstTask({ humanTask: '继续', edits: [], excluded: [] }), buildFirstTask({ humanTask: '继续', edits: [] }))
  })

  test('确认框第二项仍要说出"删了几条、不会带过去"（用户在确认框里必须看得到）', () => {
    const items = forkConfirmItems({ position: 'P', humanTask: '继续', edits: [{ seq: 3, text: 'x' }], excluded: [9, 10] })
    const carried = items.find(i => i.label.includes('会带上的改动'))
    assert.ok(carried !== undefined)
    assert.ok(carried.text.includes('#9') && carried.text.includes('#10'), carried.text)
    assert.ok(carried.text.includes('已经被你删除') && carried.text.includes('不会被带过去'), carried.text)
  })
})

// ── 文案里不许出现 markdown 星号（2026-10-08 真机发现）──────────────────────────
// 确认框那一行是 `h('p', null, item.text)` —— **纯文本渲染**，不解析 markdown。
// 所以文案里写 `**逐字**` 的真实效果是用户看到光秃秃的星号（真机实测确实如此）。
describe('确认框文案：不许出现 markdown 星号（界面不解析 markdown）', () => {
  test('五项里没有 **', () => {
    const items = forkConfirmItems({ position: '从最后聊完的那一轮开始', humanTask: '继续', edits: [{ seq: 3, text: 'x' }], excluded: [9] })
    for (const it of items) assert.equal(it.text.includes('**'), false, `${it.label}: ${it.text}`)
  })

  test('首条任务里也没有 **（它会被逐字写进子会话）', () => {
    const r = buildFirstTask({ humanTask: '继续', edits: [{ seq: 3, text: 'x' }], excluded: [9] })
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.prompt.includes('**'), false)
  })
})
