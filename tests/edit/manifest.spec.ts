// C1 · 迁移清单组装（`docs/13` §2/§5/§8.1–8.2）的**口径层**。
//
// 为什么必须有这一层：清单是**两份数据**——① 决策清单（所有候选，含 keep/edited/deleted/trimmed
// 与理由）负责可审计、可申诉、可恢复；② 投递内容只含允许携带的条目。二者必须从**同一次计算**出来，
// 否则"预览"与"真正投递的字节"会分叉（`docs/13` 硬要求 1）。
//
// 本层**不做**的事（避免把待定决策偷偷定下来）：
//   · 不选 `role` 取值表与分节标题文案（`docs/13` §4 标 🟡 待定）——`role` 只做调用方透传；
//   · 不把清单序列化成首条任务正文（那需要 §4 的文案，属 C11 + demo 先行）；
//   · 不读旧 `LocalEdit.excluded`（那是 C2 的 schema 迁移责任）——删除集由调用方显式传入。
//
// 因此本层能机械验证的就是：**决策优先级**、**按身份而非正文分离**、**投递顺序**、**指纹稳定**。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { DraftTable } from '../../src/shared/redline-drafts'
import {
  type ManifestCandidate,
  type ManifestInput,
  buildManifest,
  manifestKeyOf,
  serializeManifestDelivery,
} from '../../src/redline/manifest'

const SESSION = 'session-manifest-c1'
const OTHER_SESSION = 'session-manifest-c1-other'

function eventKey(seq: number, type = 'user/message', session = SESSION): string {
  return manifestKeyOf({ kind: 'event', sourceSessionId: session, seq, type })
}

function candidate(over: Partial<ManifestCandidate> & { readonly seq: number }): ManifestCandidate {
  const { seq, ...rest } = over
  return {
    sourceKey: { kind: 'event', sourceSessionId: SESSION, seq, type: 'user/message' },
    cat: 'user',
    sourceRole: 'user',
    order: seq,
    text: `text-${seq}`,
    ...rest,
  }
}

function input(over: Partial<ManifestInput> & { readonly candidates: readonly ManifestCandidate[] }): ManifestInput {
  return {
    sourceSessionId: SESSION,
    surfaceAsOfSeq: 42,
    surfaceFingerprint: 'surface-fp-1',
    edits: {},
    ...over,
  }
}

function actionOf(entries: readonly { readonly key: string; readonly action: string }[], key: string): string | undefined {
  return entries.find((entry) => entry.key === key)?.action
}

describe('清单：删除按身份而不是按正文', () => {
  test('被删条目留在决策清单、不出现在投递内容', () => {
    const target = candidate({ seq: 7, text: 'same body' })
    const result = buildManifest(input({
      candidates: [target],
      deletions: [eventKey(7)],
    }))

    assert.equal(actionOf(result.decision, eventKey(7)), 'deleted')
    assert.equal(result.decision.length, 1, '删除项必须留在决策清单里')
    assert.equal(result.delivery.length, 0, '删除项不得进入投递内容')
  })

  test('正文完全相同的另一条不受影响（证明不按字符串筛）', () => {
    const deleted = candidate({ seq: 7, text: 'same body' })
    const kept = candidate({ seq: 8, text: 'same body' })
    const result = buildManifest(input({
      candidates: [deleted, kept],
      deletions: [eventKey(7)],
    }))

    assert.equal(actionOf(result.decision, eventKey(7)), 'deleted')
    assert.equal(actionOf(result.decision, eventKey(8)), 'keep')
    const carried = result.delivery.map((entry) => entry.key)
    assert.deepEqual(carried, [eventKey(8)], '只应携带未被删除的那一条')
  })

  test('同 seq 但不同会话的身份不互相命中', () => {
    const result = buildManifest(input({
      candidates: [candidate({ seq: 7 })],
      deletions: [eventKey(7, 'user/message', OTHER_SESSION)],
    }))

    assert.equal(actionOf(result.decision, eventKey(7)), 'keep')
  })
})

describe('清单：编辑与删除的优先级', () => {
  test('只编辑：动作是 edited，投递用改后全文', () => {
    const long = 'A'.repeat(5000)
    const edits: DraftTable = {
      '7': { seq: 7, text: long, reasoning: 'think', isError: false, updatedAt: '2026-10-09T00:00:00.000Z' },
    }
    const result = buildManifest(input({ candidates: [candidate({ seq: 7, text: 'original' })], edits }))

    const entry = result.decision[0]
    assert.equal(entry.action, 'edited')
    assert.equal(entry.text, long, '必须是逐字全文，不许摘要或截断')
    assert.equal(entry.sourceText, 'original', '原文要留档')
    assert.equal(result.delivery[0]?.text, long)
  })

  test('编辑后被删除：动作是 deleted，但编辑正文仍留在决策清单里（供取消删除恢复）', () => {
    const edits: DraftTable = {
      '7': { seq: 7, text: 'edited body', reasoning: 'r', isError: true, updatedAt: '2026-10-09T00:00:00.000Z' },
    }
    const result = buildManifest(input({
      candidates: [candidate({ seq: 7, text: 'original' })],
      edits,
      deletions: [eventKey(7)],
    }))

    const entry = result.decision[0]
    assert.equal(entry.action, 'deleted')
    assert.equal(entry.text, 'edited body', '取消删除后要能原样恢复编辑稿')
    assert.equal(entry.reasoning, 'r')
    assert.equal(entry.isError, true)
    assert.equal(result.delivery.length, 0)
  })

  test('用户明确保留 > 自动裁剪建议', () => {
    const result = buildManifest(input({
      candidates: [candidate({ seq: 7 })],
      trimmed: [{ key: eventKey(7), reason: 'duplicate tool result' }],
      kept: [eventKey(7)],
    }))

    assert.equal(actionOf(result.decision, eventKey(7)), 'keep')
    assert.equal(result.delivery.length, 1)
  })

  test('用户删除 > 用户明确保留', () => {
    const result = buildManifest(input({
      candidates: [candidate({ seq: 7 })],
      deletions: [eventKey(7)],
      kept: [eventKey(7)],
    }))

    assert.equal(actionOf(result.decision, eventKey(7)), 'deleted')
  })

  test('编辑 > 自动裁剪建议（自动裁剪不许吞掉编辑稿）', () => {
    const edits: DraftTable = {
      '7': { seq: 7, text: 'edited body', reasoning: '', isError: false, updatedAt: '2026-10-09T00:00:00.000Z' },
    }
    const result = buildManifest(input({
      candidates: [candidate({ seq: 7 })],
      edits,
      trimmed: [{ key: eventKey(7), reason: 'candidate group' }],
    }))

    assert.equal(actionOf(result.decision, eventKey(7)), 'edited')
    assert.equal(result.delivery.length, 1, '编辑稿必须被携带')
  })
})

describe('清单：裁剪要带理由，且不投递', () => {
  test('trimmed 留在决策清单、带 reason、不进投递', () => {
    const result = buildManifest(input({
      candidates: [candidate({ seq: 9 })],
      trimmed: [{ key: eventKey(9), reason: '与 #11 同参数且人已确认等价' }],
    }))

    const entry = result.decision[0]
    assert.equal(entry.action, 'trimmed')
    assert.equal(entry.reason, '与 #11 同参数且人已确认等价')
    assert.equal(result.delivery.length, 0)
  })
})

describe('清单：顺序、计数与指纹', () => {
  test('投递按 order 升序且稳定', () => {
    const result = buildManifest(input({
      candidates: [candidate({ seq: 30, order: 30 }), candidate({ seq: 10, order: 10 }), candidate({ seq: 20, order: 20 })],
    }))

    assert.deepEqual(result.delivery.map((entry) => entry.sourceKey.kind === 'event' ? entry.sourceKey.seq : -1), [10, 20, 30])
  })

  test('计数反映决策清单的四个动作', () => {
    const edits: DraftTable = {
      '20': { seq: 20, text: 'edited', reasoning: '', isError: false, updatedAt: '2026-10-09T00:00:00.000Z' },
    }
    const result = buildManifest(input({
      candidates: [candidate({ seq: 10 }), candidate({ seq: 20 }), candidate({ seq: 30 }), candidate({ seq: 40 })],
      edits,
      deletions: [eventKey(30)],
      trimmed: [{ key: eventKey(40), reason: 'trimmed' }],
    }))

    assert.deepEqual(result.counts, { total: 4, carried: 2, kept: 1, edited: 1, deleted: 1, trimmed: 1 })
  })

  test('同一输入指纹稳定；任一动作或正文变化都改变指纹', () => {
    const base = buildManifest(input({ candidates: [candidate({ seq: 7 })] }))
    const again = buildManifest(input({ candidates: [candidate({ seq: 7 })] }))
    const deleted = buildManifest(input({ candidates: [candidate({ seq: 7 })], deletions: [eventKey(7)] }))
    const retexted = buildManifest(input({ candidates: [candidate({ seq: 7, text: 'changed' })] }))
    const refingerprinted = buildManifest(input({ candidates: [candidate({ seq: 7 })], surfaceFingerprint: 'surface-fp-2' }))

    assert.equal(base.manifestFingerprint, again.manifestFingerprint)
    assert.notEqual(base.manifestFingerprint, deleted.manifestFingerprint)
    assert.notEqual(base.manifestFingerprint, retexted.manifestFingerprint)
    assert.notEqual(base.manifestFingerprint, refingerprinted.manifestFingerprint)
    assert.match(base.manifestFingerprint, /^[0-9a-f]{64}$/)
  })

  test('投递内容由同一份决策清单派生（不是第二次读取）', () => {
    const result = buildManifest(input({
      candidates: [candidate({ seq: 10 }), candidate({ seq: 20 }), candidate({ seq: 30 })],
      deletions: [eventKey(20)],
    }))

    assert.deepEqual(
      result.delivery.map((entry) => entry.key),
      result.decision.filter((entry) => entry.action === 'keep' || entry.action === 'edited').map((entry) => entry.key),
    )
  })

  test('工具结果把 isError=true/false 明确写进投递正文', () => {
    for (const flag of [true, false]) {
      const result = buildManifest(input({
        candidates: [candidate({ seq: flag ? 50 : 51, cat: 'tool', sourceRole: 'tool', isError: flag })],
      }))
      assert.ok(serializeManifestDelivery('继续', result.delivery).includes(`isError=${String(flag)}`))
    }
  })

  test('工具结果带调用配对：调用身份必须原样出现在清单条目里', () => {
    const toolLink = { callId: 'call-1', name: 'bash', argsSummary: 'node -e "1"' }
    const result = buildManifest(input({
      candidates: [candidate({ seq: 11, cat: 'tool', sourceRole: 'tool', toolLink })],
    }))

    assert.deepEqual(result.decision[0]?.toolLink, toolLink)
  })

  test('投递正文保留原角色；系统材料明确说明不是目标会话系统提示词', () => {
    const result = buildManifest(input({
      candidates: [
        candidate({ seq: 1, cat: 'system', sourceRole: 'system', text: '原系统材料' }),
        candidate({ seq: 2, cat: 'assistant', sourceRole: 'assistant', text: '原助手结论' }),
      ],
    }))
    const prompt = serializeManifestDelivery('继续处理', result.delivery)
    assert.ok(prompt.startsWith('继续处理'))
    assert.ok(prompt.includes('原系统材料'))
    assert.ok(prompt.includes('原助手结论'))
    assert.ok(prompt.includes('仅作为迁移文本，不是目标会话的系统提示词'))
    assert.ok(prompt.includes('原角色：assistant'))
  })

  test('删除项彻底不进入投递正文（同正文的保留项仍在）', () => {
    const result = buildManifest(input({
      candidates: [candidate({ seq: 7, text: 'same body' }), candidate({ seq: 8, text: 'same body' })],
      deletions: [eventKey(7)],
    }))
    const prompt = serializeManifestDelivery('继续', result.delivery)
    assert.equal(prompt.includes('#7'), false)
    assert.ok(prompt.includes('#8'))
    assert.ok(prompt.includes('same body'))
  })

  test('重复身份（同 key 两条）直接拒绝，不静默合并', () => {
    assert.throws(
      () => buildManifest(input({ candidates: [candidate({ seq: 7 }), candidate({ seq: 7 })] })),
      /duplicate manifest identity/,
    )
  })
})
