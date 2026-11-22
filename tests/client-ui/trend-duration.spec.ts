import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { describe, test } from 'vitest'
import { aggregateByTurn, makeTrendChart, type TrendChartProps } from '../../src/client/components/trendChart'
import { makeKit, mount, query, queryAll, text } from '../client/helpers/kit'

const kit = makeKit()
const TrendChart = makeTrendChart(kit)
const fmtDuration = kit.fmtDuration

type Req = TrendChartProps['requests'][number]
const req = (seq: number, activeMs?: number, turn = 1): Req => ({
  turn,
  step: seq,
  time: seq * 1_000,
  seq,
  system: 10,
  tools: 5,
  user: 5,
  inject: 0,
  assistant: 10,
  tool: 0,
  total: 30,
  ...(activeMs === undefined ? {} : { activeMs }),
})

function props(requests: Req[], over: Partial<TrendChartProps> = {}): TrendChartProps {
  return {
    requests,
    markers: new Array(requests.length).fill(undefined),
    selectedSeq: null,
    hoveredSeq: null,
    activeTurn: null,
    granularity: 'step',
    mode: 'total',
    focusTurn: null,
    hoverCat: null,
    adaptive: false,
    onSelect: () => {},
    onHover: () => {},
    onHoverTurn: () => {},
    onPickTurn: () => {},
    onFocusTurnHandled: () => {},
    ...over,
  }
}

describe('trend duration overlay (0.5.0)', () => {
  test('turn aggregation sums the step active times and keeps a no-figure turn absent', () => {
    const [turn] = aggregateByTurn([req(1, 1_000), req(2, 500), req(3)])
    assert.equal(turn.activeMs, 1_500)
    const [empty] = aggregateByTurn([req(1), req(2)])
    assert.equal(empty.activeMs, undefined)
  })

  test('durationCurve draws the curve and the right-hand axis', async () => {
    const m = await mount(h(TrendChart, props([req(1, 1_000), req(2, 2_000)], { durationCurve: true })))
    assert.equal(queryAll(m.container, '.redline-duration').length, 1)
    assert.equal(queryAll(m.container, '.redline-duration polyline').length, 1)
    const axis = query(m.container, '.redline-axis-r')
    assert.equal(text(axis).includes(fmtDuration(2_000)), true)
    assert.equal(text(axis).includes('0'), true)
    await m.unmount()
  })

  test('a missing activeMs breaks the line into isolated dots instead of faking a point', async () => {
    const m = await mount(h(TrendChart, props([req(1, 1_000), req(2), req(3, 2_000)], { durationCurve: true })))
    assert.equal(queryAll(m.container, '.redline-duration polyline').length, 0)
    assert.equal(queryAll(m.container, '.redline-duration circle').length, 2)
    await m.unmount()
  })

  test('turning the overlay off removes both the curve and its axis', async () => {
    const m = await mount(h(TrendChart, props([req(1, 1_000), req(2, 2_000)], { durationCurve: false })))
    assert.equal(queryAll(m.container, '.redline-duration').length, 0)
    assert.equal(queryAll(m.container, '.redline-axis-r').length, 0)
    await m.unmount()
  })
})
