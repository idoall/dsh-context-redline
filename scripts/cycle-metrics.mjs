#!/usr/bin/env node
/**
 * 「开子会话这一周期，父会话到底长了多少、长的是什么」—— `docs/10` **M5-21** 的读数工具（`docs/00` S9）。
 *
 * 为什么是**只读脚本**而不是模块：S9 的产物是**一次真机读数**（验收记录），不是界面功能
 * （demo/准绳里没有这个面板）⟹ 造一个没有消费者的模块就是死代码；脚本在验收时真的被跑。
 *
 * 为什么**不走"直接读日志文件"**（我第一版就是这么写的，已作废）：
 * 本机运行时的会话日志是 `$DSH_HOME/sessions/**\/<会话>/session.v4.jsonl.zstd`，
 * 而它是 **4161 个 zstd 帧拼接**的追加式文件（2026-10-07 实测，`docs/01` **F60**）——
 * Node 自带的 `zstdDecompressSync` 与 `createZstdDecompress` **都只解第一帧**（只拿到 session 头），
 * 本机也没有 `zstd` CLI ⟹"读文件"这条路拿不到事件。
 * 所以走**平台自己的读路径**：我们自己的 `POST /api/dsh-context-redline/detail`
 * （`src/host/detail.ts`，live 会话读注册表的 fold、冷会话走 `sessionQuery.observeSession`）。
 *
 * 用法：
 *   node scripts/cycle-metrics.mjs <sessionId> [--from <seq>] [--url https://127.0.0.1:3081]
 *   node scripts/cycle-metrics.mjs --self-check
 *
 * 判定行（照本仓库习惯，一句话）：`事件 +N · 请求 +M · 父会话工具 tokens +T（S9 要求 T = 0）`
 */

// 本机自签证书：这是**只读**的本机调用，仅用于测量（不写任何东西）。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

/** 事件 → 来源（S9 只关心"人的决策"与"平台自己写的"；父会话里的工具活动是**违规信号**）。 */
export function sourceOf(event) {
  const kind = String(event?.kind ?? 'unknown')
  const form = event?.form === undefined ? '' : '/' + String(event.form)
  if (kind === 'inject' && form === '/notice') return '平台通知（结算等）'
  if (kind === 'inject' && form === '/relay') return '子会话来的转发消息'
  if (kind === 'inject' && form === '/catalog') return '子会话登记（平台写）'
  if (kind === 'inject' && form === '/snapshot') return '宿主注入：状态快照'
  if (kind === 'inject' && form === '/instructions') return '宿主注入：指令'
  if (kind === 'inject' && form === '/context') return '宿主注入：上下文'
  if (kind === 'prune') return '平台剪枝'
  if (kind === 'compaction') return '平台压缩'
  return '其他（' + kind + form + '）'
}

/** 事件增量：按来源逐条列出（条数 + tokens）。 */
export function eventDelta(events, from = null) {
  const window = (Array.isArray(events) ? events : []).filter(e => from === null || Number(e.seq) > from)
  const bySource = new Map()
  let tokens = 0
  for (const e of window) {
    const key = sourceOf(e)
    const t = typeof e.tokens === 'number' ? e.tokens : 0
    tokens += t
    const current = bySource.get(key) ?? { events: 0, tokens: 0 }
    bySource.set(key, { events: current.events + 1, tokens: current.tokens + t })
  }
  const sources = [...bySource.entries()].map(([source, stat]) => ({ source, ...stat })).sort((a, b) => b.events - a.events)
  return { events: window.length, tokens, sources }
}

/** 请求增量：S9 的关键判据 —— 父会话在周期里有没有**自己动工具**。 */
export function requestDelta(requests, from = null) {
  const window = (Array.isArray(requests) ? requests : []).filter(r => from === null || Number(r.seq) > from)
  const sum = (key) => window.reduce((acc, r) => acc + (typeof r[key] === 'number' ? r[key] : 0), 0)
  return { requests: window.length, tool: sum('tool'), assistant: sum('assistant'), user: sum('user'), total: sum('total') }
}

function selfCheck() {
  const events = [
    { seq: 1, kind: 'inject', form: 'snapshot', tokens: 10 },
    { seq: 2, kind: 'inject', form: 'notice', tokens: 5 },
    { seq: 3, kind: 'prune', tokens: 0 },
  ]
  const requests = [{ seq: 1, tool: 0, assistant: 3, user: 2, total: 5 }, { seq: 2, tool: 7, assistant: 1, user: 0, total: 8 }]
  const problems = []
  const all = eventDelta(events)
  const tail = eventDelta(events, 1)
  if (all.events !== 3 || all.tokens !== 15) problems.push('事件增量不对')
  if (tail.events !== 2) problems.push('--from 窗口不对')
  if (tail.sources.find(s => s.source === '平台通知（结算等）')?.events !== 1) problems.push('通知没归到平台')
  const req = requestDelta(requests, 1)
  if (req.tool !== 7 || req.requests !== 1) problems.push('请求增量/工具 tokens 没数出来')
  console.log(problems.length === 0
    ? '✅ cycle-metrics 自检通过（事件 3/2 · 通知归平台 · 工具 tokens 7）'
    : '❌ 自检失败：' + problems.join('、'))
  return problems.length === 0
}

const args = process.argv.slice(2)
if (args.includes('--self-check')) process.exit(selfCheck() ? 0 : 1)
const flagOf = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const sessionId = args[0] !== undefined && !args[0].startsWith('--') ? args[0] : null
const fromRaw = flagOf('--from', null)
const from = fromRaw === null ? null : Number(fromRaw)
const url = flagOf('--url', 'https://127.0.0.1:3081')
if (sessionId === null || Number.isNaN(from)) {
  console.error('用法：node scripts/cycle-metrics.mjs <sessionId> [--from <seq>] [--url https://127.0.0.1:3081] | --self-check')
  process.exit(2)
}
const response = await fetch(url + '/api/dsh-context-redline/detail', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId }),
})
const envelope = await response.json()
if (envelope?.ok !== true || envelope.value === null) {
  console.error('detail 拿不到这条会话（HTTP ' + String(response.status) + '）：' + JSON.stringify(envelope).slice(0, 200))
  process.exit(3)
}
const value = envelope.value
const events = eventDelta(value.events, from)
const requests = requestDelta(value.requests, from)
console.log('会话：' + sessionId + '（detail rev ' + String(value.rev) + '）')
console.log('窗口：' + (from === null ? '保留窗口全部' : 'seq > ' + String(from)) + '（事件 ' + String(Array.isArray(value.events) ? value.events.length : 0) + ' 条 · 请求 ' + String(Array.isArray(value.requests) ? value.requests.length : 0) + ' 次）')
for (const one of events.sources) console.log('  事件 · ' + one.source + '：' + String(one.events) + ' 条 · ' + String(one.tokens) + ' tokens')
console.log('  请求 · 人写 ' + String(requests.user) + ' · 模型 ' + String(requests.assistant) + ' · 工具 ' + String(requests.tool) + ' · 合计 ' + String(requests.total) + ' tokens')
const scope = from === null ? '（**没有 --from ⟹ 这是保留窗口总量，不是周期增量**）' : '（周期增量；S9 要求父会话工具 tokens = 0）'
console.log('事件 +' + String(events.events) + ' · 请求 +' + String(requests.requests) + ' · 父会话工具 tokens +' + String(requests.tool) + ' ' + scope)
