#!/usr/bin/env node
/**
 * 文档一致性检查（`node scripts/check-docs.mjs`）
 *
 * 存在理由：2026-10-01 的文档 review 发现三类**靠人眼必然复发**的漂移 ——
 *   ① 版本号写死且过期（运行时 0.2.0-rc.1 → 实际 rc.2）
 *   ② 目录方案并存（src/edit、src/orchestrate、src/redline、test/ 单数、tests/redline）
 *   ③ 计数过期（README 写 167 项、docs/10 §11 与正文不一致）
 * 所以把它们变成机器检查；本脚本只读，退出码 0 = 干净，1 = 有漂移。
 *
 * 约定（与 docs/11「实施共识」一致）：
 *   - 现行运行时版本写 `0.2.0-rc.2`；提到 rc.1 的行必须显式带「历史」二字。
 *   - 参考插件：复制基线 = tag `v0.59.2`（行内须带「基线/tag/复制」）；
 *     并存对手 = 实装 `0.60.0`。单独出现 `0.59.2` 且讲"已装/在跑"的视为过期。
 *   - 实现目录：`src/redline/**`（纯逻辑）、`src/host/redline-channel.ts`（唯一接线）、
 *     `src/client/**`、`src/shared/**`；测试目录 `tests/edit/**`、`tests/channel/**`。
 *     `src/edit/**`、`src/orchestrate/**`、`tests/redline/**`、`test/**`（单数）属归档线旧命名，
 *     只允许出现在带「归档/历史/旧」的行里。
 *   - 按钮名统一 `钉住这一段`（`存为不变量` 是旧名）。
 *   - 断言载体不许用 `deriveMessages()`（live Session 同步读，AGENTS §2.2 禁止新代码调用），
 *     除非该行带「历史」。
 *   - 不许引用已删除的 `docs/07`；不许出现被明令禁止的内部函数 `withContinuableReturnGuidance`。
 */
import { readFileSync, existsSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WAIT = 'WAIT' + String.fromCodePoint(0x1F64B)   // 避免源码里出现裸 emoji（编码易坏）
const problems = []
const notes = []
const rel = (p) => p.replace(ROOT + '/', '')

function read(p) {
  const abs = join(ROOT, p)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null
}

function walk(dir, out = []) {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return out
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(md|mjs|json|yml|ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

const DOCS = ['AGENTS.md', 'README.md', 'README.zh.md', 'UPSTREAM.md',
  ...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)]

/** 每行检查：命中 pattern 且该行不含任一豁免词 → 记问题 */
function scanLines(label, files, pattern, allowWords, hint) {
  for (const f of files) {
    const txt = read(f)
    if (txt == null) continue
    txt.split('\n').forEach((line, i) => {
      if (pattern.test(line) && !allowWords.some((w) => line.includes(w))) {
        problems.push(`[${label}] ${f}:${i + 1} ${hint}\n      ↳ ${line.trim().slice(0, 120)}`)
      }
    })
  }
}

/* ---------- ① 版本号 ---------- */
scanLines('版本', DOCS, /0\.2\.0-rc\.1/, ['历史'], '现行运行时是 0.2.0-rc.2；写 rc.1 的行必须显式标「历史」')
scanLines('参考插件', DOCS, /(dsh-context@0\.59\.2|已装[^\n]{0,20}0\.59\.2|在跑[^\n]{0,20}0\.59\.2)/,
  ['历史'], '并存对手是实装 0.60.0（npm 版本声明不许写 0.59.2）；复制基线请写 git tag 形式 v0.59.2')

/* ---------- ② 目录方案 ---------- */
scanLines('目录', DOCS, /src\/edit\/|src\/orchestrate\/|tests\/redline\/|(^|[^\w])test\/(edit|channel)\//,
  ['归档', '历史', '旧'], '实现 = src/redline/** + src/host/redline-channel.ts + src/client/** + src/shared/**；测试 = tests/edit/** + tests/channel/**')

/* ---------- ②′ src/host 只能放我们的接线文件（且带 redline- 前缀） ---------- */
{
  // D3.1（docs/11）：`src/host/` 下**我们自己的**接线文件必须带 `redline-` 前缀；
  // 但**上游复制过来的文件**原名保留、只在必须接线处改动（docs/11 D3.1 明确点了
  // `src/host/index.ts`、`settings.ts`），所以它们必须在豁免名单里 ——
  // 否则一提上游文件名就判红，等于逼人把出处从文档里删掉。
  // 名单 = 复制基线 tag v0.59.2 的 `src/host/*.ts`（实测 18 个），加上入口 index。
  const UPSTREAM_HOST_FILES = new Set([
    'index', 'activity', 'attribution', 'backfill', 'balance', 'compat', 'config', 'detail',
    'fallback', 'fold', 'headers', 'logShapes', 'pricing', 'settings', 'stepIdentity',
    'timeline', 'toolSources', 'version',
  ])
  const t = read('docs/10-execution-checklist.md')
  if (t) {
    t.split('\n').forEach((line, i) => {
      const m = line.match(/src\/host\/([a-z0-9-]+)\.ts/g)
      if (!m) return
      for (const hit of m) {
        const name = hit.replace('src/host/', '').replace('.ts', '')
        if (name.startsWith('redline-') || UPSTREAM_HOST_FILES.has(name)) continue
        problems.push(`[目录] docs/10-execution-checklist.md:${i + 1} src/host/${name}.ts 不合 D3.1`
          + `（我们自己的 src/host 接线文件必须带 redline- 前缀；上游文件原名保留，逻辑放 src/redline/**）`
          + `\n      ↳ ${line.trim().slice(0, 110)}`)
      }
    })
  }
}

/* ---------- ③ 按钮命名 / 禁用词 ---------- */
scanLines('命名', DOCS, /存为不变量/, ['旧名', '历史', '改名', '原名', '已废弃'],
  '统一叫「钉住这一段」；提到旧名必须显式标「旧名/历史」')
scanLines('禁用', DOCS, /withContinuableReturnGuidance/, ['历史', '禁止', '不要', '不得', '不许'],
  '不许把该内部函数写进实现路径（只在"禁止用它"的句子里提及是允许的）')
scanLines('已删文档', DOCS, /docs\/07/, ['历史', '已删除', '已按用户要求删除', '编号不复用'],
  'docs/07 已删除；只能以"已删除"的历史说明出现，不许当现行文档引用')
scanLines('断言载体', DOCS, /deriveMessages\(/, ['历史'], 'deriveMessages 是 live Session 同步读（AGENTS §2.2 禁新代码调用）；改用纯函数断言')

/* ---------- ④ docs/10 表格结构与计数 ---------- */
const cl = read('docs/10-execution-checklist.md')
if (cl == null) {
  problems.push('[docs/10] 读不到 docs/10-execution-checklist.md')
} else {
  const cells = (l) => l.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim())
  const IDRE = /^\|\s*([A-Z][A-Za-z0-9]*-\d+[a-z]?)\s*\|/
  const STATUS = ['DONE', 'DOING', 'TODO', WAIT]
  const statusOf = (c) => STATUS.find((s) => c.startsWith(s)) || null
  const body = cl.split('## 11.')[0]
  const per = new Map()
  let stage = null
  for (const [i, line] of body.split('\n').entries()) {
    const m = /^##\s+(\d+)\.\s*(.*)/.exec(line)
    if (m) { stage = m[2]; per.set(stage, []); continue }
    if (stage && IDRE.test(line)) {
      const c = cells(line)
      if (c.length !== 4) {
        problems.push(`[docs/10 表格] ${i + 1} 行有 ${c.length} 列（应为 4）：列被描述里的裸 | 顶歪了`)
        continue
      }
      const s = statusOf(c[2])
      if (!s) problems.push(`[docs/10 状态] ${i + 1} 行状态列不是四种标准值之一：${c[2].slice(0, 30)}`)
      per.get(stage).push(s || 'TODO')
    }
  }
  const tot = { DONE: 0, DOING: 0, TODO: 0, [WAIT]: 0 }
  let n = 0
  for (const [, list] of per) for (const s of list) { tot[s] += 1; n += 1 }
  // §11 合计行
  const sumLine = cl.split('\n').find((l) => l.includes('**合计**'))
  const sum = sumLine ? sumLine.split('|').slice(1, -1).map((c) => Number(c.replace(/[*\s]/g, ''))) : null
  if (!sum) {
    problems.push('[docs/10 §11] 找不到「合计」行')
  } else {
    const got = sum.slice(1, 6)
    const want = [n, tot.DONE, tot.DOING, tot.TODO, tot[WAIT]]
    if (got.join(',') !== want.join(',')) {
      problems.push(`[docs/10 §11] 合计与正文不一致：§11 = ${got.join('/')}（项数/DONE/DOING/TODO/WAIT），正文实算 = ${want.join('/')}`)
    } else {
      notes.push(`docs/10 计数自洽：${want.join(' / ')}`)
    }
  }
  var DOC_TOTAL = n
  var DOC_DONE = tot.DONE
}

/* ---------- ⑤ README 双语项数 ---------- */
if (DOC_TOTAL) {
  for (const [f, re] of [['README.md', /(\d+)\s*items/], ['README.zh.md', /共\s*(\d+)\s*项/]]) {
    const t = read(f)
    if (t == null) continue
    const m = re.exec(t)
    if (!m) problems.push(`[README] ${f} 里找不到项数声明`)
    else if (Number(m[1]) !== DOC_TOTAL) {
      problems.push(`[README] ${f} 写「${m[1]}」，docs/10 实为「${DOC_TOTAL}」`)
    }
  }
  // AGENTS §5 的进度行必须与 docs/10 §11 **一致** —— 2026-10-05 发现它陈旧到 184/269 却没人报错，
  // 根因是我改了文档却 `replace` 到不存在的串上（静默 no-op）。这条检查就是防它复发的。
  const agentsText = read('AGENTS.md')
  const am = agentsText == null ? null : /当前 \*\*DONE (\d+) \/ 共 (\d+)\*\*/.exec(agentsText)
  if (am === null) {
    problems.push('[AGENTS] §5 找不到「当前 **DONE x / 共 y**」进度行')
  } else if (Number(am[1]) !== DOC_DONE || Number(am[2]) !== DOC_TOTAL) {
    problems.push(`[AGENTS] §5 写「DONE ${am[1]} / 共 ${am[2]}」，与 docs/10 §11 的「DONE ${DOC_DONE} / 共 ${DOC_TOTAL}」不一致`)
  } else {
    notes.push(`AGENTS §5 与 docs/10 §11 一致：DONE ${DOC_DONE} / 共 ${DOC_TOTAL}`)
  }
  // README 双语必须成对
  const zh = read('README.zh.md'), en = read('README.md')
  if (zh && en) {
    const h = (t) => (t.match(/^\|\s*\[/gm) || []).length
    if (h(zh) !== h(en)) notes.push(`README 双语表格行数不同（zh ${h(zh)} / en ${h(en)}）—— 请人工确认是否成对`)
  }
}

/* ---------- ⑥ 同一文件内重复的标题 ---------- */
for (const f of DOCS) {
  const t = read(f)
  if (t == null) continue
  const seen = new Map()
  for (const [i, line] of t.split('\n').entries()) {
    const m = /^(#{2,4})\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const key = m[1] + ' ' + m[2]
    if (seen.has(key)) problems.push(`[重复标题] ${f}:${i + 1} 与 :${seen.get(key)} 标题完全相同 → ${m[2]}`)
    else seen.set(key, i + 1)
  }
}

/* ---------- ⑦ docs/05 必须定义 A17 ---------- */
const tp = read('docs/05-test-plan.md')
if (tp && !/\|\s*\*\*A17\*\*\s*\|/.test(tp)) {
  problems.push('[docs/05] A17 没有定义行（能力判定矩阵护栏无处落地）；须在 §2 三栏表补定义')
}

/* ---------- 汇报 ---------- */
if (notes.length) {
  console.log('ℹ️  提示：')
  for (const x of notes) console.log('   ·', x)
}
if (problems.length === 0) {
  console.log('✅ 文档一致性检查通过（版本 / 目录 / 命名 / 计数 / 表格 / 重复标题 / A17）')
  process.exit(0)
}
console.log(`❌ 文档一致性检查发现 ${problems.length} 个问题：\n`)
for (const p of problems) console.log('  ·', p)
console.log('\n（本脚本只读；改完文档后重跑直到退出码 0）')
process.exit(1)
