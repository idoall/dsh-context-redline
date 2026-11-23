/**
 * The browser's DNA mode: decompose an assembled context into ONE band per
 * item (the system prompt, every tool schema, every surface message) and
 * lay them out in the order the model actually reads them — the context's
 * "fingerprint" strip behind the composition bar's `dna` toggle.
 *
 * The order is PROMPT order, which is also the order items joined the
 * context: the system prompt and tool schemas prefix every request, so they
 * lead the strip; the message flow follows in seq (chronological) order.
 * The system band rides the timeline's own `systems` nodes (the prompt's real
 * surface positions), the tool bands their header epoch. The header epoch's
 * own seq is NOT usable as an ordering key: dsh appends `request/header` at
 * dispatch time of the first request that uses a header (agent.ts —
 * 'initial'/'resume'/'change'/'series'), a bookkeeping snapshot that lands
 * AFTER every message already in context. A mid-session refresh would
 * otherwise park the tools bands in the middle of the strip, behind the very
 * tool results those schemas describe. A refreshed epoch REPLACES the prefix
 * in place — the strip reflects that by keeping the current epoch's bands at
 * the front (the band's tooltip carries the epoch's time).
 */

import type { Category, SurfaceNode } from '../shared/types'
import type { Assembled } from './assemble'
import { CAT_COLOR } from './categories'

/**
 * One band of the DNA strip. Header bands carry their tokens only; message
 * bands hand the node through so the label builder reads tool/form/skill
 * straight off it (the union discriminates on `cat` — no defensive guards).
 */
export type DnaItem =
  | { key: string; cat: 'system' | 'tools'; tokens: number; time?: number }
  | { key: string; cat: Category; tokens: number; time?: number; node: SurfaceNode }

export function dnaOf(view: Assembled): DnaItem[] {
  const items: DnaItem[] = []
  // One band for the prompt in force: every surviving system message is
  // concatenated into the request, so the band carries their SUM (the head's
  // time marks where the prompt started; section updates extend it).
  const systems = view.systems
  if (systems.length > 0) {
    let tokens = 0
    for (const node of systems) tokens += node.tokens
    items.push({ key: 'sys', cat: 'system', tokens, time: systems[0].time })
  }
  if (view.header !== null) {
    for (const tool of view.header.tools) {
      items.push({ key: 'tool:' + tool.name, cat: 'tools', tokens: tool.tokens })
    }
  }
  // `assemble` guarantees seq order; zero-token items keep their band (the
  // bar drops zero widths, the reading order stays truthful).
  for (const n of view.nodes) {
    items.push({
      key: 'n' + String(n.seq),
      cat: n.cat,
      tokens: n.tokens,
      node: n,
      ...(n.time !== undefined ? { time: n.time } : {}),
    })
  }
  return items
}

/**
 * One band of a TREND bar's DNA gradient (the trend card's DNA mode): the
 * same decomposition as {@link dnaOf}, plus the band's color and `off` — the
 * cumulative tokens of the bands BELOW it, since the stack grows from the
 * floor. The gradient builder and the bar tooltip read it.
 */
export type TrendBand =
  | { key: string; cat: 'system' | 'tools'; tokens: number; off: number; color: string }
  | { key: string; cat: Category; tokens: number; off: number; color: string; node: SurfaceNode }

/** The per-bar bands behind a trend chart bar: read order, category colors, cumulative offsets. */
export function trendBandsOf(view: Assembled): TrendBand[] {
  const bands: TrendBand[] = []
  let off = 0
  for (const item of dnaOf(view)) {
    if ('node' in item) {
      bands.push({ key: item.key, cat: item.cat, tokens: item.tokens, off, color: CAT_COLOR[item.cat], node: item.node })
    } else {
      bands.push({ key: item.key, cat: item.cat, tokens: item.tokens, off, color: CAT_COLOR[item.cat] })
    }
    off += item.tokens
  }
  return bands
}

/** The trend's display mode; DNA forces total semantics, so the two share this vocabulary. */
export type TrendMode = 'total' | 'delta'

/**
 * DNA is the step's composition, not a delta: turning it on parks the trend at
 * Total. Turning it off keeps whatever mode the card is already in.
 */
export function modeAfterDnaChange(next: boolean, current: TrendMode): TrendMode {
  return next ? 'total' : current
}
