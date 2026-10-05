/**
 * `plan.next`：把"下一步该做什么"变成**机器判定**（`docs/06` §6）。
 *
 * 这一层**只回答"该做什么"，不做什么** —— 不写会话、不建会话、不压缩；执行永远由上层在用户点头之后发起。
 *
 * 次序（`docs/06` §6 的表，加上一处**规格更正**）：
 *
 *   1. `waitTurn`      轮次未闭合 —— 什么都做不了，先说清楚
 *   2. `applyDrafts`   有未提交草稿 —— 理由必须写明"种子取自会话日志，草稿不会带过去"
 *   3. ~~`pinInvariants`~~ —— **已删除**：固定块/不变量那一层整套删掉了（`docs/11` D14、
 *                      `docs/03` §「已删除的卡」），所以这里**不能**再有一个永远为假的步骤
 *   4. `startChild`    改完但还没开子会话（**可续接**，见 `docs/06` §3.1）
 *   5. `compactChild`  子会话存在、空闲、且历史很长
 *   6. `reviewChild`   有子会话刚 settle、其 `subagent-settled` 通知还没被处理
 *   —  `idle`          都不适用
 *
 * 每条判定都带 `reason`（给人看的一句话）与 `needsConfirm`（要不要走确认框）——**不允许让用户猜**。
 */

/** `plan.next` 能给出的判定。 */
export type PlanNextKind =
  | 'waitTurn'
  | 'applyDrafts'
  | 'startChild'
  | 'compactChild'
  | 'reviewChild'
  | 'idle'

/** 判定所需的事实（全部由调用方读好，本模块不读任何东西）。 */
export interface PlanInput {
  /** 轮次是否未闭合。 */
  turnOpen: boolean
  /** 还没提交到本地草稿里的改动条数（> 0 就有活要干）。 */
  draftCount: number
  /** **已经提交进会话的**改动条数 —— §6 第 4 条的前提是“改完”，没有它就无法区分
   *  “没改过”和“改完已提交”（前者不该提议开子会话）。 */
  appliedEdits: number
  /** 子会话现状；没有子会话时给 `null`。 */
  child: {
    /** 是否已存在一个可续接的子会话。 */
    exists: boolean
    /** 是否空闲（不在跑）。 */
    idle: boolean
    /** 历史是否已经长到值得压缩。 */
    historyLong: boolean
  } | null
  /** 未被"处理"的 `subagent-settled` 通知条数（键与处理记录见 `docs/06` §6）。 */
  pendingSettled: number
}

/** 一条判定。 */
export interface PlanDecision {
  kind: PlanNextKind
  /** 给界面显示的一句话（说人话，不出现内部词）。 */
  reason: string
  /** 要不要先过确认框（`docs/06` §4 的 A 编号清单）。 */
  needsConfirm: boolean
}

export function planNext(input: PlanInput): PlanDecision {
  if (input.turnOpen) {
    return { kind: 'waitTurn', reason: '这一轮还没结束 —— 改动只能在轮次边界提交。', needsConfirm: false }
  }
  if (input.draftCount > 0) {
    return {
      kind: 'applyDrafts',
      reason: `还有 ${input.draftCount} 条改动只存在本地。注意：开子会话时的种子取自会话日志，这些草稿不会自己跟过去 —— 要先提交，再开子会话。`,
      needsConfirm: true,
    }
  }
  const child = input.child
  if (child === null || !child.exists) {
    // 没有子会话：**改过**才提议开一个（§6 第 4 条的前提是"改完"）；什么都没改就是 idle。
    if (input.appliedEdits > 0) {
      return { kind: 'startChild', reason: '改完了，可以开子会话继续做 —— 首条任务由你来写。', needsConfirm: true }
    }
    return { kind: 'idle', reason: '眼下没有该做的一步。', needsConfirm: false }
  }
  if (child.idle && child.historyLong) {
    return { kind: 'compactChild', reason: '子会话空闲，但历史已经很长了 —— 压缩能让它接着跑得更久。', needsConfirm: true }
  }
  if (input.pendingSettled > 0) {
    return {
      kind: 'reviewChild',
      reason: `子会话回来了 ${input.pendingSettled} 条结果还没看 —— 去看结果，再决定是你自己接着做还是交给团队。`,
      needsConfirm: true,
    }
  }
  return { kind: 'idle', reason: '眼下没有该做的一步。', needsConfirm: false }
}
