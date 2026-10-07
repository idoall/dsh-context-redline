/**
 * The Context card: what the session's context IS and how it evolved — a
 * seven-cell grid of the session's shape (turns / steps / human inputs /
 * live tool calls), the whole-session cache-hit rate, and the cost estimate
 * at two scopes: the family total (the current agent plus every subagent
 * session) and the subagents' own share.
 * Count figures only: nothing here is part of a spendable whole, so no pie —
 * proportions live in the composition card, and the context-event tallies
 * live on the events card's kind filters (contextView.tsx). The cache-hit
 * cell reads the official `tokenUsage` projection — the same source and
 * formula as the harness chat stats line under the composer, shown with one
 * decimal — and dashes until a provider reports usage. The cost cells price
 * the host-folded cumulative billed totals (complete session logs, never
 * trimmed; the subagents' usage folds out of the session-list snapshot,
 * `makeSubagentCost` below) from the models.dev price book (modelPrices.ts)
 * in the locale's currency; their hover bubbles (a '?' marker + styled DOM
 * tip) explain each scope and list the per-1M-token rates of the models the
 * family actually billed, straight from the same book (cost.ts), so printed
 * rates can never drift from the math. A book that has not loaded (or
 * failed) dashes the cells and notes the outage.
 *
 * The counts arrive precomputed: the split-generation wire head carries them
 * (shared/types.ts `TimelineCounts` — computed over the retained records),
 * and the caller derives them from the collections on the inline generation
 * (`countsOfRecords`). The card itself never touches the collections.
 */

import type { ReactElement } from 'react'
import type { ContextEventRecord, RequestRecord, TimelineCounts } from '../../shared/types'
import { type StepStats } from '../assemble'
import type { ViewKit } from '../viewkit'


/**
 * The inline generation's counter derivation — the exact tally the card ran
 * over the served collections before the split (distinct turn values, record
 * count, per-kind event tallies). The host's split-generation counts match
 * it by construction (fold.ts buildTimelineHead).
 */
export function countsOfRecords(requests: readonly RequestRecord[], events: readonly ContextEventRecord[]): TimelineCounts {
  const turns = new Set<number>()
  for (const req of requests) turns.add(req.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  for (const ev of events) {
    if (ev.kind === 'inject') injects++
    else if (ev.kind === 'compaction') compactions++
    else if (ev.kind === 'prune') prunes++
  }
  return { turns: turns.size, steps: requests.length, injects, compactions, prunes }
}

/**
 * 上下文统计卡 —— **3 格，跟 demo**（`docs/10` M4-07：用户 2026-10-06 裁定）。
 *
 * 卡片上只有 demo 确认过的那三格 + 标题里的当前视图与 `本步可见 N 条 · ≈X tokens`：
 *   ① 模型可见条目（另 N 条被遮蔽）② 用户消息 ③ 注入内容。
 * 三个数字的口径由 `stepStatsOf()`（`src/client/assemble.ts`，纯函数 + 单测）从
 * **`assemble()` 已经算好的那一步列表**里直接数出来 —— 卡片不做任何二次判断。
 *
 * ⚠️ 与基线（上游 `dsh-context`）的**有意差异**：不再有 `轮次 / 步数 / 工具调用 / 缓存命中 / 费用 / 子 Agent 费用`
 * 六格读数。会话指认改由趋势卡标题 `按轮次（共 N 轮）` + 浏览器 meta `第 t 轮 · 第 s 步` 承担（`docs/10` M4-03）；
 * 费用与缓存属于"上下文洞察"那套能力，不是本产品（批改台）的目标。
 * 费用/价格模块（`cost.ts` / `modelPrices.ts` / 本文件的 `makeSubagentCost`）**保留未删**，只是本卡不再引用。
 */
export function makeStatsContext(
  kit: ViewKit,
): (props: {
  /** 该步的读数（`stepStatsOf` 的结果）。 */
  stats: StepStats
  /** 当前视图的轮次与步（live 时是最后一步）。 */
  turn?: number
  step?: number
  /** 正在看"当前（下一次请求）"而不是某条历史记录。 */
  live: boolean
  /**
   * 该步的列表数据到了没有（`timelineSource` 的 `detailState === 'ready'`）。
   * 没到就显示 `—`：三个数字都来自**该步的节点列表**，那是 detail 通道的产物，
   * 而 slim head 里只有 token 合计、没有条目数 —— 假装成 0 会等于在骗人。
   */
  ready: boolean
}) => ReactElement {
  const { t, fmt } = kit
  return function StatsContext(props: {
    stats: StepStats
    turn?: number
    step?: number
    live: boolean
    ready: boolean
  }): ReactElement {
    const cell = (label: string, value: string | number): ReactElement => (
      <div className="redline-stat">
        <span className="redline-stat-value">{value}</span>
        <span className="redline-stat-label">{label}</span>
      </div>
    )
    const { stats, ready } = props
    // 被遮蔽的条数只在真的有时才写出来（与 demo 的条件一致）。
    const shadowNote = ready && stats.shadowed > 0 ? t('stats.shadowedNote', { n: fmt(stats.shadowed) }) : ''
    const value = (n: number): string => (ready ? fmt(n) : '—')
    return (
      <div className="redline-card redline-col-stats flex-[3] min-w-[min(360px,100%)]">
        <div className="redline-card-title">
          <span className="redline-card-title-text">{t('stats.title')}</span>
          <span className="redline-stat-hint">
            {t('stats.viewHint', { t: props.turn ?? 0, s: props.step ?? 0 }) + (props.live ? t('stats.viewLive') : '')}
          </span>
          {ready
            ? <span className="redline-bmeta">{t('stats.bmeta', { n: fmt(stats.listed), k: fmt(stats.tokens) })}</span>
            : null}
          {ready && stats.missingTokens > 0
            // S1.1：缺 token 时不许把 `≈N` 说成完整数字（那一格显示不了 `—`，就把缺的条数说出来）。
            ? <span className="redline-stat-hint" data-redline-missing-tokens={String(stats.missingTokens)}>{t('stats.missing', { m: fmt(stats.missingTokens) })}</span>
            : null}
        </div>
        <div className="redline-stats grid grid-cols-[repeat(auto-fit,minmax(108px,1fr))] gap-1.5">
          {cell(t('stats.visibleItems') + shadowNote, value(stats.visible))}
          {cell(t('stats.userMsgs'), value(stats.user))}
          {cell(t('stats.injectItems'), value(stats.inject))}
        </div>
      </div>
    )
  }
}
