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
    classList: (() => { const set = new Set(); return {
      add: (c) => set.add(c), remove: (c) => set.delete(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
      contains: (c) => set.has(c), _all: () => [...set]
    }; })(),
    appendChild(c) { c.__parent = el; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    remove() { if (el.__parent) { const i = el.__parent.children.indexOf(el); if (i >= 0) el.__parent.children.splice(i, 1); } },
    __attrs: {},
    setAttribute(k, v) { el.__attrs[k] = String(v); },
    getAttribute(k) { return k in el.__attrs ? el.__attrs[k] : null; },
    removeAttribute(k) { delete el.__attrs[k]; },
    __on: {},
    addEventListener(type, fn) { (el.__on[type] = el.__on[type] || []).push(fn); },
    removeEventListener() {},
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
// 三个"假的可讲解元素"：用来验证序号节点的注入与点击行为
const explainHosts = Array.from({ length: 3 }, () => { const el = makeEl(); el.dataset.explain = 'act.edit'; return el; });
const document = {
  documentElement: Object.assign(makeEl('html'), { scrollWidth: 1200, clientWidth: 1200 }),
  body: makeEl('body'),
  getElementById: getById,
  createElement: (t) => makeEl(t),
  querySelector: () => null,
  querySelectorAll: (sel) => {
    if (sel === '[data-explain]') return explainHosts;
    if (sel === '.exnum') return explainHosts.flatMap((h) => h.children.filter((c) => String(c.className).startsWith('exnum')));
    return [];
  },
  __on: {},
  addEventListener(type, fn) { (document.__on[type] = document.__on[type] || []).push(fn); },
  removeEventListener() {}
};
registry.set('__body', document.body);   // 便于断言 body 上的推挤类
const window = { __trendSeries: [], matchMedia: (q) => ({ matches: /max-width:\s*899px/.test(q) ? false : false, media: q }) };

/* ---------------- 执行 demo.js，并取出内部状态 ---------------- */
const exposed = `;return { S:()=>S, setS:(v)=>{S=v}, initial, REQUESTS, NODES, TOTAL_TURNS, CATS,
  render, selectReq, trendItems, applyTrendScale, doApply, submitEditor, rowAct, familyOf, versionsOf,
  trendTipRows, showTrendTip, hideTrendTip, EVENTS, markersOfReq, markersOfBar, firstReqAtOrAfter, openDrawer, closeDrawer,
  nodesOfReq, markerOf, metricOf, reqsOfTurn, lastOfTurn, turnSteps, goneMapOf, ability, isReplacement };`;

/**
 * ⚠️ rAF 必须**后置**（排队，手动 flush），不能同步执行。
 * 同步执行会让「render() 内部先排 rAF、紧接着 renderSelfcheck() 读 DOM」这种真实浏览器里
 * 的**时序 bug 在桩里看不见** —— 2026-09-30 自测面板显示 `undefined` 就是这么漏掉的。
 */
const rafQueue = [];
const flushRaf = () => { while (rafQueue.length) rafQueue.shift()(); };
const run = new Function('document', 'window', 'requestAnimationFrame', 'setTimeout', 'console',
  code + exposed);
const api = run(document, window, (cb) => rafQueue.push(cb), () => 0, { log() {}, warn() {}, error() {} });

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

/* ---------------- 趋势图 hover 提示（用户点名的三件事） ---------------- */
{
  const S = api.S();
  const rich = api.lastOfTurn(28);
  const richIdx = 27;
  S.trendGran = 'step'; S.trendMode = 'total'; S.trendCat = null;
  let series = api.trendItems().series;
  let rows = api.trendTipRows(rich, richIdx, series);
  check('按步骤提示：第 28 轮 · 第 3 步 (共 3 步)', rows[0] === '第 28 轮 · 第 3 步 (共 3 步)', rows[0]);
  check('按步骤提示第二行：合计 ≈ …', /^合计 ≈ /.test(rows[1]), rows[1]);

  S.trendGran = 'turn';
  series = api.trendItems().series;
  rows = api.trendTipRows(rich, 27, series);
  check('按轮次提示：第 28 轮 · 共 3 步', rows[0] === '第 28 轮 · 共 3 步', rows[0]);

  const oneStep = api.REQUESTS.find((r) => api.turnSteps(r.turn) === 1);
  S.trendGran = 'turn';
  const idx1 = api.trendItems().list.findIndex((r) => r.turn === oneStep.turn);
  rows = api.trendTipRows(oneStep, idx1, api.trendItems().series);
  check('单步轮次提示：共 1 步', rows[0] === `第 ${oneStep.turn} 轮 · 共 1 步`, rows[0]);

  S.trendMode = 'delta';
  series = api.trendItems().series;
  rows = api.trendTipRows(rich, 27, series);
  check('增量模式提示：Δ …（带符号）', /^Δ [+-]/.test(rows[1]), rows[1]);

  S.trendMode = 'total'; S.trendCat = 'inject';
  series = api.trendItems().series;
  rows = api.trendTipRows(rich, 27, series);
  check('聚焦时第二行写类别名', /^注入内容 ≈ /.test(rows[1]), rows[1]);
  S.trendCat = null;

  rows = api.trendTipRows(rich, 27, api.trendItems().series);
  check('有压缩标记的柱子多一行 ✂', rows[2] && rows[2].startsWith('✂'), rows[2] || '(无)');
}

/* tip 必须渲染在滚动容器**外面**（否则会撑大 scrollWidth、滚动条乱跳） */
{
  const trendHtml = registry.get('cardTrend').innerHTML;
  check('trendTip 已渲染', trendHtml.includes('id="trendTip"'));
  check('trendTip 在 trendScroll 之前（即不在滚动容器里）',
    trendHtml.indexOf('id="trendTip"') < trendHtml.indexOf('id="trendScroll"'), '顺序检查');
  check('柱子不再用原生 title（避免延迟与手机无提示）', !/class="tbar[^>]*title=/.test(trendHtml));
}

/* ---------------- ✂ 标记语义（用户问"三个剪刀是啥意思" → 这里锁死正确行为） ---------------- */
{
  const S = api.S();
  S.trendGran = 'step';
  api.render();   // 改完粒度必须先重渲染，否则读到的是上一次的 HTML（这里踩过一次）
  const marked = api.REQUESTS.filter((r) => api.markersOfReq(r).length > 0).map((r) => r.seq);
  check('按步骤：每个事件只标一根柱 → 2 个事件 = 2 根柱', marked.length === 2, `marked=${JSON.stringify(marked)}`);
  check('被标的正是「事件之后的第一个请求」',
    api.EVENTS.every((ev) => marked.includes(api.firstReqAtOrAfter(ev.seq))), `firstAfter=${api.EVENTS.map((e) => api.firstReqAtOrAfter(e.seq)).join(',')}`);
  const flat = api.REQUESTS.flatMap((r) => api.markersOfReq(r));
  check('同一个事件不会被标两次（之前这里多出一个重复的剪刀）',
    flat.length === new Set(flat.map((e) => e.seq)).size, `flat=${flat.length} unique=${new Set(flat.map((e) => e.seq)).size}`);

  const stepHtml = registry.get('cardTrend').innerHTML;
  check('按步骤渲染出 2 个 ✂ 标记', (stepHtml.match(/class="mark"/g) || []).length === 2, `marks=${(stepHtml.match(/class="mark"/g) || []).length}`);

  S.trendGran = 'turn'; api.render();
  check('按轮次：含 2 个事件的那一轮合并成 ✂×2', api.markersOfBar({ turn: 28 }).length === 2, `n=${api.markersOfBar({ turn: 28 }).length}`);
  check('按轮次：没有事件的那一轮不带标记', api.markersOfBar({ turn: 5 }).length === 0);
  const turnHtml = registry.get('cardTrend').innerHTML;
  check('按轮次渲染出 1 个 ✂×2', (turnHtml.match(/class="mark"/g) || []).length === 1 && turnHtml.includes('✂×2'), 'turn 模式标记');

  S.trendGran = 'step';
  const firstMarked = api.REQUESTS.find((r) => api.markersOfReq(r).length > 0);
  const rows = api.trendTipRows(firstMarked, api.REQUESTS.indexOf(firstMarked), api.trendItems().series);
  check('✂ 的提示行写明事件类型与内容', rows.some((r) => r.startsWith('✂ 压缩：')), rows.filter((r) => r.startsWith('✂')).join(' / ') || '(无)');
  check('讲解词典里有 trend.mark', api.trendTipRows !== undefined && registry.get('cardTrend').innerHTML.includes('data-explain="trend.mark"'), 'mark 可点开讲解');
}

/* ---------------- 讲解面板：推挤式，不是遮罩（用户要求像 DSH 右侧栏那样"推"出来） ---------------- */
{
  const body = registry.get('__body') || document.body;
  api.openDrawer('act.edit');
  check('打开讲解面板：面板可见', registry.get('drawer').hidden === false);
  check('打开讲解面板：body 带 drawer-open（推挤式，内容让位而不是被盖住）', body.classList.contains('drawer-open'), JSON.stringify(body.classList._all()));
  check('面板内容写明"它是做什么的"', /它是做什么的/.test(registry.get('drawerBody').innerHTML));
  api.closeDrawer();
  check('关闭后面板隐藏', registry.get('drawer').hidden === true);
  check('关闭后 body 收回推挤空间', !body.classList.contains('drawer-open'));
}

/* ---------------- 讲解模式：只有序号可点，按钮本身照常可用（用户报的旧 bug） ---------------- */
{
  const S = api.S();
  S.explain = true; api.render();
  const badges = explainHosts.map((h) => (h.children || []).find((c) => String(c.className).startsWith('exnum'))).filter(Boolean);
  check('讲解模式给每个元素注入了**真实序号节点**（伪元素点不到）', badges.length === 3, `badges=${badges.length}`);
  check('序号带无障碍角色与说明', badges[0] && badges[0].getAttribute('role') === 'button' && /点这里看说明/.test(badges[0].getAttribute('title') || ''));

  api.closeDrawer();
  const clickBadge = badges[0] && (badges[0].__on.click || [])[0];
  check('序号自己挂了 click', typeof clickBadge === 'function');
  let stopped = false;
  clickBadge({ preventDefault() {}, stopPropagation() { stopped = true; } });
  check('点序号：只吃掉这一次点击（不冒泡到按钮）', stopped === true);
  check('点序号：打开讲解面板', registry.get('drawer').hidden === false);
  check('点序号：body 进入推挤态', registry.get('__body').classList.contains('drawer-open'));

  // 回归护栏：开着讲解模式时，文档捕获阶段**不许**再拦截 [data-explain] 的点击
  const cap = (document.__on.click || [])[0];
  let prevented = false;
  if (cap) cap({ target: { closest: (sel) => (sel === '.drawer' ? null : explainHosts[0]) }, preventDefault() { prevented = true; } });
  check('开着讲解模式时，点按钮本身不再被拦截（旧 bug 回归）', prevented === false, prevented ? '仍被 preventDefault' : '');

  S.explain = false; api.render();
  const after = explainHosts.map((h) => (h.children || []).filter((c) => String(c.className).startsWith('exnum')).length);
  check('关掉讲解模式后序号被清理', after.every((n) => n === 0), JSON.stringify(after));
}

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

/* ---------------- 自测面板：读数必须是数字，不许出现 undefined ----------------
 * 真实浏览器里 renderTrend() 把刻度计算排进 rAF，而 render() 紧接着就渲染自测面板 →
 * 面板读到的是**刚被重建、还没算过**的 #trendScroll → 显示 `undefined`（2026-09-30 实测发现）。
 * 这里的桩把 rAF 后置，因此能在没有浏览器的环境下复现这条时序。 */
{
  const S = api.S();
  S.selfcheck = true; api.render();                      // rAF 尚未执行（模拟浏览器真实时序）
  const html = registry.get('selfcheck').innerHTML;
  check('自测面板：刻度上限有值（rAF 未跑时也不许是 undefined）', !/undefined/.test(html), (html.match(/当前刻度上限[^<]*<code>([^<]*)<\/code>/) || [])[1] || '(没有这一行)');
  check('自测面板：整块不含 undefined', !/undefined/.test(html), html.includes('undefined') ? '仍含 undefined' : '');
  flushRaf();
  const html2 = registry.get('selfcheck').innerHTML;
  check('自测面板：rAF 跑完之后仍是数字', !/undefined/.test(html2), (html2.match(/当前刻度上限[^<]*<code>([^<]*)<\/code>/) || [])[1] || '(没有这一行)');
  check('自测面板：读数等于 #trendScroll 上的 data-max', registry.get('trendScroll').dataset.max !== undefined && html2.includes(`<code>${registry.get('trendScroll').dataset.max}</code>`), `data-max=${registry.get('trendScroll').dataset.max}`);
  S.selfcheck = false; api.render(); flushRaf();
}

/* ---------------- 快照与子会话：团队不可用时「对接点必须消失」（docs/03 R5.1） ----------------
 * 规范原文：`ctx.agentTeams` 不存在时，派活 / 建成官方任务 / 团队成员式打断 **全部不出现**（不是报错），
 * 只留 打开 / 压缩 / 裸子会话打断。旧实现只把「派活」置灰、另两个照旧显示 —— 用户逐条过门禁时必踩。 */
{
  const S = api.S();
  S.sw.team = false; api.render();
  const html = registry.get('cardOrch').innerHTML;
  const txt = html.replace(/<[^>]*>/g, ' ');
  // ⚠️ 必须按**按钮属性**判定，不能按文字：说明文案里本来就会出现"派活"这两个字
  //（第一次就是把说明文字当成按钮，白红了一次）。
  check('团队不可用：没有「派活」按钮（不是置灰）', !/data-act="csend"/.test(html), /data-act="csend"/.test(html) ? '按钮仍在（可能只是 disabled）' : '');
  check('团队不可用：没有「建成官方任务」按钮', !/data-act="ctask"/.test(html), /data-act="ctask"/.test(html) ? '按钮仍在' : '');
  check('团队不可用：没有「去官方面板」按钮', !/data-act="teamOpen"/.test(html), /data-act="teamOpen"/.test(html) ? '按钮仍在' : '');
  check('团队不可用：如实说明未启用', /未启用官方智能体团队/.test(txt));
  check('团队不可用：仍保留 打开 / 压缩 / 打断（裸子会话通道）', /data-act="copen"/.test(html) && /data-act="ccompact"/.test(html) && /data-act="cinterrupt"/.test(html));
  check('该区块没有 emoji（docs/03 V5 不许 emoji）', !/[\u2705\u26a0\u2714\u2717]/.test(html));

  S.sw.team = true; api.render();
  const html2 = registry.get('cardOrch').innerHTML;
  check('团队可用时：派活 / 建成官方任务 / 去官方面板 都回来', /data-act="csend"/.test(html2) && /data-act="ctask"/.test(html2) && /data-act="teamOpen"/.test(html2));
}

/* ---------------- 趋势柱体：结构契约（整列命中区 + 内层色块） ----------------
 * 用户 2026-10-01：移上去/点中了都看不出是哪一根。参考插件 dsh-context 的 .lc-bar
 * 是**整列**（height:100%）可点，色块画在子元素里 —— 短柱子上方的空白也能移中。
 * 我们的旧实现把高度与色块都放在按钮本身上，命中区只有那 69px 的色块。 */
{
  const html = registry.get('cardTrend').innerHTML;
  // ⚠️ 必须要求 "tbar" 后面紧跟空格或引号 —— 否则 class="tbar-fill" 也会被当成柱子
  //    （第一版就是这么错的：柱子数虚报成 144，另一条断言也被 fill 的内联 height 误伤）
  const bars = html.match(/class="tbar(?=[ "])[^"]*"/g) || [];
  const fills = html.match(/class="tbar-fill"/g) || [];
  check('趋势柱体：每根柱子都有内层色块 .tbar-fill', bars.length > 0 && fills.length === bars.length, `柱子 ${bars.length} 根 · 色块 ${fills.length} 个`);
  const outerHasHeight = /class="tbar(?=[ "])[^"]*"[^>]*style="[^"]*height:/.test(html);
  check('趋势柱体：高度不再写在外层按钮上（外层是整列命中区）', !outerHasHeight, outerHasHeight ? '外层仍带 height' : '');
}

/* ---------------- 汇报 ---------------- */
const bad = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  → ' + r.detail : ''}`);
console.log(`\n共 ${results.length} 项，失败 ${bad.length} 项`);
if (bad.length) process.exitCode = 1;
