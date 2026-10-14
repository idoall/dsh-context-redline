/**
 * The child-session half of the panel: the parent's **index of children**
 * (`subagentCatalog`) plus the two calls that open a new one (`child.plan` →
 * `child.start`).
 *
 * Three things this module deliberately does NOT do, all from `docs/03` R5.1.1:
 *
 * 1. **It does not draw a conversation.** The index lists identity + state and
 *    nothing else; the full view is the official UI's job (the runtime's own
 *    subagent package owns the tree picker in the parent header). R5.1.1 spells
 *    out why: copying a tree/dialog view would fight the official surface and
 *    drag a consistency problem we do not need.
 * 2. **It does not offer a jump.** The current demo only states the child's
 *    state ("open it = the panel switches to its context"); the actual jump is
 *    a later stage (`docs/10` M5-06 / M7-02).
 * 3. **It never guesses a state.** A child's "running / idle / not in this
 *    process" is read from the SAME `turnState` op the editor uses — one
 *    read-only call per child — so the row's sentence matches what pressing
 *    `编辑` there would actually do. Unknown stays unknown (`null`), and the
 *    row says so instead of claiming 空闲.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { planChild, readCapacity, readCarrierModels, readCarriers, readOrigins, readTurnState, startChild, type CarrierModelOption, type ChildPlan, type ChildStarted, type RedlineResult } from './redlineChannel'
import { viaOf, type OriginRecord, type OriginVia } from '../shared/redline-origins'
import { REDLINE_ERROR as ERR } from '../shared/redline-errors'
import { UNKNOWN_CAPACITY, capacityOf, type ChildCapacity } from '../shared/redline-capacity'

/** One row of the index. */
export interface ChildRow {
  readonly id: string
  /** The tail of the id, the way the official surface shows it. */
  readonly short: string
  readonly label: string
  /** `one-shot` / `continuable` / `unknown` — straight from the catalog entry. */
  readonly mode: 'one-shot' | 'continuable' | 'unknown'
  readonly createdAt: number
  /** `true` = this process hosts a live agent for it; `null` = not read yet. */
  readonly live: boolean | null
  /** `true` = its turn has not closed yet (writes are refused there too). */
  readonly open: boolean | null
  /** Carrier rows declare their source directly; legacy rows fill this from the old origin ledger. */
  readonly via?: OriginVia | 'ordinary-session' | null
}

interface CatalogEntryLike {
  readonly id?: unknown
  readonly label?: unknown
  readonly mode?: unknown
  readonly createdAt?: unknown
}

/**
 * Parse the `subagentCatalog` projection into rows.
 *
 * Pure and total on purpose: the projection is host data, so a malformed entry
 * must degrade to a row that says `unknown`, never throw inside render.
 *
 * @param raw - the projection value as it arrived (any shape).
 * @returns one row per usable entry, newest first (the fold appends).
 */
export function childRowsOf(raw: unknown): ChildRow[] {
  if (!Array.isArray(raw)) return []
  const rows: ChildRow[] = []
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as CatalogEntryLike
    const id = typeof entry.id === 'string' ? entry.id : null
    if (id === null) continue
    const mode = entry.mode === 'one-shot' || entry.mode === 'continuable' || entry.mode === 'unknown' ? entry.mode : 'unknown'
    rows.push({
      id,
      short: id.length > 8 && id.includes('-') ? id.slice(-8) : id,
      label: typeof entry.label === 'string' ? entry.label : '',
      mode,
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
      live: null,
      open: null,
    })
  }
  return rows.reverse()
}

/** 索引行 + "在这儿开的吗"（台账）。 */
export interface ChildIndexRow extends ChildRow {
  /** 在这儿开的：走的是官方成员还是裸子会话；`null`/缺省 = 台账里没有这条（不猜是谁开的）。 */
  readonly via?: OriginVia | 'ordinary-session' | null
}

export interface ChildController {
  /** The index rows; `live`/`open` fill in as the per-child probes answer. */
  readonly rows: readonly ChildRow[]
  /**
   * 这台机器允许几个团队成员（M5-13 标题里的分母）。**读不到就是"不知道"**
   * （`known:false`）⟹ 界面那时只写 `活跃 N`，不编一个分母。
   */
  readonly capacity: ChildCapacity
  /**
   * 我们那本来源台账**读得出来吗**（M5-12）。`false` = 读不出来 ⟹ 界面必须说"来源未知"，
   * **不许**说成"不是在这儿开的"（那是把一个我们没证据的结论说成事实）。
   */
  readonly originsKnown: boolean
  /**
   * 台账**为什么**读不出来（错误码）；\`null\` = 没有这件事。
   * 界面要把它说出来 —— 只说"来源未知"等于把原因吞掉（`docs/11` D54 的教训）。
   */
  readonly originsError: string | null
  /** Live selectable models; reading them never changes this or the source session. */
  readonly models: readonly CarrierModelOption[]
  /** Open the confirm box: the host builds exact default bytes/config for this task. */
  readonly plan: (humanTask: string) => Promise<RedlineResult<ChildPlan>>
  /** The only call in this whole panel that writes a session (`docs/11` D15). */
  readonly start: (
    humanTask: string,
    confirmationToken: string,
    finalText?: string,
    config?: { provider: string; model: string; reasoningEffort?: string },
  ) => Promise<RedlineResult<ChildStarted>>
}

/**
 * Probe one row's state through the same read-only op the editor's gate uses.
 *
 * @param sessionId - the child's own session id.
 * @returns `live`/`open`, or `null`s when the read failed (never a guess).
 */
export function carrierModelsOf(raw: unknown): CarrierModelOption[] {
  if (!Array.isArray(raw)) return []
  const models: CarrierModelOption[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const model = item as Record<string, unknown>
    if (typeof model.provider !== 'string' || model.provider === '' || typeof model.providerName !== 'string'
      || typeof model.model !== 'string' || model.model === '' || typeof model.modelName !== 'string'
      || !Array.isArray(model.efforts)) continue
    const efforts: { id: string; name: string }[] = []
    for (const rawEffort of model.efforts) {
      if (rawEffort === null || typeof rawEffort !== 'object' || Array.isArray(rawEffort)) continue
      const effort = rawEffort as Record<string, unknown>
      if (typeof effort.id === 'string' && effort.id !== '' && typeof effort.name === 'string') {
        efforts.push({ id: effort.id, name: effort.name })
      }
    }
    models.push({
      provider: model.provider,
      providerName: model.providerName,
      model: model.model,
      modelName: model.modelName,
      efforts,
      ...(typeof model.defaultEffort === 'string' ? { defaultEffort: model.defaultEffort } : {}),
    })
  }
  return models
}

async function probeChild(sessionId: string): Promise<{ live: boolean; open: boolean } | null> {
  const state = await readTurnState(sessionId)
  if (!state.ok) return null
  return { live: state.value.known, open: state.value.open }
}

/**
 * Wire the index + the two child calls for one session.
 *
 * @param sessionId - the session the panel is showing (the would-be parent).
 * @param catalog - the raw `subagentCatalog` projection value.
 */
export function useChildSessions(
  sessionId: string | undefined,
  catalog: unknown,
): ChildController {
  const legacy = useMemo(() => childRowsOf(catalog), [catalog])
  const [carriers, setCarriers] = useState<ChildIndexRow[]>([])
  const carrierGeneration = useRef(0)
  const refreshCarriers = useCallback(async (): Promise<void> => {
    carrierGeneration.current += 1
    const mine = carrierGeneration.current
    setCarriers([])
    if (sessionId === undefined || sessionId === '') return
    const answer = await readCarriers(sessionId)
    if (carrierGeneration.current !== mine || !answer.ok) return
    const payload: unknown = answer.value
    const rows = payload !== null && typeof payload === 'object' && Array.isArray((payload as { rows?: unknown }).rows)
      ? (payload as { rows: { id?: unknown; label?: unknown; mode?: unknown; createdAt?: unknown; via?: unknown }[] }).rows
      : []
    setCarriers(rows.flatMap((row) => {
      if (typeof row.id !== 'string' || row.id === '') return []
      return [{
        id: row.id,
        short: row.id.length > 8 ? row.id.slice(-8) : row.id,
        label: typeof row.label === 'string' ? row.label : '',
        mode: 'continuable' as const,
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
        via: 'ordinary-session' as const,
        live: null,
        open: null,
      }]
    }))
  }, [sessionId])
  useEffect(() => { void refreshCarriers() }, [refreshCarriers])
  const base = useMemo(() => {
    const carrierIds = new Set(carriers.map(row => row.id))
    return [...carriers, ...legacy.filter(row => !carrierIds.has(row.id))]
  }, [carriers, legacy])
  const [states, setStates] = useState<Record<string, { live: boolean; open: boolean }>>({})
  const generation = useRef(0)

  useEffect(() => {
    generation.current += 1
    const mine = generation.current
    setStates({})
    if (base.length === 0) return
    // A handful of read-only calls; a child that answers after the panel moved on
    // must not write into the new session's index (same guard as the draft hook).
    void (async () => {
      const entries = await Promise.all(base.map(async row => [row.id, await probeChild(row.id)] as const))
      if (generation.current !== mine) return
      const next: Record<string, { live: boolean; open: boolean }> = {}
      for (const [id, state] of entries) if (state !== null) next[id] = state
      setStates(next)
    })()
  }, [base])

  // 来源台账：跟着会话取一次；`known:false` 的初值意味着"在回答到达之前不冒充知道"。
  // 与上面的索引探测同一个惯用法：用"第几代"而不是 `let cancelled`（后者会被
  // `no-unnecessary-condition` 判成恒假 —— 规则看不见闭包里的赋值）。
  interface OriginsState { known: boolean; records: readonly OriginRecord[]; error: string | null }
  const EMPTY_ORIGINS: OriginsState = { known: false, records: [], error: null }
  const [origins, setOrigins] = useState<OriginsState>(EMPTY_ORIGINS)
  const originsGeneration = useRef(0)
  useEffect(() => {
    originsGeneration.current += 1
    const mine = originsGeneration.current
    setOrigins(EMPTY_ORIGINS)
    if (sessionId === undefined || sessionId === '') return
    void (async () => {
      const answer = await readOrigins(sessionId)
      if (originsGeneration.current !== mine) return
      // ⚠️ 用**宿主回答里的错误码**，别硬套 transport 那句 ——
      // 旧宿主没有这个 op 时答的是 \`redline/unknown-op\`，对应的人话是"刷新页面再试"，
      // 而 transport 那句是"保存没有送到宿主"，用在这里是**误导**。
      if (!answer.ok) { setOrigins({ known: false, records: [], error: answer.code === '' ? ERR.transport : answer.code }); return }
      setOrigins(answer.value.records === null
        ? { known: false, records: [], error: answer.value.error ?? ERR.originCorrupt }
        : { known: true, records: answer.value.records, error: null })
    })()
  }, [sessionId])

  const rows = useMemo(
    () => base.map(row => ({
      ...row,
      ...(states[row.id] ?? { live: null, open: null }),
      via: row.via === 'ordinary-session' ? row.via : viaOf(origins.records, row.id),
    })),
    [base, states, origins],
  )

  // 分母只问一次（与选哪个会话无关：它是这台机器的配置，不是某条日志的性质）。
  // 回答的形状不可信 ⟹ 先 `capacityOf()` re-prove 再进渲染（`docs/11` D54 的教训）。
  const [capacity, setCapacity] = useState<ChildCapacity>(UNKNOWN_CAPACITY)
  // 与上面那个索引探测同一个惯用法：用"第几代"而不是 `let alive`
  // （`let alive` 会被 `no-unnecessary-condition` 判成恒假 —— 那是规则对闭包赋值看不见，
  //  但**改成代次计数器既绕开它、又和本文件既有写法一致**）。
  const capGeneration = useRef(0)
  useEffect(() => {
    capGeneration.current += 1
    const mine = capGeneration.current
    void (async () => {
      const answer = await readCapacity()
      if (capGeneration.current !== mine || !answer.ok) return
      setCapacity(capacityOf(answer.value))
    })()
  }, [])

  const [models, setModels] = useState<readonly CarrierModelOption[]>([])
  useEffect(() => {
    void (async () => {
      const answer = await readCarrierModels()
      if (!answer.ok) return
      setModels(carrierModelsOf((answer.value as { models?: unknown }).models))
    })()
  }, [])

  const plan = useCallback(async (humanTask: string): Promise<RedlineResult<ChildPlan>> => {
    if (sessionId === undefined || sessionId === '') {
      return { ok: false, code: 'redline/not-live', message: 'no session' }
    }
    return await planChild(sessionId, humanTask)
  }, [sessionId])

  const start = useCallback(async (
    humanTask: string,
    confirmationToken: string,
    finalText?: string,
    config?: { provider: string; model: string; reasoningEffort?: string },
  ): Promise<RedlineResult<ChildStarted>> => {
    if (sessionId === undefined || sessionId === '') {
      return { ok: false, code: 'redline/not-live', message: 'no session' }
    }
    const answer = await startChild(sessionId, humanTask, confirmationToken, finalText, config)
    if (answer.ok) await refreshCarriers()
    return answer
  }, [refreshCarriers, sessionId])

  return useMemo(
    () => ({ rows, capacity, originsKnown: origins.known, originsError: origins.error, models, plan, start }),
    [rows, capacity, origins.known, origins.error, models, plan, start],
  )
}
