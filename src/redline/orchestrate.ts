/**
 * 开子会话的**纯逻辑**：首条任务怎么组装、确认框要列什么、什么情况下拒绝。
 *
 * 这里**不读也不写任何东西**（不碰 ctx、不碰会话、不碰文件）—— 执行在宿主通道 `child.start` 里，
 * 而且**只在人点了确认之后**才发生（`docs/06` §4：本文件不设任何自动路径）。
 *
 * 两条硬约束在这份代码里的落点：
 * ① **所有保存都是临时保存** ⟹ 改动只存在我们本地的草稿文件里，而 fork 的种子取自**会话日志**（`docs/01` F45：种子里没有草稿）
 *    ⟹ **必须把改后的正文逐字写进首条任务**，否则子会话根本看不到你的改动（这不是优化，是必需）。
 * ② **不产生任何 AI 生成内容** ⟹ `humanTask` 是**人写的**，空就拒绝创建（M5-04）。
 */

/** 一条要带进子会话的本地改动（`text` 是**改后的全文**，逐字，不许截断）。 */
export interface CarriedEdit {
  /** 这条改动对应的行（会话日志里的 `#seq`）。 */
  seq: number
  /** 改后的**全文**。 */
  text: string
}

export interface FirstTaskInput {
  /** 人写的首条任务（必填）。 */
  humanTask: string
  /** 要逐字带进去的本地改动（可以为空：没改也能开，只是不带任何东西）。 */
  edits: readonly CarriedEdit[]
  /**
   * 被**删除**的行（`docs/03` R4.8 / `docs/13` §7）。
   *
   * ⚠️ 它**不参与首条任务的组装** —— 新会话是零历史，"不带"就等于"不在"，不需要任何声明。
   * 保留这个字段是因为调用方（宿主）在源清单里就用它来**排除**这些行，确认框也要按它说
   * "删了几条、不会带过去"。别再把它拼回 prompt 里（那正是 `EXCLUDED_HEADING` 被删掉的原因）。
   */
  excluded?: readonly number[]
}

/** 组装结果：要么给出成品的首条任务，要么给一个**说得清楚**的拒绝。 */
export type FirstTaskResult =
  | { ok: true; prompt: string }
  | { ok: false; code: 'empty-task'; message: string }

/** 逐字带入那几段改后正文时用的分隔标题（子会话一眼能看出哪些是"改好的上下文"）。 */
export const CARRIED_HEADING = '以下是我在「上下文批改」里改好的上下文，后面的工作请按这个版本来（逐字，未作任何删改）：'

/**
 * 组装子会话的首条任务：**人写的任务** + **逐字带入的改后正文**。
 *
 * ⚠️ 2026-10-09（`docs/03` R4.8 / `docs/13` §7）：**被删除的条目不进首条任务，也不需要任何声明**。
 * 旧实现有一段「另外，以下条目我已经作废 —— 请不要采用它们的内容（历史里仍带着原文…）」——
 * 那是**旧载体**（fork 会把父会话全部历史带过去）才需要的补丁。新的承载方式是**零历史的新会话**，
 * 不带的条目就是不在 ⟹ 声明段整段作废（`EXCLUDED_HEADING` 已删）。
 *
 * 顺序固定（人写的在前，改后的在后），且改后正文**原样**出现 —— 不改字、不摘要、不加解释。
 */
export function buildFirstTask(input: FirstTaskInput): FirstTaskResult {
  const human = input.humanTask.trim()
  if (human === '') {
    return {
      ok: false,
      code: 'empty-task',
      message: '子会话的第一句话必须由你自己写 —— 这是它在做的事，不能替你决定。',
    }
  }
  // 被删除的条目由调用方在**源清单**里就排除了（宿主按删除标记过滤）；这里再没有任何"声明"要做。
  if (input.edits.length === 0) return { ok: true, prompt: human }
  const blocks = input.edits.map(edit => `【#${edit.seq}】\n${edit.text}`).join('\n\n')
  return { ok: true, prompt: [human, CARRIED_HEADING, blocks].join('\n\n') }
}

/** 确认框里的一条：标题 + 逐字内容（界面直接照着显示，不用再加工）。 */
export interface ConfirmItem {
  label: string
  text: string
}

export interface ConfirmInput {
  /** 平台算的种子范围，一句人话（见 `docs/01` F38：起点恒为"最后聊完的那一轮"）。 */
  position: string
  humanTask: string
  edits: readonly CarriedEdit[]
  /** 被标为「不要」的 seq（确认框必须把它们也说出来）。 */
  excluded?: readonly number[]
}

/**
 * 开子会话前**必须**列出来的五项（`docs/06` §4.1 的"缺一项都算没实现"）。
 * 返回的文案里**不许**出现内部词（种子/provider/切点/继承范围…）—— 见 `AGENTS.md` §5 的文案规则。
 */
export function forkConfirmItems(input: ConfirmInput): ConfirmItem[] {
  const count = input.edits.length
  const excluded = input.excluded ?? []
  const carriedParts: string[] = []
  carriedParts.push(count === 0
    ? '这一次没有本地改动要带过去。'
    : `你改好的 ${count} 条正文会「逐字」出现在新会话的第一句话里：${input.edits.map(e => `#${e.seq}`).join('、')}。`)
  if (excluded.length > 0) {
    // ⚠️ 纯文本渲染：这里**不许**出现 markdown 星号（真机踩过，见本文件末尾的守卫用例）。
    carriedParts.push(`另有 ${excluded.length} 条已经被你删除（#${excluded.join('、#')}）：它们不会被带过去 —— 新会话是零历史，这些条目根本不在里面。`)
  }
  const carried = carriedParts.join('')
  return [
    { label: '从哪儿开始', text: `${input.position}。平台会把「最后聊完那一轮之前的全部日志」带过去 —— 比你想的更晚应用的改动也会一起进去。` },
    { label: '会带上的改动', text: carried },
    { label: '第一句话（你来写）', text: input.humanTask.trim() === '' ? '（还没写 —— 空着不能开）' : input.humanTask.trim() },
    { label: '会带什么 / 不带什么', text: '带：已经聊完的历史，加上上面那几条改动。不带：这边的工具授权与权限、这边之后的新轮次；新会话的工具输出与思考也不会自动回到这边 —— 它要用「发消息」主动回传。' },
    { label: '取消', text: '取消就是什么都不发生：不建会话、不写任何日志。' },
  ]
}
