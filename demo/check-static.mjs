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
  const flat = css.replace(/\s+/g, ' ');
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
