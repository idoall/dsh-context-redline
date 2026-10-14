// Local-edit storage (`src/shared/redline-drafts.ts`) — the EDIT lane's core guardrail.
//
// What this file locks (docs/10 M2, the hard constraint of docs/11 D15):
//   · a save writes ONLY the plugin's own store — the session log is never touched;
//   · saving twice on one row OVERWRITES (one entry per row, no stacking) and the
//     latest version is the one that would be carried into a child session;
//   · "prefill / display / compare" all use the version in effect, which is why
//     editing again after a save shows your saved text (docs/11 D16);
//   · "no substantive change" (the demo's refusal) is measured against the version
//     in effect, so editing back to the original IS a change;
//   · a corrupt file is an explicit error, never a silently empty table (E13);
//   · the file name is namespaced and derived from a **stable hash** of the session id
//     (case-insensitive file systems must not collide two ids; long ids must not hit
//     the 255-byte file-name limit — Code Review P2).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  REDLINE_DRAFT_SCHEMA_VERSION,
  checkChange,
  deletedSeqsOf,
  dropEdit,
  draftFileName,
  draftRevisionOf,
  excludedSeqsOf,
  putExcluded,
  editOf,
  effectiveIsError,
  effectiveReasoning,
  effectiveText,
  emptyDrafts,
  hasEditBody,
  isDeleted,
  parseDrafts,
  putDeleted,
  putEdit,
  serializeDrafts,
  unmarkDeleted,
  type DraftTable,
  type LocalEdit,
} from '../../src/shared/redline-drafts'
import { REDLINE_DATA_DIR_NAME } from '../../src/shared/redline-paths'

/** A minimal surface row: the host fills `text` from the FULL event text. */
const row = (seq: number, text: string, extra: { reasoning?: string; isError?: boolean } = {}) => ({
  seq,
  text,
  ...(extra.reasoning === undefined ? {} : { reasoning: extra.reasoning }),
  ...(extra.isError === undefined ? {} : { isError: extra.isError }),
})

const edit = (seq: number, text: string, extra: Partial<LocalEdit> = {}): LocalEdit => ({
  seq,
  text,
  reasoning: '',
  isError: false,
  updatedAt: '2026-10-04T12:00:00.000Z',
  ...extra,
})

describe('draft file identity', () => {
  test('the file lives in OUR data directory and is named per session', () => {
    assert.equal(REDLINE_DATA_DIR_NAME, 'dsh-context-redline')
    const name = draftFileName('session-abc')
    assert.ok(name.startsWith('redline-drafts-session-abc-'), name)
    assert.ok(name.endsWith('.json'), name)
    // 同一 id 必须稳定（读与写要落到同一个文件）。
    assert.equal(draftFileName('session-abc'), name)
  })

  test('a session id cannot escape the data directory, and distinct ids stay distinct', () => {
    for (const nasty of ['../../etc/passwd', 'a/b/c', 'a\\b', 'x\0y', '.hidden', '..']) {
      const name = draftFileName(nasty)
      assert.ok(!name.includes('/'), nasty)
      assert.ok(!name.includes('\\'), nasty)
      assert.ok(!name.includes('\0'), nasty)
      assert.ok(name.startsWith('redline-drafts-'), nasty)
      assert.ok(name.endsWith('.json'), nasty)
    }
    // 不同 id 不许收敛到同一个文件 —— 包括**只差大小写**的两个（macOS 默认大小写不敏感）。
    assert.notEqual(draftFileName('a/b'), draftFileName('a-b'))
    assert.notEqual(draftFileName('Session-A'), draftFileName('session-a'))
  })
})

describe('write / read round-trip', () => {
  test('an empty store serializes and parses back to empty', () => {
    assert.deepEqual(emptyDrafts(), {})
    assert.deepEqual(parseDrafts(null), { ok: true, table: {} })
    assert.deepEqual(parseDrafts(''), { ok: true, table: {} })
    const raw = serializeDrafts('s1', emptyDrafts())
    assert.deepEqual(parseDrafts(raw), { ok: true, table: {} })
    assert.equal((JSON.parse(raw) as { schemaVersion: number }).schemaVersion, REDLINE_DRAFT_SCHEMA_VERSION)
  })

  test('every field survives the round-trip verbatim (no trimming, no folding)', () => {
    const text = '第一段\n\n第二段  带着   空格\n第三段'
    const table = putEdit(emptyDrafts(), edit(7, text, { reasoning: '想 法', isError: true, name: 'AGENTS.md', cat: 'inject' }))
    const parsed = parseDrafts(serializeDrafts('s1', table))
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.deepEqual(parsed.table, table)
    assert.equal(editOf(parsed.table, 7)?.text, text)
  })

  test('a corrupt file is an explicit error, never a silent empty table', () => {
    for (const bad of ['{', 'not json', '[1,2,3]', '{"schemaVersion":"x"}', '{"edits":[{"text":"no seq"}]}']) {
      const parsed = parseDrafts(bad)
      assert.equal(parsed.ok, false, bad)
      if (parsed.ok) continue
      assert.ok(parsed.code.startsWith('redline/'), parsed.code)
      assert.ok(parsed.message.length > 0)
    }
  })

  test('a table written by a future schema version is refused, not reinterpreted', () => {
    const raw = JSON.stringify({ schemaVersion: REDLINE_DRAFT_SCHEMA_VERSION + 1, sessionId: 's1', edits: [] })
    const parsed = parseDrafts(raw)
    assert.equal(parsed.ok, false)
  })
})

describe('draft revision for a reviewed child-confirmation', () => {
  test('is stable for one exact table and changes for every carried-field change', () => {
    const one = putEdit(emptyDrafts(), edit(7, '第一版'))
    const same = putEdit(emptyDrafts(), edit(7, '第一版'))
    const changedText = putEdit(emptyDrafts(), edit(7, '第二版'))
    const changedReasoning = putEdit(emptyDrafts(), edit(7, '第一版', { reasoning: '理由' }))
    assert.equal(draftRevisionOf('s1', one), draftRevisionOf('s1', same))
    assert.notEqual(draftRevisionOf('s1', one), draftRevisionOf('s1', changedText))
    assert.notEqual(draftRevisionOf('s1', one), draftRevisionOf('s1', changedReasoning))
    assert.notEqual(draftRevisionOf('s1', one), draftRevisionOf('s2', one), 'revision cannot cross session ids')
  })
})

describe('one row, one local edit', () => {
  test('saving twice overwrites the same row instead of stacking', () => {
    const first = putEdit(emptyDrafts(), edit(1301, '第一版'))
    const second = putEdit(first, edit(1301, '第二版：先跑全量测试'))
    assert.equal(Object.keys(second).length, 1, 'still exactly one entry')
    assert.equal(editOf(second, 1301)?.text, '第二版：先跑全量测试')
  })

  test('different rows are independent, and dropping one leaves the other', () => {
    let table = putEdit(emptyDrafts(), edit(1, 'a'))
    table = putEdit(table, edit(2, 'b'))
    assert.equal(Object.keys(table).length, 2)
    table = dropEdit(table, 1)
    assert.equal(editOf(table, 1), undefined)
    assert.equal(editOf(table, 2)?.text, 'b')
  })

  test('dropping something that is not there is a no-op, not an error', () => {
    const table = putEdit(emptyDrafts(), edit(1, 'a'))
    assert.deepEqual(dropEdit(table, 99), table)
    assert.deepEqual(dropEdit(emptyDrafts(), 99), {})
  })
})

describe('the version in effect (docs/11 D16: you can keep editing after saving)', () => {
  test('with no local edit the row shows the original, and "effective" is the original', () => {
    const r = row(5, '原文', { reasoning: '原想法' })
    assert.equal(effectiveText(r, emptyDrafts()), '原文')
    assert.equal(effectiveReasoning(r, emptyDrafts()), '原想法')
  })

  test('with a local edit the row shows YOUR saved version — never the original', () => {
    const r = row(5, '原文')
    const table = putEdit(emptyDrafts(), edit(5, '我改后的正文', { reasoning: '我改后的想法', isError: true }))
    assert.equal(effectiveText(r, table), '我改后的正文')
    assert.equal(effectiveReasoning(r, table), '我改后的想法')
    assert.equal(effectiveIsError(r, table), true)
  })

  // ⚠️ 2026-10-09 C2 按新合同更正：原用例构造 `text:'' + reasoning:'' + 无删除标记`，要求它
  // 被当成编辑。但 `docs/03` R4.8 把"编辑正文有/无 × 删除标记有/无"定为四态，全空且无标记
  // **不是任何一态**；而且保存路径的 `checkChange` 会以 `empty-content` 拒绝它 ⟹ 真实路径
  // 永远存不出这条记录。把意图拆成两条**可保存**的用例，并显式钉死全空形状的含义。
  test('清空某一个字段时那个字段保持为空（不许回退到原文）', () => {
    const keptText = row(5, '原文', { reasoning: '原想法', isError: true })
    const onlyReasoningCleared = putEdit(emptyDrafts(), edit(5, '我改后的正文', { reasoning: '', isError: false }))
    assert.equal(effectiveText(keptText, onlyReasoningCleared), '我改后的正文')
    assert.equal(effectiveReasoning(keptText, onlyReasoningCleared), '', '清空的思考文本不许回退')
    assert.equal(effectiveIsError(keptText, onlyReasoningCleared), false)

    const keptReasoning = row(5, '原文', { reasoning: '原想法' })
    const onlyTextCleared = putEdit(emptyDrafts(), edit(5, '', { reasoning: '我改后的想法' }))
    assert.equal(effectiveText(keptReasoning, onlyTextCleared), '', '清空的正文不许回退')
    assert.equal(effectiveReasoning(keptReasoning, onlyTextCleared), '我改后的想法')
  })

  test('正文与思考文本同时清空 ⟹ 保存被拒（empty-content），且该形状不是"编辑"', () => {
    // 保存路径拒了它，所以它不可能进草稿表；而全空形状在 R4.8 里只对应删除墓碑。
    assert.deepEqual(checkChange(row(5, '原文'), emptyDrafts(), { text: '', reasoning: '', isError: false }), {
      ok: false,
      code: 'redline/empty-content',
    })
    const allEmptyNoMark = putEdit(emptyDrafts(), edit(5, '', { reasoning: '', isError: false }))
    assert.equal(editOf(allEmptyNoMark, 5), undefined, '全空且无删除标记不是一条编辑')
  })
})

describe('the "no substantive change" rule (mirrors the demo)', () => {
  test('an edit identical to the version in effect is refused as no-change', () => {
    const r = row(5, '原文')
    assert.deepEqual(checkChange(r, emptyDrafts(), { text: '原文', reasoning: '', isError: false }), {
      ok: false,
      code: 'redline/no-change',
    })
  })

  test('editing BACK to the original after a save IS a change (compared against the version in effect)', () => {
    const r = row(5, '原文')
    const table = putEdit(emptyDrafts(), edit(5, '我先改成了这个'))
    assert.deepEqual(checkChange(r, table, { text: '原文', reasoning: '', isError: false }), { ok: true })
    // …and back again is refused, because now the saved version IS the original.
    const back = putEdit(table, edit(5, '原文'))
    assert.deepEqual(checkChange(r, back, { text: '原文', reasoning: '', isError: false }), {
      ok: false,
      code: 'redline/no-change',
    })
  })

  test('one changed character is enough', () => {
    const r = row(5, '把默认档位设成"注入的内容"')
    assert.deepEqual(checkChange(r, emptyDrafts(), { text: '把默认档位设成"注入的内容。"', reasoning: '', isError: false }), { ok: true })
  })

  test('emptying BOTH text and reasoning is refused with its own code', () => {
    const r = row(5, '原文', { reasoning: '原想法' })
    assert.deepEqual(checkChange(r, emptyDrafts(), { text: '', reasoning: '', isError: false }), {
      ok: false,
      code: 'redline/empty-content',
    })
    // Reasoning alone is still content.
    assert.deepEqual(checkChange(r, emptyDrafts(), { text: '', reasoning: '只剩想法', isError: false }), { ok: true })
  })

  test('for a tool result, flipping only isError is a change', () => {
    const r = row(5, '工具输出', { isError: false })
    assert.deepEqual(checkChange(r, emptyDrafts(), { text: '工具输出', reasoning: '', isError: true }), { ok: true })
  })

  test('the two refusal codes are distinct and stable', () => {
    const r = row(5, '原文')
    const noChange = checkChange(r, emptyDrafts(), { text: '原文', reasoning: '', isError: false })
    const empty = checkChange(r, emptyDrafts(), { text: '', reasoning: '', isError: false })
    assert.equal(noChange.ok, false)
    assert.equal(empty.ok, false)
    if (noChange.ok || empty.ok) return
    assert.notEqual(noChange.code, empty.code)
  })
})

// ── 删除状态与可逆性（`docs/03` R4.8 / `docs/13` §7；2026-10-09 C2）────────────
//
// 旧实现的真实缺陷（R4.8 开头写明）：`putExcluded()` 会把编辑正文清空，取消删除时直接删整条记录
// ⟹「原文 → 编辑为 B → 删除 → 取消删除」会丢掉 B。R4.8 因此把删除态与编辑正文**分开存**，
// 并点名 `deleted: boolean` 与 `text` 并存、互斥关系作废。
//
// 四条状态转换（R4.8 要求每条一条单测）：
//   原文 ──编辑──▶ 已编辑 ──删除──▶ 已删除编辑稿 ──取消删除──▶ 已编辑   ← 关键：回到 B
//   原文 ──删除──▶ 已删除原文 ──取消删除──▶ 原文
//   已删除编辑稿 ──丢弃这条改动──▶ 已删除原文
//
// 铁律不变：只写我们自己的草稿文件，当前会话一个字都不写（`docs/11` D15）。
describe('删除四态与可逆性（docs/03 R4.8：删除态与编辑正文分开存）', () => {
  const AT = '2026-10-09T00:00:00.000Z'
  const full = (seq: number, text: string): LocalEdit =>
    edit(seq, text, { reasoning: '修改后的想法', isError: true, cat: 'user', name: 'tool-x' })
  const at = (table: DraftTable, seq: number): LocalEdit => {
    const entry = table[String(seq)]
    assert.ok(entry !== undefined, `#${seq} 应该有记录`)
    return entry
  }

  test('原文：没有记录 ⟹ 不是编辑、也没有删除标记', () => {
    assert.equal(editOf(emptyDrafts(), 9), undefined)
    assert.equal(isDeleted(emptyDrafts(), 9), false)
  })

  test('原文 ──编辑──▶ 已编辑', () => {
    const table = putEdit(emptyDrafts(), full(9, '改后正文'))
    assert.equal(isDeleted(table, 9), false)
    assert.equal(hasEditBody(at(table, 9)), true)
    assert.equal(editOf(table, 9)?.text, '改后正文')
  })

  test('已编辑 ──删除──▶ 已删除编辑稿：正文与整条元数据全部保留', () => {
    const deleted = putDeleted(putEdit(emptyDrafts(), full(9, '改后正文')), 9, AT)
    const record = at(deleted, 9)
    assert.equal(isDeleted(deleted, 9), true, '删除标记生效')
    assert.equal(record.text, '改后正文', '删除不清空正文（R4.8 硬要求 2）')
    assert.equal(record.reasoning, '修改后的想法')
    assert.equal(record.isError, true)
    assert.equal(record.cat, 'user')
    assert.equal(record.name, 'tool-x')
    assert.equal(hasEditBody(record), true, '这是「已删除编辑稿」而不是「已删除原文」')
    assert.deepEqual(deletedSeqsOf(deleted), [9])
  })

  test('已删除编辑稿 ──取消删除──▶ 已编辑（回到 B，不是回到原文）', () => {
    const edited = putEdit(emptyDrafts(), full(9, '改后正文'))
    const cancelled = unmarkDeleted(putDeleted(edited, 9, AT), 9)
    assert.equal(isDeleted(cancelled, 9), false, '删除标记已取消')
    assert.equal(editOf(cancelled, 9)?.text, '改后正文', '编辑正文必须原样回来（旧实现就丢在这里）')
    assert.equal(editOf(cancelled, 9)?.reasoning, '修改后的想法', '恢复的是整条记录，不只是 text')
    assert.equal(editOf(cancelled, 9)?.isError, true)
    assert.equal(editOf(cancelled, 9)?.cat, 'user')
    assert.equal(editOf(cancelled, 9)?.name, 'tool-x')
  })

  test('原文 ──删除──▶ 已删除原文 ──取消删除──▶ 原文（整条记录消失）', () => {
    const deleted = putDeleted(emptyDrafts(), 9, AT)
    assert.equal(isDeleted(deleted, 9), true)
    assert.equal(hasEditBody(at(deleted, 9)), false, '没编辑过 ⟹ 没有正文')
    assert.equal(editOf(deleted, 9), undefined, '墓碑不是编辑（否则行会渲染成空白）')
    const cancelled = unmarkDeleted(deleted, 9)
    assert.equal(isDeleted(cancelled, 9), false)
    assert.deepEqual(cancelled, {}, '没有正文可留 ⟹ 回到原文（记录整体去掉）')
  })

  test('已删除编辑稿 ──丢弃这条改动──▶ 已删除原文（只清正文，保持删除态）', () => {
    const deleted = putDeleted(putEdit(emptyDrafts(), full(9, '改后正文')), 9, AT)
    const dropped = dropEdit(deleted, 9)
    assert.equal(isDeleted(dropped, 9), true, '丢弃改动不许顺手取消删除（R4.8）')
    assert.equal(hasEditBody(at(dropped, 9)), false)
    assert.equal(effectiveText(row(9, '原文'), dropped), '原文', '没有编辑稿时显示原文 + 删除线')
  })

  test('编辑不再解除删除标记（旧互斥关系已作废，R4.8 硬要求 3）', () => {
    const deleted = putDeleted(emptyDrafts(), 9, AT)
    const reEdited = putEdit(deleted, full(9, '又改了一次'))
    assert.equal(isDeleted(reEdited, 9), true, '编辑后仍是已删除编辑稿')
    assert.equal(editOf(reEdited, 9)?.text, '又改了一次')
  })

  test('删除线画在当前生效的正文上（有编辑稿时是编辑稿）', () => {
    const deleted = putDeleted(putEdit(emptyDrafts(), full(9, '改后正文')), 9, AT)
    assert.equal(effectiveText(row(9, '原文'), deleted), '改后正文')
    assert.equal(effectiveReasoning(row(9, '原文'), deleted), '修改后的想法')
    assert.equal(effectiveIsError(row(9, '原文'), deleted), true)
  })

  test('旧 excluded 数据：标记不许静默丢掉，且如实标记"删除前的编辑无法恢复"', () => {
    // 旧实现写盘的真实形状：清空正文后才写 excluded（所以正文永远拿不回来）。
    const legacy = JSON.stringify({
      schemaVersion: REDLINE_DRAFT_SCHEMA_VERSION,
      sessionId: 's1',
      edits: [{ seq: 5, text: '', reasoning: '', isError: false, updatedAt: '', excluded: true }],
    })
    const parsed = parseDrafts(legacy, 's1')
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    const record = at(parsed.table, 5)
    assert.equal(isDeleted(parsed.table, 5), true, '旧标记迁移后仍是删除态')
    assert.equal(record.deleted, true, '迁移到新的 deleted 字段')
    assert.equal(hasEditBody(record), false)
    assert.equal(record.legacyBodyLost, true, '必须能告诉人：这条旧标记无法恢复删除前的编辑')
  })

  test('新格式的「已删除原文」不许被误标成丢失正文', () => {
    const fresh = serializeDrafts('s1', putDeleted(emptyDrafts(), 5, AT))
    const parsed = parseDrafts(fresh, 's1')
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(isDeleted(parsed.table, 5), true)
    assert.equal(at(parsed.table, 5).legacyBodyLost, undefined, '新格式没丢过正文')
  })

  test('兼容镜像：putExcluded / excludedSeqsOf 委托到新语义（退役归 C3/C6）', () => {
    const edited = putEdit(emptyDrafts(), full(9, '改后正文'))
    const viaOldName = putExcluded(edited, 9, AT)
    assert.equal(isDeleted(viaOldName, 9), true)
    assert.equal(effectiveText(row(9, '原文'), viaOldName), '改后正文', '旧名字也不许再清空正文')
    assert.deepEqual(excludedSeqsOf(viaOldName), [9])
  })

  test('版本号：删除与取消删除都改变 revision，取消后回到编辑态那一版', () => {
    const base = putEdit(emptyDrafts(), edit(1, 'a'))
    const deleted = putDeleted(base, 1, AT)
    assert.notEqual(draftRevisionOf('s1', base), draftRevisionOf('s1', deleted), '删除必须改变版本号')
    assert.equal(
      draftRevisionOf('s1', unmarkDeleted(deleted, 1)),
      draftRevisionOf('s1', base),
      '取消删除回到编辑态那一版（供确认框比对）',
    )
  })

  test('坏文件里的 deleted / excluded 不是布尔 ⟹ 大声拒绝，不静默当没标', () => {
    const badDeleted = JSON.stringify({ schemaVersion: REDLINE_DRAFT_SCHEMA_VERSION, sessionId: 's1', edits: [{ seq: 1, text: '', reasoning: '', isError: false, updatedAt: '', deleted: 'yes' }] })
    assert.equal(parseDrafts(badDeleted, 's1').ok, false, 'deleted 必须是布尔')
    const badExcluded = JSON.stringify({ schemaVersion: REDLINE_DRAFT_SCHEMA_VERSION, sessionId: 's1', edits: [{ seq: 1, text: '', reasoning: '', isError: false, updatedAt: '', excluded: 'yes' }] })
    assert.equal(parseDrafts(badExcluded, 's1').ok, false, 'excluded 必须是布尔')
  })
})
