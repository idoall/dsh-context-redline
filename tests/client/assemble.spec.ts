// Context assembly (src/client/assemble.ts): the header epoch lookup and
// the per-step surface reconstruction with its coverage flags.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { assemble, headerAt, systemsAt } from '../../src/client/assemble'
import type { ContextHeaders, ContextTimeline, HeaderRecord, SurfaceNode } from '../../src/shared/types'

function node(seq: number, over: Partial<SurfaceNode> = {}): SurfaceNode {
  return { seq, cat: 'user', tokens: 1, ...over }
}

function epoch(seq: number): HeaderRecord {
  return { seq, time: 0, tools: [] }
}

function headers(...seqs: number[]): ContextHeaders {
  return { headers: seqs.map(epoch) }
}

function timeline(over: Partial<ContextTimeline> = {}): ContextTimeline {
  return {
    ok: true,
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  }
}

describe('headerAt', () => {
  test('absent or empty headers yield null', () => {
    assert.equal(headerAt(null, 10), null)
    assert.equal(headerAt({ headers: [] }, 10), null)
  })

  test('a null seq picks the newest epoch', () => {
    const h = headers(10, 20)
    assert.equal(headerAt(h, null), h.headers[1])
  })

  test('a seq at or before every epoch yields null', () => {
    assert.equal(headerAt(headers(10, 20), 5), null)
    assert.equal(headerAt(headers(10, 20), 10), null)
  })

  test('the latest epoch before the seq is in force', () => {
    const h = headers(10, 20)
    assert.equal(headerAt(h, 15), h.headers[0])
    assert.equal(headerAt(h, 25), h.headers[1])
  })
})

describe('assemble live view', () => {
  test('a null seq returns all live nodes for the next request', () => {
    const data = timeline({ nodes: [node(1), node(5)] })
    const h = headers(10)
    const out = assemble(data, h, null)
    assert.equal(out.live, true)
    assert.deepEqual(out.nodes.map(n => n.seq), [1, 5])
    assert.notEqual(out.nodes, data.nodes)
    assert.equal(out.header, h.headers[0])
    assert.equal(out.missingLive, 0)
    assert.equal(out.approximate, false)
  })

  test('dropped live nodes are all part of the live context', () => {
    const data = timeline({ nodes: [node(5)], droppedNodes: 3, surfaceFloor: 4 })
    assert.equal(assemble(data, null, null).missingLive, 3)
  })
})

describe('assemble past step', () => {
  test('the surface is live nodes before the step plus still-alive archive nodes', () => {
    const data = timeline({
      nodes: [node(1), node(3), node(8)],
      archive: [
        node(2, { gone: 10 }),
        node(4, { gone: 5 }),
        node(6),
        node(9, { gone: 12 }),
      ],
    })
    const out = assemble(data, null, 7)
    assert.equal(out.live, false)
    assert.deepEqual(out.nodes.map(n => n.seq), [1, 2, 3])
  })

  test('the assembled nodes come back in seq order', () => {
    const data = timeline({ nodes: [node(3), node(1)], archive: [node(2, { gone: 10 })] })
    assert.deepEqual(assemble(data, null, 7).nodes.map(n => n.seq), [1, 2, 3])
  })

  test('the header in force at the step rides along', () => {
    const h = headers(2, 10)
    assert.equal(assemble(timeline(), h, 7).header, h.headers[0])
    assert.equal(assemble(timeline(), h, 1).header, null)
  })
})

describe('assemble missingLive for past steps', () => {
  test('a step after the surface floor contains every dropped live node', () => {
    const data = timeline({ droppedNodes: 2, surfaceFloor: 5 })
    assert.equal(assemble(data, null, 6).missingLive, 2)
  })

  test('a step at or below the surface floor flags nothing', () => {
    const data = timeline({ droppedNodes: 2, surfaceFloor: 5 })
    assert.equal(assemble(data, null, 5).missingLive, 0)
    assert.equal(assemble(data, null, 3).missingLive, 0)
  })

  test('without a surface floor a past step flags nothing', () => {
    const data = timeline({ droppedNodes: 2 })
    assert.equal(assemble(data, null, 6).missingLive, 0)
  })
})

describe('assemble approximate flag', () => {
  test('a step older than the archive floor is approximate', () => {
    const data = timeline({ archiveFloor: 10 })
    assert.equal(assemble(data, null, 6).approximate, true)
  })

  test('a step at or after the archive floor is exact', () => {
    const data = timeline({ archiveFloor: 10 })
    assert.equal(assemble(data, null, 10).approximate, false)
    assert.equal(assemble(data, null, 12).approximate, false)
  })

  test('without an archive floor no step is approximate', () => {
    assert.equal(assemble(timeline(), null, 6).approximate, false)
  })
})

describe('systemsAt — the system prompt in force', () => {
  const sys = (seq: number, tokens: number, time = seq * 100) => ({ seq, time, tokens })

  test('every surviving nonempty node is in force, in surface order', () => {
    const data = timeline({ systems: [sys(3, 10), sys(8, 0), sys(12, 20)] })
    assert.deepEqual(systemsAt(data, null, null), [sys(3, 10), sys(12, 20)], 'dormant nodes drop out')
  })

  test('a step resolves only the messages logged before it', () => {
    const data = timeline({ systems: [sys(3, 10), sys(12, 20)] })
    assert.deepEqual(systemsAt(data, null, 12), [sys(3, 10)])
    assert.deepEqual(systemsAt(data, null, 13), [sys(3, 10), sys(12, 20)])
    assert.deepEqual(systemsAt(data, null, 3), [], 'at the node itself the prompt is not yet in force')
  })

  test('a list holding only dormant nodes yields an empty prompt', () => {
    assert.deepEqual(systemsAt(timeline({ systems: [sys(3, 0)] }), null, null), [])
  })

  test('rows folded before `systems` existed fall back to the header epoch', () => {
    const epoch: HeaderRecord = { seq: 15, time: 1500, systemTokens: 42, tools: [] }
    assert.deepEqual(systemsAt(timeline(), epoch, null), [{ seq: 15, time: 1500, tokens: 42 }])
    assert.deepEqual(systemsAt(timeline({ systems: [] }), epoch, 20), [{ seq: 15, time: 1500, tokens: 42 }])
    assert.deepEqual(systemsAt(timeline(), { seq: 15, time: 1500, tools: [] }, null), [], 'an epoch without a price yields none')
    assert.deepEqual(systemsAt(timeline(), null, null), [])
  })

  test('assemble exposes the resolved prompt list', () => {
    const data = timeline({ systems: [sys(3, 10), sys(6, 5)] })
    assert.deepEqual(assemble(data, null, null).systems, [sys(3, 10), sys(6, 5)])
    assert.deepEqual(assemble(timeline(), null, null).systems, [])
  })
})
