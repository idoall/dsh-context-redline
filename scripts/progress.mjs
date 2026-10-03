#!/usr/bin/env node
/**
 * 进度可见（M6-12）—— 只读地把 `docs/10-execution-checklist.md` 讲成人话。
 *
 * 用户 2026-10-01：「过程中可以看到哪些已完成、哪些未完成」。
 *
 * 三条纪律：
 *   · **只读**：不写任何文件（用例用 sha256 前后比对守着）。
 *   · **只认表格**：总数与各状态计数从**任务表**里数出来，不读 §11 的汇总 ——
 *     这样"汇总写错了"会表现为**不一致**，而不是被原样复述成事实。
 *     `docs/10` 是唯一状态源（`AGENTS.md` §5），汇报器不许另立一套。
 *   · **退出码 0**：它是给人看的，不是门禁；真门禁是 `check-docs.mjs` 与各 lane。
 *
 * 用法：
 *   node scripts/progress.mjs           # 总数 / 各状态 / 各阶段完成率 / 未完成条目
 *   node scripts/progress.mjs --all     # 连已完成的条目一起列
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKLIST = join(ROOT, 'docs/10-execution-checklist.md')

/** 任务状态：`WAIT🙋` 是唯一会停下来的状态（`docs/10` 头部第 4 条）。 */
export const STATUSES = ['DONE', 'DOING', 'TODO', 'WAIT🙋']

/**
 * 一行任务：`| ID | 子任务 | 状态 | 文件动作 |`。
 *
 * ⚠️ 不能按"第 3 格就是状态"来切：`docs/10` 里有个别行的**标题格里带了一个未转义的 `|`**
 * （真实存在，第一次跑就被自己的用例抓到）。所以状态格靠**内容**定位 —— 从左边找第一个
 * 以已知状态开头的格；标题 = 中间那些格拼回来。
 */
// ID 允许结尾一个小写字母（真实存在：`M05-52b` 是补正类的子任务）——
// 与 `check-docs.mjs` 的 ID 形状保持一致，否则汇报器会比门禁少数一条。
const ROW_ID = /^\|\s*([A-Z][A-Z0-9]*-\d+[a-z]?)\s*\|/

/** 阶段标题：`## 3. M1 · 骨架与身份（**12 / 14 DONE**）—— …`。 */
const HEADING = /^##\s+(.+?)\s*$/

/** 表格里的行 -->
 * @typedef {{ id: string, title: string, status: string, stage: string }} Item */

/**
 * 取一行标题的"一行话"：去掉 markdown 强调、把 `~~…~~`（作废）与反引号剥掉，
 * 并截到第一个句读，供列表里一眼看。
 */
function oneLine(text) {
  const plain = text
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  const cut = plain.split(/[。；：!(（]/)[0] ?? plain
  return cut.length > 72 ? cut.slice(0, 71) + '…' : cut
}

/** 状态归一：`WAIT🙋` 里的表情符号不掉，其余取大写的第一个词。 */
function statusOf(cell) {
  const raw = cell.trim()
  for (const s of STATUSES) if (raw.startsWith(s)) return s
  return raw
}

/**
 * 解析清单。**只读表格行**；`§11` 的总览表因为行首是阶段名、不是 ID 形状，天然不会被当成任务。
 *
 * @param {string} markdown
 * @returns {{ items: Item[], stages: { name: string, items: Item[] }[], totals: { total: number, byStatus: Record<string, number> } }}
 */
export function parseChecklist(markdown) {
  /** @type {Item[]} */
  const items = []
  /** @type {{ name: string, items: Item[] }[]} */
  const stages = []
  let stage = null
  let inTable = false
  for (const line of markdown.split('\n')) {
    const h = HEADING.exec(line)
    if (h !== null) {
      stage = { name: h[1], items: [] }
      stages.push(stage)
      inTable = false
      continue
    }
    // 表头 / 分隔行：只在任务表里出现，跳过并把后续行视为表格内容
    if (/^\|\s*ID\s*\|/.test(line)) { inTable = true; continue }
    if (/^\|[\s:-]+\|/.test(line)) continue
    if (!inTable && !line.startsWith('| ')) continue
    const head = ROW_ID.exec(line)
    if (head === null) continue
    const id = head[1]
    // 拆格后按内容找状态格（见 ROW_ID 上方的说明）
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
    const at = cells.findIndex(c => STATUSES.some(s => c.startsWith(s)))
    if (at < 1) continue
    const item = {
      id,
      title: cells.slice(1, at).join(' | '),
      status: statusOf(cells[at]),
      stage: stage?.name ?? '(无阶段)',
      files: cells.slice(at + 1).join(' | '),
    }
    if (stage !== null) stage.items.push(item)
    items.push(item)
  }
  const byStatus = {}
  for (const s of STATUSES) byStatus[s] = 0
  for (const it of items) byStatus[it.status] = (byStatus[it.status] ?? 0) + 1
  const kept = stages.filter(s => s.items.length > 0)
  for (const s of kept) {
    s.total = s.items.length
    s.done = s.items.filter(i => i.status === 'DONE').length
  }
  return { items, stages: kept, totals: { total: items.length, byStatus } }
}

/**
 * 渲染报告。
 *
 * @param {ReturnType<typeof parseChecklist>} cl
 * @param {{ all?: boolean }} [opts]
 */
export function renderReport(cl, opts = {}) {
  const { total, byStatus } = cl.totals
  const out = []
  out.push('docs/10 进度（只读；任务表是唯一状态源）')
  out.push('')
  out.push(`共 ${total} 条`)
  out.push(STATUSES.map(s => `${s} ${byStatus[s] ?? 0}`).join(' · '))
  out.push('')
  out.push('## 各阶段')
  for (const s of cl.stages) {
    const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0
    const bar = '█'.repeat(Math.round(pct / 10)).padEnd(10, '·')
    out.push(`${bar} ${String(pct).padStart(3)}%  ${s.done}/${String(s.total).padStart(3)}  ${s.name}`)
  }
  const open = cl.items.filter(i => i.status !== 'DONE')
  const listed = opts.all === true ? cl.items : open
  out.push('')
  out.push(opts.all === true ? `## 全部条目（${listed.length}）` : `## 未完成（${listed.length}）`)
  let lastStage = null
  for (const it of listed) {
    if (it.stage !== lastStage) { out.push(`\n### ${it.stage}`); lastStage = it.stage }
    out.push(`${it.status === 'WAIT🙋' ? '🙋' : it.status === 'DOING' ? '▶' : it.status === 'TODO' ? '·' : '✓'} ${it.id}  ${oneLine(it.title)}`)
  }
  out.push('')
  return out.join('\n')
}

function main(argv) {
  const markdown = readFileSync(CHECKLIST, 'utf8')
  const cl = parseChecklist(markdown)
  process.stdout.write(renderReport(cl, { all: argv.includes('--all') }) + '\n')
  return 0
}

// 只有直接运行时才输出（被 import 时保持安静，方便用例断言纯函数）
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
