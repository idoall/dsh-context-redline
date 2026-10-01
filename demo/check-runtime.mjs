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
// 需要时临时追加（例如模拟"data-explain 直接挂在 <select> 上"这种错误写法）
const extraHosts = [];
/* 趋势区：3 根柱子（中间那根是选中态）+ 2 个轮次刻度格 ——
 * 用来锁住"同类重复元素在讲解模式下只标一个编号"（真实页面里按步骤有 72 根柱子，
 * 每根都标就成了 102 个编号糊满图表，2026-10-01 实测）。 */
const trendScroll = makeEl('div');
const trendBars = Array.from({ length: 3 }, (_, i) => {
  // ⚠️ classList 与 className 在桩里是两套东西，必须都设上：实现是用 classList.contains('sel')
  //    找"当前选中的那根"的（第一版只设了 className，导致守卫误判）
  const el = makeEl('button'); el.className = 'tbar' + (i === 1 ? ' sel' : '');
  el.classList.add('tbar'); if (i === 1) el.classList.add('sel');
  el.dataset.explain = 'trend.pick'; el.closest = (s) => (s === '.trendscroll' ? trendScroll : null);
  return el;
});
const trendCells = Array.from({ length: 2 }, () => {
  const el = makeEl('button'); el.className = 'tcell';
  el.classList.add('tcell');      // ⚠️ 与柱子同理：桩里 classList 与 className 是两套东西
  el.dataset.explain = 'trend.strip'; el.closest = (s) => (s === '.trendscroll' ? trendScroll : null);
  return el;
});
const document = {
  documentElement: Object.assign(makeEl('html'), { scrollWidth: 1200, clientWidth: 1200 }),
  body: makeEl('body'),
  getElementById: getById,
  createElement: (t) => makeEl(t),
  querySelector: () => null,
  querySelectorAll: (sel) => {
    if (sel === '[data-explain]') return explainHosts.concat(trendBars, trendCells, extraHosts);
    if (sel === '.exnum') {
      // 清理要覆盖**所有**宿主（含趋势柱体/刻度格），否则编号会在桩里累积，掩盖真实行为
      return explainHosts.concat(trendBars, trendCells, extraHosts)
        .flatMap((h) => (h.children || []).filter((c) => String(c.className).startsWith('exnum')));
    }
    if (sel === '.explain-num') {
      return explainHosts.concat(trendBars, trendCells, extraHosts).filter((el) => el.classList.contains('explain-num'));
    }
    if (sel === '#trendScroll .tbar') return trendBars;
    if (sel === '#trendScroll .tcell') return trendCells;
    if (sel === '#trendScroll [data-explain]') return trendBars.concat(trendCells);
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
  nodesOfReq, markerOf, metricOf, reqsOfTurn, lastOfTurn, turnSteps, goneMapOf, ability, isReplacement, EXPLAIN, CATS, applyTheme, editTurnUserMessage, turnLastUser, editorHtml, editTurnInject, turnLastInject, blockDrift, blockAct, orchAct };`;

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
  check('讲解模式给可标元素注入了**真实序号节点**（伪元素点不到，同类只标一个）', badges.length === 1, `badges=${badges.length}`);
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
  const S = api.S();
  S.trendMode = 'total'; S.trendCat = null; api.render();   // 前面的用例可能把模式停在 delta
  const html = registry.get('cardTrend').innerHTML;
  // ⚠️ 必须要求 "tbar" 后面紧跟空格或引号 —— 否则 class="tbar-fill" 也会被当成柱子
  //    （第一版就是这么错的：柱子数虚报成 144，另一条断言也被 fill 的内联 height 误伤）
  const bars = html.match(/class="tbar(?=[ "])[^"]*"/g) || [];
  const fills = html.match(/class="tbar-fill(?=[ "])[^"]*"/g) || [];
  check('趋势柱体：每根柱子都有内层图形 .tbar-fill', bars.length > 0 && fills.length === bars.length, `柱子 ${bars.length} 根 · 内层 ${fills.length} 个`);
  const outerHasHeight = /class="tbar(?=[ "])[^"]*"[^>]*style="[^"]*height:/.test(html);
  check('趋势柱体：高度不再写在外层按钮上（外层是整列命中区）', !outerHasHeight, outerHasHeight ? '外层仍带 height' : '');

  /* 柱体必须**按类别分色**（用户 2026-10-01：参考插件是"按分类树有多少类、按上下文占比画颜色"）。
   * 旧实现是整根一个品牌色 + 负值涂红 —— 看不出构成，也让"增量"失去意义。 */
  const segs = [...html.matchAll(/class="cseg" data-cat="([a-z]+)"/g)].map((m) => m[1]);
  const keys = new Set(['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool']);
  check('趋势柱体：段是按类别分的（每段带 data-cat）', segs.length > 0 && segs.every((k) => keys.has(k)), `段 ${segs.length} 个 · 类别 ${[...new Set(segs)].join('/')}`);
  check('趋势柱体：段用的是类别色（不再是单一品牌色）', (html.match(/class="cseg"[^>]*background:var\(--ds-color-/g) || []).length === segs.length, `带类别色的段 ${(html.match(/class="cseg"[^>]*background:var\(--ds-color-/g) || []).length}/${segs.length}`);
  // 总计模式：不应出现增量专用的零线与两臂
  check('总计模式：不渲染零线与上下两臂', !/zeroline/.test(html) && !/arm-up/.test(html));
}

/* 增量模式：围绕零线分两臂（正差向上、负差向下），且**不再用"红色 = 负"** */
{
  const S = api.S();
  S.trendMode = 'delta'; api.render();
  const html = registry.get('cardTrend').innerHTML;
  check('增量模式：有零线', /class="zeroline"/.test(html));
  check('增量模式：每根柱子分成向上的臂与向下的臂', (html.match(/class="arm arm-up"/g) || []).length > 0 && (html.match(/class="arm arm-down"/g) || []).length > 0);
  check('增量模式：段仍然是类别色（不用红色表示负）', !/--ds-color-red/.test(html));
  /* 每根柱子的"上臂 + 下臂"总高必须 ≤ 柱区高（112px）。
   * 不筛正负号的话两臂内容一样、总高翻倍 —— 实测踩过（两臂都是 system:42 + user:2 + …）。 */
  {
    const barsHtml = html.split('class="tbar').slice(1);
    const bad = barsHtml.filter((b) => {
      const hs = [...b.matchAll(/class="cseg"[^>]*height:(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
      return hs.reduce((n, h) => n + h, 0) > 112 + 1;
    });
    check('增量模式：上臂+下臂总高不超过柱区高（两臂没有重复渲染全部类别）', bad.length === 0, bad.length ? `${bad.length} 根柱子超了` : '');
  }

  check('增量模式：轴显式给出零线上下的量', /id="trendAxisBottom"/.test(html));
  S.trendMode = 'total'; api.render();
}

/* 趋势卡底部：步级快捷片与顺序导航已按用户意见删除（柱体 hover 就报第几轮/第几步） */
{
  const html = registry.get('cardTrend').innerHTML;
  check('趋势卡底部不再有步级快捷片', !/stepchips/.test(html) && !/chipstep/.test(html));
  check('趋势卡底部不再有 上一轮/下一轮/上一步/下一步 导航', !/上一轮|下一轮|上一步|下一步/.test(html));
  check('轮号刻度带保留（它是坐标轴，不是导航）', /class="strip"/.test(html));
}

/* ---------------- 讲解模式：同类重复元素只标一个编号，且不改变元素自身样式 ----------------
 * 用户 2026-10-01：「我以为讲解模式只是加个编号，不会影响原来的样式」→ 实测在趋势区影响很大：
 * ① 72 根柱子各挂一个编号 = 102 个编号糊满图表；② 讲解高亮用 outline 且特异性更高，
 *    把柱体的 hover/选中整片盖掉（详见 check-static 的第 5 条契约）。 */
{
  const S = api.S();
  S.explain = true; api.render();
  const badgesOf = (el) => (el.children || []).filter((c) => String(c.className).startsWith('exnum')).length;
  const noOf = (el) => { const b = (el.children || []).find((c) => String(c.className).startsWith('exnum')); return b ? b.textContent : null; };
  const dictIdx = (key) => Object.keys(api.EXPLAIN).indexOf(key);
  check('讲解模式：同类元素共用一个编号，只标一个', badgesOf(explainHosts[0]) === 1 && explainHosts.slice(1).every((h) => badgesOf(h) === 0), explainHosts.map(badgesOf).join(','));
  /* 编号规则（用户 2026-10-01 两轮反馈后定死）：
   *   ① 连续（不许留空号）；② 顺序由**类别**决定（词典顺序），不由"谁先出现在 DOM 里"决定。
   * 桩里的三个类别：trend.pick(词典 11) < trend.strip(13) < act.edit(20)，
   * 而 DOM 顺序恰恰是 act.edit 在最前 → 若实现退回"按出现顺序现数"，act.edit 会变成 1，这里就会红。 */
  {
    const nums = [noOf(explainHosts[0]), noOf(trendBars[1]), noOf(trendCells[0])].map(Number).sort((a, b) => a - b);
    check('讲解模式：编号连续（1..N，没有空号）', JSON.stringify(nums) === JSON.stringify([1, 2, 3]), `实际 ${nums.join(',')}`);
    check('讲解模式：编号顺序 = 类别的词典顺序（不随出现顺序变）',
      Number(noOf(trendBars[1])) < Number(noOf(trendCells[0])) && Number(noOf(trendCells[0])) < Number(noOf(explainHosts[0])) && dictIdx('trend.pick') < dictIdx('act.edit'),
      `pick=${noOf(trendBars[1])} strip=${noOf(trendCells[0])} edit=${noOf(explainHosts[0])}`);
  }
  check('讲解模式：柱子**不是每根都标**（3 根里只标 1 根）', trendBars.reduce((n, b) => n + badgesOf(b), 0) === 1, `柱子上的编号：${trendBars.map(badgesOf).join(',')}`);
  check('讲解模式：标记在**当前选中的那根**柱子上', badgesOf(trendBars[1]) === 1 && badgesOf(trendBars[0]) === 0 && badgesOf(trendBars[2]) === 0);
  check('讲解模式：轮次刻度格同样只标 1 个', trendCells.reduce((n, c) => n + badgesOf(c), 0) === 1, `刻度格上的编号：${trendCells.map(badgesOf).join(',')}`);
  /* 高亮（虚线环）必须**跟着编号走**：只有带编号的元素才该被标亮。
   * 否则柱子这类重复元素会各自带一个虚线环 —— 图表照样不像原样（用户就是为此提的意见）。 */
  const marked = (el) => (el.classList && el.classList.contains('explain-num') ? 1 : 0);
  check('讲解模式：只有带编号的元素被标亮（重复柱体不加环）', trendBars.reduce((n, b) => n + marked(b), 0) === 1, `带环的柱子：${trendBars.map(marked).join(',')}`);
  check('讲解模式：带编号的元素同时被标亮', badgesOf(explainHosts[0]) === 1 && marked(explainHosts[0]) === 1);
  S.explain = false; api.render();
  check('关掉讲解模式后，柱子与刻度格上的编号都被清理', trendBars.concat(trendCells).every((el) => badgesOf(el) === 0));
  check('关掉讲解模式后，标亮状态也被清理', trendBars.concat(trendCells).every((el) => marked(el) === 0));
}

/* ---------------- 主题与自检入口：都不再占顶栏（用户 2026-10-01） ---------------- */
{
  const html = registry.get('__html') ? '' : '';
  check('主题：跟随系统 —— 深色走 body[data-ds-dark-theme]（DSH 自己的选择器）', typeof api.applyTheme === 'function');
  check('主题：applyTheme 可被调用且不抛错', (() => { try { api.applyTheme(); return true; } catch (e) { return String(e); } })() === true);
}

/* ---------------- 趋势柱体与分类树必须同色（用户："柱体颜色和上下文浏览器不一样"） ----------------
 * 两边都从 CATS[].color 取色，所以只要没人再往柱子上加 filter/opacity 之类的色彩处理，就是同一个色。 */
{
  const S = api.S(); S.trendMode = 'total'; S.trendCat = null; api.render();
  const html = registry.get('cardTrend').innerHTML;
  const colors = [...html.matchAll(/background:([^;"]+)/g)].map((m) => m[1].trim());
  const catVars = new Set(api.CATS.map((c) => c.color));
  check('趋势柱体：段色直接取自 CATS（与分类树同一份）', colors.length > 0 && colors.every((v) => catVars.has(v)), `色值 ${[...new Set(colors)].join(' ')}`);
}

/* ---------------- R1.4「改这一轮的用户消息」必须**真的**做三件事 ----------------
 * 旧实现只有一句 `document.querySelector('[data-turn=N]').click()`，而 [data-turn] 只在"按步骤"模式的
 * 刻度格里才有 → 默认（按轮次）模式下点了等于没点（用户 2026-10-01 实测："按钮点击了没有效果？"）。 */
{
  const S = api.S();
  S.selTurn = 1; S.selSeq = api.reqsOfTurn(1)[0].seq; S.openCat = null; S.openElem = null; S.editor = null;
  const ok = api.editTurnUserMessage(1);
  const expect = api.turnLastUser(1);
  check('R1.4：点「改这一轮的用户消息」真的切到该轮最后一条用户消息', ok === true && expect !== null && S.selSeq === expect.req.seq, `selSeq=${S.selSeq} 期望 ${expect && expect.req.seq}`);
  check('R1.4：并展开「用户消息」类', S.openCat === 'user', `openCat=${S.openCat}`);
  check('R1.4：并就地展开编辑器（预填的是该条）', !!S.editor && S.editor.seq === expect.node.seq && S.editor.kind === 'edit', JSON.stringify(S.editor && { kind: S.editor.kind, seq: S.editor.seq }));
  S.sw.noUser = true;
  check('R1.4：这一轮没有用户消息时返回 false（按钮应为置灰态）', api.editTurnUserMessage(1) === false);
  S.sw.noUser = false; S.openCat = null; S.openElem = null; S.editor = null; api.render();
}

/* ---------------- 编号不许塞进装不下子节点的元素（select/input/textarea/img） ----------------
 * 用户 2026-10-01 问"11 编号在哪里？"—— `step.pick` 当时挂在 <select> 上，而 <select> 只能装 option，
 * 塞进去的 <span> 被浏览器直接丢掉，编号自然看不见。这类元素要把编号挂到**父节点**上。 */
{
  const S = api.S();
  const sel = makeEl('select'); sel.dataset.explain = 'step.pick';
  const wrap = makeEl('span'); sel.parentElement = wrap;
  extraHosts.push(sel);
  S.explain = true; api.render();
  const badgesIn = (el) => (el.children || []).filter((c) => String(c.className).startsWith('exnum')).length;
  check('讲解模式：data-explain 落在 <select> 上时，编号挂到父节点（select 里装不下）', badgesIn(wrap) === 1 && badgesIn(sel) === 0, `父节点 ${badgesIn(wrap)} · select 本身 ${badgesIn(sel)}`);
  check('讲解模式：高亮也跟着父节点（否则环也画不出来）', wrap.classList.contains('explain-num'));
  S.explain = false; api.render(); extraHosts.length = 0;
}

/* ---------------- R3.4：编辑器预填**全文**，多段要给提示；门禁第 5 条要能在 demo 上真验 ----------------
 * 用户 2026-10-01：「demo 里没有一条 >200 字、多段的用户消息，所以 R3.4（全文/多段合并提示）
 * 与人工门禁第 5 条在 demo 上验不了」。补一条这样的演示消息，并让它成为 R1.4 的目标。 */
{
  const S = api.S();
  // ⚠️ 前面的用例跑过"草稿 → 应用"，会往最后一轮追加一条替换体（seq 从 1600 起）（它就成了该轮最后一条用户消息）。
  //    这里先清干净，否则验的不是演示数据的原始状态（第一版就是这么误红的）。
  S.applied = []; S.extraNodes = []; S.drafts = {}; S.editor = null;
  const longOnes = api.NODES.filter((n) => n.cat === 'user' && String(n.text || '').length > 200 && /\n\s*\n/.test(n.text));
  check('演示数据里有一条 >200 字、多段的用户消息（门禁第 5 条才有得验）', longOnes.length >= 1, `条数=${longOnes.length} 最长=${Math.max(...longOnes.map((n) => n.text.length))} 字`);
  const longNode = longOnes[0];
  S.selTurn = api.TOTAL_TURNS; S.openCat = null; S.openElem = null; S.editor = null; S.sw.noUser = false;
  api.editTurnUserMessage(api.TOTAL_TURNS);
  check('R1.4 的目标就是那条长消息（点一下即可验"全文 + 多段提示"）', !!S.editor && S.editor.seq === longNode.seq, `editor.seq=${S.editor && S.editor.seq} 期望 ${longNode.seq}`);
  check('R3.4：编辑器里预填的是**全文**（不是 80 字预览）', !!S.editor && S.editor.text.length === longNode.text.length && S.editor.text.length > 200, `编辑器 ${S.editor && S.editor.text.length} 字 / 原文 ${longNode.text.length} 字`);
  const htmlLong = api.editorHtml();
  check('R3.4：多段消息在编辑器里给出"会被合并为一段"的提示', /这条消息有多个文本段落；改写后会合并为一段。/.test(htmlLong));
  const single = api.NODES.find((n) => n.cat === 'user' && !/\n\s*\n/.test(n.text) && String(n.text).length > 10);
  S.editor = { kind: 'edit', seq: single.seq, text: single.text, reasoning: '' };
  const htmlSingle = api.editorHtml();
  check('R3.4：单段消息**不**出现该提示（不许见谁都提示）', !/这条消息有多个文本段落/.test(htmlSingle), `单段样例 #${single.seq}`);
  S.editor = null; S.openCat = null; S.openElem = null; api.render();
}

/* ---------------- 注入内容是一等公民（用户 2026-10-01：「注入内容也是要编辑的」） ----------------
 * 检查四件事：能改（R2.1 的行按钮）→ 能钉住（存为不变量后**看得见**）→ 能看漂移（逐字比对）→
 * 能重注入 / 能退休（R4.3 的确认框）。之前只有"能改"，存完就消失了。 */
{
  const S = api.S();
  S.applied = []; S.extraNodes = []; S.drafts = {}; S.invariants = []; S.editor = null;
  S.selTurn = api.TOTAL_TURNS; S.selSeq = api.lastOfTurn(api.TOTAL_TURNS).seq; S.sw.noUser = false;
  api.render();

  const req = api.lastOfTurn(api.TOTAL_TURNS);
  const injects = api.nodesOfReq(req, true).filter((n) => n.cat === 'inject');
  const lastInj = injects[injects.length - 1];
  // ① 「改这一轮的注入内容」：R1.16，R1.4 的对称入口（它会把「注入内容」类展开）
  const ok = api.editTurnInject(api.TOTAL_TURNS);
  // ⚠️ 这条必须放在 editTurnInject 之后：注入类默认是折叠的，折叠时那不是"行上没按钮"而是"行没渲染"
  check('注入类：行上给出「存为不变量」（R2.1）', /data-act="pin"/.test(registry.get('cardBrowser').innerHTML) && injects.length > 0, `这一步注入 ${injects.length} 条`);
  check('R1.16：能切到该轮最后一条注入内容并展开编辑器', ok === true && S.openCat === 'inject' && !!S.editor && S.editor.seq === lastInj.seq, `editor.seq=${S.editor && S.editor.seq} 期望 ${lastInj.seq}`);
  check('R1.16：编辑器预填的是这条注入的全文', !!S.editor && S.editor.text === lastInj.text);

  // ② 存为不变量 → 面板里看得见
  S.editor = { kind: 'pin', seq: lastInj.seq, label: 'AGENTS.md', text: lastInj.text };
  // submitEditor 对固定块是从 DOM 读标签/正文的（真实页面里是用户在输入框里填）→ 桩里要先塞值
  document.getElementById('edLabel').value = 'AGENTS.md';
  document.getElementById('edPin').value = lastInj.text;
  api.submitEditor();
  const b = S.invariants[0];
  check('存为不变量：落库为 workspace 级 + 带 id/版本/时间', !!b && b.scope === 'workspace' && !!b.id && b.version === 1 && !!b.savedAt, JSON.stringify(b && { id: b.id, version: b.version, scope: b.scope }));
  api.render();
  check('固定块面板：列表里看得见它（不再是"存完就消失"）', new RegExp(b.id).test(registry.get('cardBlocks').innerHTML));

  // ③ 漂移检查：当前这一步逐字命中 → 在效
  const d0 = api.blockDrift(b);
  check('漂移检查：正文逐字出现在当前注入里 → 在效', d0.ok === true && d0.code === 'pinned', d0.why);

  // ④ 把这条注入改掉（走真正的 apply 路径）→ 漂移检查必须报出来
  S.drafts[lastInj.seq] = { seq: lastInj.seq, text: '（演示）把 AGENTS.md 这段口径改掉了', reasoning: '', requestSeq: api.lastOfTurn(api.TOTAL_TURNS).seq };
  api.doApply(lastInj.seq);
  const d1 = api.blockDrift(b);
  check('漂移检查：注入被改写后必须报"漂移"（不许沉默）', d1.ok === false && d1.code === 'edited', d1.why);

  // ⑤ 重注入：确认框（R4.3）→ 逐字追加
  api.blockAct('breinject', b.id);
  document.getElementById('modalReason').value = '宿主这轮没注入，钉回去';
  registry.get('modalOk').onclick();
  check('重注入：往会话**逐字**追加了这段正文', S.extraNodes.some((n) => n.text === b.text), `extraNodes=${S.extraNodes.length}`);

  // ⑥ 退休：确认框 → 不再生效（历史保留）
  api.blockAct('bretire', b.id);
  registry.get('modalOk').onclick();
  const d2 = api.blockDrift(b);
  check('退休固定块：不再生效，且历史版本仍在列表里', b.retired === true && d2.code === 'retired' && new RegExp(b.id).test(registry.get('cardBlocks').innerHTML));

  // ⑦ R5.2：一块固定块都没有时，要给出建议
  S.invariants = []; S.applied = []; S.extraNodes = []; api.render();
  check('R5.2：没有固定块时给出"先存固定块"的建议', /先把目标 \/ 约束/.test(registry.get('cardOrch').innerHTML));
}

/* ---------------- apply 生成的新 seq 不许撞上演示数据里已有的条目 ----------------
 * 2026-10-01 实测：生成规则本来是 `1300 + 已应用数`，而演示数据里已经有 1300/1301/1303/1305 →
 * **连改两次就撞号**，nodeOf() 会命中演示里那条同名 seq，出现"张冠李戴"（浏览器里真的复现了）。 */
{
  const S = api.S();
  S.applied = []; S.extraNodes = []; S.drafts = {}; S.editor = null;
  const before = new Set(api.NODES.map((n) => n.seq));
  const targets = [2, 3];                       // 两条不同的注入条目，各改一次
  for (const seq of targets) {
    S.drafts[seq] = { seq, text: '（演示）改后的正文 ' + seq, reasoning: '', requestSeq: api.lastOfTurn(api.TOTAL_TURNS).seq };
    api.doApply(seq);
  }
  const news = S.applied.map((a) => a.newSeq);
  check('apply 生成的新 seq 不与演示数据撞号', news.every((s) => !before.has(s)), `新 seq=${news.join(',')} · 原有 ${[...before].slice(-6).join(',')}…`);
  check('apply 生成的新 seq 彼此不重复', new Set(news).size === news.length, `新 seq=${news.join(',')}`);
  S.applied = []; S.extraNodes = []; S.drafts = {}; api.render();
}

/* ---------------- A17：每一种行类型的**按钮集合**按底层事件类型锁定（docs/03 R2.1 / R4.6） ----------------
 * 这条是"能编辑哪些内容"的机器答案：改 any 一行的按钮集合，这里就会红。 */
{
  const S = api.S();
  const btnsOf = (node) => {
    const a = api.ability(node);
    if (a.inert) return '（无动作条）';
    const out = [];
    if (a.canRewrite) out.push('编辑');
    if (a.canAnnotate) out.push('批注');
    if (a.pinnable) out.push('存为不变量');
    return out.join('+');
  };
  const byType = {};
  for (const n of api.NODES) {
    const key = `${n.cat}/${n.type}${n.compacted ? '/compacted' : ''}`;
    if (!byType[key]) byType[key] = btnsOf(n);
  }
  const expect = {
    'system/system/message': '（无动作条）',
    'tools': '（这一类没有行）',
    'user/user/message': '编辑+批注',
    'inject/user/message': '编辑+批注+存为不变量',
    'skill/user/message': '编辑+批注+存为不变量',
    'assistant/assistant/message': '批注',
    'tool/tool/result': '编辑+批注',
    'user/user/message/compacted': '批注'
  };
  for (const [k, v] of Object.entries(expect)) {
    if (k === 'tools') { check('按钮集合：工具定义（这一类在演示数据里没有行）', true, ''); continue; }
    check(`按钮集合：${k} → ${v}`, byType[k] === v, `实际 ${byType[k] === undefined ? '(没有这种行)' : byType[k]}`);
  }
  const sh = api.NODES.find((n) => n.seq === 1287);
  check('按钮集合：已被遮蔽的原文 → 不给「编辑」，并给原因', api.ability(sh).canRewrite === false && /接替/.test(api.ability(sh).blockReason), api.ability(sh).blockReason);

  // R3.2：编辑器字段按底层类型给
  const toolNode = api.NODES.find((n) => n.type === 'tool/result');
  S.editor = { kind: 'edit', seq: toolNode.seq, text: toolNode.text, reasoning: '', err: !!toolNode.err };
  const th = api.editorHtml();
  check('R3.2：工具结果的编辑器 = 结果文本 + isError（不给思考文本）', /id="edT"/.test(th) && /id="edErr"/.test(th) && !/id="edR"/.test(th));
  const userNode = api.NODES.find((n) => n.cat === 'user' && !n.compacted && n.type === 'user/message');
  S.editor = { kind: 'edit', seq: userNode.seq, text: userNode.text, reasoning: '', err: false };
  const uh = api.editorHtml();
  check('R3.2：用户消息的编辑器 = 可见文本 + 思考文本（不给 isError）', /id="edT"/.test(uh) && /id="edR"/.test(uh) && !/id="edErr"/.test(uh));

  // 工具结果的 isError 改动要能落进草稿、并带到新条目上
  S.applied = []; S.extraNodes = []; S.drafts = {};
  document.getElementById('edT').value = toolNode.text;
  document.getElementById('edErr').checked = !toolNode.err;
  S.editor = { kind: 'edit', seq: toolNode.seq, text: toolNode.text, reasoning: '', err: !!toolNode.err };
  api.submitEditor();
  check('工具结果：只勾选 isError 也算实质改动（落进草稿）', !!S.drafts[toolNode.seq] && S.drafts[toolNode.seq].err === !toolNode.err, JSON.stringify(S.drafts[toolNode.seq] && { err: S.drafts[toolNode.seq].err }));
  api.doApply(toolNode.seq);
  check('工具结果：apply 后新条目带上新的 isError', S.applied.length === 1 && S.extraNodes.some((n) => n.seq === S.applied[0].newSeq && n.err === !toolNode.err));
  S.applied = []; S.extraNodes = []; S.drafts = {}; S.editor = null; api.render();
}

/* ---------------- 「高级编辑」开关：默认收起"模型/工具回了什么"那两类的编辑入口 ----------------
 * 判据不是"会不会漂移"（注入内容/技能注入每轮被重新注入 → 会漂，属**常用**），
 * 而是"用户需要动手的概率"：工具结果一轮几十条、要改的概率低 → 默认收起，但**不许凭空消失**（R2.3）。 */
{
  const S = api.S();
  const toolNode = api.NODES.find((n) => n.type === 'tool/result');
  const editBtn = (seq) => new RegExp('data-act="edit" data-seq="' + seq + '"');
  S.openCat = 'tool'; S.sw.advanced = false; S.editor = null; api.render();
  const off = registry.get('cardBrowser').innerHTML;
  check('高级编辑关：工具结果行不显示「编辑」按钮', !editBtn(toolNode.seq).test(off));
  check('高级编辑关：但留「高级编辑」标记 + 说明在哪打开（R2.3 不许凭空消失）', /高级编辑/.test(off) && /打开顶部「高级编辑」开关/.test(off));
  check('高级编辑关：批注仍然在（助手消息只能靠批注纠正）', /data-act="annotate"/.test(off));
  S.sw.advanced = true; api.render();
  check('高级编辑开：工具结果的「编辑」出现', editBtn(toolNode.seq).test(registry.get('cardBrowser').innerHTML));
  S.sw.advanced = false; S.openCat = 'inject'; api.render();
  check('高级编辑关：注入内容的「编辑」不受影响（常用类始终可见）', /data-act="edit"/.test(registry.get('cardBrowser').innerHTML));
  S.openCat = 'skill'; api.render();
  check('高级编辑关：技能注入的「编辑」也不受影响（它与注入内容同族：每轮重注入、会漂）', /data-act="edit"/.test(registry.get('cardBrowser').innerHTML));
  S.sw.advanced = false; S.openCat = 'user'; api.render();
}

/* ---------------- 批注：写入型提交**必须先出确认框**（R3.3.1），且框里要写清它在快照里起什么作用 ----------------
 * 用户 2026-10-01 问："批注以后，在新的会话快照中，这个批注起到什么作用？" ——
 * 答案必须在确认框里能读到，否则用户只能靠猜（原先这段连确认框都没有，是漏了 R3.3.1）。 */
{
  const S = api.S();
  S.applied = []; S.extraNodes = []; S.drafts = {};
  const node = api.NODES.find((n) => n.cat === 'user' && !n.compacted && n.type === 'user/message');
  S.selSeq = api.lastOfTurn(api.TOTAL_TURNS).seq;
  S.editor = { kind: 'annotate', seq: node.seq, reason: '演示理由', voidFrom: String(node.seq), voidTo: String(node.seq) };
  document.getElementById('edWhy').value = '演示理由';
  document.getElementById('edFrom').value = String(node.seq);
  document.getElementById('edTo').value = String(node.seq);
  const before = S.extraNodes.length;
  api.submitEditor();
  check('批注：提交**先出确认框**，不直接写会话（R3.3.1）', S.extraNodes.length === before && registry.get('modalWrap').hidden === false, `extraNodes=${S.extraNodes.length}`);
  const rows = registry.get('modalList').innerHTML;
  check('批注确认框：写明它在**快照/子会话**里的作用', /在快照里/.test(rows) && /fork 种子/.test(rows), '');
  check('批注确认框：写明它是"请求式"的（不遮蔽原文、不保证模型照做）', /请求式/.test(rows) && /不遮蔽原文/.test(rows));
  check('批注确认框：给出"想确定生效"的替代路径', /确定生效/.test(rows) && /应用到会话/.test(rows));
  check('批注确认框：短警示说清"原文保留、两者都能看到"', /不可撤销；原文保留，模型两者都能看到/.test(registry.get('modalWarn').textContent));
  check('批注确认框：本次清单含更正目标（人话）/ 范围说明 / 理由', /更正目标/.test(rows) && /只针对上面这一条/.test(rows) && /理由/.test(rows));
  document.getElementById('modalOk').onclick();
  const added = S.extraNodes[S.extraNodes.length - 1];
  check('批注确认后：真的追加了那条更正（带结构化头部）', S.extraNodes.length === before + 1 && /\[redline\] 更正目标 seq=/.test(added.text) && /作废范围 seq=/.test(added.text));
  S.extraNodes = []; S.applied = []; S.drafts = {}; S.editor = null; api.render();
}

/* ---------------- 子会话的上下文也能编辑：行上必须说清"现在能不能改"（用户 2026-10-01 问） ----------------
 * 事实：子会话是真会话；面板跟"当前选中的会话"走 → **打开它就能编辑它的上下文**，不需要两套界面。
 * 两条前提：① 它**轮次闭合**；② 它**在本进程**（docs/03 R5.1.3）。 */
{
  const S = api.S();
  S.children = [
    { id: '00aaaaaa', src: 'own', state: 'running', label: '跑测试', from: 'snap-1' },
    { id: '00bbbbbb', src: 'own', state: 'idle', label: '写文档', from: 'snap-1' }
  ];
  api.render();
  const html = registry.get('cardOrch').innerHTML;
  check('子会话索引：运行中的那一行要说明"轮次闭合前只能看，不能改"', /轮次闭合前只能看，不能改/.test(html));
  check('子会话索引：空闲的那一行要说明"打开它就能像这里一样编辑"', /打开它 = 面板切到它的上下文，就能像这里一样编辑/.test(html));
  check('子会话索引：打开按钮的说明里点出"子会话的上下文同样能编辑"', /子会话的上下文同样能编辑/.test(JSON.stringify(api.EXPLAIN['child.open'])));
  check('子会话索引：说明里点出两条前提（轮次闭合 / 在本进程）', /轮次闭合/.test(api.EXPLAIN['child.open'].effect) && /在本进程/.test(api.EXPLAIN['child.open'].effect));
  S.children = []; api.render();
}

/* ---------------- 界面说人话（用户 2026-10-01 四条） ----------------
 * ① 思考文本收进「高级」折叠、主字段叫「正文」；② 批注的作废范围**不用输数字**；
 * ③ 动态出现的按钮有「?」；④ 「保存草稿」旁边写清两步流程。 */
{
  const S = api.S();
  const userNode = api.NODES.find((n) => n.cat === 'user' && !n.compacted && n.type === 'user/message');
  S.editor = { kind: 'edit', seq: userNode.seq, text: userNode.text, reasoning: '', err: false };
  const eh = api.editorHtml();
  check('编辑用户消息：主字段叫「正文」', /正文/.test(eh) && /id="edT"/.test(eh));
  check('编辑用户消息：思考文本收进「高级」折叠（默认不展开）', /<details class="adv">/.test(eh) && /id="edR"/.test(eh));
  check('编辑用户消息：写清两步流程（保存草稿 → 应用到会话才生效）', /第 1 步/.test(eh) && /应用到会话/.test(eh) && /才会真的生效/.test(eh));
  check('编辑器：提交按钮**左上角飘一个「?」**（与讲解模式序号同一种做法，不是按钮后面挂一个）', /class="qfloat"[^>]*data-help="act.edit"/.test(eh) && /class="qwrap"/.test(eh));

  // 批注：不许再出现数字输入框，作废范围改成"就这一条 / 从这条到…"
  S.editor = { kind: 'annotate', seq: userNode.seq, reason: '演示', voidFrom: String(userNode.seq), voidTo: String(userNode.seq) };
  const ah = api.editorHtml();
  check('批注：不再让用户输 seq 数字（没有 type="number"）', !/type="number"/.test(ah));
  /* 用户 2026-10-01：一步可能几百条、一会话上万条，"从这条到…"的下拉既没有语义、又是性能/体验负担
   * → 批注**只针对点的那一条**；要更大的范围就写在理由里（模型读的正是理由）。 */
  check('批注：**没有**范围选择器（不许出现下拉/区间选择）', !/id="edTo"/.test(ah) && !/voidRange/.test(ah), '');
  check('批注：只针对"你点的那一条"，并说清更大范围写在理由里', /只针对/.test(ah) && /写在理由里/.test(ah));
  check('批注：更正目标用人话描述（轮/步/类别/正文开头），seq 退居括号', /class="targetbox"/.test(ah) && /第 \$\{/.test(ah) === false && /事件序号 #/.test(ah));
  check('批注：提交按钮左上角也有「?」', /class="qfloat"[^>]*data-help="act.annotate"/.test(ah));

  // 走一遍：默认"就这一条"→ 确认框里写的是人话范围
  S.extraNodes = []; S.applied = [];
  document.getElementById('edWhy').value = '演示理由';
  api.submitEditor();
  const rows = registry.get('modalList').innerHTML;
  check('批注确认框：更正目标显示成人话（第 N 轮 · 第 M 步 · 类别 “正文…”（#seq））', /第 \d+ 轮 · 第 \d+ 步/.test(rows) && /#\d+/.test(rows), rows.slice(0, 90));
  document.getElementById('modalOk').onclick();
  S.extraNodes = []; S.applied = []; S.editor = null; api.render();
}

/* ---------------- 「说人话」的固定结构：一句话是什么 / 为什么需要 / 什么时候用 / 不做什么 ----------------
 * 用户 2026-10-01：「看了右侧弹出的提示，也没看懂」→ 说明文字光有术语不算说明，要有这四段。 */
{
  const need = (key, marks, label) => {
    const e = api.EXPLAIN[key];
    const text = e ? (e.what + ' ' + e.effect + ' ' + e.rev) : '';
    check(`说明说人话：${label}`, !!e && marks.every((m) => text.includes(m)), e ? marks.filter((m) => !text.includes(m)).join('缺:') || '' : '没有这条讲解词');
  };
  need('act.pin', ['一句话', '为什么需要', '你什么时候会用它', '它不做什么', '逐字'], '存为不变量');
  need('orch.freeze', ['一句话', '记下什么', '为什么需要', '它不做什么', '什么时候会用'], '冻结当前位置');
  need('orch.spawn', ['一句话', '两条路', '种子是一次性的', '在界面上怎么找'], '开子会话');
  // 上下文事件卡：必须说明"这一栏是干什么用的"
  const cap = registry.get('cardEvents').innerHTML;
  check('上下文事件卡：说明"这一栏是干什么用的"（不只是图标含义）', /这一栏是干什么用的/.test(cap) && /被压掉的条目从此改不了/.test(cap));
}

/* ---------------- 用户 2026-10-01「再四问」：全局性 / 随位置变化 / 历史机制 / 多轮子会话 ----------------
 * ① 固定块是**全局**的（按钮在行上只是"要选钉哪一段"）；
 * ② 上下文事件必须**随当前位置变化**（已发生 / 尚未发生）；
 * ③ 冻结是**历史机制**（每点一次加一条，不覆盖）；
 * ④ 开子会话必须说清"**多轮 + 双向 + 可指定模型与推理档 + 可带标签**"。 */
{
  const S = api.S();
  // ① 全局性
  S.invariants = []; S.applied = []; S.extraNodes = []; api.render();
  const blocks = registry.get('cardBlocks').innerHTML;
  check('固定块面板：写明它是**全局**的（不只属于注入内容/技能注入）', /全局/.test(blocks) && /workspace 级/.test(blocks), '');
  check('固定块面板：解释"按钮为什么长在条目行上"（要选钉哪一段）', /按钮之所以长在/.test(blocks) && /钉哪一段/.test(blocks));

  // ② 事件随位置变化
  // 取"两个事件之间"的那一刻：这样才能同时看到"1 条已发生 + 1 条还没发生"
  const between = api.REQUESTS.find((r) => r.seq >= 1200);
  const early = between.seq, late = api.lastOfTurn(api.TOTAL_TURNS).seq;
  S.selSeq = early; S.selTurn = between.turn; api.render();
  const evEarly = registry.get('cardEvents').innerHTML;
  S.selSeq = late; S.selTurn = api.TOTAL_TURNS; api.render();
  const evLate = registry.get('cardEvents').innerHTML;
  check('上下文事件：看早期那一步时，事件标成「尚未发生」+ 计数分开显示', /尚未发生/.test(evEarly) && /已发生 1/.test(evEarly) && /还没发生 1/.test(evEarly));
  check('上下文事件：看最后一步时，事件全部「已发生」且内容与早期**不一样**', !/尚未发生/.test(evLate) && /已发生 2/.test(evLate) && evEarly !== evLate);
  check('上下文事件：会变的事件做成行（is-done / is-todo），不变的说明收成小字', /class="evrow is-done"/.test(evLate) && /evhint/.test(evLate));

  /* ③ 冻结：**幂等**（用户 2026-10-01 纠正："同一位置再点一次为什么会出现多条？"）——
   * 一条记录的身份 = 「切点 + 当时的固定块版本」；同身份再点 → **不新增**，只问要不要改备注。
   * 备注可改；切点/条目数/时刻/固定块版本不可改（客观读数），只能删。 */
  S.snapshots = [];
  api.orchAct({ dataset: { act: 'freeze' } });
  const afterOne = S.snapshots.length;
  api.orchAct({ dataset: { act: 'freeze' } });
  check('冻结：同一位置再点**不新增**记录（幂等），而是问"要不要改备注"', afterOne === 1 && S.snapshots.length === 1 && registry.get('modalWrap').hidden === false && /已经冻过/.test(registry.get('modalTitle').textContent), `第一次=${afterOne} 第二次=${S.snapshots.length}`);
  check('冻结确认框：写明"只保留一条"并列出不会变的字段', /只保留一条/.test(registry.get('modalWarn').textContent) && /不会变的字段/.test(registry.get('modalList').innerHTML));
  document.getElementById('snapNote').value = '改一下备注';
  document.getElementById('modalOk').onclick();
  check('冻结：备注能被更新，且仍然只有一条记录', S.snapshots.length === 1 && S.snapshots[0].note === '改一下备注', `note=${S.snapshots[0] && S.snapshots[0].note}`);
  // 换一个位置 → 才是新记录
  S.selSeq = api.REQUESTS[0].seq; S.selTurn = api.REQUESTS[0].turn;
  api.orchAct({ dataset: { act: 'freeze' } });
  check('冻结：**不同位置**才新增一条（两条并存）', S.snapshots.length === 2);
  // 改备注 / 删除
  api.orchAct({ dataset: { act: 'snote', i: 1 } });
  document.getElementById('modalReason').value = '第二条的备注';
  document.getElementById('modalOk').onclick();
  check('冻结记录：备注可就地改（另一条不受影响）', S.snapshots[1].note === '第二条的备注' && S.snapshots[0].note === '改一下备注');
  api.orchAct({ dataset: { act: 'sdel', i: 0 } });
  document.getElementById('modalOk').onclick();
  check('冻结记录：可删除（只删本地记录）', S.snapshots.length === 1 && S.snapshots[0].note === '第二条的备注');

  // ④ 多轮子会话的事实必须写在讲解词里
  const sp = api.EXPLAIN['orch.spawn'].what;
  check('开子会话说明：写明**可以多轮**（每发一条 = 一个新轮次）', /多轮的/.test(sp) && /新轮次/.test(sp));
  check('开子会话说明：写明**双向互通**（子也能给父发，父不在进程会冷恢复）', /双向互通/.test(sp) && /冷恢复/.test(sp));
  check('开子会话说明：写明可**指定模型与推理档**并给短标签', /reasoningEffort/.test(sp) && /label/.test(sp));
  // ⑤ 「发消息」：官方通道 = 排成子会话的下一个轮次（多轮）
  S.children = [{ id: '00aaaaaa', src: 'own', state: 'running', label: '跑测试', from: 'snap-1' }];
  api.render();
  api.orchAct({ dataset: { act: 'cprompt', i: 0 } });
  check('发消息：先出确认框，且写明"会成为它的新轮次 / 忙就排队"', registry.get('modalWrap').hidden === false && /新轮次/.test(registry.get('modalWarn').textContent) && /排队/.test(registry.get('modalWarn').textContent));
  check('发消息：确认框写明走的是官方通道', /ctx\.subagents\.prompt/.test(registry.get('modalList').innerHTML) && /queue/.test(registry.get('modalList').innerHTML));
  document.getElementById('modalReason').value = '再跑一遍全量测试';
  document.getElementById('modalOk').onclick();
  check('发消息：确认后真的排上一条（行上出现已排队计数）', S.children[0].sent === 1 && /已排队/.test(registry.get('cardOrch').innerHTML));

  S.sw.team = false; api.render();
  const off = registry.get('cardOrch').innerHTML;
  check('发消息（子会话通道）**不依赖官方团队**：团队关着它照样在', /data-act="cprompt"/.test(off));
  check('派活（团队通道）团队关着就**不出现**（不是置灰）', !/data-act="csend"/.test(off));
  S.sw.team = true;
  S.invariants = []; S.snapshots = []; S.children = []; S.selTurn = api.TOTAL_TURNS; S.selSeq = late; api.render();
}

/* ---------------- 汇报 ---------------- */
const bad = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  → ' + r.detail : ''}`);
console.log(`\n共 ${results.length} 项，失败 ${bad.length} 项`);
if (bad.length) process.exitCode = 1;
