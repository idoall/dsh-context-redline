/* ============================================================================
 * 上下文批改台 · 交互原型（demo.js）
 * 目标：把 docs/03 的交互规格做成"可点击的规格书" —— 每个动作都能点开看它是做什么的。
 * ⚠️ 全部为演示数据与本地状态；不发任何请求、不碰真实会话。
 *
 * 趋势区（M05-16）参照参考插件 dsh-context 的 trendChart 设计：
 *   · granularity: 'turn' | 'step'（按轮次 / 按步骤）
 *   · mode: 'total' | 'delta'（总计 / 增量）
 *   · 固定柱宽 + 横向滚动（稀疏不拉伸、稠密就滚动）
 *   · adaptive：刻度按"当前可见范围"缩放（长日志里远处的尖峰不会把眼前的柱子压平）
 *   · ✂ 压缩/裁剪事件标记挂在它之后的第一个请求上
 * ==========================================================================*/

/* ------------------------------------------------------------------ 1. 讲解词典 */
const EXPLAIN = {
  'ui.explain': { t: '讲解模式', what: '打开后所有可交互元素会被编号高亮；点任一元素，右侧滑出"这个按钮是做什么的"。', effect: '只影响看到的内容，不改任何数据。', rev: '可随时关闭', confirm: '不需要', refs: ['docs/03 §0 阅读方式'] },
  'ui.theme': { t: '深色 / 浅色', what: '在深浅两套主题间切换（同一套 DSH 令牌名）。', effect: '只换配色。', rev: '可随时切回', confirm: '不需要', refs: ['docs/03 §6 V1/V2'] },
  'ui.selfcheck': { t: '自测面板', what: '显示当前状态组合、这一屏本该出现哪些按钮（对照行身份×状态矩阵）、关键盒子的尺寸与是否横向溢出。', effect: '只读。', rev: '可随时关闭', confirm: '不需要', refs: ['docs/03 R4.6', 'docs/05 §4'] },
  'ui.reset': { t: '重置原型', what: '把演示数据恢复到初始状态（草稿、版本、快照、子会话、趋势选项）。', effect: '只重置本地演示状态。', rev: '可再点一次回到初始', confirm: '不需要', refs: ['demo'] },
  'ui.switch': { t: '状态开关', what: '模拟宿主侧的真实状态（轮次是否闭合 / 会话是否在本进程 / 官方团队是否可用 / 草稿条数 / 压缩是否忙 / 回流是否确认）。', effect: '切换后界面的按钮可见性与文案立即按规范变化。', rev: '可随时切回', confirm: '不需要', refs: ['docs/03 R4.4 / R4.6 / R5.2 / R5.3'] },

  /* —— 趋势区的四个新开关（参照参考插件） —— */
  'trend.gran': { t: '按轮次 / 按步骤', what: '切换趋势图的粒度：按轮次 = 一轮一根柱（合并该轮各步，柱下标步数）；按步骤 = 一次请求一根柱。', effect: '只换画法；点柱子的含义随之变化——按轮次点柱子 = 选这一轮（右侧显示该轮末步），按步骤点柱子 = 选那一步。', rev: '随时切回', confirm: '不需要', refs: ['docs/03 R1.3', '参考插件 trendChart: granularity'] },
  'trend.mode': { t: '总计 / 增量', what: '一根柱代表"这次请求的上下文总量"还是"比上一次请求多了多少"。', effect: '增量模式下负值向下画（上下文变小，通常是压缩/裁剪之后）。', rev: '随时切回', confirm: '不需要', refs: ['docs/03 R1.4', '参考插件 trendChart: mode'] },
  'trend.adaptive': { t: '自适应刻度', what: '打开时，纵轴最大值按"当前可见的那几根柱"算；关闭时按整段历史算。', effect: '长会话里远处的尖峰不会把眼前的柱子压成一条线。', rev: '随时切回', confirm: '不需要', refs: ['docs/03 R1.5', '参考插件 trendChart: adaptive'] },
  'trend.cat': { t: '聚焦某一类', what: '点右侧分类树里的某一类，趋势图只画那一类的量（纵轴重新缩放）。', effect: '再点一次"全部"恢复。', rev: '随时切回', confirm: '不需要', refs: ['docs/03 R1.6', '参考插件 trendChart: focusCat'] },
  'trend.jump': { t: '回到当前', what: '把趋势条滚回最右端（最新一次请求）。', effect: '只滚动视图。', rev: '不需要', confirm: '不需要', refs: ['docs/03 R1.7'] },
  'trend.pick': { t: '点一根柱子', what: '按轮次模式：选中这一轮（右侧切到该轮**末步**）；按步骤模式：选中那一步。**整列都可点**（不只是色块那一截）：移上去有底色与虚线框预览，点中后是实线框 + 底色，同一轮的其它柱子也会带整轮底色。', effect: '右侧浏览器的分类树、条数、token 全部跟着变。', rev: '随时可改选', confirm: '不需要', refs: ['docs/03 R1.1 / R1.2'] },
  'trend.mark': { t: '✂ 压缩 / 剪枝标记', what: '表示这一刻上下文被压过：压缩（历史被摘要替换）或剪枝（工具输出被丢弃）。', effect: '每个事件只标在它之后的第一个请求上；按轮次时标在包含它的那一轮，一轮里有多个事件就显示 ✂×N。鼠标移上去看详情，点它可以跳到那一次。', rev: '只读', confirm: '不需要', refs: ['docs/03 R1.12', '参考插件 attachMarkers'] },
  'trend.strip': { t: '轮次刻度带（趋势图下面那排轮号）', what: '就是图下面那排 1…28 的号码格。**按轮次**模式：一格 = 一轮；**按步骤**模式：一格 = 一轮，格子的宽度 = 这一轮有几步。', effect: '点一格 = 选中那一轮的末步（选中的格子会描边，并弹一句提示）。⚠️ 手机上这排格子很窄（它是坐标轴，宽度跟着轮长走），要稳定选轮次请用上面的 `轮次` 下拉。讲解模式下**每类只标一个编号**（只标第一格），其余每格行为一样。', rev: '随时可改选', confirm: '不需要', refs: ['docs/03 R1.10'] },

  'turn.pick': { t: '选择某一轮', what: '点轮次条 = 让右侧浏览器切到该轮最后一步。', effect: '右侧标题变成"第 T 轮（共 N 步，显示末步）"，分类条数/token/占比跟着变。', rev: '随时可切别的轮', confirm: '不需要', refs: ['docs/03 R1.1'] },
  'turn.inject': { t: '改这一轮的注入内容', what: '切到这一轮**最后一条注入内容**（AGENTS.md / memory-doc / runtime-context 这类每轮由宿主重新注入的东西），就地展开编辑器。', effect: '注入内容才是最容易让模型理解错的那一半；而且它每轮会被重新注入 —— 改一轮漂一轮，所以改完通常还要「存为不变量」把口径钉住。', rev: '只切视图与展开编辑器，不改任何内容', confirm: '不需要', refs: ['docs/03 R1.16'] },
  'act.reinject': { t: '重注入固定块', what: '把这块正文**逐字**作为一条消息重新注入会话。', effect: '会往会话追加一条消息，不可撤销；插件不改一个字。用于"宿主这轮没注入 / 被改漂了"时把口径重新钉回去。', rev: '不可撤销（追加即落地）', confirm: '要（列出块版本与正文逐字）', refs: ['docs/03 R4.3', 'docs/00 G4'] },
  'act.retire': { t: '退休固定块', what: '让这块不再生效（历史版本保留）。', effect: '之后漂移检查不再盯它；冻结记录里"在效固定块版本"跟着变；已开出去的子会话不受影响。', rev: '可重新保存为新版本', confirm: '要', refs: ['docs/03 R4.3', 'docs/06 §1'] },
  'step.pick': { t: '步级选择', what: '选某一步（或回到"当前（下一次请求）"）。', effect: '右侧展示该步的上下文构成；与轮次入口交叉比对应当逐项一致。', rev: '随时可切', confirm: '不需要', refs: ['docs/03 R1.2'] },
  'step.chip': { t: '步级快捷片', what: '当前选中轮次的每一步一片，点一下就切到那一步。', effect: '等于用步级下拉选同一件事，但少两次点击。', rev: '随时可切', confirm: '不需要', refs: ['docs/03 R1.9'] },
  'step.nav': { t: '上一轮 / 下一轮 · 上一步 / 下一步', what: '在轮与步之间顺序移动（不用去点趋势图）。', effect: '到边界时按钮禁用。', rev: '随时可用', confirm: '不需要', refs: ['docs/03 R1.10'] },

  'cat.toggle': { t: '展开 / 收起分类', what: '展开某类（系统提示词 / 工具定义 / 用户消息 / 注入内容 / 技能注入 / 助手消息 / 工具结果）。', effect: '列出该类里的每一条（带 #seq、时间、token）。**点类名左侧的色块 = 聚焦到趋势图**。', rev: '再点一次收起', confirm: '不需要', refs: ['docs/03 §2'] },
  'row.toggle': { t: '展开这一条', what: '看这一条的正文。', effect: '就地展开全文（不跳页）。', rev: '再点一次收起', confirm: '不需要', refs: ['docs/03 R2.2'] },

  'ui.advanced': { t: '高级编辑', what: '打开后，**工具结果**这一类的「编辑」入口才会出现。', effect: '默认收起的两类：工具结果（一轮几十条、"要动手"的概率低）与助手消息（平台本来就不给「编辑」，只有「批注」）。常用三类始终可见：用户消息 / 注入内容 / 技能注入 —— 它们都是"我告诉模型什么"，而且后两类每轮会被宿主重新注入（会漂）。', rev: '随时关掉，只是收起入口，不改任何数据', confirm: '不需要', refs: ['docs/03 R2.1 / R2.5'] },
  'act.edit': { t: '编辑（遮蔽原文）', what: '改写这一条的内容。', effect: '先把改动存成本地草稿（模型还看不到）；确认后才"应用到会话"，届时原文被替换、模型再也看不到原文（但日志里仍在）。', rev: '草稿可放弃；已应用的改动可用"版本历史"恢复', confirm: '提交时要', refs: ['docs/03 R2.2 / R3.3', 'docs/01 F7'] },
  'act.annotate': { t: '批注（保留原文）', what: '不遮蔽原文，追加一条带「作废范围」的更正（一条普通 user 消息，不是伪造宿主内容）。', effect: '模型会同时看到原文与更正 —— 所以它是**请求式**的：靠措辞让模型照做，平台不保证。它会随快照（fork 种子）进子会话；不会被重新注入（不漂），但**长对话或压缩之后可能被摘要吞掉**。想要"确定生效"要用「编辑」+「应用到会话」。', rev: '不可撤销（追加即落地）', confirm: '提交时要（确认框里会写清它在快照里起什么作用）', refs: ['docs/03 R2.2 / R3.3.1', 'docs/01 F6'] },
  'act.pin': {
    t: '钉住这一段（存起来，给新会话用）',
    what: '**一句话**：把这一条的正文**逐字**存成"新规范"（只存插件本地）。**它不在本会话生效** ——\n'
      + '等你在这一刻**冻结**（新快照）、并开一个**新子会话**时，它才会**逐字带进那个新会话的第一句话**，\n'
      + '那个新会话的模型才读到它，并以此为准（与此冲突的此前理解作废）。\n'
      + '**为什么需要**：注入内容 / 技能注入这两类**每轮都由宿主重新塞给模型**（AGENTS.md、项目约定、技能目录…）。\n'
      + '你这一轮把它改对了，下一轮宿主又塞回原文 —— 于是"改一轮漂一轮"。钉住的这段就是**新的标准**：\n'
      + '之后每轮都能**逐字比对**，一旦"我钉的那句不在宿主注入里了"，「固定块（不变量）」卡会把状态标成**漂移**；\n'
      + '要当场再强调一次，就点 `重注入`（那是往会话追加一条逐字消息，那个会话的模型看得到）。\n'
      + '**你什么时候会用它**：这条注入是"模型必须一直遵守的口径"（例如"不许自动提交"、"必须先读 AGENTS.md"），\n'
      + '而你要**开一个新子会话去干活** —— 让它一开工就按新口径，而不是带着旧理解。\n'
      + '**它不做什么**：① 不改本会话（本会话的模型看不到它，会话日志里没有它）；\n'
      + '② 不会删掉宿主注入的旧文本（那要改装配层，本轮不做）；③ 不生成任何内容（只做逐字复制）。',
    effect: '**只在插件本地多一块基准**（逐字 + 标签 + 版本 + workspace 级）。本会话一字不动；'
      + '**下次冻结 + 开子会话**时，它被逐字附进那个新会话的第一句话。',
    rev: '可以退休 / 删除那块基准（已经开出去的子会话不受影响）',
    confirm: '要（确认框会列：正文逐字 + 只存本地 + 谁会读到它 / 什么时候读到）',
    refs: ['docs/03 R2.4', 'docs/11 D9'] },
  'act.apply': { t: '应用到会话', what: '把这条草稿真的写进会话。', effect: '追加一条替换事件；模型此后看到的是改后的内容；原文仍保留在日志里但不再可见。', rev: '不可撤销（可用版本历史恢复某一版）', confirm: '要，且会列出本次清单', refs: ['docs/03 R4.3', 'docs/01 F7.1'] },
  'act.history': { t: '版本历史', what: '看这一条的全部版本：原始 → 每次改写 → 每次回滚（**跨替换体**，按行身份串起来）。', effect: '只读展示；可选中某一版"恢复"。', rev: '只读', confirm: '不需要', refs: ['docs/03 R4.5', 'docs/00 S8'] },
  'act.restore': { t: '恢复这一版', what: '把"模型看到的内容"变回你选的那一版。', effect: '再追加一条替换事件——不是删除，错的那版仍在日志里但不再可见。', rev: '再次替换即可换别的版本', confirm: '要', refs: ['docs/03 R4.5', 'docs/00 S8'] },

  'orch.freeze': {
    t: '冻结当前位置（给"现在这一刻"拍个记号）',
    what: '**一句话**：给当前这个会话"现在这一刻"记一笔账，**只写在插件本地**。\n'
      + '**记下什么**：这一刻在哪儿（= 最后聊完的那一轮的末尾）、这一刻的条目数、时间、你写的那句备注，\n'
      + '以及**当时还在生效的固定块版本**。\n'
      + '**为什么需要**：之后你「开子会话」或「压缩」时，要能说清"我是从哪一刻分出去的、当时有哪些口径在生效"——\n'
      + '这条记录就是那句话的留档凭据。\n'
      + '**它不做什么**：不会改模型看到的内容，也不会让模型"记住"什么；它只是一条本地记录。\n'
      + '**什么时候会用**：准备开子会话之前（把口径和进度钉在时间线上）；或者你想给"改到这里为止"留个标记。',
    effect: '在「冻结记录」里**多加一行**（历史机制，不覆盖上一条；带时间、条目数、你写的备注）。会话内容与模型可见内容都不变。',
    rev: '可以删除这条记录',
    confirm: '要（短警示会说清"只写插件本地、不写会话"）',
    refs: ['docs/00 S5.2', 'docs/03 R5.1'] },
  'orch.spawn': {
    t: '从这里开子会话（把这件事交给一个新会话来干）',
    what: '**一句话**：把当前会话"已经聊完的部分"交给一个新会话，让它接着干一件具体的活；第一句话由你写。\n'
      + '**新会话从哪儿开始，由平台决定，不由你选**：它会带上"本会话最后聊完的那一轮"之前的全部内容。\n'
      + '（这不是我们偷懒：平台只提供"从最后聊完的那一轮接着往下"这一种开法，**没有**挑更早位置的开关。）\n'
      + '**冻结记录是留档凭据**：它记下"我在这一刻冻过什么"（当时的轮次末、当时的条数、当时在效的固定块版本）。\n'
      + '**只有"正好冻在最后聊完那一轮"的那条记录**才与平台的实际开头一致 ⟹ 只有它行上有 `从这里开子会话`；\n'
      + '**更早的记录点不了**，只留一个标记和一句替代建议（想按当时的口径干，就用那条记录里记下的固定块版本）。\n'
      + '**它就是你在别处看到的"主会话派活给子会话"**：子会话是独立会话（有自己的日志、自己的上下文）。\n'
      + '**它是多轮的**（这一条最容易误会）：可续接子会话**可以一直接收你的后续消息** —— 每发一条就是它的**一个新轮次**\n'
      + '（官方 `ctx.subagents.prompt({delivery:"queue"})` = 排成下一个轮次；`steer` = 插到最近的步骤边界）。\n'
      + '**双向互通**：子会话也能主动给父会话发消息（`ctx.subagents.sendMessage`）；父会话忙就在最近的步骤边界接收，\n'
      + '空闲就起一个轮次，**父会话不在进程里也会冷恢复**（`docs/01` F37）。子会话收工时另有一条运行时的"结算通知"（best-effort，\n'
      + '父不在进程就不投递 —— 界面会如实标"回流未确认"）。\n'
      + '**可以指定模型与推理档**：开子会话时可以给它单独的 `provider / model / reasoningEffort`（`agentOptions`），\n'
      + '也能给它一个短标签（`label`，例如"跑测试"）—— 在官方谱系目录/右栏里就带着这个标签显示。\n'
      + '**两条路**：团队可用时优先走官方 `spawnTeammate(context:"fork")`（于是它有官方名册/任务板/派活）；\n'
      + '团队不可用时退化成"裸可续接子会话"（没有任务板，界面会如实写出来）。\n'
      + '**只切一次（种子是一次性的）**：子会话只拿到"开它那一刻之前"的历史 —— 之后父会话的新轮次**不会**再进子会话；\n'
      + '所以**草稿必须先「应用到会话」**再开（草稿只在插件本地，不是会话内容，进不了种子）。\n'
      + '**子会话在界面上怎么找**：官方把子会话**排除在左侧会话列表之外**，入口在**父会话页头的谱系目录**和**右侧 Sidebar**；\n'
      + '打开它之后，本插件的面板会跟着切到它的上下文（于是它的上下文也能编辑，见 R5.1.3）。',
    effect: '新建一个真会话（独立 sessionId）。父会话**此刻不会**被写入任何内容；子会话跑完后才有结算通知回流。',
    rev: '子会话可以归档，但"开头切到哪儿"不能再重来（历史只取一次）',
    confirm: '要（确认框列五项：从哪儿开始 / 首条任务 / 它会带上什么 / 走哪条路 / 取消会怎样）',
    refs: ['docs/06 §3.1 / §4.1', 'docs/03 R5.1.3'] },
  'child.prompt': {
    t: '给子会话发消息（它会变成它的新轮次）※ 不依赖官方团队',
    what: '**一句话**：你在主会话里写一句话，直接发给这个子会话，成为它的**一个新轮次**。\n'
      + '**为什么能多轮**：可续接子会话（continuable）本来就是**可以一直接收后续消息**的 ——\n'
      + '官方 `ctx.subagents.prompt({delivery:"queue"})` 把**人写的**这条话排成它的下一个轮次；\n'
      + '`delivery:"steer"` 则是插到它**最近的步骤边界**（不打断当前这步）。\n'
      + '**它忙怎么办**：忙就排队（到步骤边界接收）；空闲就立刻起一个新轮次；\n'
      + '**它不在进程里**时官方会冷恢复（容量满则报 `subagent/delivery-unavailable`，界面会翻成人话）。\n'
      + '**反向也通**：子会话能用 `ctx.subagents.sendMessage` 主动给父会话发消息（父忙→最近步骤边界、父闲→起轮次、父不在进程→冷恢复）。\n'
      + '**你要说的话由你写**：插件不生成、不润色一个字的正文。',
    effect: '这条消息进入子会话的收件箱并排成它的下一个轮次。主会话内容不变（不是"把这条也塞进我自己的上下文"）。',
    rev: '不可撤销（消息一旦被收件箱接受就落地）',
    confirm: '要（确认框列：发给谁 / 走哪条通道 / 它现在的状态）',
    refs: ['docs/01 F37', 'docs/06 §2', 'docs/03 R5.1.4'] },
  'child.open': { t: '打开', what: '跳到官方视图看这个子会话/成员的完整过程。', effect: '优先在右侧 Sidebar 打开；本插件不重画对话。**打开之后面板会跟着切到它的上下文** —— 所以子会话的上下文同样能编辑（改条目/批注/存为不变量/冻结/压缩），不需要两套界面。两条前提：① 它**轮次闭合**（正在跑就只能看）；② 它**在本进程**（拿不到它的 live agent 时只剩只读）。', rev: '只读跳转', confirm: '不需要', refs: ['docs/03 R5.1.1 / R5.1.3'] },
  'child.send': { t: '派活（经官方）', what: '给这个成员追加一条任务消息。', effect: '走官方通道（agentTeams.sendMessage），返回 accepted 或 queued；queued 不许重发。', rev: '不可撤销', confirm: '要（收件人/逐字正文/投递方式/理由）', refs: ['docs/06 §3.2', 'docs/01 F32'] },
  'child.totask': { t: '建成官方任务', what: '把这条待办写成官方任务板上的一条任务。', effect: '写进官方任务板——我们显示的就是官方那份数据，不另存一份。', rev: '可在官方任务板更新/关闭', confirm: '要', refs: ['docs/03 R5.1', 'docs/01 F34'] },
  'child.compact': { t: '压缩（不可逆）', what: '把子会话的历史压成摘要。', effect: '先体检（是否空闲/是否有未闭合轮次/是否已在压）。成功后原文被摘要取代，不可逆；失败会给人话与"是否留痕"。', rev: '不可逆', confirm: '要（执行前列出将丢失的区间与条目数）', refs: ['docs/06 §4.2 / §5', 'docs/01 F11'] },
  'child.interrupt': { t: '打断', what: '停止这个子会话/成员当前的轮次。', effect: '成员走官方 interrupt；裸子会话走 interruptByParent。已提交的工作不会被回滚。', rev: '不可撤销', confirm: '要（当前状态/会发什么信号/已提交不回滚）', refs: ['docs/03 R4.3', 'docs/06 §4'] },
  'pending.view': { t: '待处理的结果', what: '子会话结束后，看"结果有没有回流"。', effect: '分三个状态：已收到平台结算通知 / 父会话下一轮已开始 / 回流未确认（父 Agent 当时不在进程 → 平台不投递）。', rev: '只读（"已查看"记在本地）', confirm: '不需要', refs: ['docs/03 R5.1 第 4 项', 'docs/01 F12.1'] },
  'team.read': { t: '官方团队区块（只读）', what: '直接显示官方那份 roster 与任务板。', effect: '不复制、不缓存、不自己算依赖就绪；投影报失败时按官方做法在最后有效数据之上显示失败。', rev: '只读', confirm: '不需要', refs: ['docs/01 F34', 'docs/03 R5.1'] }
};

/* ------------------------------------------------------------------ 2. 演示数据 */
const N = (seq, cat, type, text, tokens, x = {}) => ({ seq, cat, type, text, tokens, ...x });

const CATS = [
  { key: 'system', label: '系统提示词', color: 'var(--ds-color-indigo)' },
  { key: 'tools', label: '工具定义', color: 'var(--ds-color-amber)' },
  { key: 'user', label: '用户消息', color: 'var(--ds-color-green)' },
  { key: 'inject', label: '注入内容', color: 'var(--ds-color-purple)' },
  { key: 'skill', label: '技能注入', color: 'var(--ds-color-orange)' },
  { key: 'assistant', label: '助手消息', color: 'var(--ds-color-blue)' },
  { key: 'tool', label: '工具结果', color: 'var(--ds-color-teal)' }
];

const TOTAL_TURNS = 28;          // ← 演示"轮数很多"（原来只有 3 轮）
const RICH_TURN = TOTAL_TURNS;   // 最后一轮放全部边界态（遮蔽/替换体/助手/工具/压缩）

/** 常驻节点：seq 很小，所以出现在**每一次**请求里 */
const NODES = [
  N(1, 'system', 'system/message', '你是 DeepSeek Harness 的编码助手……（系统提示词很长，这里只给预览；正文走宿主全文）', 2300, { preview: true }),
  N(2, 'inject', 'user/message', '[runtime-context] 当前环境：cwd=/repo，git 分支 main，Node v24.15.0', 180, { name: 'runtime-context' }),
  N(3, 'inject', 'user/message', '[AGENTS.md] 本文件是唯一必读入口……（约 6KB，宿主每轮注入）', 1600, { name: 'AGENTS.md' })
];

/** 一条**长且分多段**的用户消息（>200 字）。用来演示 docs/03 R3.4 与人工门禁第 5 条：
 *  · 列表行里只能看到被截断的预览，而编辑器必须预填**宿主全文**；
 *  · 多段会被合并成一段 —— 这件事要在提交**之前**就写在编辑器里。
 *  它同时是 R1.4「改这一轮的用户消息」的目标（那一轮的最后一条用户消息）。 */
const LONG_USER_TEXT = '这轮先把「上下文批改台」的验收标准收紧一点，麻烦你按下面三条逐条来，别一次全做完。\n\n第一条：编辑一条超过两百字、而且分成好几段的用户消息时，编辑器里预填的必须是宿主全文，不能是列表上那种被截断的预览 —— 我上次就是被这个坑过一次，改完才发现只剩前面八十个字。\n\n第二条：多段消息会被合并成一段这件事，要在提交之前就看得见，别等我写完才告诉我。\n\n第三条：哪一条做不到就直接说做不到，别绕过去；这一条也算进验收，我会逐条对。';

/** 富态轮（最后一轮）的节点：故意做全边界态 */
const RICH = {
  user1: N(1240, 'user', 'user/message', '这条消息我后来发现写错了：我说的是"只改用户消息"，其实要把注入内容也一起管。请以后都按这个来。', 120),
  asst1: N(1241, 'assistant', 'assistant/message', '收到，我把两类都纳入判定范围。（助手消息在平台上无法改写，只能批注。）', 300),
  tool1: N(1243, 'tool', 'tool/result', 'npm test — 42 passed, 0 failed（工具结果，编辑只能改它的内容文本与错误标记）', 260),
  orig: N(1287, 'user', 'user/message', '（原始版本 #1287）请把「上下文」面板的默认档位设成"注入的内容"，我要一眼看到模型这轮收到了什么。', 96, { versions: [{ seq: 1287, kind: 'origin', time: '12:05', text: '（原始版本 #1287）请把「上下文」面板的默认档位设成"注入的内容"，我要一眼看到模型这轮收到了什么。', why: '' }] }),
  compacted: N(1290, 'user', 'user/message', '（来自被压缩掉的早期历史 #1290）这句在压缩时被摘要取代了 —— 改写够不到它，只能批注。', 40, { compacted: true }),
  asst2: N(1293, 'assistant', 'assistant/message', '（助手消息 #1293）平台两条规则互斥 → 助手消息无法改写，只能批注。', 210),
  toolErr: N(1295, 'tool', 'tool/result', 'ERROR: cannot read properties of undefined (reading "seq")', 150, { err: true }),
  inject2: N(1297, 'inject', 'user/message', '[memory-doc] 项目速览：这是本项目的一句话摘要……（注入类，可编辑，也能存为不变量）', 700, { name: 'memory-doc' }),
  skill: N(1299, 'skill', 'user/message', '[skill-catalog] 可用技能：agent-experience / browser-skill / cordis-plugin-development / editing-cordis-compositions …（底层是 user/message，可编辑）', 900, { name: 'skill-catalog' }),
  repl: N(1301, 'user', 'user/message', '（当前可见的替换体 #1301）请把「上下文」面板的默认档位设成"注入的内容"，并且给我逐条的 #seq。', 110),
  tail: N(1303, 'inject', 'user/message', '[compaction checkpoint] 早期历史已被压缩成摘要 —— 这一条够不到"改写"，只能批注。', 400, { name: 'compact-checkpoint', compacted: true }),
  longUser: N(1305, 'user', 'user/message', LONG_USER_TEXT, 620)
};
Object.values(RICH).forEach((n) => NODES.push(n));

const USER_TEXTS = [
  '帮我看看这个报错是怎么来的', '把这段逻辑抽成函数', '这个改动会影响别的地方吗',
  '跑一遍测试看看', '为什么这里要加锁', '这个接口的返回结构能再简化吗',
  '帮我补一下注释', '这个分支需要处理空值吗', '把配置项挪到独立文件', '再看一眼有没有遗漏的边界'
];

/** 早期轮次：按 turn 生成「步数 / 条数都不同」的请求，用来看 28 轮时的效果 */
function buildEarly() {
  const nodes = [], reqs = [];
  for (let turn = 1; turn < TOTAL_TURNS; turn++) {
    let s = 100 + (turn - 1) * 40;
    const steps = 1 + (turn % 4);                    // 1–4 步
    const nUser = 1 + (turn % 2);                    // 1–2 条用户消息
    const nTool = turn % 4;                          // 0–3 条工具结果
    const skill = turn % 3 === 0;
    const userSeqs = [];
    for (let i = 0; i < nUser; i++) {
      userSeqs.push(++s);
      nodes.push(N(s, 'user', 'user/message', `第 ${turn} 轮 · 用户消息 ${i + 1}：${USER_TEXTS[(turn + i) % USER_TEXTS.length]}`, 42 + ((turn * 7 + i * 13) % 90)));
    }
    const asst = ++s;
    nodes.push(N(asst, 'assistant', 'assistant/message', `第 ${turn} 轮的助手回复：先看代码再动手，附带必要说明。（第 ${turn} 轮）`, 180 + ((turn * 17) % 260)));
    const toolSeqs = [];
    for (let i = 0; i < nTool; i++) {
      toolSeqs.push(++s);
      nodes.push(N(s, 'tool', 'tool/result', `第 ${turn} 轮 · 工具结果 ${i + 1}：${'output line\n'.repeat(1 + ((turn + i) % 3))}`, 70 + ((turn * 11 + i * 29) % 180)));
    }
    let skillSeq = null;
    if (skill) { skillSeq = ++s; nodes.push(N(skillSeq, 'skill', 'user/message', '[skill-catalog] 可用技能：agent-experience / browser-skill / cordis-plugin-development …', 900, { name: 'skill-catalog' })); }
    for (let k = 1; k <= steps; k++) {
      const reqSeq = ++s;
      const surface = [1, 2, 3, ...userSeqs];
      if (k >= 1) surface.push(asst);
      for (let i = 0; i < Math.min(k - 1, toolSeqs.length); i++) surface.push(toolSeqs[i]);
      if (skillSeq) surface.push(skillSeq);
      reqs.push({ seq: reqSeq, turn, step: k, time: `${10 + Math.floor(turn / 6)}:${String((turn * 3 + k) % 60).padStart(2, '0')}`, surface, gone: {} });
    }
  }
  return { nodes, reqs };
}
const EARLY = buildEarly();
EARLY.nodes.forEach((n) => NODES.push(n));

const REQUESTS = [
  ...EARLY.reqs,
  // 富态轮（3 步）：第 2 步出现"原始 #1287"，第 3 步被 #1301 替换掉
  { seq: 1250, turn: RICH_TURN, step: 1, time: '12:05', surface: [1, 2, 3, 1240, 1241], gone: {} },
  { seq: 1289, turn: RICH_TURN, step: 2, time: '12:07', surface: [1, 2, 3, 1240, 1241, 1243, 1287], gone: {} },
  // 1305 = 那条长且多段的用户消息，放在最后 → 它就是这一轮「最后一条用户消息」（R1.4 的目标）
  { seq: 1310, turn: RICH_TURN, step: 3, time: '12:10', surface: [1, 2, 3, 1240, 1241, 1243, 1287, 1290, 1293, 1295, 1297, 1299, 1301, 1303, 1305], gone: { 1287: 1301 } }
];

/** ✂ 压缩 / 剪枝（prune）事件。语义照参考插件的 attachMarkers：
 *  **每个事件只标在「它之后的第一个请求」那一根柱子上**（一个事件 = 一根柱，绝不重复标）。 */
const EVENTS = [
  { seq: 1200, kind: 'compaction', label: '压缩上下文（摘要替换 12 条消息）' },
  { seq: 1296, kind: 'prune', label: '剪枝工具输出' }
];
const KIND_LABEL = { compaction: '压缩', prune: '剪枝' };
/** 该事件之后出现的第一个请求 */
function firstReqAtOrAfter(seq) {
  const r = REQUESTS.find((x) => x.seq >= seq);
  return r ? r.seq : null;
}
/** 这一根柱子（按步骤模式）上挂着的事件；正常 0 或 1 条 */
function markersOfReq(req) {
  return EVENTS.filter((ev) => firstReqAtOrAfter(ev.seq) === req.seq);
}
/** 这一根柱子（两种粒度通用）上挂着的事件：
 *  按轮次时该轮各步的标记会合并（因为一轮只有一根柱，不能把事件吞掉）。 */
function markersOfBar(item) {
  if (S.trendGran !== 'turn') return markersOfReq(item);
  const seen = new Set();
  return reqsOfTurn(item.turn).flatMap((r) => markersOfReq(r)).filter((ev) => (seen.has(ev.seq) ? false : seen.add(ev.seq)));
}
/** 兼容旧调用：取第一（通常也是唯一）个 */
function markerOf(req) { return markersOfReq(req)[0] || null; }

const initial = () => ({
  explain: false, selfcheck: false,
  sw: { turnOpen: false, live: true, team: true, drafts: 0, compressBusy: false, pendingState: 'settled', noUser: false, advanced: false },
  /* 趋势区选项（参照参考插件） */
  trendGran: 'turn', trendMode: 'total', trendAdaptive: true, trendCat: null,
  selTurn: RICH_TURN, selSeq: REQUESTS[REQUESTS.length - 1].seq,
  openCat: 'user', openElem: null,
  editor: null, editorError: null, editorOk: null, historyFor: null,
  drafts: {}, applied: [], extraNodes: [], invariants: [], snapshots: [], children: [], tasks: [], members: [], pendingSeen: false
});

let S = initial();

/* ------------------------------------------------------------------ 3. 工具函数 */
const $ = (id) => document.getElementById(id);
const ALL = () => NODES.concat(S.extraNodes);
const nodeOf = (seq) => ALL().find((n) => n.seq === seq);
const catLabel = (k) => (CATS.find((c) => c.key === k) || { label: k }).label;
const catColor = (k) => (CATS.find((c) => c.key === k) || { color: 'inherit' }).color;
const fmt = (n) => (Math.abs(n) >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reqOf = () => REQUESTS.find((r) => r.seq === S.selSeq) || REQUESTS[REQUESTS.length - 1];
/** 当前在效固定块版本（冻结记录身份的一部分）：id@版本，稳定排序后拼串。 */
const invariantsVersion = () => S.invariants.filter((b) => !b.retired).map((b) => `${b.id}@${b.version}`).sort().join('|') || 'none';
const turnSteps = (turn) => REQUESTS.filter((r) => r.turn === turn).length;
const reqsOfTurn = (turn) => REQUESTS.filter((r) => r.turn === turn);
const lastOfTurn = (turn) => reqsOfTurn(turn)[reqsOfTurn(turn).length - 1];
const isLive = () => S.selSeq === REQUESTS[REQUESTS.length - 1].seq;

/** 该请求里"模型可见"的节点（排除被遮蔽的原文；但替换体本身要算可见） */
const isReplacement = (seq) => S.applied.some((a) => a.newSeq === seq) || S.extraNodes.some((n) => n.seq === seq);
function goneMapOf(req) {
  const m = { ...(req.gone || {}) };
  S.applied.forEach((a) => { if (a.requestSeq === req.seq) m[a.replacedSeq] = a.newSeq; });
  return m;
}
function nodesOfReq(req, visibleOnly) {
  const gone = goneMapOf(req);
  return req.surface
    .concat(S.applied.filter((a) => a.requestSeq === req.seq).map((a) => a.newSeq))
    .concat(S.extraNodes.filter((n) => n.requestSeq === req.seq).map((n) => n.seq))
    .map(nodeOf).filter(Boolean)
    .filter((n) => !visibleOnly || gone[n.seq] === undefined || isReplacement(n.seq));
}
const goneMap = () => goneMapOf(reqOf());
const surfaceOf = () => nodesOfReq(reqOf(), false);
const visibleOf = () => nodesOfReq(reqOf(), true);
const metricOf = (req, cat) => nodesOfReq(req, true).filter((n) => !cat || n.cat === cat).reduce((s, n) => s + n.tokens, 0);
const draftOf = (seq) => S.drafts[seq];
const draftCount = () => Object.keys(S.drafts).length;

/** 兜住 WebKit 忽略 overscroll-behavior-x 的情况（参照参考插件 overscroll.ts）：
 *  横向滑到头时取消这次 wheel，否则会触发浏览器的"左滑返回/右滑前进"，整个页面被带出去。 */
function containHorizontalOverscroll(el) {
  if (!el) return;
  el.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const atStart = e.deltaX < 0 && el.scrollLeft <= 0;
    const atEnd = e.deltaX > 0 && el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    if (atStart || atEnd) e.preventDefault();
  }, { passive: false });
}

function toast(msg, kind) {
  const d = document.createElement('div');
  d.className = 'toast' + (kind === 'err' ? ' err' : '');
  d.textContent = msg;
  $('toastWrap').appendChild(d);
  setTimeout(() => d.remove(), 2600);
}
/** 打开讲解面板：**推**出右侧栏（body 加 drawer-open → 内容被挤窄、不被遮住） */
/** 讲解词里用 `**粗体**` 写强调（照参考插件的写法）。抽屉是 innerHTML，所以要转成 <b>，
 *  否则页面上会原样显示两个星号（实测踩过：说明栏与抽屉里都出现过字面的 `**`）。 */
const md = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
function openDrawer(key) {
  const e = EXPLAIN[key];
  if (!e) return;
  document.body.classList.add('drawer-open');   // 关键：推挤而不是覆盖
  const body = $('drawerBody');
  if (body) body.scrollTop = 0;
  $('drawerTitle').textContent = e.t;
  $('drawerBody').innerHTML = `
    <div class="kv"><b>它是做什么的</b><div>${md(e.what)}</div></div>
    <div class="kv"><b>会发生什么</b><div>${md(e.effect)}</div></div>
    <div class="kv"><b>能不能撤回</b><div>${md(e.rev)}</div></div>
    <div class="kv"><b>要不要确认</b><div>${md(e.confirm)}</div></div>
    <div class="kv"><b>对应规格</b><div>${(e.refs || []).map(esc).join(' · ')}</div></div>`;
  $('drawer').hidden = false;
}
/** 关掉讲解面板（同时收回被推挤的空间） */
function closeDrawer() {
  document.body.classList.remove('drawer-open');
  $('drawer').hidden = true;
}
function confirmModal(o) {
  $('modalTitle').textContent = o.title;
  $('modalWarn').textContent = o.warn;
  $('modalList').innerHTML = '<ul class="list">' + o.rows.map((r) => `<li><b>${esc(r[0])}</b>${esc(r[1])}</li>`).join('') + '</ul>';
  $('modalReasonWrap').hidden = !o.needReason;
  /* ⚠️ 用户 2026-10-02 问：「弹出窗里的备注，是仅给人看的，还是会进 agent 下一次会话的内容？」
   * 答：**两种都有，取决于哪个框** —— 所以**每个框必须自己写明去向**，不许所有框共用一句
   * 「理由（会写进记录）」（那种写法对"只写本地"与"会进模型上下文"是同一句话，等于没说）。
   * 四档去向（`docs/03` R3.3 的硬要求）：
   *   ① 只写插件本地（模型看不到）  ② 写进会话（模型看得到）
   *   ③ 成为子会话的第一句话 / 新轮次（子会话的模型看得到）  ④ 写进官方成员的收件箱（那位 agent 看得到） */
  const rl = $('modalReasonLabel');
  if (rl) rl.textContent = o.reasonLabel || '理由（去向见上面清单）';
  $('modalReason').placeholder = o.reasonPlaceholder || '一句话说明为什么这样改';
  $('modalReason').value = '';
  $('modalOk').textContent = o.okText || '确认';
  // 动态弹出的按钮在讲解模式下拿不到稳定编号 → 按用户建议给一个「?」（点它看说明）
  const okQ = $('modalOkHelp');
  if (okQ) { okQ.dataset.help = o.helpKey || 'act.apply'; }
  $('modalWrap').hidden = false;
  $('modalOk').onclick = () => {
    const reason = o.needReason ? $('modalReason').value.trim() : '';
    if (o.needReason && reason === '') { toast('这一栏不能空着', 'err'); return; }
    $('modalWrap').hidden = true;
    o.onOk(reason);
  };
}
/** 选中某个请求（按轮/按步共用入口） */
function selectReq(req, why) {
  S.selSeq = req.seq; S.selTurn = req.turn; S.openElem = null;
  render();
  if (why) toast(why);
}
/** 点了趋势图下面刻度带的一格（用户 2026-10-02：「（那排轮号）17 点了没有反应」）。
 *  修复前：按轮次模式下这里传 `why = null` ⟹ **不弹任何提示**，而刻度带又没有选中态
 *  ⟹ 点完看不出发生过什么（手机上尤其像坏了）。现在两条分支都给一句人话提示。 */
function trendCellAct(b) {
  if (b.dataset.seq) {                      // 按轮次模式：一格 = 一轮（data-seq = 该轮末步）
    const r = REQUESTS.find((x) => x.seq === Number(b.dataset.seq));
    if (r) selectReq(r, `已选第 ${r.turn} 轮（该轮末步）`);
    return;
  }
  const t = Number(b.dataset.turn);         // 按步骤模式：一格 = 一轮，宽度 = 步数
  selectReq(lastOfTurn(t), `已选第 ${t} 轮（该轮末步）`);
}

/* ------------------------------------------------------------------ 4. 状态开关 / 说明条 */
function renderSwitches() {
  const items = [['turnOpen', '轮次未结束'], ['live', '会话在本进程'], ['team', '官方团队可用'], ['compressBusy', '子会话正忙（压缩会 busy）'], ['noUser', '本轮没有用户消息'], ['advanced', '高级编辑']];
  $('switches').innerHTML =
    items.map(([k, label]) => `<button class="sw" data-sw="${k}" aria-pressed="${!!S.sw[k]}" data-explain="ui.switch"><i></i>${label}</button>`).join('') +
    `<button class="sw" data-act="drafts" aria-pressed="${draftCount() > 0}" data-explain="ui.switch"><i></i>草稿 ${draftCount()} 条</button>` +
    `<button class="sw" data-sw="pendingState" aria-pressed="${S.sw.pendingState === 'unconfirmed'}"><i></i>回流未确认</button>`;
  $('switches').querySelectorAll('[data-sw]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.sw;
      if (k === 'pendingState') S.sw.pendingState = S.sw.pendingState === 'settled' ? 'unconfirmed' : 'settled';
      else S.sw[k] = !S.sw[k];
      render();
    };
  });
  // 防御：querySelector 取不到就不要硬赋 onclick（冒烟测试抓到的脆弱点）
  const draftBtn = $('switches').querySelector('[data-act="drafts"]');
  if (draftBtn) draftBtn.onclick = (e) => {
    e.preventDefault();
    const live = REQUESTS[REQUESTS.length - 1];
    S.drafts[1301] = { seq: 1301, text: '（演示草稿）把默认档位设成"注入的内容"，并显示 #seq。', reasoning: '', updatedAt: '12:11', requestSeq: live.seq };
    selectReq(live, '已加 1 条演示草稿（看右侧行上的"未生效"与吸顶计数）');
  };
}
function renderNotice() {
  const msgs = [];
  if (S.sw.turnOpen) msgs.push('当前轮次还没结束 —— 改动只能在轮次边界提交。');
  if (!S.sw.live) msgs.push('这个会话不在本进程里，只能查看，不能编辑。');
  if (!S.sw.team) msgs.push('本机未启用官方智能体团队 —— 与团队相关的对接点已隐藏（不是报错）。');
  $('noticeBar').hidden = msgs.length === 0;
  $('noticeBar').innerHTML = msgs.map((m) => `<span>${esc(m)}</span>`).join('<span class="muted">·</span>');
}

/* ------------------------------------------------------------------ 5. 左列 */
function renderStats() {
  const vis = visibleOf(), all = surfaceOf();
  const r = reqOf();
  $('cardStats').innerHTML = `
    <div class="card-title">上下文统计 <span class="hint">（当前视图：第 ${r.turn} 轮 · 第 ${r.step} 步${isLive() ? ' · 当前' : ''}）</span>
      <span class="bmeta">本步可见 ${surfaceOf().length} 条 · ≈${fmt(surfaceOf().reduce((a, n) => a + n.tokens, 0))} tokens</span></div>
    <div class="stats">
      <div class="stat"><b>${vis.length}</b><span>模型可见条目${all.length > vis.length ? `（另 ${all.length - vis.length} 条被遮蔽）` : ''}</span></div>
      <div class="stat"><b>${vis.filter((n) => n.cat === 'user').length}</b><span>用户消息</span></div>
      <div class="stat"><b>${vis.filter((n) => n.cat === 'inject').length}</b><span>注入内容</span></div>
      <div class="stat"><b>${draftCount()}</b><span>未生效改动</span></div>
    </div>`;
}

/* ---------- 5.1 上下文趋势（按轮次 / 按步骤 · 总计 / 增量 · 自适应 · 聚焦 · ✂） ---------- */
const BAR_W = 14, BAR_GAP = 3, CHART_H = 112;

/**
 * 每根柱子**按类别拆开**（照参考插件 dsh-context 的 trendChart）：
 *   · 总计模式：`parts[cat]` = 该类这次的上下文量 → 柱体是 7 个类别的堆叠，颜色 = 类别；
 *   · 增量模式：`parts[cat]` = 该类与上一根柱子的差 → 正差向上、负差向下（方向表示正负，颜色仍是类别）。
 * 参考实现的原话："positive category deltas pile UP from the zero line, negative ones hang DOWN
 * from it, both in category colors (direction carries the sign, color the category)"。
 * 之前我们的实现是"整根一个品牌色、负值涂红"，既看不出构成，也让增量模式失去意义。
 */
function barParts(req, prevReq) {
  const out = {};
  for (const c of CATS) {
    const v = metricOf(req, c.key);
    out[c.key] = S.trendMode === 'delta' ? v - (prevReq ? metricOf(prevReq, c.key) : 0) : v;
  }
  if (S.trendCat) {                    // 聚焦某一类时：只保留那一类（其余置 0）
    for (const c of CATS) if (c.key !== S.trendCat) out[c.key] = 0;
  }
  return out;
}
function trendItems() {
  const list = S.trendGran === 'turn'
    ? (() => {                                   // aggregateByTurn：一轮 = 该轮**末步**的请求，带 stepCount
        const out = [];
        for (const r of REQUESTS) {
          const last = out[out.length - 1];
          if (last && last.turn === r.turn) out[out.length - 1] = { ...r, stepCount: (last.stepCount || 1) + 1 };
          else out.push({ ...r, stepCount: 1 });
        }
        return out;
      })()
    : REQUESTS;
  const parts = list.map((r, i) => barParts(r, i > 0 ? list[i - 1] : null));
  const series = parts.map((p) => CATS.reduce((sum, c) => sum + (p[c.key] || 0), 0));
  return { list, series, parts };
}
/** 可见范围（自适应刻度只按眼前这几根算）。 */
function visibleRange(n, scrollEl) {
  if (!S.trendAdaptive || !scrollEl) return [0, n - 1];
  const bw = BAR_W + BAR_GAP;
  const i0 = Math.max(0, Math.floor(scrollEl.scrollLeft / bw) - 1);
  const i1 = Math.min(n - 1, Math.ceil((scrollEl.scrollLeft + scrollEl.clientWidth) / bw) + 1);
  return [i0, i1];
}
/**
 * 刻度：返回整柱上限与零线上下限。
 * 增量模式下零线按 maxUp : maxDown **成比例**分割柱区（参考插件原文：
 * "The zero line splits the bar area PROPORTIONALLY to the larger side, so the px-per-token scale is
 * identical above and below it — a compaction's downward bar reads honestly against a growth bar."），
 * 于是"向下那截"和"向上那截"每一像素代表的量是一样的，不会骗人。
 */
function chartScale(parts, scrollEl) {
  const [i0, i1] = visibleRange(parts.length, scrollEl || null);
  let maxTotal = 1, maxUp = 1, maxDown = 1;
  for (let i = i0; i <= i1; i++) {
    const p = parts[i] || {};
    let up = 0, down = 0;
    for (const c of CATS) {
      const v = p[c.key] || 0;
      if (v >= 0) up += v; else down += -v;
    }
    maxTotal = Math.max(maxTotal, up + down);
    maxUp = Math.max(maxUp, up);
    maxDown = Math.max(maxDown, down);
  }
  const span = Math.max(1, maxUp + maxDown);
  const deltaScale = CHART_H / span;
  const upPx = Math.round(maxUp * deltaScale);
  return { maxTotal, maxUp, maxDown, deltaScale, upPx, downPx: CHART_H - upPx };
}
const visibleMax = (series, scrollEl) => (S.trendMode === 'delta'
  ? chartScale(window.__trendParts || [], scrollEl).maxUp
  : chartScale(window.__trendParts || [], scrollEl).maxTotal);
function applyTrendScale() {
  const sc = $('trendScroll');
  if (!sc) return;
  const parts = (window.__trendParts || []);
  const sc0 = chartScale(parts, sc);
  const delta = S.trendMode === 'delta';
  const prevMax = sc.dataset.max;              // 用于判断"刻度上限有没有变"（变了才刷自测面板）
  // 轴标签：增量模式下要显式给出零线上下的量（不再用"红色 = 负"这种讲不清的表达）
  const top = $('trendAxisTop'), mid = $('trendAxisMid'), bot = $('trendAxisBottom');
  if (top) top.textContent = fmt(delta ? sc0.maxUp : sc0.maxTotal);
  if (mid) mid.textContent = delta ? '' : fmt(sc0.maxTotal / 2);
  if (bot) bot.textContent = delta ? '-' + fmt(sc0.maxDown) : '0';
  const inline = $('trendAxisTopInline');
  if (inline) inline.textContent = fmt(delta ? sc0.maxUp : sc0.maxTotal);
  const zero = sc.querySelector ? sc.querySelector('.zeroline') : null;
  if (zero) zero.style.bottom = sc0.downPx + 'px';
  const totalScale = CHART_H / Math.max(1, sc0.maxTotal);
  const segH = (v, scale) => Math.max(1, Math.round(Math.abs(v) * scale)) + 'px';
  sc.querySelectorAll('.tbar').forEach((el, i) => {
    const p = parts[i] || {};
    if (delta) {
      // 增量：两臂分别锚在零线下方/上方，段高按同一 px/量 比例（参考插件 deltaScale 的语义）
      const up = el.querySelector ? el.querySelector('.arm-up') : null;
      const down = el.querySelector ? el.querySelector('.arm-down') : null;
      if (up) { up.style.bottom = sc0.downPx + 'px'; up.querySelectorAll('.cseg').forEach((sg) => { sg.style.height = segH(p[sg.dataset.cat], sc0.deltaScale); }); }
      if (down) { down.style.top = sc0.upPx + 'px'; down.querySelectorAll('.cseg').forEach((sg) => { sg.style.height = segH(p[sg.dataset.cat], sc0.deltaScale); }); }
    } else {
      el.querySelectorAll('.cseg').forEach((sg) => { sg.style.height = segH(p[sg.dataset.cat], totalScale); });
    }
  });
  sc.dataset.max = String(delta ? sc0.maxUp : sc0.maxTotal);
  /* 刻度上限也是自测面板上的一个读数。面板已经开着时，这里要把它刷新掉 ——
   * 否则面板会一直留着"这个节点刚被重建、还没算过刻度"的那一帧（实测显示 undefined）。 */
  if (prevMax !== sc.dataset.max && S.selfcheck) renderSelfcheck();
}
/* ---------- 趋势图的 hover 提示（照参考插件的 2 行式自绘 tooltip）----------
 * 文案照抄参考插件 i18n：
 *   按步骤：第 {t} 轮 · 第 {s} 步 (共 {n} 步) ／ 按轮次：第 {t} 轮 · 共 {n} 步
 *   第二行：合计 ≈ {n} ／ {类} ≈ {n}（聚焦时）／ Δ {n}（增量模式）
 * 关键：tip 挂在**滚动容器外面**，用 transform 夹在可视区内；pointer-events:none。 */
function trendTipRows(req, i, series) {
  const n = turnSteps(req.turn);
  const head = S.trendGran === 'turn'
    ? (n > 1 ? `第 ${req.turn} 轮 · 共 ${n} 步` : `第 ${req.turn} 轮 · 共 1 步`)
    : `第 ${req.turn} 轮 · 第 ${req.step} 步 (共 ${n} 步)`;
  const v = series[i] || 0;
  const metric = S.trendMode === 'delta'
    ? `Δ ${v > 0 ? '+' : ''}${fmt(v)}`
    : (S.trendCat ? `${catLabel(S.trendCat)} ≈ ${fmt(Math.abs(v))}` : `合计 ≈ ${fmt(Math.abs(v))}`);
  const rows = [head, metric];
  // 事件行：按步骤时该柱最多一条；按轮次时该轮可能含多条，逐条列出（用户就是靠这行知道 ✂ 是什么）
  for (const ev of markersOfBar(req)) rows.push(`✂ ${KIND_LABEL[ev.kind] || ev.kind}：${ev.label}`);
  return rows;
}
/** 把 tip 贴到该柱子的**可见切片**上（夹在滚动容器可视范围内，绝不越界） */
function syncTrendTip() {
  const sc = $('trendScroll'), tip = $('trendTip');
  if (!sc || !tip || tip.hidden) return;
  const lw = tip.offsetWidth || 120, cw = sc.clientWidth || 300;
  const half = Math.min(lw / 2, cw / 2);
  const col = (Number(tip.dataset.col) || 0) + (BAR_W / 2);
  const cx = Math.min(Math.max(col - sc.scrollLeft, half), cw - half);
  tip.style.transform = `translate(${Math.round(cx - lw / 2)}px, 0)`;
}
function showTrendTip(i, req, series) {
  const tip = $('trendTip');
  if (!tip) return;
  const rows = trendTipRows(req, i, series);
  tip.innerHTML = rows.map((r, k) => `<span class="${k === 2 ? 'tipmark' : ''}">${esc(r)}</span>`).join('');
  tip.dataset.col = String(i * (BAR_W + BAR_GAP));
  tip.hidden = false;
  syncTrendTip();
}
function hideTrendTip() { const tip = $('trendTip'); if (tip) tip.hidden = true; }

function renderTrend() {
  const { list, series, parts } = trendItems();
  window.__trendSeries = series;
  window.__trendParts = parts;                       // applyTrendScale 要按类别重算每段高度
  const sc0 = chartScale(parts, null);               // 首屏按整段历史；rAF 里再按可见范围自适应收紧
  const maxAll = S.trendMode === 'delta' ? sc0.maxUp : sc0.maxTotal;
  const selIdx = list.findIndex((r) => r.seq === S.selSeq);
  const granLabel = S.trendGran === 'turn' ? `按轮次（共 ${REQUESTS[REQUESTS.length - 1].turn} 轮）` : `按步骤（共 ${REQUESTS.length} 次请求）`;
  const markers = list.map((r) => markersOfBar(r));

  $('cardTrend').innerHTML = `
    <div class="card-title">上下文趋势
      <span class="hint">${esc(granLabel)}</span>
      <span class="grow" style="flex:1"></span>
      <button class="seg" data-trend="gran" data-v="turn" aria-pressed="${S.trendGran === 'turn'}" data-explain="trend.gran">按轮次</button>
      <button class="seg" data-trend="gran" data-v="step" aria-pressed="${S.trendGran === 'step'}" data-explain="trend.gran">按步骤</button>
      <span class="segsep"></span>
      <button class="seg" data-trend="mode" data-v="total" aria-pressed="${S.trendMode === 'total'}" data-explain="trend.mode">总计</button>
      <button class="seg" data-trend="mode" data-v="delta" aria-pressed="${S.trendMode === 'delta'}" data-explain="trend.mode">增量</button>
      <span class="segsep"></span>
      <button class="seg" data-trend="adaptive" aria-pressed="${S.trendAdaptive}" data-explain="trend.adaptive">自适应</button>
      <button class="seg" data-act="jumpNow" data-explain="trend.jump">回到当前</button>
    </div>
    <div class="cap">聚焦：${S.trendCat ? `<b style="color:${catColor(S.trendCat)}">${esc(catLabel(S.trendCat))}</b> <a href="#" data-act="clearCat">（全部）</a>` : '全部类别 —— 点分类树左边的色块可只画某一类'}
      · ${S.trendMode === 'delta'
        ? '每根柱子是<b>比上一次请求的增量</b>：涨的段在零线<b>上方</b>、跌的段在<b>下方</b>，颜色仍然是类别'
        : '柱体<b>按类别分色堆叠</b>：段高 = 该类这次的上下文量，颜色与右侧分类树一一对应'}${S.trendCat ? '（已聚焦某一类）' : ''}
      · 刻度 ${S.trendAdaptive ? '按可见范围自适应' : '按整段历史'} = <b id="trendAxisTopInline">${fmt(maxAll)}</b></div>
    <div class="trendwrap">
      <div class="axis">
        <span id="trendAxisTop">${fmt(maxAll)}</span>
        <span id="trendAxisMid">${S.trendMode === 'delta' ? '' : fmt(maxAll / 2)}</span>
        <span id="trendAxisBottom">${S.trendMode === 'delta' ? '-' + fmt(sc0.maxDown) : '0'}</span>
      </div>
      <div class="trendpos">
      <div class="chart-tip" id="trendTip" hidden></div>
      <div class="trendscroll" id="trendScroll">
        <div class="trendinner" style="width:${list.length * (BAR_W + BAR_GAP)}px">
          <div class="markers">${markers.map((evs, i) => (evs.length
            ? `<span class="mark" data-marki="${i}" data-explain="trend.mark" style="left:${i * (BAR_W + BAR_GAP)}px;width:${BAR_W}px">✂${evs.length > 1 ? '×' + evs.length : ''}</span>`
            : '')).join('')}</div>
          <div class="bars">
            ${S.trendMode === 'delta' ? `<i class="zeroline" style="bottom:${sc0.downPx}px"></i>` : ''}
            ${list.map((r, i) => {
              const v = series[i] || 0, p = parts[i] || {};
              const sel = r.seq === S.selSeq;
              /* 整列都是命中区：色块画在内层 .tbar-fill 上（照参考插件 dsh-context 的 .lc-bar）。
               * 顺带把"这一轮里的其它柱子"标出来（in-turn）——按步骤模式下一轮有多根，
               * 光靠一根柱子的框看不出点中的是哪一轮。 */
              const inTurn = !sel && r.turn === S.selTurn;
              const label = `${S.trendGran === 'turn' ? `第 ${r.turn} 轮 · 共 ${r.stepCount || turnSteps(r.turn)} 步` : `第 ${r.turn} 轮 · 第 ${r.step} 步`} · ${S.trendMode === 'delta' ? 'Δ' : '≈'}${fmt(Math.abs(v))}`;
              // 每段 = 一个类别（只有有量才渲染）；颜色走 CATS，与右侧分类树同源
              /* sign：'up' 只画正差、'down' 只画负差（undefined = 总计模式，全画）。
               * 不筛的话两臂会一模一样 —— 实测踩过：每根柱子上下两臂内容完全相同，总高翻倍。 */
              const segs = (vals, scale, sign) => CATS.map((c) => {
                const sv = vals[c.key] || 0;
                if (!sv) return '';
                if (sign === 'up' && sv <= 0) return '';
                if (sign === 'down' && sv >= 0) return '';
                return `<i class="cseg" data-cat="${c.key}" style="height:${Math.max(1, Math.round(Math.abs(sv) * scale))}px;background:${c.color}"></i>`;
              }).join('');
              const totalScale = CHART_H / Math.max(1, sc0.maxTotal);
              const inner = S.trendMode === 'delta'
                ? `<i class="tbar-fill tbar-diverge">
                     <i class="arm arm-up" style="bottom:${sc0.downPx}px">${segs(p, sc0.deltaScale, 'up')}</i>
                     <i class="arm arm-down" style="top:${sc0.upPx}px">${segs(p, sc0.deltaScale, 'down')}</i>
                   </i>`
                : `<i class="tbar-fill tbar-stack">${segs(p, totalScale)}</i>`;
              return `<button class="tbar${sel ? ' sel' : ''}${inTurn ? ' in-turn' : ''}" data-i="${i}" data-seq="${r.seq}" data-explain="trend.pick"
                        aria-label="${esc(label)}"
                        style="width:${BAR_W}px">${inner}</button>`;
            }).join('')}
          </div>
          <div class="strip">${S.trendGran === 'step'
            ? [...new Set(list.map((r) => r.turn))].map((t) => {
                const k = turnSteps(t);
                return `<button class="tcell" data-turn="${t}" style="width:${k * (BAR_W + BAR_GAP)}px" title="第 ${t} 轮（共 ${k} 步）→ 选中末步" data-explain="trend.strip">${t}</button>`;
              }).join('')
            : list.map((r) => `<button class="tcell${r.turn === S.selTurn ? ' is-sel' : ''}" data-seq="${r.seq}" data-explain="trend.strip" style="width:${BAR_W + BAR_GAP}px" title="第 ${r.turn} 轮 · 共 ${r.stepCount} 步 → 选中末步">${r.turn}</button>`).join('')}
          </div>
        </div>
      </div>
      </div>
      </div>
    </div>
    `;  /* 底部那一条（步级快捷片 + 上一轮/下一轮/上一步/下一步）按用户 2026-10-01 的意见删掉：
           柱体自身 hover 就报"第几轮 / 第几步"，点一下就选中；那一排只是重复信息、还抢注意力。
           柱子下面那行轮号刻度带保留 —— 它是图表的坐标轴，不是导航。 */

  const c = $('cardTrend');
  c.querySelectorAll('[data-trend]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.trend;
      if (k === 'gran') S.trendGran = b.dataset.v;
      if (k === 'mode') S.trendMode = b.dataset.v;
      if (k === 'adaptive') S.trendAdaptive = !S.trendAdaptive;
      render();
    };
  });
  c.querySelectorAll('.tbar').forEach((b) => {
    const i = Number(b.dataset.i);
    const req = () => REQUESTS.find((r) => r.seq === Number(b.dataset.seq)) || list[i];
    // hover / 键盘聚焦：立刻显示（原生 title 有延迟，所以自绘 —— 参考插件的原话）
    b.onmouseenter = () => showTrendTip(i, req(), series);
    b.onfocus = () => showTrendTip(i, req(), series);
    b.onblur = () => hideTrendTip();
    b.onclick = () => {
      const r = req();
      const label = S.trendGran === 'turn' ? `已选第 ${r.turn} 轮（切到该轮末步）` : `已选第 ${r.turn} 轮 · 第 ${r.step} 步`;
      selectReq(r, label);
      showTrendTip(i, r, series);   // 触屏没有 hover：点一下就常显，直到滑开或换一根
    };
  });
  // ✂ 标记自己也要能 hover 出提示（用户就是因为它没有任何说明才来问的）
  c.querySelectorAll('.mark').forEach((mk) => {
    const i = Number(mk.dataset.marki);
    mk.onmouseenter = () => showTrendTip(i, list[i], series);
    mk.onclick = () => { const r = list[i]; if (r) selectReq(r, `已跳到 ✂ 所在的那一次：第 ${r.turn} 轮 · 第 ${r.step} 步`); };
  });
  const wrap = c.querySelector('.trendpos');
  if (wrap) { wrap.onmouseleave = () => hideTrendTip(); }
  c.querySelectorAll('.tcell').forEach((b) => { b.onclick = () => trendCellAct(b); });
  c.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.act;
      if (a === 'jumpNow') { const sc = $('trendScroll'); sc.scrollLeft = sc.scrollWidth; applyTrendScale(); toast('已滚到最新一次请求'); return; }
      if (a === 'clearCat') { S.trendCat = null; render(); return; }
    };
  });
  const sc = $('trendScroll');
  sc.onscroll = () => { if (S.trendAdaptive) applyTrendScale(); syncTrendTip(); };
  containHorizontalOverscroll(sc);   // 滑到头不把整页带走（移动端尤其重要）
  /* ⚠️ 必须**同步**先算一次刻度：render() 紧接着就调 renderSelfcheck()，而自测面板要读 data-max。
   * 只把计算排进下面的 rAF 的话，面板拿到的是"刚重建、还没算过"的节点 → 显示 undefined（实测踩过）。 */
  applyTrendScale();
  requestAnimationFrame(() => {
    applyTrendScale();
    const sel = sc.querySelector('.tbar.sel');
    if (sel) sc.scrollLeft = Math.max(0, sel.offsetLeft - sc.clientWidth / 2);
    applyTrendScale();
  });
}

/**
 * 一轮里**最后一条用户消息**（R1.4 的入口要用它）。
 * 从该轮最后一步往前找：哪一步里有用户消息，就取那一步里最后一条用户消息。
 */
function turnLastUser(turn) {
  const reqs = reqsOfTurn(turn);
  for (let i = reqs.length - 1; i >= 0; i--) {
    const us = nodesOfReq(reqs[i], true).filter((n) => n.cat === 'user');
    if (us.length) return { req: reqs[i], node: us[us.length - 1] };
  }
  return null;
}
/**
 * R1.4「改这一轮的用户消息」：切到该轮的**最后一条用户消息** → 展开「用户消息」类 →
 * 滚到那一条并把内联编辑器展开（预填全文，不是 80 字预览）。
 * ⚠️ 旧实现只有一句 `document.querySelector('[data-turn=N]').click()`，而 `[data-turn]`
 * **只在"按步骤"模式的刻度格里才有** → 默认（按轮次）模式下点了等于没点
 * （用户 2026-10-01 实测："按钮点击了没有效果？"）。而且它压根没做 R1.4 要求的后两件事。
 * @returns 是否找到并展开（false = 这一轮没有用户消息，按钮应为置灰态）
 */
function editTurnUserMessage(turn) {
  if (S.sw.noUser) return false;              // 演示"这一轮没有用户消息"的置灰态
  const hit = turnLastUser(turn);
  if (!hit) return false;
  S.selSeq = hit.req.seq; S.selTurn = hit.req.turn;
  S.openCat = 'user'; S.openElem = hit.node.seq;
  S.editor = { kind: 'edit', seq: hit.node.seq, text: hit.node.text, reasoning: '', err: !!hit.node.err };
  S.editorError = null; S.editorOk = null; S.historyFor = null;
  render();
  const row = document.querySelector ? document.querySelector(`[data-elem="${hit.node.seq}"]`) : null;
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  toast(`已切到第 ${turn} 轮最后一条用户消息 #${hit.node.seq}，编辑器已展开`);
  return true;
}
function renderStep() {
  const r = reqOf();
  const hasUser = !S.sw.noUser && !!turnLastUser(r.turn);
  const hasInject = !!turnLastInject(r.turn);
  $('cardStep').innerHTML = `
    <div class="card-title">第 ${r.turn} 轮 · 第 ${r.step} 步 <span class="hint">${r.time}${isLive() ? ' · 当前（下一次请求）' : ''}</span>
      <span class="bmeta">共 ${turnSteps(r.turn)} 步 · ${reqsOfTurn(r.turn).length} 次请求</span></div>
    <div class="cap">这一屏的条数：用户消息 ${visibleOf().filter((n) => n.cat === 'user').length} · 注入内容 ${visibleOf().filter((n) => n.cat === 'inject').length}
      ${markerOf(r) ? `· <b>✂ ${esc(markerOf(r).label)}</b>` : ''}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
      <button class="btn sm" data-act="editTurnUser" data-explain="turn.pick"
        ${hasUser ? '' : 'disabled title="这一轮没有用户消息"'}
        title="切到这一轮最后一条用户消息，展开编辑器">改这一轮的用户消息</button>
      <button class="btn sm" data-act="editTurnInject" data-explain="turn.inject"
        ${hasInject ? '' : 'disabled title="这一轮没有注入内容"'}
        title="切到这一轮最后一条注入内容，展开编辑器">改这一轮的注入内容</button>
      <button class="btn sm ghost" data-act="pickLive" data-explain="turn.pick">回到当前</button>
    </div>`;
  const live = $('cardStep').querySelector('[data-act="pickLive"]');
  if (live) live.onclick = () => selectReq(REQUESTS[REQUESTS.length - 1], null);
  const editUser = $('cardStep').querySelector('[data-act="editTurnUser"]');
  if (editUser) editUser.onclick = () => { if (!editTurnUserMessage(r.turn)) toast('这一轮没有用户消息'); };
  const editInject = $('cardStep').querySelector('[data-act="editTurnInject"]');
  if (editInject) editInject.onclick = () => { if (!editTurnInject(r.turn)) toast('这一轮没有注入内容'); };
}
function renderEvents() {
  $('cardEvents').innerHTML = `
    <div class="card-title">上下文事件 <span class="hint">（压缩 / 裁剪，会标在趋势图上 · 一旦发生不可逆）</span></div>
    ${(() => {
      /* 用户 2026-10-01（两条）：「内容不变、不拟真」+「会变的和不变的都挤在一起、都是浅灰、不醒目」
       * ⟹ ① 事件随当前这一步变化；② **会变的内容做成事件行**（已发生＝有色条+实心标记，尚未发生＝虚线灰），
       *    不会变的说明收成最后一行小字（它不随位置变，就不该占视觉重量）。 */
      const cur = reqOf().seq;
      const done = EVENTS.filter((e) => e.seq <= cur);
      const later = EVENTS.filter((e) => e.seq > cur);
      const row = (e, isDone) => {
        const at = REQUESTS.find((r) => r.seq >= e.seq) || {};
        return `<div class="evrow ${isDone ? 'is-done' : 'is-todo'}">
          <span class="evicon">✂</span>
          <span class="evmain"><b>${esc(KIND_LABEL[e.kind])}</b><span class="evlabel">${esc(e.label)}</span></span>
          <span class="evat">第 ${at.turn} 轮 · 第 ${at.step} 步</span>
          <span class="evstate">${isDone ? '已发生' : '尚未发生'}</span>
        </div>`;
      };
      return `<div class="evsum">看的是<b>第 ${reqOf().turn} 轮 · 第 ${reqOf().step} 步</b>这一刻
        <span class="evchip evchip-done">已发生 ${done.length}</span>
        <span class="evchip evchip-todo">还没发生 ${later.length}</span></div>
        <div class="evlist">${done.map((e) => row(e, true)).join('')}${later.map((e) => row(e, false)).join('')}</div>
        <div class="cap evhint"><b>这一栏是干什么用的</b>：告诉你上下文在哪一轮被压掉 / 剪掉过。
          被压掉的条目从此改不了（只能批注），压缩也不可逆 —— 灰色那几条是<b>还没发生</b>的。
          每个事件标在它之后的第一个请求上（点趋势图上的 ✂ 可跳到那一次）。共 ${TOTAL_TURNS} 轮 / ${REQUESTS.length} 次请求。</div>`;
    })()}`;
}

/* ------------------------------------------------------------------ 6. 右侧浏览器 */
function ability(node) {
  const gone = goneMap();
  const repl = isReplacement(node.seq);
  const shadowed = gone[node.seq] !== undefined && !repl;
  const type = node.type;
  /* ⚠️ 三类"不能改"要分清（docs/03 R2.1 / R4.6）：
   *   · inert（系统提示词 / 工具定义）：**一个动作都不给**，也不渲染空动作区（宿主保护 node 0 的 system）；
   *   · assistant/message：只给批注；
   *   · 被遮蔽 / 被压缩埋掉：不给改写。
   * 「存为不变量」给的是**每轮会被宿主重新注入**的那两类：注入内容 + 技能注入（R2.1 表里的两个 ✅）。 */
  const inert = node.cat === 'system' || node.cat === 'tools';
  const canRewrite = !inert && !shadowed && type !== 'assistant/message' && !node.compacted;
  return {
    canRewrite, shadowed, isReplacement: repl, canAnnotate: !inert, inert,
    /* 「高级编辑」：**模型/工具回了什么**那一类（工具结果）。
     * 判据不是"会不会漂移"（只有每轮被重新注入的注入内容/技能注入才漂），而是"用户需要动手的概率"：
     * 工具结果一轮几十条、要改的概率低 —— 默认把「编辑」收起来，避免干扰；
     * 助手消息根本没有编辑按钮（平台互斥），它的批注**始终保留**（那是纠正它的唯一路径）。 */
    advancedOnly: node.cat === 'tool',
    pinnable: !inert && (node.cat === 'inject' || node.cat === 'skill'),
    isToolResult: type === 'tool/result',
    blockReason: inert ? '系统提示词 / 工具定义由宿主保护：改不了，也不批注'
      : shadowed ? `这一条已被 #${gone[node.seq]} 接替，已不在模型可见内容里`
      : type === 'assistant/message' ? '助手消息在平台上无法改写（两条规则互斥），只能批注'
      : node.compacted ? '这一条被压缩埋掉了，改写够不到它，只能批注'
      : type === 'system/message' ? '系统提示词不可改' : ''
  };
}
const EDGES = () => {
  const e = {};
  REQUESTS.forEach((r) => Object.entries(r.gone || {}).forEach(([f, t]) => { e[Number(f)] = t; }));
  S.applied.forEach((a) => { e[a.replacedSeq] = a.newSeq; });
  return e;
};
function familyOf(seq) {
  const e = EDGES(), back = {};
  Object.entries(e).forEach(([f, t]) => { back[t] = Number(f); });
  let first = seq; const g = new Set();
  while (back[first] !== undefined && !g.has(first)) { g.add(first); first = back[first]; }
  const chain = []; let cur = first;
  while (cur !== undefined && !g.has('f' + cur)) { g.add('f' + cur); chain.push(cur); cur = e[cur]; }
  return chain;
}
function versionsOf(node) {
  const fam = familyOf(node.seq);
  return fam.map((seq, i) => {
    const n = nodeOf(seq) || {}, ap = S.applied.find((a) => a.newSeq === seq);
    return { seq, kind: i === 0 ? 'origin' : (ap && /回滚/.test(ap.reason || '') ? 'rollback' : 'edit'), time: ap ? ap.time : ((n.versions && n.versions[0] && n.versions[0].time) || '—'), text: n.text || '', why: ap ? ap.reason : '' };
  });
}
function historyHtml(node) {
  const vs = versionsOf(node), cur = vs.length ? vs[vs.length - 1].seq : node.seq;
  return `<div class="history">
    <div class="cap" style="margin-bottom:4px">版本历史（同一行身份，跨替换体）：原始 → 每次改写 → 每次回滚</div>
    ${vs.map((v) => `<div class="vrow">
      <span class="vlabel">#${v.seq} · ${v.kind === 'origin' ? '原始' : v.kind === 'edit' ? '改写' : '回滚'} · ${esc(v.time || '')}</span>
      <span class="vtext" title="${esc(v.text)}">${esc((v.text || '').slice(0, 60))}</span>
      ${v.seq === cur ? '<span class="vwhy">当前可见</span>' : `<button class="btn sm" data-act="restore" data-seq="${cur}" data-to="${v.seq}" data-explain="act.restore">从这一版恢复</button>`}
    </div>`).join('')}
  </div>`;
}
function rowHtml(node) {
  const a = ability(node), gone = goneMap();
  const chain = S.applied.filter((x) => x.replacedSeq === node.seq);
  const isNew = isReplacement(node.seq);
  const open = S.openElem === node.seq;
  const draft = draftOf(node.seq) ? '<span class="chip-draft">未生效</span>' : '';
  const tail = isNew ? '<span class="chain">（这是替换后的新条目）</span>'
    : (gone[node.seq] !== undefined ? `<span class="chip-shadow">已被 #${gone[node.seq]} 接替</span>` : '');
  return `<div class="row${a.shadowed ? ' shadowed' : ''}">
    <button class="row-main" data-elem="${node.seq}" data-explain="row.toggle">
      <i class="catsq" style="background:${catColor(node.cat)}" title="点色块 = 趋势图聚焦这一类" data-focus="${node.cat}"></i>
      <span class="tagchip">${catLabel(node.cat)}</span>${node.name ? `<span class="tagchip">${esc(node.name)}</span>` : ''}
      <span class="preview">${esc((node.text || '').slice(0, 90))}</span>
      <span class="tok">≈${fmt(node.tokens)}</span>
    </button>
    ${open ? `<div class="row-body"><div class="meta">#${node.seq} · ${esc(node.type)}${node.err ? ' · 错误结果' : ''}${node.compacted ? ' · 被压缩埋掉' : ''}</div>${esc(node.text)}</div>` : ''}
    ${a.inert ? '' : `<div class="actions" data-rowactions="${node.seq}">
      <span class="seq">#${node.seq}</span>${draft}${tail}${chain.length ? '<span class="chain">（这里被改过）</span>' : ''}
      ${a.canRewrite
        ? (a.advancedOnly && !S.sw.advanced
          ? '<span class="chip-soft" title="工具结果的「编辑」属于高级编辑：打开顶部「高级编辑」开关即可看到（避免几十条工具结果把常用动作淹掉）">高级编辑</span>'
          : `<button class="btn sm" data-act="edit" data-seq="${node.seq}" data-explain="act.edit">编辑</button>`)
        : `<span class="chip-soft" title="${esc(a.blockReason)}">${esc(a.blockReason.slice(0, 14))}…</span>`}
      ${a.canAnnotate ? `<button class="btn sm" data-act="annotate" data-seq="${node.seq}" data-explain="act.annotate">批注</button>` : ''}
      ${a.pinnable ? (pinnedVersionOf(node)
        ? `<span class="chip-soft" title="这一段已经钉住了（逐字基准见「固定块」那一栏）；要换基准就在新的那条注入上再钉一次">已钉住 · v${pinnedVersionOf(node)}</span>`
        : `<button class="btn sm" data-act="pin" data-seq="${node.seq}" data-explain="act.pin" title="把这一段的正文逐字钉住，成为全局固定块">钉住这一段</button>`) : ''}
      ${draftOf(node.seq) ? `<button class="btn sm danger" data-act="apply" data-seq="${node.seq}" data-explain="act.apply">应用到会话</button>` : ''}
      ${familyOf(node.seq).length > 1 || node.versions ? `<button class="btn sm ghost" data-act="history" data-seq="${node.seq}" data-explain="act.history">版本历史</button>` : ''}
    </div>`}
    ${S.historyFor === node.seq ? historyHtml(node) : ''}
    ${S.editor && S.editor.seq === node.seq ? editorHtml() : ''}
  </div>`;
}
/** 用**人话**描述"这一条是哪一条"：轮 / 步 / 类别 / 正文开头。`#seq` 只是日志里的编号，退居次要。 */
function nodeWhere(n) {
  const r = reqOf();
  return `第 ${r.turn} 轮 · 第 ${r.step} 步 · ${catLabel(n.cat)}`;
}
const nodeExcerpt = (n, len = 26) => `“${String(n.text || '').replace(/\s+/g, ' ').slice(0, len)}…”`;

/* 输入去向标记（`docs/03` R3.3.3）：**界面上每一处"让你写字"的地方都必须带一个**，只有两种取值。
 * 用户 2026-10-02：「整个 Demo 都存在这个问题：哪些编辑了模型能看到、哪些看不到……给人类可能简单一些，
 * 如果给 Agent，就要写清楚，避免漂移」⟹ 给模型看的那一档**必须提醒怎么写**。 */
const DEST_LOCAL = '<span class="chip-soft dest-local" title="这段字只存在插件本地（我们自己的库）：模型看不到，也不会随快照进子会话">只写本地 · 模型看不到</span>';
const DEST_MODEL = '<span class="chip-soft dest-model" title="这段字会进模型上下文：请写清楚它要对模型说什么（别写给自己看的备忘）—— 写含糊就是下一次漂移的源头">会进模型上下文</span>';
/** 有门槛的"会进模型"：编辑草稿要**点「应用到会话」之后**模型才看得到（两步语义，R3.3）。 */
const DEST_MODEL_GATED = '<span class="chip-soft dest-model" title="这段字会进模型上下文 —— 但要等你点「应用到会话」之后；在那之前只有插件本地有">会进模型上下文（点「应用到会话」之后）</span>';
/** 钉住这一档：**本会话看不到**，但会在"新快照 + 新子会话启动"时逐字带进那个新会话（`docs/11` D9）。
 *  用户 2026-10-02 二次纠正：「不是钉住了以后模型立刻就能读到它，而是钉住了以后，在新快照、并且在新子会话启动的时候，才会读到它」。 */
const DEST_PIN_CARRY = '<span class="chip-soft dest-model" title="这段字本会话的模型看不到 —— 但你冻结并开新子会话时，它会逐字带进那个新会话的第一句话（那边的模型才读到）">开新会话时会带进新会话（本会话看不到）</span>';

function editorHtml() {
  const st = S.editor, blocked = S.sw.turnOpen || !S.sw.live;
  const node = nodeOf(st.seq);              // 字段要按**底层类型**给（R3.2）：工具结果只给内容文本 + isError
  const title = st.kind === 'edit' ? `编辑第 ${reqOf().turn} 轮 · 第 ${reqOf().step} 步的这一条`
    : st.kind === 'annotate' ? `批注第 ${reqOf().turn} 轮 · 第 ${reqOf().step} 步的这一条`
    : `钉住这一段（存起来，给新会话用）`;
  const note = st.kind === 'pin'
    ? '钉住 = 把这段正文逐字存成"新规范"（只存插件本地 —— 本会话的模型看不到）。等你在这一刻冻结、并开一个新子会话时，它会逐字附在那个新会话的第一句话前面 ⟹ 那个新会话的模型才读到它，并以此为准（冲突的旧理解作废）。'
    : st.kind === 'annotate' ? '提交后会往会话追加一条更正消息，不可撤销；原文不会被遮蔽，模型两者都看到。它是"请求式"的（不保证模型照做）。'
    : '这一步只把改动存在插件本地，模型还看不到；要让模型看到，还要做下面第 2 步。';
  const multiPara = st.kind === 'edit' && /\n\s*\n/.test(String(st.text || ''));
  /* ③ 左上角飘一个「?」——与讲解模式序号同一种做法（贴着元素，一眼知道对应谁）。
   *    用户 2026-10-01：「我说的问号不是在按钮后面单独加一个问号……这么做用户体验看着很差」。 */
  const q = (key, label) => `<span class="qfloat" role="button" tabindex="0" data-help="${key}"
      title="${esc(label)}：点这里看它是做什么的（不影响这个按钮）">?</span>`;
  /* ① 更正目标写成人话（哪一轮、哪一步、哪一类、正文开头），#seq 只作为追溯编号放在括号里。 */
  const targetBox = () => (node ? `<div class="targetbox">
      <b>${esc(nodeWhere(node))}</b><br>${esc(nodeExcerpt(node))}
      <span class="cap">（事件序号 #${node.seq}：写进更正消息里供追溯；你不用记它）</span>
    </div>` : '');
  return `<div class="editor">
    <p class="etitle">${esc(title)}</p>
    ${st.kind !== 'annotate' ? '' : targetBox()}
    <p class="enote">${esc(note)}</p>
    ${multiPara ? '<p class="enote">这条消息有多个文本段落；改写后会合并为一段。</p>' : ''}
    ${st.kind === 'edit' ? (node && node.type === 'tool/result' ? `
      <label class="field"><span>结果文本${DEST_MODEL}<span class="cap">（工具结果只能改内容文本与错误标记）</span></span><textarea rows="4" id="edT">${esc(st.text)}</textarea></label>
      <label class="field" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="edErr" style="width:auto;min-height:0" ${node.err ? 'checked' : ''}><span style="margin:0">标记为错误${DEST_MODEL}</span></label>`
    : `
      <label class="field"><span>正文${DEST_MODEL_GATED}<span class="cap">（模型看到的就是这一段；这里预填的是宿主全文，不是列表里那种 80 字预览）</span></span><textarea rows="4" id="edT">${esc(st.text)}</textarea></label>
      <details class="adv"><summary>高级：思考文本（可选，多数消息没有）</summary>
        <p class="cap">思考文本是模型的 reasoning 块；用户自己发的消息通常没有。留空即沿用原文。</p>
        <label class="field"><span>思考文本${DEST_MODEL_GATED}</span><textarea rows="2" id="edR">${esc(st.reasoning || '')}</textarea></label>
      </details>`)
    : st.kind === 'annotate' ? `
      <label class="field"><span>理由${DEST_MODEL}<span class="cap">（会跟着这条更正写进会话：模型看得到。所以写具体 —— "作废哪些、改成什么"；这段就是模型读到的全部）</span></span><textarea rows="3" id="edWhy" placeholder="一句话说明为什么更正">${esc(st.reason || '')}</textarea></label>
      <p class="cap">这条批注<b>只针对上面那一条</b>。如果你要作废的范围不止这一条，就直接写在理由里（例如"上面第 3、4 条都作废"）—— 模型读的正是这段理由，不需要你去选范围或记编号。</p>`
    : `
      <label class="field"><span>标签${DEST_LOCAL}<span class="cap">（只用来在列表里认这块）</span></span><input type="text" id="edLabel" value="${esc(st.label || '')}" placeholder="例如「目标」「约束」"></label>
      <label class="field"><span>正文（逐字为准）${DEST_PIN_CARRY}<span class="cap">—— 只存本地；<b>本会话看不到</b>，它会在"冻结出新快照 + 新子会话启动"时逐字带进那个新会话</span></span><textarea rows="4" id="edPin">${esc(st.text)}</textarea></label>`}
    ${blocked ? `<p class="eblocked">${S.sw.turnOpen ? '当前轮次还没结束 —— 改动只能在轮次边界提交。' : '这个会话不在本进程里，只能查看，不能编辑。'}</p>` : ''}
    ${S.editorError ? `<p class="emsg-err">${esc(S.editorError)}</p>` : ''}
    ${S.editorOk ? `<p class="emsg-ok">${esc(S.editorOk)}</p>` : ''}
    ${st.kind === 'edit' ? '<p class="cap esteps"><b>第 1 步</b> 保存草稿 → 只存在插件本地（模型还看不到）· <b>第 2 步</b> 行上出现「未生效」→ 点<b>「应用到会话」</b>才会真的生效（那时原文被遮蔽、模型只看到改后的）</p>' : ''}
    <div class="efoot">
      <span class="qwrap"><button class="btn sm" data-act="esubmit" ${blocked ? 'disabled' : ''}>${st.kind === 'pin' ? '钉住这一段（存起来）' : st.kind === 'annotate' ? '提交更正到会话' : '保存草稿'}</button>${q(st.kind === 'pin' ? 'act.pin' : st.kind === 'annotate' ? 'act.annotate' : 'act.edit', '这个按钮')}</span>
      <span class="qwrap"><button class="btn sm ghost" data-act="ecancel">取消（Esc）</button></span>
      <span class="cap">Cmd/Ctrl + Enter 提交</span>
    </div>
  </div>`;
}
function renderBrowser() {
  const nodes = surfaceOf(), r = reqOf();
  const total = visibleOf().reduce((s, n) => s + n.tokens, 0);
  const byCat = {}; CATS.forEach((c) => { byCat[c.key] = nodes.filter((n) => n.cat === c.key); });
  const gone = goneMap();
  $('cardBrowser').innerHTML = `
    <div class="card-title">上下文浏览器 <span class="hint">DNA 模式</span>
      <span class="grow" style="flex:1"></span>
      <span class="pickwrap" data-explain="turn.pick"><select class="btn sm" id="turnPick" title="选轮次">
        ${Array.from({ length: TOTAL_TURNS }, (_, i) => i + 1).map((t) => `<option value="${t}" ${t === S.selTurn ? 'selected' : ''}>第 ${t} 轮（共 ${turnSteps(t)} 步）</option>`).join('')}
      </select></span>
      <span class="pickwrap" data-explain="step.pick"><select class="btn sm" id="stepPick" title="选步骤">
        ${reqsOfTurn(S.selTurn).map((x) => `<option value="${x.seq}" ${x.seq === S.selSeq ? 'selected' : ''}>第 ${x.step} 步（共 ${turnSteps(S.selTurn)} 步） · ${x.time}</option>`).join('')}
        <option value="live" ${isLive() ? 'selected' : ''}>当前（下一次请求）</option>
      </select></span>
    </div>
    <div class="cap" style="margin-bottom:6px">${esc(isLive() ? '当前 · 下一次请求' : `第 ${r.turn} 轮 · 第 ${r.step} 步（共 ${turnSteps(r.turn)} 步）`)} · 估算合计 ≈ ${fmt(total)} tokens${markerOf(r) ? ` · ✂ ${esc(markerOf(r).label)}` : ''}</div>
    <div id="catList">${CATS.map((c) => {
      const list = byCat[c.key] || [];
      const vis = list.filter((n) => gone[n.seq] === undefined || isReplacement(n.seq));
      const t = vis.reduce((s, n) => s + n.tokens, 0);
      const open = S.openCat === c.key;
      return `<div>
        <button class="catrow" data-cat="${c.key}" aria-expanded="${open}" data-explain="cat.toggle">
          <span class="chev"></span>
          <i class="swatch${S.trendCat === c.key ? ' focused' : ''}" data-focus="${c.key}" style="background:${c.color}" title="点色块 = 趋势图只画这一类"></i>
          <span class="label">${c.label}</span><span class="grow"></span>
          <span class="count">${vis.length} 项${list.length > vis.length ? `（+${list.length - vis.length} 被遮蔽）` : ''}</span>
          <span class="tokens">≈${fmt(t)}</span><span class="pct">${total ? Math.round(t / total * 100) : 0}%</span>
        </button>
        ${open ? `<div class="catbody">${list.map(rowHtml).join('') || '<div class="cap">（这一步没有这类内容）</div>'}</div>` : ''}
      </div>`;
    }).join('')}</div>`;

  $('turnPick').onchange = (e) => selectReq(lastOfTurn(Number(e.target.value)), `已选第 ${e.target.value} 轮（末步）`);
  $('stepPick').onchange = (e) => {
    if (e.target.value === 'live') selectReq(REQUESTS[REQUESTS.length - 1], null);
    else selectReq(REQUESTS.find((x) => x.seq === Number(e.target.value)), null);
  };
  $('cardBrowser').querySelectorAll('[data-cat]').forEach((b) => { b.onclick = () => { S.openCat = S.openCat === b.dataset.cat ? null : b.dataset.cat; S.openElem = null; render(); }; });
  $('cardBrowser').querySelectorAll('[data-focus]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const k = b.dataset.focus; S.trendCat = S.trendCat === k ? null : k; render(); toast(S.trendCat ? `趋势图聚焦：${catLabel(k)}` : '趋势图恢复：全部类别'); };
  });
  $('cardBrowser').querySelectorAll('[data-elem]').forEach((b) => { b.onclick = (e) => { if (e.target.dataset.focus) return; S.openElem = S.openElem === Number(b.dataset.elem) ? null : Number(b.dataset.elem); render(); }; });
  $('cardBrowser').querySelectorAll('[data-act]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); rowAct(b); }; });
  wireHelpButtons();
}

/* ------------------------------------------------------------------ 7. 快照与子会话 */
/**
 * R1.16「改这一轮的注入内容」—— R1.4 的对称入口（用户 2026-10-01：**注入内容才是 AI 会理解错的那一半**）。
 * 取这一轮**最后一条**注入内容（seq 最大的那条 inject），展开「注入内容」类 → 打开编辑器（预填全文）。
 */
function turnLastInject(turn) {
  const reqs = reqsOfTurn(turn);
  for (let i = reqs.length - 1; i >= 0; i--) {
    const ins = nodesOfReq(reqs[i], true).filter((n) => n.cat === 'inject');
    if (ins.length) return { req: reqs[i], node: ins[ins.length - 1] };
  }
  return null;
}
function editTurnInject(turn) {
  const hit = turnLastInject(turn);
  if (!hit) return false;
  S.selSeq = hit.req.seq; S.selTurn = hit.req.turn;
  S.openCat = 'inject'; S.openElem = hit.node.seq;
  S.editor = { kind: 'edit', seq: hit.node.seq, text: hit.node.text, reasoning: '', err: !!hit.node.err };
  S.editorError = null; S.editorOk = null; S.historyFor = null;
  render();
  const row = document.querySelector ? document.querySelector(`[data-elem="${hit.node.seq}"]`) : null;
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  toast(`已切到第 ${turn} 轮最后一条注入内容 #${hit.node.seq}（${hit.node.name || '注入'}），编辑器已展开`);
  return true;
}

/**
 * 固定块（不变量）的**漂移检查**：这块正文现在还**逐字**出现在当前这一步的注入内容里吗？
 * 为什么必须做：注入类每轮由宿主重新注入，改一轮漂一轮 —— 不逐字比对就不知道"钉住的还是不是那句话"。
 * 只做**逐字包含**判断（不含推断、不含模糊匹配），与 docs/03 S4 的口径一致。
 */
function blockDrift(b) {
  /* ⚠️ 必须排除**我们自己**写进会话的消息（批注、重注入）：钉住的正文只存本地（`docs/11` D9），
   * 但 `重注入` 会把正文逐字追加进会话 —— 若不排除，那条就会自己命中自己 ⟹ 漂移永远报不出来。 */
  const here = nodesOfReq(reqOf(), true).filter((n) => n.cat === 'inject' && !n.ours);
  if (b.retired) return { ok: false, code: 'retired', why: '已退休：不再生效（历史版本保留）' };
  const hit = here.find((n) => String(n.text || '').includes(b.text));
  if (hit) return { ok: true, code: 'pinned', seq: hit.seq, why: `逐字命中 #${hit.seq}${hit.name ? '（' + hit.name + '）' : ''}` };
  const edited = here.find((n) => S.applied.some((a) => a.replacedSeq === n.seq || a.newSeq === n.seq));
  return {
    ok: false, code: edited ? 'edited' : 'missing',
    why: edited ? `这一步的注入被改写过（#${edited.seq}），钉住的原文已不在里面` : '当前这一步的注入内容里找不到这段正文'
  };
}

/** 给所有「?」帮助按钮接线（编辑器、确认框、动态弹出的按钮都用它）。
 *  用户 2026-10-01：「触发之后才展开的按钮，编号不好加，那就加一个问号，点了问号说明是什么」。 */
function wireHelpButtons() {
  document.querySelectorAll('[data-help]').forEach((b) => {
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openDrawer(b.dataset.help); };
  });
}
/** 这一条注入是否已经被钉住（逐字相同即视为同一条基准），返回最新版本号；没有则返回 0。 */
function pinnedVersionOf(node) {
  const hit = S.invariants.filter((b) => b.text === node.text);
  return hit.length ? Math.max(...hit.map((b) => b.version)) : 0;
}
function renderBlocks() {
  const box = $('cardBlocks');
  if (!box) return;
  const rows = S.invariants.map((b) => {
    const d = blockDrift(b);
    return `<div class="orch-row">
      <div class="orch-id">
        <span class="snapid">${esc(b.id)}</span>
        <span class="badge-state"><i class="mstat ${d.ok ? 's-done' : b.retired ? 's-idle' : 's-run'}"></i>${d.ok ? '在效' : b.retired ? '已退休' : '漂移'}</span>
        <span class="cap orch-desc">${esc(b.label)} · v${b.version} · ${b.scope === 'workspace' ? 'workspace 级（新会话也看得见）' : '仅本会话'} · ${d.why}</span>
      </div>
      <div class="orch-actions">
        <span class="orch-note">正文逐字（基准，只读）：${esc(b.text.slice(0, 46))}${b.text.length > 46 ? '…' : ''}</span>
        <button class="btn sm" data-act="breinject" data-id="${esc(b.id)}" data-explain="act.reinject">重注入</button>
        <button class="btn sm ghost" data-act="bretire" data-id="${esc(b.id)}" data-explain="act.retire" ${b.retired ? 'disabled' : ''}>退休</button>
      </div>
    </div>`;
  }).join('');
  box.innerHTML = `
    <div class="card-title">固定块（不变量） <span class="hint"><b>全局</b>：workspace 级，本会话与子会话都看得见</span>
      <span class="bmeta">${S.invariants.filter((b) => !b.retired).length} 个在效 / 共 ${S.invariants.length} 个</span></div>
    <div class="cap" style="margin-bottom:4px"><b>这一栏是全局的</b>（不属于某一类条目）：任何一轮、任何会话钉住的话都汇总到这里，之后每轮逐字比对、发现漂移就标出来。<br>
      按钮之所以长在<b>条目行上</b>，是因为要选的是<b>钉哪一段</b>：请回到上面「注入内容 / 技能注入」点那一条的 <b>「钉住这一段」</b>。
      钉下的正文就是<b>漂移基准</b>，所以它在本栏里<b>只读</b>；要换基准就在新的那条上再钉一次（自动升版）。<br>
      逐字保存：插件不生成、不润色、不压缩；漂移检查只做<b>逐字包含</b>判断（不含推断）。</div>
    <div class="efoot" style="margin-bottom:6px">
      <button class="btn sm ghost" data-act="gotoPin" data-explain="act.pin">去注入内容里钉一段</button>
      <span class="cap">会展开「注入内容」这一类，并按行给出「钉住这一段」</span>
    </div>
    ${S.invariants.length ? rows : '<div class="cap">还没有固定块。回到上面展开 <b>注入内容</b>，点某条的 <b>「钉住这一段」</b>（例如 <b>AGENTS.md</b> / <b>memory-doc</b> / <b>runtime-context</b>）。</div>'}`;
  box.querySelectorAll('[data-act]').forEach((el) => {
    el.onclick = () => blockAct(el.dataset.act, el.dataset.id);
  });
}

function blockAct(act, id) {
  const b = S.invariants.find((x) => x.id === id);
  if (!b) return;
  if (act === 'breinject') {
    confirmModal({
      title: '重注入固定块',
      warn: '会往会话追加一条消息，不可撤销。',
      rows: [['固定块', `${b.label} · v${b.version} · ${b.scope}`],
             ['正文逐字', b.text],
             ['为什么现在注入', b.id]],
      needReason: true, okText: '确认重注入',
      reasonLabel: '理由（会跟着这条消息写进会话 —— 模型看得到）',
      reasonPlaceholder: '一句话说明为什么现在重注入',
      onOk: (reason) => {
        const live = REQUESTS[REQUESTS.length - 1];
        S.extraNodes.push(N(1400 + S.extraNodes.length, 'inject', 'user/message', b.text, Math.round(b.text.length * 1.6),
          { name: b.label, ours: true }));   // ours：这条是**我们**写进去的，漂移检查要排除它（见 blockDrift）
        S.extraNodes[S.extraNodes.length - 1].requestSeq = live.seq;
        render();
        toast(`已重注入「${b.label}」（逐字追加；理由：${reason || '（未填）'}）`);
      }
    });
    return;
  }
  if (act === 'bretire') {
    confirmModal({
      title: '退休固定块',
      warn: '退休后它不再生效，但历史版本会保留。',
      rows: [['块 id 与版本', `${b.id} · v${b.version}`], ['当前生效范围', b.scope], ['退休影响面', '冻结记录里记的"在效固定块版本"会跟着变；已开出去的子会话不受影响']],
      needReason: false, okText: '确认退休',
      onOk: () => { b.retired = true; render(); toast(`已退休「${b.label}」（历史版本保留）`); }
    });
  }
}

function renderOrch() {
  const c = S.children;
  const active = c.filter((x) => x.state === 'running' || x.state === 'idle').length;
  const stateOf = (s) => (s === 'running' ? ['s-run', '运行中'] : s === 'idle' ? ['s-idle', '空闲'] : ['s-done', '已结束']);
  /**
   * 排布约定（用户 2026-09-30 反馈"这块没有其他几个部分好看"）：
   * 「小标题（.subhead）+ 行（.orch-row）」——和上下文浏览器/上下文事件用同一套语法。
   * 每个子会话/成员行统一成**两行**：上行 = 身份（id / 来源 / 状态 / 描述），下行 = 动作（缩进 22px，与 .actions 对齐）。
   * 这样"打开"不会再孤零零挂在右上角、其余按钮也不会掉到第二行还带悬挂缩进。
   * 状态一律用圆点 + 徽章，**不用 emoji**（docs/03 V5）。
   */
  $('cardOrch').innerHTML = `
    <div class="card-title">快照与子会话 <span class="hint">A′：只做快照化子会话 + 对接官方；不自己造协作层</span>
      <span class="bmeta">冻结 ${S.snapshots.length} · 子会话 ${S.children.length}</span></div>

    ${/* 用户 2026-10-01：「整块挤成一个大竖条、看着乱」→ 按**内容块**分区：
         冻结 / 子会话索引 / 待处理的结果 / 官方团队。宽屏两块并排（冻结一列，索引+待处理一列，团队跨两列），
         窄屏单列堆叠但每块有自己的边框与标题（不许再挤成一片）。 */''}
    <div class="orchgrid">

    <section class="orchblock" data-block="freeze">
    <div class="subhead blocktitle">冻结 <span class="hint">先冻一条记录（当时的留档凭据）；开子会话只有最新那条能点</span>
      <span class="bmeta">${S.snapshots.length
        ? `${S.snapshots.length} 条记录 · 最近 ${esc(S.snapshots[S.snapshots.length - 1].time)}`
        : '还没有记录'}</span></div>

    <div class="orch-toolbar">
      <input id="snapNote" placeholder="备注（只写本地，模型看不到）" />
      ${DEST_LOCAL}
      <button class="btn sm" data-act="freeze" data-explain="orch.freeze" ${!S.sw.live || draftCount() > 0 ? 'disabled' : ''}>冻结当前位置</button>
      <span class="cap">冻完在下面多一条记录 → <b>在那条上点「从这里开子会话」（只有最新那条能点）</b></span>
      ${S.invariants.filter((b) => !b.retired).length === 0
        ? '<span class="chip-soft" title="建议先把目标 / 约束（尤其是每轮被重新注入的那几条）存为固定块，否则子会话里没人守漂移">尚无固定块</span>'
        : ''}

      ${draftCount() > 0 ? `<span class="cap warn-text">还有 ${draftCount()} 条草稿没提交 —— 草稿不在新会话里，也不在这条记录里；它只存在插件本地。</span>` : ''}
    </div>

    <div class="subhead">冻结记录（每一条 = 当时的留档凭据）<span class="hint">只存在本地，不写会话 · <b>新会话从哪儿开始由平台定 = 最后聊完的那一轮</b>，所以只有最新那条能点；同一条再冻不新增（只问你改不改备注）；备注能改，其余字段只能删</span></div>
    ${S.snapshots.length
      ? S.snapshots.map((s, i) => ({ s, i })).reverse().map(({ s, i }) => {
        /* 用户 2026-10-01 定的**结构**：开子会话挂在**这一条**记录行上（不挂在冻结按钮那一行）。
         * 但**从哪儿开始由平台定**（= 最后聊完的那一轮，`docs/01` F38）⟹ 只有切点等于它的那条
         * 才与平台实际开头一致，才给按钮；更早的记录只给一句原因 + 替代建议（R2.3 / R4.7）。
         * ⚠️ **列表按时间倒序**（`docs/03` R5.1 第 1 条："列表按时间倒序"）—— 最新冻的那条在最上面，
         * 也就是贴着「冻结当前位置」按钮的那一条；否则用户最容易点到最旧、甚至没冻住规范的那条。
         * 注意 `data-i` 仍用**数组下标**（`{s,i}` 保留原索引），否则点行会张冠李戴。 */
        const ok = isBranchable(s);
        const fields = `第 ${s.turn} 轮末 · ${s.items} 条 · 固定块版本 ${esc(s.inv === undefined ? '—' : (s.inv === 'none' ? '无' : s.inv))}`;
        return `
      <div class="orch-row">
        <div class="orch-id">
          <span class="snapid">${esc(s.id)}</span>
          <span class="cap">第 ${s.turn} 轮末 · ${s.items} 条 · ${s.time} · 固定块版本：${esc(s.inv === undefined ? '—' : (s.inv === 'none' ? '无' : s.inv))}${s.blocks && s.blocks.length ? ` · <b>冻住 ${s.blocks.length} 条规范正文</b>` : ' · 没冻住规范正文'}</span>
          <span class="orch-note orch-desc">人写备注：${esc(s.note || '（无）')}</span>
        </div>
        <div class="orch-actions">
          ${ok
            ? `<button class="btn sm" data-act="spawn" data-i="${i}" data-explain="orch.spawn"
            ${!S.sw.live || draftCount() > 0 ? 'disabled title="先处理草稿 / 会话不在本进程"' : ''}>从这里开子会话</button>
          <span class="cap">新会话从<b>最后聊完的那一轮</b>往下接着干（${fields}）</span>`
            : `<span class="chip-soft" title="开子会话时，新会话只会从「本会话最后聊完的那一轮」接着往下，不能往前挑更早的位置。这条记录比那儿更早，所以点不了；它留着当凭据。">这条更早，只能从最新那条开</span>
          <span class="cap">更早的记录（${fields}）—— 只作<b>凭据</b>；想按当时的口径干，就用这里记下的固定块版本</span>`}
          <button class="btn sm ghost" data-act="snote" data-i="${i}" data-explain="orch.freeze">改备注</button>
          <button class="btn sm ghost" data-act="sdel" data-i="${i}" data-explain="orch.freeze">删除</button>
        </div>
      </div>`; }).join('')
      : '<div class="cap">还没有冻结记录。建议：先把草稿清零 → 冻结 → 再开子会话。</div>'}

    </section>

    <section class="orchblock" data-block="children">
    <div class="subhead blocktitle">子会话 / 成员索引 <span class="hint">官方 teammate 也占同一份额度</span>
      <span class="bmeta">活跃 ${active} / 8 · 共 ${S.children.length} 个</span></div>
    ${c.length === 0 ? '<div class="cap">（还没有子会话）</div>' : c.map((x, i) => {
      const [stCls, stText] = stateOf(x.state);
      return `
      <div class="orch-row">
        <div class="orch-id">
          <span class="snapid">${esc(x.id)}</span>
          <span class="${x.src === 'own' ? 'badge-src-own' : 'badge-src-team'}">${x.src === 'own' ? '本项目发起' : '来自 Agent Teams'}</span>
          <span class="badge-state"><i class="mstat ${stCls}"></i>${stText}</span>
          <span class="cap orch-desc">${esc(x.label)}${x.from ? ' · 来源记录 ' + esc(x.from) : ''}${x.norms ? ` · <span class="chip-soft">带 ${x.norms} 条新规范启动</span>` : ''}</span>
          <span class="chev" title="打开它（去官方视图）">›</span>
        </div>
        <div class="orch-actions">
          <button class="btn sm ghost" data-act="copen" data-i="${i}" data-explain="child.open">打开</button>
          ${x.src === 'own' ? `<button class="btn sm" data-act="cprompt" data-i="${i}" data-explain="child.prompt">发消息</button>
          ${x.sent ? `<span class="cap">已排队 <b>${x.sent}</b> 条</span>` : ''}` : ''}
          <span class="cap">${x.state === 'running'
            ? '运行中：打开它 = 面板切到它的上下文；<b>轮次闭合前只能看，不能改</b>（要改就先等它空闲或打断）'
            : '打开它 = 面板切到它的上下文，就能像这里一样编辑'}</span>
          ${x.src === 'own' ? `
            ${S.sw.team ? `
              <button class="btn sm" data-act="csend" data-i="${i}" data-explain="child.send">派活</button>
              <button class="btn sm" data-act="ctask" data-i="${i}" data-explain="child.totask">建成官方任务</button>` : ''}
            <button class="btn sm" data-act="ccompact" data-i="${i}" data-explain="child.compact">压缩</button>
            <button class="btn sm danger" data-act="cinterrupt" data-i="${i}" data-explain="child.interrupt">打断</button>`
          : `<span class="cap">${S.sw.team
              ? '这类成员请在会话页头的 Agent Teams 面板里管理'
              : '平台目录里的子会话（只读）；本机未启用官方智能体团队，故不提供派活 / 建任务'}</span>`}
        </div>
      </div>`;
    }).join('')}

    </section>

    <section class="orchblock" data-block="pending">
    <div class="subhead blocktitle">待处理的结果 <span class="hint" data-explain="pending.view">结算通知由平台尽力投递，投不到就说投不到</span>
      <span class="bmeta">${S.pendingSeen ? '已全部确认' : '1 条待确认'}</span></div>
    ${S.sw.pendingState === 'settled' ? `
      <div class="orch-row">
        <div class="orch-id">
          <i class="dot dot-ok"></i>
          <span>已收到平台结算通知</span>
          <span class="cap orch-desc">子会话 #004c37a5 已结束：「改完了 3 处，测试全绿」</span>
        </div>
        <div class="orch-actions">
          <button class="btn sm ghost" data-act="pendingSeen">标记已查看</button>
        </div>
      </div>` : `
      <div class="orch-row">
        <div class="orch-id">
          <i class="dot dot-warn"></i>
          <span class="warn-text">回流未确认</span>
          <span class="cap orch-desc">没收到平台的结算通知 —— 子会话结束了，但父会话没收到回流</span>
        </div>
        <div class="orch-actions">
          <button class="btn sm" data-act="pendingHand">让主会话接着做</button>
        </div>
      </div>`}

    </section>

    <section class="orchblock" data-block="team">
    <div class="subhead blocktitle">官方团队 <span class="hint" data-explain="team.read">只读 —— 显示的就是官方那份数据</span>
      <span class="bmeta">${S.sw.team ? `${S.members.length} 位成员 · ${S.tasks.length} 条任务` : '未启用'}</span></div>
    ${S.sw.team ? `
      <div class="cap list-label">成员</div>
      <div class="roster">${S.members.map((m) => `<span class="member"><i class="mstat ${m.st}"></i>${esc(m.name)}</span>`).join('')}</div>
      <div class="cap list-label">任务板</div>
      ${S.tasks.length
        ? S.tasks.map((t) => `
        <div class="task">
          <i class="tstat ${t.st}"></i>
          <span class="subject">${esc(t.subject)}</span>
          <span class="owner muted">${esc(t.owner || '未认领')}${t.blocked ? ' · 被依赖阻塞' : ''}</span>
        </div>`).join('')
        : '<div class="cap">（任务板为空）</div>'}
      <div class="orch-actions">
        <button class="btn sm ghost block" data-act="teamOpen" data-explain="team.read">去官方面板</button>
        <span class="cap">成员导航复用官方，我们不在面板里重画对话</span>
      </div>`
      : '<div class="cap">本机未启用官方智能体团队 → 派活 / 建成官方任务 / 成员式打断全部不出现（不是报错）。</div>'}
    </section>

    </div>
  `;
  $('cardOrch').querySelectorAll('[data-act]').forEach((b) => { b.onclick = (e) => { e.preventDefault(); orchAct(b); }; });
  wireHelpButtons();
}

/* ------------------------------------------------------------------ 8. 动作 */
function rowAct(btn) {
  const act = btn.dataset.act;
  S.editorError = null; S.editorOk = null;
  if (act === 'esubmit') return submitEditor();
  if (act === 'ecancel') { S.editor = null; render(); return; }
  const seq = Number(btn.dataset.seq), node = nodeOf(seq);
  if (!node) return;

  if (act === 'edit') { S.editor = { kind: 'edit', seq, text: node.text, reasoning: '', err: !!node.err }; S.historyFor = null; render(); toast(`打开 #${seq} 的内联编辑器（预填的是全文，不是 80 字预览）`); }
  if (act === 'annotate') { S.editor = { kind: 'annotate', seq, reason: '', voidFrom: String(seq), voidTo: String(seq) }; S.historyFor = null; render(); }
  if (act === 'pin') { S.editor = { kind: 'pin', seq, label: '', text: node.text }; S.historyFor = null; render(); }
  if (act === 'history') { S.historyFor = S.historyFor === seq ? null : seq; S.editor = null; render(); }

  if (act === 'apply') {
    const d = draftOf(seq);
    confirmModal({
      title: '应用到会话',
      warn: '会向会话追加一条替换记录，之后无法删除；原文对模型永久不可见，但仍保留在日志里。当前可见的那一条之后还能继续改，也能从版本历史里恢复某一版。',
      rows: [['目标', `#${seq}（当前可见节点）`], ['原文', (node.text || '').slice(0, 120)], ['改后', (d.text || '').slice(0, 120)], ['理由', d.reason || '（未填）']],
      needReason: false, okText: '确认应用',
      onOk: () => doApply(seq)
    });
  }
  if (act === 'restore') {
    const to = Number(btn.dataset.to), v = versionsOf(node).find((x) => x.seq === to) || { text: '' };
    confirmModal({
      title: '回滚到某一版',
      warn: '会向会话追加一条替换记录，把模型看到的内容恢复成你选的那一版。原文与中间版本都还在日志里，之后还可以再改。',
      rows: [['当前可见', `#${seq}`], ['要恢复到的版本', `#${to}`], ['该版正文', (v.text || '').slice(0, 140)], ['理由', `（回滚到 #${to}）`]],
      needReason: false, okText: '确认恢复',
      onOk: (reason) => {
        const ns = 1400 + S.applied.length;
        S.applied.push({ replacedSeq: seq, newSeq: ns, requestSeq: reqOf().seq, text: v.text, reason: reason || `回滚到 #${to}`, time: '12:1' + (S.applied.length % 9) });
        S.extraNodes.push(N(ns, node.cat, node.type, v.text, node.tokens, { name: node.name, requestSeq: reqOf().seq }));
        delete S.drafts[seq];
        render(); toast(`已回滚：#${seq} → 恢复为 #${to} 的内容（关系链见行上）`);
      }
    });
  }
}
function submitEditor() {
  const st = S.editor; if (!st) return;
  const node = nodeOf(st.seq);
  if (st.kind === 'edit') {
    const isTool = node && node.type === 'tool/result';
    const text = ($('edT') && $('edT').value) || '', reasoning = isTool ? '' : (($('edR') && $('edR').value) || '');
    const errBox = $('edErr'), err = isTool ? !!(errBox && errBox.checked) : !!node.err;
    if (text === '' && reasoning === '') { S.editorError = '可见文本与思考文本不能同时为空'; render(); return; }
    if (text === node.text && reasoning === '' && err === !!node.err) { S.editorError = '没有实质改动 —— 宿主会拒绝这样的提交（no-change）'; render(); return; }
    S.drafts[st.seq] = { seq: st.seq, text, reasoning, err, updatedAt: '12:1x', requestSeq: reqOf().seq };
    S.editor = null; render(); toast('已保存草稿（模型还看不到）→ 行上出现「未生效」，点「应用到会话」才生效'); return;
  }
  if (st.kind === 'annotate') {
    const reason = ($('edWhy') && $('edWhy').value.trim()) || '';
    if (reason === '') { S.editorError = '理由不能为空'; render(); return; }
    /* ⚠️ 批注**只针对你点的那一条**（用户 2026-10-01：范围下拉在"一步几百条、一会话上万条"时
     * 既没有语义、又是性能/体验负担；要说明更大范围就写在**理由**里 —— 模型读的正是理由）。
     * 结构化头部里的 seq 只用于我们自己的追溯。 */
    const from = st.seq, to = st.seq;
    const rangeText = `${nodeWhere(nodeOf(st.seq))} ${nodeExcerpt(nodeOf(st.seq), 18)}（#${st.seq}）`;
    /* ⚠️ R3.3.1：凡**写入型**提交按钮都要先出 R4.3 确认框，`提交更正到会话` 不例外
     *（唯一例外是「保存草稿」——不写会话、可一键放弃）。原先这里直接追加，是漏了这道门。
     * 框里必须写清"这条更正在**快照/子会话**里起什么作用"（用户 2026-10-01 问的那件事）。 */
    confirmModal({
      title: '提交更正到会话（批注）',
      warn: '会向会话追加一条消息，不可撤销；原文保留，模型两者都能看到。',
      rows: [
        ['更正目标', rangeText],   // 人话：第 N 轮 · 第 M 步 · 类别 “正文…”（#seq）—— 只有这一条
        ['范围', '只针对上面这一条；要更大范围请写在理由里'],
        ['理由', reason],
        ['在快照里', '这条更正会跟着快照进子会话 —— 但它只是"请求式"的：不遮蔽原文、不保证模型照做；长对话或压缩之后，它可能被摘要吞掉'],
        ['想要"确定生效"', '用「编辑」+「应用到会话」（遮蔽原文，模型只看到改后的那条）；想长期有效就把它 `钉住这一段`']
      ],
      needReason: false, okText: '确认提交更正',
      onOk: () => {
        const ns = 1500 + S.extraNodes.length;
        const text = `[redline] 更正目标 seq=${st.seq}\n作废范围 seq=${from}..${to}\n理由：${reason}`;
        S.extraNodes.push(N(ns, 'inject', 'user/message', text, 60, { requestSeq: reqOf().seq, name: '批注', ours: true }));
        const r = reqOf(); if (!r.surface.includes(ns)) r.surface.push(ns);
        S.editor = null; render(); toast(`已追加更正 #${ns}（不可撤销）；原文 #${st.seq} 仍在模型可见内容里`);
      }
    });
    return;
  }
  if (st.kind === 'pin') {
    const label = (($('edLabel') && $('edLabel').value.trim()) || '目标'), text = ($('edPin') && $('edPin').value) || '';
    if (text.trim() === '') { S.editorError = '固定块正文不能为空'; render(); return; }
    /* ⚠️ 语义（用户 2026-10-02 **二次纠正**，`docs/11` D9）：钉住**不在当前会话生效** ——
     * 它只存本地；**读到它的时机 = 新快照（冻结）+ 新子会话启动时**：开子会话时把这条新规范
     * **逐字附在子会话的第一句话前面**。所以这里**不写会话**（本会话的模型看不到它）。 */
    confirmModal({
      title: '钉住这一段（存起来，给新会话用）',
      warn: '钉住 = 把这段正文逐字存成"新规范"（只存插件本地，本会话的模型看不到）。等你在这一刻冻结、并开一个新子会话时，它会逐字带进那个新会话的第一句话前面 —— 那个新会话的模型才读到它，并以此为准（冲突的旧理解作废）。',
      rows: [['这段正文（逐字为准）', text.slice(0, 140) + (text.length > 140 ? '…' : '')],
             ['它现在去哪', '只存插件本地 —— 本会话的模型看不到（会话日志不写）'],
             ['谁会读到它', '新子会话启动时读到（逐字附在它的第一句话前面）；本会话与其它旧会话都读不到'],
             ['什么时候读到', '先冻结（新快照记下"当时的固定块版本"）→ 再从那一条记录开子会话']],
      needReason: false, okText: '钉住（存起来）', helpKey: 'act.pin',
      onOk: () => {
        const version = S.invariants.filter((x) => x.label === label).length + 1;
        S.invariants.push({
          id: 'inv-' + label.replace(/\s+/g, '-').slice(0, 16) + '-' + version,
          label, text, version, retired: false, scope: 'workspace',
          savedAt: '12:1' + (S.invariants.length % 9)
        });
        S.editor = null; render();
        toast(`已钉住「${label}」v${version} —— 只存本地（本会话看不到）；下次冻结 + 开子会话时，它会逐字带进那个新会话的第一句话`);
      }
    });
    return;
  }
}
function doApply(seq) {
  // ⚠️ 新条目的 seq 从 **1600** 起（不是 1300）：演示数据里已经有 1300/1301/1303/1305 这些条目，
  //    从 1300 起算的话**连改两次就会撞号** —— nodeOf() 会命中演示里那条同名 seq，张冠李戴（2026-10-01 实测）。
  const d = draftOf(seq), node = nodeOf(seq), ns = 1600 + S.applied.length;
  S.applied.push({ replacedSeq: seq, newSeq: ns, requestSeq: reqOf().seq, text: d.text, reason: d.reason || '', time: '12:1' + (S.applied.length % 9) });
  S.extraNodes.push(N(ns, node.cat, node.type, d.text, node.tokens, { name: node.name, requestSeq: reqOf().seq, err: !!d.err }));
  delete S.drafts[seq];
  render(); toast(`已应用：#${seq} 被遮蔽 → 新条目 #${ns}（原文仍在日志里；可用版本历史恢复）`);
}
/** 平台种子切点 = 父会话日志里**最后一个** `turn/end`（`docs/01` F38，读安装树类型定义 + provider 源码的结论）。
 *  fork provider **永远**取"最后一个 turn/end 及其之前"，调用方**没有任何参数**能指定更早的切点
 *  ⟹ 只有切点正好等于它的那条冻结记录，才与平台实际种子重合；更早的记录**复现不了**。 */
const headCut = () => { const r = REQUESTS[REQUESTS.length - 1]; return `${r.turn}·${r.step}`; };
const isBranchable = (s) => !!s && s.cut === headCut();
/** 起点 = **你点的那一行冻结记录**（行内按钮 `data-i`）—— 用户 2026-10-01 定的**结构**保留。
 *  但只有"可作起点"的那条（切点 == 当前最后一个轮次末）会渲染出按钮；这里再挡一次：
 *  记录不存在、或它比当前最后一个轮次末更早 → **拒绝建会话**（不许拿别的记录顶上）。 */
function seedAt(i) {
  const s = S.snapshots[i];
  return isBranchable(s) ? s : null;
}
const seedLabel = (x) => `${x.id} · 第 ${x.turn} 轮末 · ${x.items} 条 · 固定块版本：${x.inv === undefined ? '—' : (x.inv === 'none' ? '无' : x.inv)}`;
function orchAct(b) {
  const act = b.dataset.act, i = Number(b.dataset.i);
  if (act === 'cprompt') {
    const x = S.children[i];
    /* 官方能力（docs/01 F37）：`ctx.subagents.prompt({delivery:'queue'})` 把**人写的**一条话排成子会话的
     * **下一个轮次**（steer 则是插到最近的步骤边界）—— 所以子会话是**多轮**的，能一来一回。 */
    confirmModal({
      title: '给这个子会话发一条消息',
      warn: '这条消息会成为它的一个新轮次（子会话是多轮的）；它现在忙就排队，等它空闲或到步骤边界再执行。不可撤销。',
      rows: [['发给', `${x.id}${x.label ? ' · ' + x.label : ''}`],
             ['走哪条通道', '官方 ctx.subagents.prompt({delivery:"queue"}) —— 排队成为它的下一个轮次'],
             ['它现在', x.state === 'running' ? '运行中：会在最近的步骤边界接收' : '空闲：会立刻起一个新轮次'],
             ['你要说的话', '写在下面那一栏 —— 它就是这条消息的正文（插件不生成任何内容）']],
      needReason: true, okText: '排队发送', helpKey: 'child.prompt',
      reasonLabel: '要说的话（会成为子会话的一个新轮次 —— 它的模型看得到）',
      reasonPlaceholder: '一句话说清要它做什么（这句就是消息正文）',
      onOk: () => { x.sent = (x.sent || 0) + 1; render(); toast(`已排队给 ${x.id} 的消息（会成为它的新轮次）`); }
    });
    return;
  }
  if (act === 'freeze') {
    /* ⚠️ 幂等（用户 2026-10-01：「同一位置再点一次为什么会出现多条？我没理解」）：
     * 一条冻结记录的**身份** = 「切点 + 当时在效的固定块版本」。
     * 同一身份再点一次 **不是新记录**，而是问你要不要更新那条的备注（写错了不用一条条改）。
     * 其余字段（切点/条目数/时刻/固定块版本）是当时的客观读数 —— **不可改**，只能删（改了就不叫凭证）。 */
    const cut = `${reqOf().turn}·${reqOf().step}`, inv = invariantsVersion();
    const same = S.snapshots.find((x) => x.cut === cut && x.inv === inv);
    const note = ($('snapNote') && $('snapNote').value.trim()) || '';
    if (same) {
      confirmModal({
        title: '这一刻已经冻过了',
        warn: '同一个位置 + 同一批固定块只留一条记录（重复的没有意义）。要更新那条的备注吗？',
        rows: [['已有记录', `${same.id} · 第 ${same.turn} 轮末 · ${same.items} 条 · ${same.time}`],
               ['原来的备注', same.note || '（无）'],
               ['这次要写的备注', note || '（空 —— 确认后保持原备注不变）'],
               ['不能改的字段', '第几轮末 / 条目数 / 冻结时间 / 当时的固定块版本与它们的逐字正文（都是当时冻住的东西，改了就不算凭据了）']],
        needReason: false, okText: '更新备注', helpKey: 'orch.freeze',
        // 确认时**再读一次**输入框：先写备注再点、或点完再写，两种顺序都成立
        onOk: () => { const t = ($('snapNote') && $('snapNote').value.trim()) || note; if (t) same.note = t; render(); toast(`已更新 ${same.id} 的备注（没有新增记录）`); }
      });
      return;
    }
    /* ⚠️ **冻结冻住的是"那一刻的东西"**（用户 2026-10-02 定，`docs/11` D9）：
     * 除了切点/条目数/备注/版本号，还要把**当时在效固定块的逐字正文**一起冻进这条记录。
     * 之后那块被改 / 退休**都不影响这条记录** —— 开子会话带的是**记录里这份**，
     * 不是"现在在效的那份"（否则"冻结"就只是张空收据）。 */
    const frozen = S.invariants.filter((b) => !b.retired)
      .map((b) => ({ id: b.id, label: b.label, version: b.version, text: b.text }));
    const id = 'snap-20260930-' + String(120000 + S.snapshots.length * 137).slice(0, 6);
    const row = { id, cut, inv, turn: reqOf().turn, items: surfaceOf().length, time: '12:1' + (S.snapshots.length % 9), note, blocks: frozen };
    S.snapshots.push(row);
    render();
    toast(`已冻结（第 ${row.turn} 轮末 · ${row.items} 条${frozen.length ? ` · 冻住 ${frozen.length} 条规范正文` : ''}）—— 只写插件本地，不写会话`);
    return;
  }
  if (act === 'gotoPin') {
    S.openCat = 'inject'; S.selSeq = reqOf().seq; render();
    toast('已展开「注入内容」——点某条的「钉住这一段」即可钉住它的原文');
    return;
  }
  if (act === 'snote' || act === 'sdel') {
    const x = S.snapshots[i];
    if (!x) return;
    if (act === 'snote') {
      confirmModal({
        title: '改这条冻结记录的备注',
        warn: '只有你写的备注能改；第几轮末 / 条目数 / 时间 / 当时的固定块版本是当时的客观读数，不能改。',
        rows: [['记录', `${x.id} · 第 ${x.turn} 轮末 · ${x.items} 条 · ${x.time}`], ['现在的备注', x.note || '（无）']],
        needReason: true, okText: '保存备注', helpKey: 'orch.freeze',
        reasonLabel: '备注（只写插件本地 —— 模型看不到，也不会进子会话）',
        reasonPlaceholder: '一句话提醒自己：当时为什么冻在这儿',
        onOk: (t) => { x.note = t; render(); toast('备注已更新'); }
      });
      return;
    }
    confirmModal({
      title: '删除这条冻结记录',
      warn: '只删这条本地记录，不影响会话与模型可见内容。',
      rows: [['记录', `${x.id} · 第 ${x.turn} 轮末 · ${x.items} 条 · ${x.time}`], ['备注', x.note || '（无）']],
      needReason: false, okText: '删除', helpKey: 'orch.freeze',
      onOk: () => { S.snapshots.splice(i, 1); render(); toast('已删除该冻结记录'); }
    });
    return;
  }
  if (act === 'spawn') {
    const seed = seedAt(i);
    if (!seed) { toast('这条记录更早（或已经被删）—— 开子会话只能从「最后聊完的那一轮」开始', 'err'); return; }
    /* ⚠️ **钉住的"新规范"就在这里生效**（用户 2026-10-02 二次纠正，`docs/11` D9）：
     * 它不在本会话生效，而是在**新子会话启动时**逐字带进子会话的**第一句话**。
     * 所以：① 确认框要列出"这次会带上哪几条新规范"；② 确认后把规范块逐字拼在首条任务前面。
     * ⚠️ **带的是"这条记录冻住的那份"**（`seed.blocks`），不是"现在在效的那份" ——
     * 块后来被改 / 退休都不影响这条记录（用户 2026-10-02 定，`docs/11` D9）。 */
    const carry = seed.blocks || [];
    const normHead = '[redline] 新规范（以此为准）\n以下逐段逐字为准；与此冲突的此前理解一律作废。\n';
    const normBody = carry.map((x) => `【${x.label} · v${x.version}】\n${x.text}`).join('\n\n');
    confirmModal({
      title: '允许创建子会话',
      warn: '会新建一个会话，把这个会话「已经聊完的内容」当作它的开头。开头到哪儿，由平台决定（= 最后聊完的那一轮），我们挑不了更早的位置；开出去之后，这个会话后面新聊的内容不会再进去。',
      rows: [['① 从哪儿开始', `本会话「最后聊完的那一轮」为止（第 ${seed.turn} 轮末 · 共 ${seed.items} 条）—— 平台自己算的，改不了；这条记录正好冻在这儿，所以两者一致`],
             ['① 这条记录（留档用）', seedLabel(seed)],
             ['① 会带上的新规范', carry.length
               ? `${carry.length} 条（${carry.map((x) => x.label + ' v' + x.version).join('、')}）—— 逐字附在它的第一句话前面（本会话看不到，只有那个新会话的模型读到）。来自这条记录冻结时存下的逐字正文：那块后来被改 / 退休都不影响`
               : '（这条记录冻结时没有在效的固定块 —— 想带上规范，请先「钉住这一段」，再重新「冻结当前位置」，然后从新记录开子会话）'],
             ['② 首条任务', '（写在下面那一栏 —— 必须你写；插件不生成任何内容）'],
             ['③ 它会带上什么', '✅ 会带上：已经聊完的对话（包含你已经改过的内容）+ 上面那些新规范｜❌ 不会带上：这个会话的工具授权；它也不会自动把干活的过程（工具输出、思考）送回本会话。注意：对话历史取的是"最后聊完的那一轮"之前的全部日志 —— 比这条记录更晚应用的改动也会一起进去（平台只给这一个起点，没有参数可选更早）'],
             ['④ 走哪条路', S.sw.team ? '走官方团队：它会成为官方名册里的一名成员（任务板、成员导航、派活都有）' : '团队不可用 → 变成一个"裸子会话"（没有任务板，也没有官方派活）'],
             ['⑤ 取消', '取消 = 什么都不发生（不建会话、不写记录）']],
      needReason: true, okText: '确认创建',
      reasonLabel: '首条任务（会成为子会话的第一句话 —— 它的模型看得到；本会话的模型看不到）',
      reasonPlaceholder: '一句话说清这次要它干什么',
      onOk: (reason) => {
        const id = '00' + (49000 + S.children.length * 771).toString(16).slice(0, 6);
        // 首条任务 = （有规范时）逐字规范块 + 人写的一句话；规范块来自用户自己钉住的正文（插件只做逐字复制）
        const prime = (carry.length ? normHead + normBody + '\n---\n' : '') + reason;
        S.children.push({ id, src: 'own', state: 'running', label: reason.slice(0, 24), from: seed.id, prime, norms: carry.length });
        render();
        toast(`已创建 ${id}（来源记录 ${seed.id}${carry.length ? `；已带上 ${carry.length} 条新规范` : ''}；来源徽章 = 本项目发起）`);
      }
    }); return;
  }
  if (act === 'copen') { openDrawer('child.open'); toast('（演示）这里会跳到官方视图：父会话页头血缘目录 / 右侧 Sidebar 打开它的对话'); return; }
  if (act === 'teamOpen') { toast('（演示）这里会跳到官方团队面板：成员导航与任务板都复用官方那一份'); return; }
  if (act === 'csend') {
    confirmModal({ title: '派活（经官方通道）', warn: '会向子会话写入一条任务消息，不可撤销。',
      rows: [['收件人', S.children[i].id], ['逐字任务正文', '（写在下面那一栏）'], ['投递方式', '排队下一轮（queue）']],
      needReason: true, okText: '确认发送',
      reasonLabel: '任务正文（写进那位成员的收件箱 —— 那个 agent 看得到）',
      reasonPlaceholder: '一句话说清要它做什么（这句就是任务正文）',
      onOk: (reason) => toast(`已发送（模拟官方返回 accepted）：${reason.slice(0, 30)}`) }); return;
  }
  if (act === 'ctask') { S.tasks.push({ subject: `跟进 ${S.children[i] ? S.children[i].id : ''} 的产出`, owner: '', blocked: false, st: 's-idle' }); render(); toast('已建成官方任务（写进官方任务板 —— 官方面板现在也能看到它）'); return; }
  if (act === 'ccompact') {
    if (S.sw.compressBusy) { toast('压缩被拒：子会话正在运行，等它空闲再压缩。（busy）', 'err'); return; }
    confirmModal({ title: '压缩子会话（不可逆）', warn: '子会话的历史会被摘要取代，不可逆。失败也通常会留下痕迹。',
      rows: [['目标', S.children[i].id], ['将被替代的区间与条目数', '第 1–3 步 · 共 12 条'], ['不可逆提示', '原文会被摘要取代（不是遮蔽，读不回来）']],
      needReason: false, okText: '确认压缩', onOk: () => { S.children[i].state = 'idle'; render(); toast('压缩完成（演示）：子会话历史出现 compaction/* 事件'); } }); return;
  }
  if (act === 'cinterrupt') {
    confirmModal({ title: '打断子会话', warn: '会向子会话发出取消信号；未完成的工作可能被中断，不可撤销。已提交的工作不会被回滚。',
      rows: [['目标', S.children[i].id], ['当前状态', S.children[i].state === 'running' ? '运行中' : '空闲'], ['信号', '成员走官方 interrupt；裸子会话走 interruptByParent']],
      needReason: false, okText: '确认打断', onOk: () => { S.children[i].state = 'ended'; render(); toast('已打断（演示）'); } }); return;
  }
  if (act === 'pendingSeen') { S.pendingSeen = true; toast('已标记「已查看」（记在插件本地；重启后从父会话日志重扫重建）'); return; }
  if (act === 'pendingHand') { toast('已把结果交回主会话（演示）'); return; }
}

/* ------------------------------------------------------------------ 9. 自测面板 */
function renderSelfcheck() {
  const box = $('selfcheck');
  if (!S.selfcheck) { box.hidden = true; return; }
  box.hidden = false;
  const rows = [
    ['原始节点（当前可见）', '编辑 / 批注'],
    ['替换体（当前可见）', '仍有「编辑」（可连续改）+ 版本历史'],
    ['旧替换体 / 已被遮蔽的原文', '无「编辑」，给原因 + 版本历史'],
    ['助手消息', '只给「批注」+ 原因'],
    ['工具结果', '「编辑」（只改内容文本/错误标记）+ 批注'],
    ['注入内容', '编辑 + 批注 + 存为不变量'],
    ['被压缩埋掉', '只能批注'],
    ['系统提示词 / 工具定义', '无动作条，也不留空占位']
  ];
  const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
  const rowW = document.querySelector('.row-main') ? document.querySelector('.row-main').getBoundingClientRect().width : 0;
  const btnH = document.querySelector('.actions .btn') ? document.querySelector('.actions .btn').getBoundingClientRect().height : 0;
  const sc = $('trendScroll');
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center"><b>自测面板</b><span class="muted">${S.sw.turnOpen ? '轮次未结束' : '轮次已闭合'} · ${S.sw.live ? '会话在本进程' : '不在本进程'} · 团队${S.sw.team ? '可用' : '不可用'} · 草稿 ${draftCount()}</span></div>
    <h4>趋势区</h4>
    <div>粒度 <code>${S.trendGran}</code> · 模式 <code>${S.trendMode}</code> · 自适应 <code>${S.trendAdaptive}</code> · 聚焦 <code>${S.trendCat || '全部'}</code></div>
    <div>柱数 <code>${(window.__trendSeries || []).length}</code> · 内容宽 <code>${sc ? Math.round(sc.scrollWidth) : 0}px</code> · 可视宽 <code>${sc ? Math.round(sc.clientWidth) : 0}px</code> · 需横向滚动 <span class="${sc && sc.scrollWidth > sc.clientWidth ? 'ok' : ''}">${sc && sc.scrollWidth > sc.clientWidth ? '是（正常，固定柱宽）' : '否'}</span></div>
    <div>当前刻度上限 <code>${sc ? sc.dataset.max : '-'}</code>（自适应＝只按可见范围）</div>
    <h4>该出现的按钮（对照 docs/03 R4.6）</h4>
    <ul class="list">${rows.map(([k, v]) => `<li><b>${k}</b>${v}</li>`).join('')}</ul>
    <h4>盒子测量</h4>
    <div>行宽 <code>${Math.round(rowW)}px</code> · 动作按钮高 <code>${Math.round(btnH)}px</code>（窄屏应 ≥44）</div>
    <div>整页横向溢出：<span class="${overflow ? 'bad' : 'ok'}">${overflow ? '有（不合格）' : '无'}</span></div>
    <h4>本原型不覆盖的门禁</h4>
    <div class="muted">真实会话写入、真实压缩、console 无报错、与 dsh-context 并存 —— 只能在装进 DSH 后验（docs/03 §7）。</div>`;
}

/* ------------------------------------------------------------------ 10. 讲解模式 */
/**
 * 讲解模式下要标编号的元素。
 * ⚠️ **同类重复元素只标一个**：趋势柱体（按步骤模式 72 根）与轮次刻度格如果每根都标，
 * 图表会被 100+ 个编号糊满（2026-10-01 实测：#trendScroll 里挂了 102 个编号），
 * 用户的原话是"我以为讲解模式只是加个编号，不会影响原来的样式"。
 * 柱体优先标**当前选中的那根**（用户正看着哪根，编号就落在哪根上）；刻度格标第一格。
 */
/**
 * 编号规则（2026-10-01 两次实测后才定下来的）：
 *   ① **连续**：取当前页面上"真实存在的类别"，按讲解词典里的先后顺序排好，依次编 1..N。
 *      —— 不能直接用"词典序号"当编号：那会留下空号（用户问"13、15、16、17…在哪里？"）。
 *   ② **稳定**：顺序由**类别**决定，不由"第几个出现"决定 ——
 *      按出现顺序现数的话，切按轮次/按步骤时前面的元素个数会变（步骤模式多一个 ✂ 标记、
 *      轮次模式的刻度格又没有 data-explain），实测"点轮次时第 1 步是 18、点按步骤时变成 20"。
 *   ③ 同类元素共用一个编号、只标一个（见 explainTargets）。
 */
const EXPLAIN_ORDER = Object.keys(EXPLAIN);
/** 当前页面上存在的类别 → 1..N 的编号（顺序 = 讲解词典顺序）。 */
function explainNumbering(nodes) {
  const present = [...new Set(nodes.map((el) => el.dataset.explain))]
    .filter((k) => EXPLAIN_ORDER.includes(k))
    .sort((a, b) => EXPLAIN_ORDER.indexOf(a) - EXPLAIN_ORDER.indexOf(b));
  return new Map(present.map((k, i) => [k, i + 1]));
}
function explainTargets() {
  const all = [...document.querySelectorAll('[data-explain]')];
  // 趋势区里同类元素成百上千（72 根柱、28 格刻度、若干 ✂），那里**每类只标一个**：
  // 全标的话图表会被编号糊满（实测 102 个）。区外元素不重复标。
  const chart = [...document.querySelectorAll('#trendScroll [data-explain]')];
  if (!chart.length) return all;
  const pickBy = (cls) => {
    const els = chart.filter((el) => el.classList && el.classList.contains(cls));
    return els.find((el) => el.classList.contains('sel')) || els[0];
  };
  const keep = new Set();
  for (const cls of ['tbar', 'tcell', 'mark']) { const el = pickBy(cls); if (el) keep.add(el); }
  // 通用规则（docs/03 §7）：**同类重复元素只标一个编号** —— 柱体标选中的那根、其余同类标第一个。
  const seen = new Set();
  return all.filter((el) => {
    if (chart.includes(el) && !keep.has(el)) return false;
    const k = el.dataset.explain;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function applyExplain() {
  document.body.classList.toggle('explain', S.explain);
  // 每次渲染都重建序号：先清旧的，避免残留（DOM 会被 render() 整体替换）
  document.querySelectorAll('.exnum').forEach((el) => el.remove());
  document.querySelectorAll('.explain-num').forEach((el) => el.classList.remove('explain-num'));
  const nodes = explainTargets();
  let bar = document.querySelector('.explainbar');

  if (S.explain) {
    const numbering = explainNumbering(nodes);
    nodes.forEach((el) => {
      const no = numbering.get(el.dataset.explain);
      el.dataset.exnum = String(no);
      /**
       * ⚠️ 关键：讲解的触达点是**这个序号本身**，不是被讲解的元素。
       * 用真实节点（不是 ::after 伪元素，伪元素点不到）—— 于是：
       *   · 点序号 → 看它是做什么的
       *   · 点按钮本身 → 照常走它自己的交互（不被拦截）
       * 之前我在捕获阶段拦了所有 [data-explain] 的点击，导致开着讲解模式就没法试按钮、只能刷新。
       */
      /* ⚠️ `select`/`input`/`textarea`/`img` **装不下子节点**：塞进去的 <span> 会被浏览器直接丢掉，
       *    于是"编号根本看不见"（用户 2026-10-01 问"11 编号在哪里？"就是 <select> 上的那个）。
       *    这类元素把编号挂到**父节点**上。 */
      const canHost = !['select', 'input', 'textarea', 'img', 'br', 'hr'].includes(String(el.tagName || '').toLowerCase());
      const host = canHost ? el : (el.parentElement || el);
      host.classList.add('explain-num');   // 高亮（::after 虚线环）只跟着有编号的元素走
      const badge = document.createElement('span');
      badge.className = 'exnum' + (el.closest && el.closest('.trendscroll') ? ' exnum-in' : '');
      badge.textContent = String(no);
      badge.setAttribute('role', 'button');
      badge.setAttribute('tabindex', '0');
      badge.setAttribute('title', `#${no} ${(EXPLAIN[el.dataset.explain] || {}).t || ''} —— 点这里看说明（不影响按钮本身）`);
      const show = (e) => {
        e.preventDefault();
        e.stopPropagation();          // 只吃掉这一次点击，别让它触发按钮自身
        openDrawer(el.dataset.explain);
      };
      badge.addEventListener('click', show);
      badge.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') show(e); });
      host.appendChild(badge);
    });
    if (!bar) { bar = document.createElement('div'); bar.className = 'explainbar'; document.body.appendChild(bar); }
        bar.innerHTML = `讲解模式已开：共 <b>${nodes.length}</b> 个序号 · 点<b>左上角序号</b>看它是做什么的；<b>按钮本身照常可用</b>（<span class="muted">Esc 关闭面板</span>）<span class="muted"> · 同类元素共用一个编号、只标一个</span>`;
  } else if (bar) bar.remove();
}

/* ------------------------------------------------------------------ 11. 渲染 + 事件 */
function render() {
  applyTheme();
  renderSwitches(); renderNotice();
  renderStats(); renderTrend(); renderStep(); renderEvents();
  renderBrowser();
  $('stickyDrafts').hidden = draftCount() === 0;
  $('stickyDrafts').innerHTML = `<span>还有 <b>${draftCount()}</b> 条改动未生效</span>
    <button class="btn sm" data-act="applyAll">逐条应用到会话</button>
    <button class="btn sm ghost" data-act="discardAll">放弃未应用的改动</button>`;
  $('stickyDrafts').querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.act === 'discardAll') {
        confirmModal({ title: '放弃未应用的改动', warn: '只清本地草稿，不影响会话；未保存的输入会丢失。', rows: [['将丢弃', Object.keys(S.drafts).map((s) => '#' + s).join(' · ')]], needReason: false, okText: '确认放弃', onOk: () => { S.drafts = {}; render(); toast('已清空本地草稿（会话未动）'); } });
      } else {
        confirmModal({ title: '逐条应用到会话', warn: '会向会话追加替换记录，之后无法删除；原文对模型永久不可见（日志里仍在）。', rows: Object.keys(S.drafts).map((s) => ['#' + s, (draftOf(Number(s)).text || '').slice(0, 90)]), needReason: false, okText: '确认逐条应用', onOk: () => { Object.keys(S.drafts).forEach((s) => doApply(Number(s))); } });
      }
    };
  });
  renderBlocks(); renderOrch(); applyExplain(); renderSelfcheck();
}

/**
 * 主题**跟随系统**（用户 2026-10-01：不要那个切换按钮）。
 * 深色落到 `body[data-ds-dark-theme]` —— 这正是 DSH 自己的深色选择器（docs/03 V2），
 * 所以 demo 与真机上的表现是同一条通道；`?theme=dark|light` 是给验证用的调试钩子。
 */
/** 读 URL 上的调试开关（?dev=1 / ?theme=dark|light）。
 *  用 window.location + try 包住：冒烟测试的 DOM 桩里没有 location，不能让整个页面挂掉。 */
function queryFlag(k) {
  try { return new URLSearchParams((window.location && window.location.search) || '').get(k); }
  catch (e) { return null; }
}
function applyTheme() {
  const forced = queryFlag('theme');
  const dark = forced === 'dark' || (forced !== 'light' && !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
  if (dark) document.body.setAttribute('data-ds-dark-theme', '');
  else document.body.removeAttribute('data-ds-dark-theme');
}
{
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (mq && mq.addEventListener) {
    mq.addEventListener('change', () => { if (!queryFlag('theme')) { applyTheme(); render(); } });
  }
}
$('btnExplain').onclick = () => { S.explain = !S.explain; if (!S.explain) closeDrawer(); $('btnExplain').setAttribute('aria-pressed', String(S.explain)); render(); toast(S.explain ? '讲解模式：点任一高亮元素看说明' : '讲解模式已关'); };
// 自测面板是**自检工具**，不再占顶栏：?dev=1 直接打开（见 demo/README）
if (queryFlag('dev') === '1') S.selfcheck = true;
$('btnReset').onclick = () => { S = initial(); render(); toast('原型已重置'); };
$('drawerClose').onclick = () => closeDrawer();
$('modalCancel').onclick = () => { $('modalWrap').hidden = true; };
// 捕获阶段**只做一件事**：窄屏（遮罩式）时点面板外关闭。
// ⚠️ 绝不再拦截 [data-explain] 的点击 —— 那会让讲解模式把按钮本身的交互全部吃掉。
document.addEventListener('click', (e) => {
  const drawer = $('drawer');
  if (!drawer || drawer.hidden) return;
  const narrow = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 899px)').matches : false;
  const insideDrawer = !!(e.target.closest && e.target.closest('.drawer'));
  if (narrow && !insideDrawer) closeDrawer();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { S.editor = null; $('modalWrap').hidden = true; closeDrawer(); render(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && S.editor) submitEditor();
  if (!S.editor && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const list = reqsOfTurn(S.selTurn), i = list.findIndex((r) => r.seq === S.selSeq);
    const n = list[i + (e.key === 'ArrowRight' ? 1 : -1)];
    if (n) selectReq(n, null);
  }
});

/* 预置：两条冻结记录 + 一个成员与任务，让首屏就有内容可点 */
(function seed() {
  /* 首屏那条记录**故意冻在最新切点**（28·3 = 当前最后一个轮次末）⟹ 它可与平台实际种子重合，按钮可用。
   * 更要紧的是：一旦父会话又跑完一轮，它的切点就**不再是**最新 ⟹ 按 `docs/01` F38 它立刻变成"更早的记录"，
   * 按钮消失、只留原因标记 —— 这正是评审 P0 要求界面对用户如实交代的那件事。 */
  S.snapshots.push({ id: 'snap-20260930-120412', cut: '28·3', inv: 'none', turn: 28, items: 41, time: '12:04', note: '改完注入漂移，准备开子会话', blocks: [] });
  S.children.push({ id: '004c37a5', src: 'own', state: 'running', label: '把 README 双语改完并跑测试', from: 'snap-20260930-120412' });
  S.children.push({ id: '00a1b2c3', src: 'team', state: 'idle', label: 'reviewer（官方 teammate）' });
  S.members.push({ name: 'lead（当前会话）', st: 's-run' }, { name: 'reviewer', st: 's-idle' }, { name: 'tester', st: 's-done' });
  S.tasks.push({ subject: '改 README 双语', owner: 'reviewer', blocked: false, st: 's-run' });
  S.tasks.push({ subject: '跑全量测试', owner: '', blocked: true, st: 's-block' });
  S.tasks.push({ subject: '出发布说明', owner: 'tester', blocked: false, st: 's-done' });
})();

render();
