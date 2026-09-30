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
