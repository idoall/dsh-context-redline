// demo 的「运行时冒烟测试」——没有浏览器时，用它真的把 demo.js 跑一遍。
// 用法：node demo/check-runtime.mjs
//
// 做法：造一个最小 DOM 桩，把 demo.js 当函数体执行，然后把内部状态取出来断言。
// 目的：抓住"渲染路径里的运行期错误"（拼错变量、undefined 属性、数组越界），
//       这些是静态 grep 抓不到、而我又没有浏览器可以点的时候最容易漏掉的。
import { readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const code = readFileSync(new URL('demo.js', dir), 'utf8');

/* ---------------- 最小 DOM 桩 ---------------- */
function makeEl(tag = 'div') {
  const el = {
    tagName: tag, children: [], style: {}, dataset: {}, value: '',
    hidden: false, innerHTML: '', textContent: '', scrollLeft: 0,
    scrollWidth: 2400, clientWidth: 800, scrollHeight: 400, clientHeight: 200, offsetLeft: 40,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { return c; }, remove() {},
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 320, height: 44, top: 0, left: 0, bottom: 44, right: 320 }),
    focus() {}, blur() {}, click() {}, closest: () => null
  };
  return el;
}
const registry = new Map();
const getById = (id) => {
  if (!registry.has(id)) registry.set(id, makeEl());
  return registry.get(id);
};
const document = {
  documentElement: Object.assign(makeEl('html'), { scrollWidth: 1200, clientWidth: 1200 }),
  body: makeEl('body'),
  getElementById: getById,
  createElement: (t) => makeEl(t),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}
};
const window = { __trendSeries: [] };

/* ---------------- 执行 demo.js，并取出内部状态 ---------------- */
const exposed = `;return { S:()=>S, setS:(v)=>{S=v}, initial, REQUESTS, NODES, TOTAL_TURNS, CATS,
  render, selectReq, trendItems, applyTrendScale, doApply, submitEditor, rowAct, familyOf, versionsOf,
  nodesOfReq, markerOf, metricOf, reqsOfTurn, lastOfTurn, turnSteps, goneMapOf, ability, isReplacement };`;

const run = new Function('document', 'window', 'requestAnimationFrame', 'setTimeout', 'console',
  code + exposed);
const api = run(document, window, (cb) => cb(), () => 0, { log() {}, warn() {}, error() {} });

/* ---------------- 断言 ---------------- */
const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });

check('初始 render() 没抛错', true);
check('轮数 = 28', api.TOTAL_TURNS === 28, `TOTAL_TURNS=${api.TOTAL_TURNS}`);
check('请求数 = 72（27 轮 × 1–4 步 + 富态轮 3 步）', api.REQUESTS.length === 72, `REQUESTS=${api.REQUESTS.length}`);

const turnAgg = api.trendItems.call(null) && (() => { const S = api.S(); S.trendGran = 'turn'; return api.trendItems(); })();
check('按轮次：柱数 = 轮数 28', turnAgg.list.length === 28, `bars=${turnAgg.list.length}`);
const stepAgg = (() => { const S = api.S(); S.trendGran = 'step'; return api.trendItems(); })();
check('按步骤：柱数 = 请求数 72', stepAgg.list.length === 72, `bars=${stepAgg.list.length}`);
check('按轮次的柱子带 stepCount', turnAgg.list.every((r) => typeof r.stepCount === 'number' && r.stepCount >= 1));
check('每轮步数与请求表一致', turnAgg.list.every((r) => r.stepCount === api.turnSteps(r.turn)), 'stepCount vs turnSteps');

const delta = (() => { const S = api.S(); S.trendGran = 'turn'; S.trendMode = 'delta'; return api.trendItems(); })();
check('增量模式：出现负值（压缩/裁剪后变小）', delta.series.some((v) => v < 0), `min=${Math.min(...delta.series)}`);
check('增量模式：首项 = 首项总量', delta.series[0] === turnAgg.series[0]);

const focused = (() => { const S = api.S(); S.trendMode = 'total'; S.trendCat = 'inject'; return api.trendItems(); })();
check('聚焦某类后总量变小', focused.series.every((v, i) => v <= turnAgg.series[i]), 'focusCat ≤ total');
(() => { const S = api.S(); S.trendCat = null; S.trendGran = 'turn'; })();

check('富态轮有 3 步', api.turnSteps(28) === 3, `steps=${api.turnSteps(28)}`);
check('被遮蔽的原文仍在 surface 里（R4.6/A3）', api.nodesOfReq(api.lastOfTurn(28), false).some((n) => n.seq === 1287));
check('但可见集合里没有它', !api.nodesOfReq(api.lastOfTurn(28), true).some((n) => n.seq === 1287));
check('能力判定：助手消息不可改写', api.ability(api.NODES.find((n) => n.type === 'assistant/message')).canRewrite === false);
check('能力判定：替换体可改写', api.ability(api.NODES.find((n) => n.seq === 1301)).canRewrite === true);
check('能力判定：被压缩埋掉的不可改写', api.ability(api.NODES.find((n) => n.seq === 1303)).canRewrite === false);
check('压缩标记挂在它之后的请求上', api.markerOf(api.lastOfTurn(28)) !== null);

check('行身份链跨替换体：#1287 → #1301', JSON.stringify(api.familyOf(1301)) === JSON.stringify([1287, 1301]), JSON.stringify(api.familyOf(1301)));

/* 走一遍动作：草稿 → 应用 → 回滚链 */
(() => {
  const S = api.S();
  S.drafts[1301] = { seq: 1301, text: '（冒烟测试）改后的正文', reasoning: '', requestSeq: api.lastOfTurn(28).seq };
  api.doApply(1301);
})();
check('应用后 draft 被清空', Object.keys(api.S().drafts).length === 0);
check('应用后产生新条目并记账', api.S().applied.length === 1 && api.S().extraNodes.length === 1);
check('应用后链变 3 段', api.familyOf(1301).length === 3, JSON.stringify(api.familyOf(1301)));

/* 走一遍切换：轮 / 步 / 粒度 / 模式，确认渲染路径不抛错 */
let threw = null;
try {
  const S = api.S();
  for (const gran of ['turn', 'step']) for (const mode of ['total', 'delta']) {
    S.trendGran = gran; S.trendMode = mode; api.render();
  }
  for (const t of [1, 2, 14, 27, 28]) { api.selectReq(api.lastOfTurn(t)); api.render(); }
  for (const r of api.reqsOfTurn(28)) { api.selectReq(r); api.render(); }
  S.sw.turnOpen = true; api.render();
  S.sw.live = false; api.render();
  S.sw.team = false; api.render();
  S.sw.turnOpen = false; S.sw.live = true; S.sw.team = true; api.render();
} catch (e) { threw = e; }
check('切换粒度/模式/轮/步/状态开关时 render() 不抛错', threw === null, threw ? String(threw) : '');

/* ---------------- 汇报 ---------------- */
const bad = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  → ' + r.detail : ''}`);
console.log(`\n共 ${results.length} 项，失败 ${bad.length} 项`);
if (bad.length) process.exitCode = 1;
