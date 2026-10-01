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
  'trend.strip': { t: '轮次分组条', what: '按步骤模式下，柱子下面按轮分组的刻度带（每格标轮号，宽度 = 该轮步数）。', effect: '点一格 = 选中该轮末步。讲解模式下**只标第一格**，每一格行为都一样。', rev: '随时可改选', confirm: '不需要', refs: ['docs/03 R1.8'] },

  'turn.pick': { t: '选择某一轮', what: '点轮次条 = 让右侧浏览器切到该轮最后一步。', effect: '右侧标题变成"第 T 轮（共 N 步，显示末步）"，分类条数/token/占比跟着变。', rev: '随时可切别的轮', confirm: '不需要', refs: ['docs/03 R1.1'] },
  'turn.inject': { t: '改这一轮的注入内容', what: '切到这一轮**最后一条注入内容**（AGENTS.md / memory-doc / runtime-context 这类每轮由宿主重新注入的东西），就地展开编辑器。', effect: '注入内容才是最容易让模型理解错的那一半；而且它每轮会被重新注入 —— 改一轮漂一轮，所以改完通常还要「存为不变量」把口径钉住。', rev: '只切视图与展开编辑器，不改任何内容', confirm: '不需要', refs: ['docs/03 R1.16'] },
  'act.reinject': { t: '重注入固定块', what: '把这块正文**逐字**作为一条消息重新注入会话。', effect: '会往会话追加一条消息，不可撤销；插件不改一个字。用于"宿主这轮没注入 / 被改漂了"时把口径重新钉回去。', rev: '不可撤销（追加即落地）', confirm: '要（列出块版本与正文逐字）', refs: ['docs/03 R4.3', 'docs/00 G4'] },
  'act.retire': { t: '退休固定块', what: '让这块不再生效（历史版本保留）。', effect: '之后漂移检查不再盯它；冻结记录里"在效固定块版本"跟着变；已开出去的子会话不受影响。', rev: '可重新保存为新版本', confirm: '要', refs: ['docs/03 R4.3', 'docs/06 §1'] },
  'step.pick': { t: '步级选择', what: '选某一步（或回到"当前（下一次请求）"）。', effect: '右侧展示该步的上下文构成；与轮次入口交叉比对应当逐项一致。', rev: '随时可切', confirm: '不需要', refs: ['docs/03 R1.2'] },
  'step.chip': { t: '步级快捷片', what: '当前选中轮次的每一步一片，点一下就切到那一步。', effect: '等于用步级下拉选同一件事，但少两次点击。', rev: '随时可切', confirm: '不需要', refs: ['docs/03 R1.9'] },
  'step.nav': { t: '上一轮 / 下一轮 · 上一步 / 下一步', what: '在轮与步之间顺序移动（不用去点趋势图）。', effect: '到边界时按钮禁用。', rev: '随时可用', confirm: '不需要', refs: ['docs/03 R1.10'] },

  'cat.toggle': { t: '展开 / 收起分类', what: '展开某类（系统提示词 / 工具定义 / 用户消息 / 注入内容 / 技能注入 / 助手消息 / 工具结果）。', effect: '列出该类里的每一条（带 #seq、时间、token）。**点类名左侧的色块 = 聚焦到趋势图**。', rev: '再点一次收起', confirm: '不需要', refs: ['docs/03 §2'] },
  'row.toggle': { t: '展开这一条', what: '看这一条的正文。', effect: '就地展开全文（不跳页）。', rev: '再点一次收起', confirm: '不需要', refs: ['docs/03 R2.2'] },

  'act.edit': { t: '编辑（遮蔽原文）', what: '改写这一条的内容。', effect: '先把改动存成本地草稿（模型还看不到）；确认后才"应用到会话"，届时原文被替换、模型再也看不到原文（但日志里仍在）。', rev: '草稿可放弃；已应用的改动可用"版本历史"恢复', confirm: '提交时要', refs: ['docs/03 R2.2 / R3.3', 'docs/01 F7'] },
  'act.annotate': { t: '批注（保留原文）', what: '不遮蔽原文，追加一条带"作废范围"的更正。', effect: '模型会同时看到原文与更正。', rev: '不可撤销（追加即落地）', confirm: '提交时要', refs: ['docs/03 R2.2', 'docs/01 F6'] },
  'act.pin': { t: '存为不变量', what: '把注入类的这段正文逐字保存为固定块。', effect: '插件不生成、不润色、不改一个字；以后逐字比对就能发现漂移，并可显式重注入。', rev: '可退休（历史保留）', confirm: '保存时要', refs: ['docs/00 G4', 'docs/06 §1'] },
  'act.apply': { t: '应用到会话', what: '把这条草稿真的写进会话。', effect: '追加一条替换事件；模型此后看到的是改后的内容；原文仍保留在日志里但不再可见。', rev: '不可撤销（可用版本历史恢复某一版）', confirm: '要，且会列出本次清单', refs: ['docs/03 R4.3', 'docs/01 F7.1'] },
  'act.history': { t: '版本历史', what: '看这一条的全部版本：原始 → 每次改写 → 每次回滚（**跨替换体**，按行身份串起来）。', effect: '只读展示；可选中某一版"恢复"。', rev: '只读', confirm: '不需要', refs: ['docs/03 R4.5', 'docs/00 S8'] },
  'act.restore': { t: '恢复这一版', what: '把"模型看到的内容"变回你选的那一版。', effect: '再追加一条替换事件——不是删除，错的那版仍在日志里但不再可见。', rev: '再次替换即可换别的版本', confirm: '要', refs: ['docs/03 R4.5', 'docs/00 S8'] },

  'orch.freeze': { t: '冻结当前位置', what: '记录一个冻结点：切点（最后一个 turn/end）、条目数、时间、人写备注、在效固定块版本。', effect: '只写插件本地，不写会话、不改模型可见内容。', rev: '可删除', confirm: '要（说明只写本地）', refs: ['docs/00 S5.2', 'docs/03 R5.1'] },
  'orch.spawn': { t: '开子会话', what: '用这个会话已完成的轮次做种子，开一个新的子会话/成员，首条任务由你写。', effect: '优先走官方 spawnTeammate(context:"fork")（进官方名册）；团队不可用时退化为"裸可续接子会话"（界面如实标注）。种子是一次性的。', rev: '会话可归档，但种子不可重来', confirm: '要（框内列五项）', refs: ['docs/06 §3.1 / §4.1', 'docs/01 F33'] },
  'child.open': { t: '打开', what: '跳到官方视图看这个子会话/成员的完整过程。', effect: '优先在右侧 Sidebar 打开；本插件不重画对话。', rev: '只读跳转', confirm: '不需要', refs: ['docs/03 R5.1.1'] },
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
  sw: { turnOpen: false, live: true, team: true, drafts: 0, compressBusy: false, pendingState: 'settled', noUser: false },
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
  $('modalReason').value = '';
  $('modalOk').textContent = o.okText || '确认';
  $('modalWrap').hidden = false;
  $('modalOk').onclick = () => {
    const reason = o.needReason ? $('modalReason').value.trim() : '';
    if (o.needReason && reason === '') { toast('理由不能为空（会写进记录）', 'err'); return; }
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

/* ------------------------------------------------------------------ 4. 状态开关 / 说明条 */
function renderSwitches() {
  const items = [['turnOpen', '轮次未结束'], ['live', '会话在本进程'], ['team', '官方团队可用'], ['compressBusy', '子会话正忙（压缩会 busy）'], ['noUser', '本轮没有用户消息']];
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
    <div class="card-title">上下文统计 <span class="hint">（当前视图：第 ${r.turn} 轮 · 第 ${r.step} 步${isLive() ? ' · 当前' : ''}）</span></div>
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
            : list.map((r) => `<button class="tcell" data-seq="${r.seq}" style="width:${BAR_W + BAR_GAP}px" title="第 ${r.turn} 轮 · 共 ${r.stepCount} 步">${r.turn}</button>`).join('')}
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
  c.querySelectorAll('.tcell').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.seq) { selectReq(REQUESTS.find((r) => r.seq === Number(b.dataset.seq)), null); return; }
      const t = Number(b.dataset.turn);
      selectReq(lastOfTurn(t), `已选第 ${t} 轮（该轮末步）`);
    };
  });
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
  S.editor = { kind: 'edit', seq: hit.node.seq, text: hit.node.text, reasoning: '' };
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
    <div class="card-title">第 ${r.turn} 轮 · 第 ${r.step} 步（共 ${turnSteps(r.turn)} 步） <span class="hint">${r.time}${isLive() ? ' · 当前（下一次请求）' : ''}</span></div>
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
    <div class="card-title">上下文事件 <span class="hint">（压缩 / 裁剪，会标在趋势图上）</span></div>
    <div class="cap" style="margin-bottom:4px"><b>✂ = 上下文被压缩 / 剪枝的位置</b>；每个事件只标在它之后的<b>第一个请求</b>上（鼠标移到 ✂ 上看详情，点它可跳到那一次）。</div>
    ${EVENTS.map((e) => `<div class="cap">#${e.seq} · ✂ ${KIND_LABEL[e.kind]} · ${esc(e.label)} → 标在第 ${(REQUESTS.find((r) => r.seq >= e.seq) || {}).turn} 轮 · 第 ${(REQUESTS.find((r) => r.seq >= e.seq) || {}).step} 步</div>`).join('')}
    <div class="cap" style="margin-top:4px">共 ${TOTAL_TURNS} 轮 / ${REQUESTS.length} 次请求 —— 把趋势条拉宽就能看到全部。</div>`;
}

/* ------------------------------------------------------------------ 6. 右侧浏览器 */
function ability(node) {
  const gone = goneMap();
  const repl = isReplacement(node.seq);
  const shadowed = gone[node.seq] !== undefined && !repl;
  const type = node.type;
  const canRewrite = !shadowed && type !== 'assistant/message' && type !== 'system/message' && !node.compacted;
  return {
    canRewrite, shadowed, isReplacement: repl, canAnnotate: true, isInjection: node.cat === 'inject',
    blockReason: shadowed ? `这一条已被 #${gone[node.seq]} 接替，已不在模型可见内容里`
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
    <div class="actions" data-rowactions="${node.seq}">
      <span class="seq">#${node.seq}</span>${draft}${tail}${chain.length ? '<span class="chain">（这里被改过）</span>' : ''}
      ${a.canRewrite ? `<button class="btn sm" data-act="edit" data-seq="${node.seq}" data-explain="act.edit">编辑</button>` : `<span class="chip-soft" title="${esc(a.blockReason)}">${esc(a.blockReason.slice(0, 14))}…</span>`}
      <button class="btn sm" data-act="annotate" data-seq="${node.seq}" data-explain="act.annotate">批注</button>
      ${a.isInjection ? `<button class="btn sm" data-act="pin" data-seq="${node.seq}" data-explain="act.pin">存为不变量</button>` : ''}
      ${draftOf(node.seq) ? `<button class="btn sm danger" data-act="apply" data-seq="${node.seq}" data-explain="act.apply">应用到会话</button>` : ''}
      ${familyOf(node.seq).length > 1 || node.versions ? `<button class="btn sm ghost" data-act="history" data-seq="${node.seq}" data-explain="act.history">版本历史</button>` : ''}
    </div>
    ${S.historyFor === node.seq ? historyHtml(node) : ''}
    ${S.editor && S.editor.seq === node.seq ? editorHtml() : ''}
  </div>`;
}
function editorHtml() {
  const st = S.editor, blocked = S.sw.turnOpen || !S.sw.live;
  const title = st.kind === 'edit' ? `编辑 #${st.seq}（遮蔽原文）` : st.kind === 'annotate' ? `批注 #${st.seq}（保留原文）` : `把 #${st.seq} 存为不变量`;
  const note = st.kind === 'pin' ? '固定块逐字保存：插件不生成、不润色、不压缩。'
    : st.kind === 'annotate' ? '提交后会往会话追加一条更正消息，不可撤销；原文不会被遮蔽，模型两者都看到。'
    : '这一步只存本地草稿（不进会话）。要生效，提交后还需点「应用到会话」。';
  // docs/03 R3.4：多段文本会被合并为一段 → 编辑器上方常驻一行灰字（仅在原消息确实是多段时出现）
  const multiPara = st.kind === 'edit' && /\n\s*\n/.test(String(st.text || ''));
  return `<div class="editor">
    <p class="etitle">${esc(title)}</p>
    <p class="enote">${esc(note)}</p>
    ${multiPara ? '<p class="enote">这条消息有多个文本段落；改写后会合并为一段。</p>' : ''}
    ${st.kind === 'edit' ? `
      <label class="field"><span>思考文本（可选；留空则沿用原文）</span><textarea rows="2" id="edR">${esc(st.reasoning || '')}</textarea></label>
      <label class="field"><span>可见文本（预填的是宿主全文，不是 80 字预览）</span><textarea rows="4" id="edT">${esc(st.text)}</textarea></label>`
    : st.kind === 'annotate' ? `
      <label class="field"><span>理由</span><textarea rows="2" id="edWhy" placeholder="一句话说明为什么更正">${esc(st.reason || '')}</textarea></label>
      <div style="display:flex;gap:8px">
        <label class="field" style="flex:1"><span>作废范围（起点 seq）</span><input type="number" id="edFrom" value="${esc(st.voidFrom)}"></label>
        <label class="field" style="flex:1"><span>作废范围（终点 seq）</span><input type="number" id="edTo" value="${esc(st.voidTo)}"></label>
      </div>`
    : `
      <label class="field"><span>标签</span><input type="text" id="edLabel" value="${esc(st.label || '')}" placeholder="例如「目标」「约束」"></label>
      <label class="field"><span>正文（逐字保存）</span><textarea rows="4" id="edPin">${esc(st.text)}</textarea></label>`}
    ${blocked ? `<p class="eblocked">${S.sw.turnOpen ? '当前轮次还没结束 —— 改动只能在轮次边界提交。' : '这个会话不在本进程里，只能查看，不能编辑。'}</p>` : ''}
    ${S.editorError ? `<p class="emsg-err">${esc(S.editorError)}</p>` : ''}
    ${S.editorOk ? `<p class="emsg-ok">${esc(S.editorOk)}</p>` : ''}
    <div class="efoot">
      <button class="btn sm" data-act="esubmit" ${blocked ? 'disabled' : ''}>${st.kind === 'pin' ? '保存为固定块' : st.kind === 'annotate' ? '提交更正到会话' : '保存草稿'}</button>
      <button class="btn sm ghost" data-act="ecancel">取消（Esc）</button>
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
  S.editor = { kind: 'edit', seq: hit.node.seq, text: hit.node.text, reasoning: '' };
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
  const here = nodesOfReq(reqOf(), true).filter((n) => n.cat === 'inject');
  if (b.retired) return { ok: false, code: 'retired', why: '已退休：不再生效（历史版本保留）' };
  const hit = here.find((n) => String(n.text || '').includes(b.text));
  if (hit) return { ok: true, code: 'pinned', seq: hit.seq, why: `逐字命中 #${hit.seq}${hit.name ? '（' + hit.name + '）' : ''}` };
  const edited = here.find((n) => S.applied.some((a) => a.replacedSeq === n.seq || a.newSeq === n.seq));
  return {
    ok: false, code: edited ? 'edited' : 'missing',
    why: edited ? `这一步的注入被改写过（#${edited.seq}），钉住的原文已不在里面` : '当前这一步的注入内容里找不到这段正文'
  };
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
        <span class="orch-note">正文逐字：${esc(b.text.slice(0, 46))}${b.text.length > 46 ? '…' : ''}</span>
        <button class="btn sm" data-act="breinject" data-id="${esc(b.id)}" data-explain="act.reinject">重注入</button>
        <button class="btn sm ghost" data-act="bretire" data-id="${esc(b.id)}" data-explain="act.retire" ${b.retired ? 'disabled' : ''}>退休</button>
      </div>
    </div>`;
  }).join('');
  box.innerHTML = `
    <div class="card-title">固定块（不变量） <span class="hint">注入内容每轮会被宿主重新注入 —— 钉住它，才能发现"漂了没有"</span></div>
    <div class="cap" style="margin-bottom:4px">逐字保存：插件不生成、不润色、不压缩。漂移检查只做<b>逐字包含</b>判断（不含推断）。</div>
    ${S.invariants.length ? rows : '<div class="cap">还没有固定块。在<b>注入内容</b>那一类里点某条的「存为不变量」（例如 <b>AGENTS.md</b> / <b>memory-doc</b> / <b>runtime-context</b>）。</div>'}`;
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
      onOk: (reason) => {
        const live = REQUESTS[REQUESTS.length - 1];
        S.extraNodes.push(N(1400 + S.extraNodes.length, 'inject', 'user/message', b.text, Math.round(b.text.length * 1.6),
          { name: b.label }));
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
    <div class="card-title">快照与子会话 <span class="hint">A′：只做快照化子会话 + 对接官方；不自己造协作层</span></div>

    <div class="orch-toolbar">
      <input id="snapNote" placeholder="人写备注（插件不生成摘要）" />
      <button class="btn sm" data-act="freeze" data-explain="orch.freeze" ${!S.sw.live || draftCount() > 0 ? 'disabled' : ''}>冻结当前位置</button>
      <button class="btn sm" data-act="spawn" data-explain="orch.spawn" ${!S.sw.live || draftCount() > 0 || !S.snapshots.length ? 'disabled' : ''}>开子会话（人写首条任务）</button>
      ${draftCount() > 0 ? `<span class="cap warn-text">还有 ${draftCount()} 条草稿没提交 —— 草稿不在 fork 种子里，也不在冻结记录里，它只存在插件本地。</span>` : ''}
    ${S.invariants.filter((b) => !b.retired).length === 0 ? '<span class="cap">建议先把目标 / 约束（尤其是每轮被重新注入的那几条）存为固定块，否则子会话里没人守漂移。</span>' : ''}
    </div>

    <div class="subhead">冻结记录 <span class="hint">只写本地，不写会话</span></div>
    ${S.snapshots.length
      ? S.snapshots.map((s) => `
      <div class="orch-row">
        <div class="orch-id">
          <span class="snapid">${esc(s.id)}</span>
          <span class="cap">第 ${s.turn} 轮末 · ${s.items} 条 · ${s.time}</span>
          <span class="orch-note orch-desc">人写备注：${esc(s.note || '（无）')}</span>
        </div>
      </div>`).join('')
      : '<div class="cap">还没有冻结记录。建议：先把草稿清零 → 冻结 → 再开子会话。</div>'}

    <div class="subhead">子会话 / 成员索引 <span class="hint">活跃 ${active} / 8 · 官方 teammate 也占同一份额度</span></div>
    ${c.length === 0 ? '<div class="cap">（还没有子会话）</div>' : c.map((x, i) => {
      const [stCls, stText] = stateOf(x.state);
      return `
      <div class="orch-row">
        <div class="orch-id">
          <span class="snapid">${esc(x.id)}</span>
          <span class="${x.src === 'own' ? 'badge-src-own' : 'badge-src-team'}">${x.src === 'own' ? '本项目发起' : '来自 Agent Teams'}</span>
          <span class="badge-state"><i class="mstat ${stCls}"></i>${stText}</span>
          <span class="cap orch-desc">${esc(x.label)}${x.from ? ' · 来自快照 ' + esc(x.from) : ''}</span>
        </div>
        <div class="orch-actions">
          <button class="btn sm ghost" data-act="copen" data-i="${i}" data-explain="child.open">打开</button>
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

    <div class="subhead">待处理的结果 <span class="hint" data-explain="pending.view">结算通知由平台尽力投递，投不到就说投不到</span></div>
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

    <div class="subhead">官方团队 <span class="hint" data-explain="team.read">只读 —— 显示的就是官方那份数据</span></div>
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
        <button class="btn sm ghost" data-act="teamOpen" data-explain="team.read">去官方面板</button>
        <span class="cap">成员导航复用官方，我们不在面板里重画对话</span>
      </div>`
      : '<div class="cap">本机未启用官方智能体团队 → 派活 / 建成官方任务 / 成员式打断全部不出现（不是报错）。</div>'}`;
  $('cardOrch').querySelectorAll('[data-act]').forEach((b) => { b.onclick = (e) => { e.preventDefault(); orchAct(b); }; });
}

/* ------------------------------------------------------------------ 8. 动作 */
function rowAct(btn) {
  const act = btn.dataset.act;
  S.editorError = null; S.editorOk = null;
  if (act === 'esubmit') return submitEditor();
  if (act === 'ecancel') { S.editor = null; render(); return; }
  const seq = Number(btn.dataset.seq), node = nodeOf(seq);
  if (!node) return;

  if (act === 'edit') { S.editor = { kind: 'edit', seq, text: node.text, reasoning: '' }; S.historyFor = null; render(); toast(`打开 #${seq} 的内联编辑器（预填的是全文，不是 80 字预览）`); }
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
    const text = ($('edT') && $('edT').value) || '', reasoning = ($('edR') && $('edR').value) || '';
    if (text === '' && reasoning === '') { S.editorError = '可见文本与思考文本不能同时为空'; render(); return; }
    if (text === node.text && reasoning === '') { S.editorError = '没有实质改动 —— 宿主会拒绝这样的提交（no-change）'; render(); return; }
    S.drafts[st.seq] = { seq: st.seq, text, reasoning, updatedAt: '12:1x', requestSeq: reqOf().seq };
    S.editor = null; render(); toast('已保存草稿（模型还看不到）→ 行上出现「未生效」，点「应用到会话」才生效'); return;
  }
  if (st.kind === 'annotate') {
    const reason = ($('edWhy') && $('edWhy').value.trim()) || '';
    const from = Number(($('edFrom') && $('edFrom').value) || ''), to = Number(($('edTo') && $('edTo').value) || '');
    if (reason === '') { S.editorError = '理由不能为空'; render(); return; }
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) { S.editorError = '作废范围要两端都给、且起点 ≤ 终点（bad-range）'; render(); return; }
    const ns = 1500 + S.extraNodes.length;
    const text = `[redline] 更正目标 seq=${st.seq}\n作废范围 seq=${from}..${to}\n理由：${reason}`;
    S.extraNodes.push(N(ns, 'inject', 'user/message', text, 60, { requestSeq: reqOf().seq, name: '批注' }));
    const r = reqOf(); if (!r.surface.includes(ns)) r.surface.push(ns);
    S.editor = null; render(); toast(`已追加更正 #${ns}（不可撤销）；原文 #${st.seq} 仍在模型可见内容里`); return;
  }
  if (st.kind === 'pin') {
    const label = (($('edLabel') && $('edLabel').value.trim()) || '目标'), text = ($('edPin') && $('edPin').value) || '';
    if (text.trim() === '') { S.editorError = '固定块正文不能为空'; render(); return; }
    const version = S.invariants.filter((x) => x.label === label).length + 1;
    S.invariants.push({
      id: 'inv-' + label.replace(/\s+/g, '-').slice(0, 16) + '-' + version,
      label, text, version, retired: false, scope: 'workspace',
      savedAt: '12:1' + (S.invariants.length % 9)
    });
    S.editor = null; render(); toast(`已存为固定块「${label}」（逐字，插件不改一个字）；换会话仍可见 → 每轮逐字比对即可发现漂移`);
  }
}
function doApply(seq) {
  // ⚠️ 新条目的 seq 从 **1600** 起（不是 1300）：演示数据里已经有 1300/1301/1303/1305 这些条目，
  //    从 1300 起算的话**连改两次就会撞号** —— nodeOf() 会命中演示里那条同名 seq，张冠李戴（2026-10-01 实测）。
  const d = draftOf(seq), node = nodeOf(seq), ns = 1600 + S.applied.length;
  S.applied.push({ replacedSeq: seq, newSeq: ns, requestSeq: reqOf().seq, text: d.text, reason: d.reason || '', time: '12:1' + (S.applied.length % 9) });
  S.extraNodes.push(N(ns, node.cat, node.type, d.text, node.tokens, { name: node.name, requestSeq: reqOf().seq }));
  delete S.drafts[seq];
  render(); toast(`已应用：#${seq} 被遮蔽 → 新条目 #${ns}（原文仍在日志里；可用版本历史恢复）`);
}
function orchAct(b) {
  const act = b.dataset.act, i = Number(b.dataset.i);
  if (act === 'freeze') {
    const note = ($('snapNote') && $('snapNote').value.trim()) || '';
    const id = 'snap-20260930-' + String(120000 + S.snapshots.length * 137).slice(0, 6);
    S.snapshots.push({ id, turn: reqOf().turn, items: surfaceOf().length, time: '12:1' + (S.snapshots.length % 9), note });
    render(); toast('已冻结（只写插件本地：切点 / 条目数 / 时间 / 人写备注 / 固定块版本 —— 不写会话）'); return;
  }
  if (act === 'spawn') {
    confirmModal({
      title: '允许创建子会话',
      warn: '会用这个会话「已完成的轮次」做种子新建一个子会话（种子是一次性的：之后本会话的新轮次不会进去）。',
      rows: [['① 种子范围', `第 ${reqOf().turn} 轮末（cutSeq = 最后一个 turn/end）`],
             ['② 首条任务', '（见下方理由栏 —— 必须由你写）'],
             ['③ 继承范围', '✅ 继承：已完成的对话历史（含你已应用的编辑）｜❌ 不继承：父会话的工具授权/权限；父会话也不会自动收到子会话的 transcript / 工具输出 / 思考'],
             ['④ 副作用', S.sw.team ? '走官方 spawnTeammate(context:"fork") → 进官方名册（任务板/成员导航/派活都有）' : '团队不可用 → 退化为"裸可续接子会话"（没有任务板与官方派活）'],
             ['⑤ 取消', '取消 = 什么都不发生（不建会话、不写日志）']],
      needReason: true, okText: '确认创建',
      onOk: (reason) => {
        const id = '00' + (49000 + S.children.length * 771).toString(16).slice(0, 6);
        S.children.push({ id, src: 'own', state: 'running', label: reason.slice(0, 24), from: S.snapshots.length ? S.snapshots[S.snapshots.length - 1].id : 'snap-（当前）' });
        render(); toast(`已创建 ${id}（看索引行；来源徽章 = 本项目发起）`);
      }
    }); return;
  }
  if (act === 'copen') { openDrawer('child.open'); toast('（演示）这里会跳到官方视图：父会话页头血缘目录 / 右侧 Sidebar 打开它的对话'); return; }
  if (act === 'teamOpen') { toast('（演示）这里会跳到官方团队面板：成员导航与任务板都复用官方那一份'); return; }
  if (act === 'csend') {
    confirmModal({ title: '派活（经官方通道）', warn: '会向子会话写入一条任务消息，不可撤销。',
      rows: [['收件人', S.children[i].id], ['逐字任务正文', '（见理由栏）'], ['投递方式', '排队下一轮（queue）'], ['理由', '（见理由栏）']],
      needReason: true, okText: '确认发送', onOk: (reason) => toast(`已发送（模拟官方返回 accepted）：${reason.slice(0, 30)}`) }); return;
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
  S.snapshots.push({ id: 'snap-20260930-120412', turn: 27, items: 41, time: '12:04', note: '改完注入漂移，准备开子会话' });
  S.children.push({ id: '004c37a5', src: 'own', state: 'running', label: '把 README 双语改完并跑测试', from: 'snap-20260930-120412' });
  S.children.push({ id: '00a1b2c3', src: 'team', state: 'idle', label: 'reviewer（官方 teammate）' });
  S.members.push({ name: 'lead（当前会话）', st: 's-run' }, { name: 'reviewer', st: 's-idle' }, { name: 'tester', st: 's-done' });
  S.tasks.push({ subject: '改 README 双语', owner: 'reviewer', blocked: false, st: 's-run' });
  S.tasks.push({ subject: '跑全量测试', owner: '', blocked: true, st: 's-block' });
  S.tasks.push({ subject: '出发布说明', owner: 'tester', blocked: false, st: 's-done' });
})();

render();
