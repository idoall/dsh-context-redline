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
//   · the file name is namespaced and derived from a sanitized session id.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  REDLINE_DRAFT_SCHEMA_VERSION,
  checkChange,
  dropEdit,
  draftFileName,
  editOf,
  effectiveIsError,
  effectiveReasoning,
  effectiveText,
  emptyDrafts,
  parseDrafts,
  putEdit,
  safeSessionId,
  serializeDrafts,
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
    assert.equal(draftFileName('session-abc'), 'redline-drafts-session-abc.json')
  })

  test('a session id cannot escape the data directory', () => {
    for (const nasty of ['../../etc/passwd', 'a/b/c', 'a\\b', 'x\0y', '.hidden', '..']) {
      const safe = safeSessionId(nasty)
      assert.ok(!safe.includes('/'), nasty)
      assert.ok(!safe.includes('\\'), nasty)
      assert.ok(!safe.includes('\0'), nasty)
      assert.ok(!safe.startsWith('.'), nasty)
      assert.ok(!safe.includes('..'), nasty)
      assert.ok(draftFileName(nasty).startsWith('redline-drafts-'), nasty)
      assert.ok(draftFileName(nasty).endsWith('.json'), nasty)
    }
    // Two different ids must not collapse onto one file.
    assert.notEqual(safeSessionId('a/b'), safeSessionId('a-b'))
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

  test('a local edit that empties a field stays empty (it must not fall back to the original)', () => {
    const r = row(5, '原文', { reasoning: '原想法', isError: true })
    const table = putEdit(emptyDrafts(), edit(5, '', { reasoning: '', isError: false }))
    assert.equal(effectiveText(r, table), '')
    assert.equal(effectiveReasoning(r, table), '')
    assert.equal(effectiveIsError(r, table), false)
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
