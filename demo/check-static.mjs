// demo 的「静态契约检查」——没有浏览器也能跑的那种自检。
// 用法：node demo/check-static.mjs
//
// 查三件事（都是我在没有浏览器工具时最容易踩的坑）：
//   1) demo.js 里 $('xxx') / getElementById('xxx') 用到的 id，必须在 HTML 里、或由 demo.js 自己渲染出来
//   2) demo.js 里写出的 class，必须在 demo.css 里有对应规则（防止样式漏写、看起来"没生效"）
//   3) 每个 data-explain="key" 必须在 EXPLAIN 里有条目（否则讲解模式点开是空的）
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const dir = new URL('./', import.meta.url);
const rd = (f) => readFileSync(new URL(f, dir), 'utf8');
const html = rd('redline-panel.html');
const js = rd('demo.js');
const css = rd('demo.css');
const standalone = rd('redline-panel.standalone.html');

const uniq = (a) => [...new Set(a)];
const problems = [];

/* 1) id 契约 */
const idsInHtml = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const idsInJs = new Set([...js.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const idsUsed = uniq([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1])
  .concat([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1])));
for (const id of idsUsed) {
  if (!idsInHtml.has(id) && !idsInJs.has(id)) problems.push(`id 用到但没有定义：${id}`);
}

/* 2) class 契约（只看 demo.js 自己写出来的 class） */
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
// 只认「纯标识符」的 class：模板串里的三目表达式（${a === b ? 'sel' : ''}）会切出一堆碎片，
// 那些不是 class 名，检查器踩过一次（把 === / S.selSeq 当成 class 报错）。
const jsClasses = uniq([...js.matchAll(/class="([^"]*)"/g)]
  .flatMap((m) => m[1].split(/\s+/))
  .filter((c) => /^[a-zA-Z][\w-]*$/.test(c)));
for (const c of jsClasses) {
  if (!cssClasses.has(c)) problems.push(`class 没有对应样式：.${c}`);
}

/* 3) 讲解词典契约 */
const explainKeys = new Set([...js.matchAll(/^\s*'([\w.]+)':\s*\{/gm)].map((m) => m[1]));
const usedExplain = uniq([...js.matchAll(/data-explain="([^"]+)"/g)].map((m) => m[1]).filter((k) => !k.includes('$')));
for (const k of usedExplain) {
  if (!explainKeys.has(k)) problems.push(`data-explain 没有讲解词：${k}`);
}

/* 回归护栏：讲解模式**不许**在捕获阶段拦截 [data-explain] 的点击
 * （旧实现写成 `if (S.explain && el) { e.preventDefault(); ... }` → 开着讲解模式就点不动任何按钮） */
if (/closest\('\[data-explain\]'\)/.test(js) && !/badge\.addEventListener/.test(js)) {
  problems.push('讲解模式的点击拦截又回来了：必须只让序号节点触发讲解，不能拦按钮本身');
}

/* 4) 趋势柱体的「看得见」契约（用户 2026-10-01 反馈：移上去/点中了都看不出是哪一根）
 * 照参考插件 dsh-context 的 trendChart 定死四条，缺一条就等于没做：
 *   · 命中区 = **整列**（色块画在内层 .tbar-fill 上）—— 短柱子上方的空白也要能移中；
 *   · hover 必须有**底色/亮度**变化，不能只给一根 1px 虚线；
 *   · 选中必须有**实线框 + 底色**；
 *   · `.tbar.sel` 的规则必须声明在 `.tbar:hover` **之后** —— 参考插件源码专门注释过这个顺序陷阱：
 *     反了的话，鼠标停在刚点过的柱子上时虚线 hover 会盖掉实线选中，只有移开才看得见选中。 */
{
  // ⚠️ 先剥掉 CSS 注释：注释里为了解释病因会写出 `body.explain … .tbar` 这样的字样，
  //    不剥的话会被当成真实规则误报（第一版就是这么白红了一次）
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ruleAt = (sel) => { const m = new RegExp(escRe(sel) + '\\s*\\{([^}]*)\\}').exec(flat); return m ? { body: m[1], index: m.index } : null; };
  const tbar = ruleAt('.tbar'), hover = ruleAt('.tbar:hover'), sel = ruleAt('.tbar.sel');
  if (!tbar) problems.push('趋势柱体：没有 .tbar 规则');
  else if (!/height:\s*100%/.test(tbar.body)) problems.push('趋势柱体：.tbar 必须整列高度（height:100%）—— 否则短柱子上方的空白不算命中区，很难移中');
  if (!hover) problems.push('趋势柱体：没有 .tbar:hover 规则');
  else if (!/background/.test(hover.body)) problems.push('趋势柱体：hover 必须有可见的底色变化（只给 1px 虚线框等于没做）');
  if (!sel) problems.push('趋势柱体：没有 .tbar.sel 规则');
  else {
    if (!/outline/.test(sel.body)) problems.push('趋势柱体：选中的柱子必须给实线框');
    if (!/background/.test(sel.body)) problems.push('趋势柱体：选中的柱子必须给底色（多根柱子挤在一起时 2px 框看不出来）');
  }
  if (hover && sel && sel.index < hover.index) problems.push('趋势柱体：.tbar.sel 必须声明在 .tbar:hover 之后（顺序反了 → 鼠标停在刚点过的柱子上时看不清选中）');
  if (!ruleAt('.tbar-fill')) problems.push('趋势柱体：色块必须画在内层 .tbar-fill 上，柱子本体留作整列命中区');
  if (!ruleAt('.tbar.in-turn')) problems.push('趋势柱体：选中那一轮里的其它柱子要给整轮底色（照参考插件的 lc-bar-in-turn）');
}

/* 5) 讲解模式**不许改被测元素自身的样式**（用户 2026-10-01 实测：开着讲解模式，柱体的 hover/选中全看不见）
 * 病因：`body.explain [data-explain] { outline: … }` 的特异性是 (0,2,1)，高于柱体自己的
 * `.tbar:hover` / `.tbar.sel`（都是 0,2,0）→ 所有柱子被同一条虚线框盖住，选中那根也分不出来。
 * 规矩：讲解高亮只能画在**伪元素**上（不占用 outline / background / border 三条通道），
 * 也不许出现专门针对 .tbar 的几何覆盖规则（旧遗留 `body.explain .trendscroll .tbar { min-height }`）。 */
{
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
  const el = /body\.explain \[data-explain\](?!::)[^{]*\{([^}]*)\}/.exec(flat);
  // 高亮必须**跟着编号走**（.explain-num）：只给"有编号的元素"画环。
  // 若对全部 [data-explain] 画环，趋势图里 28~72 根柱子会各自带一个虚线框，图表就不像原样了。
  const after = /body\.explain \[data-explain\]\.explain-num::after\s*\{([^}]*)\}/.exec(flat);
  if (!el) problems.push('讲解模式：找不到 body.explain [data-explain] 规则');
  else if (/\b(outline|background|border)\s*:/.test(el[1])) {
    problems.push(`讲解模式：不许给元素自身设 outline/background/border（会盖掉柱体的 hover/选中）→ 画到 ::after 上；当前：${el[1].trim().slice(0, 70)}`);
  }
  if (!after) problems.push('讲解模式：高亮必须画在 body.explain [data-explain].explain-num::after 上（伪元素 + 只标有编号的元素）');
  else if (!/border\s*:/.test(after[1])) problems.push('讲解模式：::after 高亮必须有可见边框');
  if (/body\.explain [^{}]*\.tbar[^{}]*\{/.test(flat)) {
    problems.push('讲解模式：不许出现专门针对 .tbar 的覆盖规则（旧的 body.explain .trendscroll .tbar { min-height } 会让柱体几何变化）');
  }
}

/* 6) 类名撞车护栏：类别色段必须叫 .cseg
 * `.seg` 已经是**分段控件按钮**的类（按轮次/按步骤/总计/增量…），
 * 当时我把柱子的类别色段也叫 .seg → 那条 `.seg { display:block; width:100% }`
 * 直接把这些按钮撑成了整行（自己踩过一次，靠浏览器实测才发现）。 */
{
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
  const segRules = (flat.match(/(^|\})\s*\.seg\s*\{/g) || []).length;
  if (segRules !== 1) problems.push(`分段控件按钮的 .seg 规则应恰好 1 条，实际 ${segRules} 条 —— 类别色段不许再叫 .seg（撞名会改掉按钮布局）`);
  if (!/\.cseg\s*\{/.test(flat)) problems.push('类别色段必须有 .cseg 规则（颜色=类别、段高=该类占比）');
}

/* 7) 主题与自检入口（用户 2026-10-01）：
 *  · 深色**跟随系统** → DOM 上落到 `body[data-ds-dark-theme]`（DSH 自己的选择器），
 *    不许再回到 `html[data-theme="dark"]` 那套自带开关；
 *  · 顶栏不再有「深色 / 浅色」与「自测面板」两个按钮（自测面板改由 `?dev=1` 打开）。 */
{
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
  if (!/body\[data-ds-dark-theme\]\s*\{/.test(flat)) problems.push('主题：深色必须挂在 body[data-ds-dark-theme]（DSH 的选择器；demo 要与真机同一条通道）');
  if (/data-theme="dark"/.test(html) || /html\[data-theme/.test(flat)) problems.push('主题：不许再用 html[data-theme="dark"] 这套自带开关（应跟随系统）');
  if (/id="btnTheme"/.test(html)) problems.push('主题：顶栏不该再有「深色 / 浅色」按钮');
  if (/id="btnSelfcheck"/.test(html)) problems.push('自检：顶栏不该再有「自测面板」按钮（它是自检工具，改由 ?dev=1 打开）');
  if (!/queryFlag\('dev'\)/.test(js)) problems.push('自检：必须保留 ?dev=1 打开自测面板的入口（否则没浏览器时没法量尺寸）');
}

/* 8) 柱体颜色必须与右侧分类树**同源同色**（用户 2026-10-01："柱体颜色和上下文浏览器不一样"）
 * 两边都从 CATS[].color 取；柱子上不许再加 brightness/opacity 这类会改色的处理。 */
{
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
  const uses = (js.match(/background:\$\{c\.color\}/g) || []).length;
  if (uses < 2) problems.push(`柱体与分类树必须共用 CATS 的色值（应有 2 处 background:\${c.color}，实际 ${uses} 处）`);
  if (/\.tbar[^{]*\{[^}]*filter:\s*brightness/.test(flat)) problems.push('柱体：不许用 filter:brightness() 提亮（会改掉类别色，就是在这一步和分类树对不上的）');
}

/* 9) 两个实测踩到的写法，列为禁写：
 *  · `data-explain` 挂在 <select>/<input>/<textarea> 上 —— 装不下子节点，编号会被浏览器丢掉
 *    （用户问"编号在哪里？"）；这类元素要包一层 .pickwrap 再挂。
 *  · 用 `document.querySelector('[data-turn=N]').click()` 这种跨卡片点按 —— [data-turn] 只在
 *    "按步骤"模式的刻度格里才有，默认的按轮次模式下点了等于没点（用户："按钮点击没有效果"）。 */
{
  // ⚠️ 先剥掉注释：注释里为解释病因会把旧写法照样写一遍，不剥就会误报（第二次踩）
  const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  if (/<select[^>]*data-explain/.test(jsCode) || /<input[^>]*data-explain/.test(jsCode) || /<textarea[^>]*data-explain/.test(jsCode)) {
    problems.push('讲解模式：data-explain 不许直接挂在 select/input/textarea 上（装不下编号）→ 外面包一层 .pickwrap');
  }
  if (/querySelector\('\[data-turn=/.test(jsCode)) {
    problems.push('R1.4：不许再用 `[data-turn]` 跨卡片点按 —— 它只在按步骤模式存在，按轮次模式点了没反应；应直接调 editTurnUserMessage()');
  }
  if (!/class="pickwrap" data-explain/.test(jsCode)) problems.push('轮次/步骤下拉必须包在 .pickwrap 里再挂 data-explain');
}

/* 10) R3.4 的两条硬要求必须在 demo 里有落点（否则门禁第 5 条又变成"没法验"） */
{
  if (!/这条消息有多个文本段落；改写后会合并为一段。/.test(js)) {
    problems.push('R3.4：编辑器缺少"多段会被合并为一段"的提示文案（多段消息时必须出现）');
  }
  if (!/editTurnUserMessage/.test(js) || !/LONG_USER_TEXT/.test(js)) {
    problems.push('R3.4/门禁#5：必须保留一条长且多段的演示消息，并让它成为 R1.4 的目标（否则全文预填验不了）');
  }
}

/* 11) 注入内容是一等公民：三件事缺一不可（用户 2026-10-01 指出"注入内容也是要编辑的"） */
{
  if (!/function editTurnInject/.test(js)) problems.push('「改这一轮的注入内容」入口没了（R1.16）——注入类不该只有用户消息那条快捷入口');
}

/* 12) 「高级编辑」开关必须存在，且**只能收起"高级"那一类**（不许把常用类的编辑入口一起收掉） */
{
  if (!/'advanced', '高级编辑'/.test(js)) problems.push('状态开关里必须保留「高级编辑」（否则工具结果的编辑入口无处可开）');
  if (!/advancedOnly: node\.cat === 'tool'/.test(js)) problems.push('「高级编辑」只应收起工具结果这一类；用户消息/注入内容/技能注入必须始终可见');
  if (!/打开顶部「高级编辑」开关/.test(js)) problems.push('收起时不许让按钮凭空消失（R2.3）：必须留标记 + 说明在哪打开');
}

/* 13) 批注的"快照语义"必须写在用户能看到的地方（R3.3.1 的确认框 + 编辑器提示） */
{
  if (!/在快照里/.test(js) || !/fork 种子/.test(js)) problems.push('批注确认框里必须写清它在快照/子会话里起什么作用（用户 2026-10-01 问过这件事）');
  if (!/请求式/.test(js)) problems.push('批注必须说明它是"请求式"的：不遮蔽原文、不保证模型照做（与「编辑」的确定生效相对）');
}

/* 14) 界面说人话：四条硬要求（用户 2026-10-01） */
{
  if (/type="number"/.test(js)) problems.push('批注不许再用数字输入框（用户不知道 seq）');
  if (/id="edTo"/.test(js)) problems.push('批注不许再给"从这条到…"的范围选择器（一步几百条、一会话上万条 → 无意义且是负担；要范围就写在理由里）');
  if (!/class="qfloat"/.test(js) || !/class="qwrap"/.test(js)) problems.push('动态出现的按钮要用**左上角飘的**「?」（.qfloat/.qwrap，与讲解模式序号同一种做法），不是按钮后面再挂一个按钮');
  if (!/class="targetbox"/.test(js)) problems.push('批注必须用**人话**说明"这条批注针对哪一条"（轮/步/类别/正文开头），#seq 只能退居括号');
  if (!/<details class="adv">/.test(js)) problems.push('思考文本这类"多数消息没有"的字段必须收进「高级」折叠（R3.2 本来就要求折叠）');
  if (!/第 1 步/.test(js) || !/应用到会话/.test(js)) problems.push('「保存草稿」旁边必须写清两步流程（否则用户不知道点完还要做什么）');
}

/* 15) 说明文字里的 markdown 星号必须经 md() 转换，不许原样进 HTML（踩过三次：趋势说明、讲解说明栏、编辑器提示） */
{
  // ⚠️ 先剥注释（第三次踩同一个坑：注释里解释病历时会把 ** 照样写一遍）
  const jsc = js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const htmlStrings = jsc.split('\n').filter((l) => /<p class|<span|innerHTML/.test(l) && /\*\*/.test(l));
  if (htmlStrings.length) problems.push(`这些行把 markdown 的 ** 直接写进了 HTML（会原样显示星号）：${htmlStrings[0].trim().slice(0, 60)}`);
}

/* 15.8) 每个 `data-act` 按钮都必须有讲解词（`data-explain`）—— 否则用户点了不知道会发生什么，
 *        而"照 demo 实施"的人也会漏掉这个动作的说明（2026-10-02 审计查出 4 个：顶部横幅 2 个 + 待处理结果 2 个）。
 * 白名单：编辑器里的 `esubmit`/`ecancel`（它们旁边由 `.qwrap + .qfloat` 提供 `?`，不挂 data-explain）。 */
{
  const NO_HELP = new Set(['esubmit', 'ecancel']);
  /* ⚠️ **不要**先用正则剥模板（`${...}` 里可能有嵌套花括号，一剥就会吃掉后面的按钮）。
   * 直接在原文上扫标签，并把 `${...}` 当作一个整体（它的 `>` 不结束标签）。 */
  const tags = [...js.matchAll(/<button\b(?:\$\{[^}]*\}|[^>])*>/g)].map((m) => m[0]);
  const missing = tags.filter((t) => /data-act="/.test(t) && !/data-explain="/.test(t))
    .map((t) => (/data-act="([\w.]+)"/.exec(t) || [])[1]).filter((a) => a && !NO_HELP.has(a));
  if (missing.length) problems.push(`这些按钮没有讲解词（data-explain）：${[...new Set(missing)].join(', ')}`);
}

/* 15.9) ⚠️ **文档逐字 ↔ demo 逐字**（用户 2026-10-02：「你要确保 demo 和你文档中描述的一致，因为我会在 demo 上验证。
 * 最终这两个保持一致了才可以去实施，否则你照着 demo 去实现会有问题。」）
 *
 * 做法：**从 `docs/03` 里把"界面逐字"的合同条款抽出来，逐条断言它出现在 `demo.js` 里** ——
 *   · R4.3 的**短警示**（确认框第一句）逐字；
 *   · R3.3.2 的**去向标签**、R3.3.3 的**两态标记文案**逐字；
 *   · 关键按钮名 / 徽章 / 空白态文案逐字。
 * 任何一边改了而另一边没跟上 → 这里直接红（不是靠人眼比对）。
 * ⚠️ 只放**稳定**的短句；带占位符（`#N` / `N 条`）或依赖运行时的句子不进这张表。 */
{
  const spec = rd('../docs/03-ui-spec.md');
  // ① R4.3 短警示：从表里自动抽取（动作表的第 2 列第一段反引号），保证"文档改了就必须同步 demo"
  const rows = spec.split('\n').filter((l) => l.startsWith('| ') && l.includes('|'));
  const r43 = [];
  const i0 = spec.indexOf('| 动作 | 短警示');
  if (i0 < 0) problems.push('docs/03 里找不到 R4.3 的「动作 | 短警示」表头（文档结构变了？）');
  else {
    for (const l of spec.slice(i0).split('\n').slice(2)) {
      if (!l.startsWith('|')) break;
      const cols = l.split('|').slice(1, -1).map((c) => c.trim());
      const m = cols[1] && /`([^`]{6,200})`/.exec(cols[1]);
      if (m) r43.push([cols[0].replace(/\*\*/g, '').slice(0, 20), m[1]]);
    }
    if (r43.length < 4) problems.push(`R4.3 短警示只抽到 ${r43.length} 条（应 ≥4：减法后剩 4 条；表格结构或反引号被改动了？）`);
    for (const [action, txt] of r43) {
      if (!js.includes(txt)) problems.push(`R4.3 短警示与 demo 不一致：${action} → 文档写「${txt.slice(0, 40)}…」但 demo.js 里找不到`);
    }
  }
  // ② 其余"界面逐字"（人工维护的小表：改了这两边就要同改）
  const VERBATIM = [
    ['确认框去向·子会话首条任务', '会成为子会话的第一句话 —— 它的模型看得到'],
    ['两态标记·灰', '只写本地 · 模型看不到'],
    ['两态标记·琥珀（编辑带门槛）', '会进模型上下文（点「应用到会话」之后）'],
    ['按钮·开子会话', '开启子会话'],
    ['按钮·去改现在这条（被遮蔽行的出路）', '去改现在这条（#'],
    ['按钮·版本历史', '版本历史'],
    ['按钮·应用到会话', '应用到会话'],
    ['按钮·保存草稿', '保存草稿'],
    ['按钮·批注', '批注'],
    ['按钮·编辑', '编辑'],
    ['徽章·助手消息仅可批注', '助手消息仅可批注'],
    ['徽章·未生效', '未生效'],
    ['徽章·已被接替', '已被 #'],
    ['空白态·还没有子会话', '（还没有子会话）'],
    ['助手消息原因（title）', '助手消息在平台上无法改写（两条规则互斥）'],
    ['被遮蔽行的两条草稿处置', '丢弃草稿'],
    ['被遮蔽行的两条草稿处置（迁移）', '把草稿应用到当前可见的 #'],
  ];
  for (const [what, txt] of VERBATIM) {
    if (!js.includes(txt)) problems.push(`文档逐字 ↔ demo 不一致：${what} → demo.js 里找不到「${txt}」`);
  }
}

/* 16) 「子会话」卡的排布契约：宽屏两列（第一列跨行、团队跨两列）、窄屏单列、块与块要能区分 */
{
  if (!/\.orchgrid\s*\{/.test(css)) problems.push('缺少 .orchgrid（快照卡的分块网格）');
  if (!/grid-template-areas:\s*"spawnone children"\s*"spawnone pending"\s*"team team"/.test(css)) {
    problems.push('宽屏排布契约变了：应为 开子会话 一列跨两行、children+pending 一列、team 跨两列（冻结已删，spawnone 占原位置）');
  }
  if (!/@media \(min-width: 1040px\)/.test(css)) problems.push('缺少宽屏断点（≥1040px 才两列，窄屏必须单列）');
  if (!/\.orchblock\s*\{[^}]*bg-layer-3/.test(css)) problems.push('块底色必须比卡片底深一档（光靠边框不够"明显区分"）');
  if (!/\.orchblock > \.blocktitle/.test(css)) problems.push('每块标题必须有独立样式（块身份要一眼可见）');
}

/* 16.5) 全页统一语言（2026-10-01 一致性 pass）：卡片标题与块标题同一套（下细虚线 + 右读数） + 行间细虚线 */
{
  if (!/\.card-title\s*\{[^}]*border-bottom:\s*1px dashed/.test(css)) problems.push('卡片标题下必须有细虚线（与「子会话」卡的块标题同一套语言）');
  if (!/\.card-title \.bmeta\s*\{/.test(css)) problems.push('卡片标题要有右读数样式（.card-title .bmeta）');
  if (!/#cardBrowser \.row \+ \.row/.test(css) || !/\.catbody \.row \+ \.row/.test(css)) {
    problems.push('分类树/浏览器行之间要有细虚线分隔（与块内行分隔一致）');
  }
}

/* 17) 借鉴 V0 的视觉细节契约（配色不动）：两端对齐读数 / 焦点块左侧竖条 / 行间虚线 / 行右 › / 块底整宽按钮 */
{
  if (!/\.bmeta\s*\{[^}]*margin-left:\s*auto/.test(css)) problems.push('块标题右读数（.bmeta）必须右对齐（margin-left:auto）');
  // ⚠️ 用户 2026-10-01 否掉了"焦点块加彩色标记"（整圈描边与左侧竖条都被否）——这里锁死别再回来
  if (/is-focus|orchblock\s*\{[^}]*box-shadow:\s*inset/.test(css)) {
    problems.push('快照卡的块不许再加重色焦点标记（整圈描边 / 左侧竖条都已否掉）：与整页风格不和谐');
  }
  if (!/\.orch-id \.chev\s*\{/.test(css)) problems.push('子会话行右需要 › 标记（.orch-id .chev）');
  if (!/\.btn\.block\s*\{/.test(css)) problems.push('块底需要整宽次级按钮样式（.btn.block）');
}

/* 18) 标题右读数的纪律（用户 2026-10-01）：不会变的不许放 */
{
  if (!/开子会话块读数|还没开过/.test(js)) {
    problems.push('开子会话块读数必须用会变的量（还没开过 / 已开 N 个），不许回到"最新 <id> · 第 N 轮末 · M 条"那种死字符串');
  }
}

/* 19) 「点了没反应」的两条硬契约（用户 2026-10-02：「17 点了没有反应」）
 *   ① 轮次刻度带**必须有选中态**：点完要能看出选了哪一格（原来只有 :hover，点完毫无痕迹）；
 *   ② 触屏下**讲解序号与 ✂ 标记必须有 ≥44px 命中区**：它们分别是 16×15 / 24×16 的小节点，
 *      而 .btn 那批早在 coarse 分支里放过 44px —— 序号是真实节点、手指点不到就等于"没反应"。 */
{
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
  if (!/\.tcell\.is-sel\s*\{/.test(flat)) {
    problems.push('轮次刻度带必须有选中态样式（.tcell.is-sel）—— 否则点完看不出选了哪一格（用户 2026-10-02 报的「17 点了没反应」）');
  }
  if (!/@media \(pointer: coarse\)[\s\S]*\.exnum::after\s*\{[^}]*inset:\s*-/.test(flat)) {
    problems.push('触屏下讲解序号（.exnum）必须用透明 ::after 撑出 ≥44px 命中区 —— 它只有 16×15px，手指点不到');
  }
  if (!/@media \(pointer: coarse\)[\s\S]*\.mark::after\s*\{[^}]*inset:\s*-/.test(flat)) {
    problems.push('触屏下 ✂ 标记（.mark）也要撑出 ≥44px 命中区（它只有 24×16px）');
  }
}

/* 20) 输入去向标记（`docs/03` R3.3.3）：凡"让你写字"的地方都必须带一个，**只有两种**
 *   用户 2026-10-02：「整个 Demo 都存在这个问题：哪些编辑了模型能看到、哪些看不到」——
 *   两种标记必须各自有一套样子（`.dest-model` 琥珀实线 = 会进模型上下文；`.dest-local` 灰虚线 = 只写本地），
 *   否则"两种"就退化成"一团一样的灰字"，用户还是分不出来。 */
{
  if (!/\.dest-model\s*\{/.test(css) || !/\.dest-local\s*\{/.test(css)) {
    problems.push('输入去向标记必须有两种不同样式（.dest-model = 会进模型上下文 / .dest-local = 只写本地）');
  }
  if (!/\.dest-model\s*\{[^}]*ds-color-amber/.test(css)) {
    problems.push('.dest-model 必须用琥珀色区别于 `.dest-local`（用户要能一眼看出"这句模型会读到"）');
  }
}

/* 附加：单文件版是否**真的是最新**（不是"看起来内联过"就行）——
 * 比对打包指纹（demo.css + demo.js 的 sha256 前 7 位）。单文件版内联、没有 ?v=N 查询串，
 * 改完 css/js 忘了重打包的话，外观上看不出任何区别，只能靠指纹抓。 */
{
  const fp = createHash('sha256').update(css + '\u0000' + js).digest('hex').slice(0, 7);
  if (!standalone.includes('<style>') || !standalone.includes('TOTAL_TURNS')) {
    problems.push('单文件独立版看起来没重新打包：请跑 node demo/build-standalone.mjs');
  } else if (!standalone.includes(`单文件版 ${fp}`)) {
    problems.push(`单文件独立版不是最新的（指纹对不上，当前应为 ${fp}）：请跑 node demo/build-standalone.mjs`);
  }
}

/* 打印结论 */
console.log(`检查：${idsUsed.length} 个 id · ${jsClasses.length} 个 class · ${usedExplain.length} 个讲解键`);
if (problems.length === 0) {
  console.log('✅ 静态契约检查通过');
} else {
  console.log(`❌ 发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log('  - ' + p);
  process.exitCode = 1;
}
