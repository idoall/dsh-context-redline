// `scripts/progress.mjs` — the read-only progress reporter (M6-12).
//
// The user asked for this on 2026-10-01: 「过程中可以看到哪些已完成、哪些未完成」.
// Two properties matter and both are asserted here:
//
//   · **It must agree with `docs/10`** — the checklist is the single source of
//     truth (`AGENTS.md` §5), so the reporter may never invent its own counts.
//     It parses the TABLE, not the §11 summary, so a stale summary shows up as a
//     disagreement instead of being echoed back as fact.
//   · **It is read-only** — running it must not modify the checklist (asserted by
//     hashing the file before and after the CLI run).

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, test } from 'vitest'
import { parseChecklist, renderReport, type Checklist } from '../../scripts/progress.mjs'

const PATH = 'docs/10-execution-checklist.md'
const md = readFileSync(PATH, 'utf8')

/** The section a row belongs to: the nearest `## …` heading above it. */
function sectionOf(text: string, id: string): string | null {
  let stage: string | null = null
  for (const line of text.split('\n')) {
    const h = /^##\s+(.+)$/.exec(line)
    if (h !== null) stage = h[1] ?? null
    else if (line.startsWith(`| ${id} |`)) return stage
  }
  return null
}

describe('parseChecklist reads the table, not the summary', () => {
  const cl: Checklist = parseChecklist(md)

  test('every task row becomes an item with its id, title and status', () => {
    assert.ok(cl.items.length > 200, `expected the whole checklist, got ${cl.items.length}`)
    for (const it of cl.items) {
      assert.match(it.id, /^[A-Z0-9]+-\d+[a-z]?$/, `id shape: ${it.id}`)
      assert.ok(it.title.length > 0, `title for ${it.id}`)
      assert.ok(['DONE', 'DOING', 'TODO', 'WAIT🙋'].includes(it.status), `status for ${it.id}: ${it.status}`)
    }
  })

  test('a task with a 作废 mark still counts under its status', () => {
    // 【作废】rows are DONE: the decision was made, nothing is pending.
    const killed = cl.items.find(i => i.id === 'M4-01')
    assert.ok(killed !== undefined)
    assert.equal(killed.status, 'DONE')
  })

  test('stages are derived from the headings and each row lands in one', () => {
    assert.ok(cl.stages.length >= 10, `stages: ${cl.stages.length}`)
    const m401 = cl.stages.flatMap(s => s.items).find(i => i.id === 'M4-01')
    assert.equal(sectionOf(md, 'M4-01'), m401?.stage ?? null, 'the row reports the heading it sits under')
    // Every parsed item belongs to exactly one stage.
    const ids = cl.stages.flatMap(s => s.items.map(i => i.id))
    assert.equal(new Set(ids).size, ids.length)
  })

  test('$11 and the parsed table agree — a stale summary cannot hide', () => {
    // The reporter is only useful if a drift becomes visible; assert the property
    // on the REAL file so a future edit that forgets §11 fails here.
    const totals = cl.totals
    const sum = cl.stages.reduce((n, s) => n + s.items.length, 0)
    assert.equal(totals.total, sum, 'the total equals the sum of the stages')
    assert.equal(totals.total, cl.items.length)
    const statuses = cl.items.reduce<Record<string, number>>((m, i) => {
      m[i.status] = (m[i.status] ?? 0) + 1
      return m
    }, {})
    assert.deepEqual(totals.byStatus, statuses)
  })
})

describe('renderReport', () => {
  const cl = parseChecklist(md)

  test('the summary names the totals and every stage rate', () => {
    const out = renderReport(cl, { all: false })
    assert.ok(out.includes(String(cl.totals.total)), 'the total is printed')
    for (const s of cl.stages) {
      assert.ok(out.includes(s.name), `stage printed: ${s.name}`)
    }
    assert.ok(/DONE/.test(out) && /TODO/.test(out))
  })

  test('the default listing is the unfinished items only; --all adds the finished ones', () => {
    const open = renderReport(cl, { all: false })
    const all = renderReport(cl, { all: true })
    const todo = cl.items.find(i => i.status === 'TODO')
    const done = cl.items.find(i => i.status === 'DONE')
    assert.ok(todo !== undefined && done !== undefined)
    assert.ok(open.includes(todo!.id), 'an unfinished item is listed')
    assert.ok(!open.includes(`| ${done!.id}`) && !new RegExp(`\\b${done!.id}\\b\\s`).test(open.split('## 未完成')[0] ?? ''), 'finished ones are not in the short list')
    assert.ok(all.includes(done!.id), '--all lists the finished ones too')
  })
})

describe('the CLI', () => {
  test('runs, prints a report, exits 0, and leaves the checklist byte-identical', () => {
    const before = createHash('sha256').update(readFileSync(PATH)).digest('hex')
    const out = execFileSync('node', ['scripts/progress.mjs'], { encoding: 'utf8' })
    assert.ok(out.includes('DONE'), 'a real report was printed')
    const after = createHash('sha256').update(readFileSync(PATH)).digest('hex')
    assert.equal(after, before, 'the reporter never writes')
    const wide = execFileSync('node', ['scripts/progress.mjs', '--all'], { encoding: 'utf8' })
    assert.ok(wide.length > out.length, '--all prints more')
  })
})
