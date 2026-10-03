// Full-text reading (`src/redline/inspect.ts`) — the A4 / F35 guardrail
// (`docs/01` F35, `docs/00` S3/S3.1, `AGENTS.md` §2.3).
//
// The defect this locks out: the host's projection carries `firstText(blocks)` —
// `text.replace(/\s+/g,' ').trim().slice(0,80)` — i.e. an **80-character,
// whitespace-collapsed PREVIEW**. Using it as the editor's prefill destroyed a
// whole message in the earlier attempt. So:
//
//   · the editor's prefill/commit text comes from the durable event, never from a preview;
//   · a >200-character, 4-paragraph message round-trips VERBATIM (newlines included);
//   · multiple text blocks are joined by a documented rule, not silently merged.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { fullReasoningOf, fullTextOf, isErrorOf } from '../../src/redline/inspect'

/** The host's preview, reproduced here so the test can prove we are NOT equal to it. */
const hostPreview = (blocks: unknown): string => {
  if (!Array.isArray(blocks)) return ''
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const b = item as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
      return b.text.replace(/\s+/g, ' ').trim().slice(0, 80)
    }
  }
  return ''
}

const LONG = [
  '第一条：把「上下文」面板的默认档位设成“注入的内容”，并且在每一行上显示 #seq，方便我对照日志。',
  '第二条：我上次说的“不要动历史”指的是不要删除任何条目 —— 遮蔽是可以的，压缩要等我点头。',
  '第三条：跑测试的时候请把原始输出贴出来，不要只写“已通过”三个字，我需要能复核的证据。',
  '第四条：如果某一步你拿不准，就把两种做法的代价写清楚再来问我 —— 不要自己挑一个悄悄做掉，也不要'
  + '在文档里把它写成“已经做完”。我需要的是能复核的证据，不是一句“已通过”。',
].join('\n\n')
const TEXT = (text: string) => [{ type: 'text', text }]

describe('the prefill is the FULL text, never the 80-character preview', () => {
  test('a >200-character, 4-paragraph message comes back verbatim', () => {
    assert.ok(LONG.length > 200, `fixture must be long (is ${LONG.length})`)
    assert.ok(LONG.includes('\n\n'), 'fixture must be multi-paragraph')
    const event = { type: 'user/message', data: { content: TEXT(LONG) } }
    const text = fullTextOf(event)
    assert.equal(text, LONG, 'exact round-trip, newlines included')
    assert.equal(text.length, LONG.length)
    assert.equal(text.split('\n\n').length, 4, 'all four paragraphs survive')
  })

  test('and it is demonstrably NOT the host preview', () => {
    const event = { type: 'user/message', data: { content: TEXT(LONG) } }
    const preview = hostPreview((event.data as { content: unknown }).content)
    const text = fullTextOf(event)
    assert.equal(preview.length, 80, 'the preview really is 80 chars')
    assert.notEqual(text, preview)
    assert.ok(!text.includes('  '), 'the full text keeps its layout (no whitespace folding)')
    assert.ok(text.includes('\n'), 'the full text keeps its paragraph breaks')
  })

  test('whitespace inside one block is preserved exactly', () => {
    const raw = '前 面\n\n后面  有两个空格\t还有制表符\n结尾'
    assert.equal(fullTextOf({ type: 'user/message', data: { content: TEXT(raw) } }), raw)
  })
})

describe('block joining is a documented rule, not an accident', () => {
  test('several text blocks are joined with a blank line, each kept verbatim', () => {
    const event = { type: 'user/message', data: { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] } }
    assert.equal(fullTextOf(event), 'one\n\ntwo')
  })

  test('non-text blocks are skipped without losing the text around them', () => {
    const event = {
      type: 'user/message',
      data: { content: [{ type: 'image', source: {} }, { type: 'text', text: 'after the image' }] },
    }
    assert.equal(fullTextOf(event), 'after the image')
  })

  test('empty text blocks do not create stray blank lines', () => {
    const event = { type: 'user/message', data: { content: [{ type: 'text', text: '' }, { type: 'text', text: 'real' }, { type: 'text', text: '' }] } }
    assert.equal(fullTextOf(event), 'real')
  })
})

describe('one extraction per underlying event type', () => {
  test('user/message reads data.content', () => {
    assert.equal(fullTextOf({ type: 'user/message', data: { content: TEXT('u') } }), 'u')
  })

  test('assistant/message reads data.message.content', () => {
    assert.equal(fullTextOf({ type: 'assistant/message', data: { message: { content: TEXT('a') } } }), 'a')
  })

  test('tool/result reads data.message.content', () => {
    assert.equal(fullTextOf({ type: 'tool/result', data: { message: { content: TEXT('t') } } }), 't')
  })

  test('system/message reads data.content', () => {
    assert.equal(fullTextOf({ type: 'system/message', data: { content: TEXT('s') } }), 's')
  })

  test('reasoning blocks are separate from the visible text', () => {
    const event = {
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: '先想一下\n换行也算' },
            { type: 'text', text: '回答' },
          ],
        },
      },
    }
    assert.equal(fullTextOf(event), '回答')
    assert.equal(fullReasoningOf(event), '先想一下\n换行也算')
  })

  test('a malformed or unknown event yields an empty string, never a crash', () => {
    for (const bad of [
      null,
      undefined,
      {},
      { type: 'user/message' },
      { type: 'user/message', data: {} },
      { type: 'user/message', data: { content: 'not an array' } },
      { type: 'something/else', data: { content: TEXT('x') } },
      { type: 'user/message', data: { content: [null, 42, { type: 'text' }] } },
    ]) {
      assert.equal(fullTextOf(bad as never), '', JSON.stringify(bad) ?? 'undefined')
      assert.equal(fullReasoningOf(bad as never), '', JSON.stringify(bad) ?? 'undefined')
      assert.equal(isErrorOf(bad as never), false, JSON.stringify(bad) ?? 'undefined')
    }
  })
})

describe('tool-result error marks (three spellings the host uses)', () => {
  test('data.error, data.message.isError and a nested isError block all count', () => {
    assert.equal(isErrorOf({ type: 'tool/result', data: { error: 'boom' } }), true)
    assert.equal(isErrorOf({ type: 'tool/result', data: { message: { content: TEXT('x'), isError: true } } }), true)
    assert.equal(isErrorOf({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', isError: true }] } } }), true)
    assert.equal(isErrorOf({ type: 'tool/result', data: { message: { content: TEXT('x') } } }), false)
  })

  test('the error mark is not invented for other event types', () => {
    assert.equal(isErrorOf({ type: 'user/message', data: { error: 'nope', content: TEXT('x') } }), false)
  })
})
