/**
 * Per-step context assembly — the pure reconstruction behind the Context
 * browser card.
 *
 * A request record R was snapshotted by the Host exactly as dispatched:
 * header in force + the model-visible surface BEFORE the response landed.
 * Given the timeline's live `nodes` (newest tail) and `archive` (removed
 * nodes stamped with `gone`), the surface assembled into R is:
 *
 *   every node with seq < R.seq AND (gone undefined OR gone > R.seq)
 *
 * For the LIVE view (the next request's context) it is simply the current
 * live nodes. Coverage is honest: when the served window cannot contain the
 * full answer (older live nodes dropped, or removals older than the archive
 * retention), the result carries the flags the UI turns into notices.
 */

import type { ContextHeaders, ContextTimeline, HeaderRecord, SurfaceNode, SystemPromptNode } from '../shared/types'

export interface Assembled {
  /** True when browsing the live surface (the next request's context). */
  live: boolean
  /** The header epoch in force (null = headers projection absent or none yet). */
  header: HeaderRecord | null
  /**
   * The system prompt in force at the shown step (null = none), resolved from
   * the timeline's live `systems` nodes; on rows folded before that field
   * existed the header epoch's own envelope figure stands in.
   */
  system: SystemPromptNode | null
  /** The assembled surface messages, in seq order. */
  nodes: SurfaceNode[]
  /** Live nodes outside the served window that are also part of the context. */
  missingLive: number
  /** True when removals this step depends on may exceed archive retention. */
  approximate: boolean
}

/** The header epoch in force at `seq` (last logged before it), or the newest. */
export function headerAt(headers: ContextHeaders | null, seq: number | null): HeaderRecord | null {
  if (headers === null || headers.headers.length === 0) return null
  if (seq === null) return headers.headers[headers.headers.length - 1]
  for (let i = headers.headers.length - 1; i >= 0; i--) {
    if (headers.headers[i].seq < seq) return headers.headers[i]
  }
  return null
}

/**
 * The system prompt in force at `seq` (null = none) — the LAST live system
 * node at or before it carrying tokens, which is exactly the host fold's
 * "last nonempty surviving system" rule and therefore agrees with the
 * per-step `system` figure the fold recorded. Rows folded before `systems`
 * existed carry none; the header epoch's own figure stands in for them (the
 * legacy wire shape older plugin builds served — current epochs fold
 * metadata-only, so the fallback only ever fires on those cached rows).
 */
export function systemAt(
  data: ContextTimeline,
  header: HeaderRecord | null,
  seq: number | null,
): SystemPromptNode | null {
  const systems = data.systems
  if (systems !== undefined && systems.length > 0) {
    for (let i = systems.length - 1; i >= 0; i--) {
      const node = systems[i]
      if (node.tokens <= 0) continue
      if (seq === null || node.seq < seq) return node
    }
    return null
  }
  return header !== null && header.systemTokens !== undefined
    ? { seq: header.seq, time: header.time, tokens: header.systemTokens }
    : null
}

export function assemble(data: ContextTimeline, headers: ContextHeaders | null, seq: number | null): Assembled {
  const live = seq === null
  let nodes: SurfaceNode[]
  if (live) {
    nodes = data.nodes.slice()
  } else {
    const picked: SurfaceNode[] = []
    for (const n of data.nodes) {
      if (n.seq < seq) picked.push(n)
    }
    for (const n of data.archive) {
      if (n.seq < seq && n.gone !== undefined && n.gone > seq) picked.push(n)
    }
    nodes = picked
  }
  nodes.sort((a, b) => a.seq - b.seq)

  let missingLive = 0
  if (data.droppedNodes > 0) {
    // Live: every dropped live node is part of the current context. A past
    // step: the dropped slice sits at or below `surfaceFloor`, so a step
    // after it contains them all (an older step's unknown subset is left
    // unflagged rather than overstated).
    if (live || (data.surfaceFloor !== undefined && seq > data.surfaceFloor)) {
      missingLive = data.droppedNodes
    }
  }
  const approximate = !live
    && data.archiveFloor !== undefined
    && seq < data.archiveFloor

  const header = headerAt(headers, seq)
  return { live, header, system: systemAt(data, header, seq), nodes, missingLive, approximate }
}

/** 「当前这一步」的读数：统计卡那 3 格 + `本步可见 N 条 · ≈X tokens`（`docs/10` M4-07）。 */
export interface StepStats {
  /** 该步列表里的条目总数（demo 的 `本步可见 N 条`）。 */
  readonly listed: number
  /** 模型可见条目 = 列表里**没有** `gone` 的那些。 */
  readonly visible: number
  /** 列表里**已失效**的原文条数（demo 那句「另 N 条被遮蔽」）。 */
  readonly shadowed: number
  /** 可见条目里的用户消息条数。 */
  readonly user: number
  /** 可见条目里的注入内容条数。 */
  readonly inject: number
  /** 整张列表的估算 token 合计（`≈` 前缀由界面加）。 */
  readonly tokens: number
}

/**
 * The three cells the demo defines (user ruling 2026-10-06, `docs/10` M4-07).
 *
 * 口径**完全取自 `assemble()` 已经算好的那张列表**，不再自己定边界：
 * `assemble()` 对"某一步"返回的 `nodes` 里既有仍然有效的条目，也有**在那一步还活着、
 * 如今已被接替**的原文（判据 `n.gone !== undefined`，因为原文在那一步尚未被替换）。
 * 所以：
 *   · `visible`  = 列表里没有 `gone` 的；
 *   · `shadowed` = 列表里有 `gone` 的（界面把它渲染成"已被接替"那一行）；
 *   · 两个分类计数只数**可见**的（demo 同样从 `vis` 里筛）；
 *   · `tokens`  = 整张列表的合计（对得上 `本步可见 N 条 · ≈X tokens` 里那个 N）。
 * 按 seq 去重：早期那次把同一条替换体渲染两遍、面板列 5 项却报 7 项（2026-10-02 用户截图抓到的 #1600 重复计数）。
 */
export function stepStatsOf(assembly: { readonly nodes: readonly SurfaceNode[] }): StepStats {
  const seen = new Set<number>()
  let listed = 0
  let visible = 0
  let shadowed = 0
  let user = 0
  let inject = 0
  let tokens = 0
  for (const n of assembly.nodes) {
    if (seen.has(n.seq)) continue
    seen.add(n.seq)
    listed += 1
    tokens += typeof n.tokens === 'number' ? n.tokens : 0
    if (n.gone === undefined) {
      visible += 1
      if (n.cat === 'user') user += 1
      else if (n.cat === 'inject') inject += 1
    } else {
      shadowed += 1
    }
  }
  return { listed, visible, shadowed, user, inject, tokens }
}
