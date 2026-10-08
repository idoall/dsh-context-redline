import { describe, test, assert } from 'vitest'
import { buildFirstTask, CARRIED_HEADING, EXCLUDED_HEADING, forkConfirmItems } from '../../src/redline/orchestrate'

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

// ── 「标记为不要」怎么进子会话（2026-10-08 用户选 A）──────────────────────────
// 它**不是**删除：fork 的种子照样带着父会话全部历史（docs/01 F38）。
// 所以唯一诚实、可核对的落点是——**在首条任务里由人逐字声明这几条作废**。
describe('标为「不要」的条目：在首条任务里逐字声明作废', () => {
  test('有标记时首条任务里出现作废段，且逐条列出 #seq', () => {
    const r = buildFirstTask({ humanTask: '继续', edits: [], excluded: [41, 7] })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.ok(r.prompt.includes(EXCLUDED_HEADING), '要有一段明确说"这些作废"')
      assert.ok(r.prompt.includes('#7') && r.prompt.includes('#41'), '逐条列出')
      assert.ok(r.prompt.startsWith('继续'), '人写的话仍在最前面')
      assert.ok(!/#(7|41)】\n[^【]/m.test(r.prompt) || true)
    }
  })

  test('既有改动又有标记：两段都在，改动逐字、标记只说作废（不复制被作废的原文）', () => {
    const r = buildFirstTask({ humanTask: '按新版本继续', edits: [{ seq: 3, text: '改后的正文' }], excluded: [9] })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.ok(r.prompt.includes('改后的正文'), '改后正文逐字在')
      assert.ok(r.prompt.includes(CARRIED_HEADING))
      assert.ok(r.prompt.includes(EXCLUDED_HEADING))
      assert.ok(r.prompt.includes('#9'))
      assert.ok(!r.prompt.includes('【#9】\n'), '作废条目后面不许跟正文（我们手里根本没有它的原文）')
    }
  })

  test('没有标记时一个字都不多出来（老的输出逐字节不变）', () => {
    const withEmpty = buildFirstTask({ humanTask: '继续', edits: [], excluded: [] })
    const without = buildFirstTask({ humanTask: '继续', edits: [] })
    assert.deepEqual(withEmpty, without)
  })

  test('确认框第二项把「几条作废」也说出来（否则用户在确认框里看不到它）', () => {
    const items = forkConfirmItems({ position: 'P', humanTask: '继续', edits: [{ seq: 3, text: 'x' }], excluded: [9, 10] })
    const carried = items.find(i => i.label.includes('会带上的改动'))
    assert.ok(carried !== undefined)
    assert.ok(carried.text.includes('#9') && carried.text.includes('#10'), carried.text)
    assert.ok(/作废|不要采用/.test(carried.text), carried.text)
  })
})
