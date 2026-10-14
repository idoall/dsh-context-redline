// C1 · 迁移清单组装（`docs/13` §2/§5）。
//
// 本模块只做一件事：把「候选条目 + 本地草稿 + 用户决策集」按 `docs/13` 的**决策优先级**折叠成
// 两份数据（决策清单 / 投递内容）+ 一个稳定指纹。它是纯函数：不改文件、不读会话、不碰平台。
//
// 明确的边界（都在 `docs/13` 里标了"待定"或属别的卡）：
//   · `role`（迁移后的呈现角色）取值表仍 🟡 待定 ⟹ 本模块只透传调用方给的值，不自己决定；
//   · 分节标题与首条任务文案仍 🟡 待定 ⟹ 本模块不产出 prompt 文本（序列化属 C11）；
//   · 旧 `LocalEdit.excluded` 的迁移属 C2 ⟹ 删除集由调用方显式传入，本模块不读该字段；
//   · 来源身份的**捕获**属 C3 ⟹ 本模块只接收已捕获的候选与版本。

import type { RowClass } from '../shared/redline-ability'
import type { DraftTable } from '../shared/redline-drafts'

/** 一条候选在决策后的去留动作（`docs/13` §2 的 `action`）。 */
export type ManifestAction = 'keep' | 'edited' | 'deleted' | 'trimmed'

/**
 * 原始角色/来源（`docs/13` §2 的 `sourceRole`）。
 * 与面板的七类同词表；**由捕获层判定**，本模块不猜。
 */
export type SourceRole = RowClass

/** 事件型来源身份（`docs/13` §2 F09）。 */
export interface EventSourceKey {
  readonly kind: 'event'
  readonly sourceSessionId: string
  readonly seq: number
  readonly type: string
}

/**
 * 请求材料型来源身份：system / tools / 注入 / 技能。
 * ⚠️ 平台没有稳定 block id 时，用「已捕获请求身份 + 章节 + 块序号 + 内容指纹」定位**该快照内**的材料，
 * 不得跨快照声称同一身份（`docs/13` §2）。
 */
export interface RequestMaterialSourceKey {
  readonly kind: 'request-material'
  readonly sourceSessionId: string
  readonly requestIdentity: string
  readonly headerEpochIdentity: string
  readonly section: 'system' | 'tools' | 'injection' | 'skill'
  readonly blockIdentity: string
}

export type ManifestSourceKey = EventSourceKey | RequestMaterialSourceKey

/** 工具结果必须带上的调用配对，否则模型读到孤立文本不知道它是什么操作的结果。 */
export interface ManifestToolLink {
  readonly callId: string
  readonly name: string
  readonly argsSummary: string
}

/** 一条待决策的候选条目（已捕获、尚未决定去留）。 */
export interface ManifestCandidate {
  readonly sourceKey: ManifestSourceKey
  readonly cat: RowClass
  readonly sourceRole: SourceRole
  /** 稳定排序位：事件型用 seq；请求材料型用捕获顺序。 */
  readonly order: number
  /** 当前有效**全文**（不许是 80 字预览）。 */
  readonly text: string
  readonly reasoning?: string
  readonly isError?: boolean
  readonly toolLink?: ManifestToolLink
  /** 迁移后的呈现角色；取值表仍待定，本模块只透传。 */
  readonly role?: string
}

/** 一次裁剪决策：按身份命中 + 必须给出的理由。 */
export interface ManifestTrim {
  readonly key: string
  readonly reason: string
}

/** 组装输入。所有"版本"字段一起构成来源快照身份。 */
export interface ManifestInput {
  readonly sourceSessionId: string
  readonly surfaceAsOfSeq: number
  readonly surfaceFingerprint: string
  readonly candidates: readonly ManifestCandidate[]
  /** 本地草稿表（按 `String(seq)`），提供编辑后的全文与字段。 */
  readonly edits: DraftTable
  /** 用户删除集（身份 key）。删除优先级最高。 */
  readonly deletions?: readonly string[]
  /** 用户确认的裁剪集（身份 key + 理由）。 */
  readonly trimmed?: readonly ManifestTrim[]
  /** 用户明确保留 / 取消裁剪（身份 key）。 */
  readonly kept?: readonly string[]
}

/** 决策后的一条清单条目。 */
export interface ManifestEntry {
  readonly key: string
  readonly sourceKey: ManifestSourceKey
  readonly cat: RowClass
  readonly sourceRole: SourceRole
  readonly role?: string
  readonly order: number
  /** 当前有效全文（编辑优先）。 */
  readonly text: string
  /** 捕获时的原文，留档以便审计与恢复。 */
  readonly sourceText: string
  readonly reasoning?: string
  readonly isError?: boolean
  readonly toolLink?: ManifestToolLink
  readonly action: ManifestAction
  /** 仅 `trimmed` 时出现，且必须能显示给人看、可撤回。 */
  readonly reason?: string
}

/** 组装结果：两份数据同源产出，另附计数与稳定指纹。 */
export interface ManifestDecision {
  readonly sourceSessionId: string
  readonly surfaceAsOfSeq: number
  readonly surfaceFingerprint: string
  /** ① 决策清单：**所有**候选，含 deleted/trimmed（可审计、可申诉、可恢复）。 */
  readonly decision: readonly ManifestEntry[]
  /** ② 投递内容：只含 `keep` / `edited`。 */
  readonly delivery: readonly ManifestEntry[]
  readonly counts: {
    readonly total: number
    readonly carried: number
    readonly kept: number
    readonly edited: number
    readonly deleted: number
    readonly trimmed: number
  }
  /** 决策清单的稳定指纹：来源版本 + 每条身份/动作/理由/正文/字段。 */
  readonly manifestFingerprint: string
}

/** 一条来源身份的稳定 key（删除/裁剪/保留都用它匹配，不按正文）。 */
export function manifestKeyOf(sourceKey: ManifestSourceKey): string {
  if (sourceKey.kind === 'event') {
    return `event:${sourceKey.sourceSessionId}:${String(sourceKey.seq)}:${sourceKey.type}`
  }
  return [
    'request-material',
    sourceKey.sourceSessionId,
    sourceKey.requestIdentity,
    sourceKey.headerEpochIdentity,
    sourceKey.section,
    sourceKey.blockIdentity,
  ].join(':')
}

/** 指纹的字节宽度：8 条 32 位 lane = 256 位 = 64 个十六进制字符。 */
const FINGERPRINT_LANES = 8
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193
const LANE_SEED_MIX = 0x9e3779b9

/**
 * 确定性变更检测指纹（**不是**加密摘要）。
 *
 * 为什么不引 `node:crypto`：命名空间门禁「面 9 纯度」要求 `src/redline/**` 与
 * `src/shared/redline-*.ts` 不碰 `node:`/DOM/React —— 这条 lane 必须能在任何 JS 环境里跑。
 * 因此这里用 8 条独立的 32 位 FNV-1a lane（各带不同种子）拼出 256 位十六进制。
 *
 * 诚实边界：它只用于**同一份清单是否发生变化**（确认失效判定），不是安全边界；
 * 理论上存在碰撞，但需要有人刻意构造，而本产品没有任何攻击者可控的“猜指纹”入口。
 * 若将来某个 op 需要密码学保证，必须由**宿主层**（可 import node:crypto）注入摘要函数，
 * 不得放宽面 9。
 *
 * @param text - 规范化后的载荷文本。
 * @returns 64 个十六进制字符的稳定指纹。
 */
export function stableFingerprint(text: string): string {
  const lane = new Uint32Array(FINGERPRINT_LANES)
  for (let index = 0; index < FINGERPRINT_LANES; index += 1) {
    lane[index] = (FNV_OFFSET_BASIS ^ Math.imul(index + 1, LANE_SEED_MIX)) >>> 0
  }
  for (let position = 0; position < text.length; position += 1) {
    const code = text.charCodeAt(position)
    for (let index = 0; index < FINGERPRINT_LANES; index += 1) {
      const mixed = Math.imul((lane[index] ?? 0) ^ code, FNV_PRIME) >>> 0
      lane[index] = (mixed ^ (mixed >>> 13)) >>> 0
    }
  }
  let out = ''
  for (let index = 0; index < FINGERPRINT_LANES; index += 1) {
    out += (lane[index] ?? 0).toString(16).padStart(8, '0')
  }
  return out
}

/**
 * 组装迁移清单。
 *
 * @param input - 候选、草稿、删除/裁剪/保留决策与来源版本。
 * @returns 决策清单、投递内容、计数与指纹。
 */
function sourceLabel(entry: ManifestEntry): string {
  if (entry.sourceKey.kind === 'event') return `#${String(entry.sourceKey.seq)} · 原角色：${entry.sourceRole} · ${entry.sourceKey.type}`
  return `请求材料 · ${entry.sourceKey.section} · 原角色：${entry.sourceRole}`
}

/**
 * Serialize the exact delivery set into one user message for a zero-history carrier.
 * System/request material remains plainly labelled migration text; it never claims
 * to be the target session's actual system prompt or tool definition.
 */
export function serializeManifestDelivery(humanTask: string, delivery: readonly ManifestEntry[]): string {
  const task = humanTask.trim()
  if (task === '') throw new Error('human task is empty')
  if (delivery.length === 0) return task
  const blocks = delivery.map((entry) => {
    const warning = entry.sourceRole === 'system' || entry.cat === 'tools' || entry.cat === 'inject' || entry.cat === 'skill'
      ? '\n注意：此段仅作为迁移文本，不是目标会话的系统提示词或工具定义。'
      : ''
    const reasoning = entry.reasoning === undefined ? '' : `\n\n【原思考文本】\n${entry.reasoning}`
    const tool = entry.toolLink === undefined ? ''
      : `\n工具调用：${entry.toolLink.name} · ${entry.toolLink.callId}\n参数摘要：${entry.toolLink.argsSummary}`
    const errorFlag = entry.sourceRole === 'tool' && entry.isError !== undefined ? `\nisError=${String(entry.isError)}` : ''
    return `【${sourceLabel(entry)}】${warning}${tool}${errorFlag}\n${entry.text}${reasoning}`
  })
  return [
    task,
    '以下是经你确认后迁移到这个零历史新会话的上下文。每段都保留原来源；被删除和被裁剪的条目不在其中。',
    blocks.join('\n\n'),
  ].join('\n\n')
}

export function buildManifest(input: ManifestInput): ManifestDecision {
  const deletions = new Set(input.deletions ?? [])
  const kept = new Set(input.kept ?? [])
  const trims = new Map<string, string>()
  for (const trim of input.trimmed ?? []) trims.set(trim.key, trim.reason)

  const seen = new Set<string>()
  const entries: ManifestEntry[] = []
  for (const candidate of input.candidates) {
    const key = manifestKeyOf(candidate.sourceKey)
    if (seen.has(key)) throw new Error(`duplicate manifest identity: ${key}`)
    seen.add(key)

    // 编辑只可能命中事件型（草稿表按 seq 存）；请求材料型没有草稿。
    const edit = candidate.sourceKey.kind === 'event' ? input.edits[String(candidate.sourceKey.seq)] : undefined
    const reasoning = edit?.reasoning ?? candidate.reasoning
    const isError = edit?.isError ?? candidate.isError
    const trimReason = trims.get(key)

    // 决策优先级（`docs/13` §5）：用户删除 ＞ 用户明确保留/取消裁剪 ＞ 用户编辑 ＞ 自动裁剪建议。
    const action: ManifestAction =
      deletions.has(key) ? 'deleted'
        : kept.has(key) ? 'keep'
          : edit !== undefined ? 'edited'
            : trimReason !== undefined ? 'trimmed'
              : 'keep'

    entries.push({
      key,
      sourceKey: candidate.sourceKey,
      cat: candidate.cat,
      sourceRole: candidate.sourceRole,
      ...candidate.role === undefined ? {} : { role: candidate.role },
      order: candidate.order,
      // 编辑优先，但原文留档：被删除时编辑稿仍在决策清单里，取消删除即可原样恢复。
      text: edit?.text ?? candidate.text,
      sourceText: candidate.text,
      ...reasoning === undefined ? {} : { reasoning },
      ...isError === undefined ? {} : { isError },
      ...candidate.toolLink === undefined ? {} : { toolLink: candidate.toolLink },
      action,
      ...action === 'trimmed' && trimReason !== undefined ? { reason: trimReason } : {},
    })
  }

  entries.sort((left, right) => left.order - right.order || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  const decision: readonly ManifestEntry[] = entries
  const delivery = entries.filter(entry => entry.action === 'keep' || entry.action === 'edited')

  const counts = {
    total: decision.length,
    carried: delivery.length,
    kept: decision.filter(entry => entry.action === 'keep').length,
    edited: decision.filter(entry => entry.action === 'edited').length,
    deleted: decision.filter(entry => entry.action === 'deleted').length,
    trimmed: decision.filter(entry => entry.action === 'trimmed').length,
  }

  // 指纹覆盖来源版本与每条的身份/动作/理由/正文/字段：任一项变化都必须让确认失效。
  const payload = [
    input.sourceSessionId,
    String(input.surfaceAsOfSeq),
    input.surfaceFingerprint,
    decision.map(entry => [
      entry.key,
      entry.action,
      entry.reason ?? null,
      entry.text,
      entry.reasoning ?? null,
      entry.isError ?? null,
      entry.role ?? null,
    ]),
  ]
  const manifestFingerprint = stableFingerprint(JSON.stringify(payload))

  return {
    sourceSessionId: input.sourceSessionId,
    surfaceAsOfSeq: input.surfaceAsOfSeq,
    surfaceFingerprint: input.surfaceFingerprint,
    decision,
    delivery,
    counts,
    manifestFingerprint,
  }
}
