#!/usr/bin/env node
/**
 * 命名空间契约检查（`node scripts/namespace-contract.mjs`）—— M1 的机器门禁
 * （`docs/04` M1 DoD 第 1 条 / `docs/10` M1-11）。
 *
 * 存在理由：本插件与参考插件 `dsh-context@0.60.0` **必须并存**，而上游源码用的是
 * 全局名字。三类撞车会**抛错**（HTTP 路由 / 投影 key / 客户端 bundle id），
 * 其余几类**静默**（slot 被顶掉、偏好被共用、localStorage 互相覆盖、CSS 类名互相
 * 覆盖到对方面板上）。静默那类靠人眼 grep 必然漏，所以这里逐面断言。
 *
 * 判据一律是**字符串相等**。查"上游旧值零命中"必须带排除，否则正则会把我们自己
 * 的名字判红（`docs/01` F4）：
 *   ✅ /dsh-context(?!-redline)/   ❌ /dsh-context/
 *
 * ⚠️ 扫代码前**先剥注释**：注释里**应该**提到上游旧名（那是出处与理由），
 * 把它当违规会让下一个人删掉解释而留下真问题。剥注释器认字符串字面量，
 * 所以 `'https://…'` 里的 `//` 不会被误当注释。
 *
 * 本脚本只读；退出码 0 = 干净，1 = 有漂移。反向验证：改坏任一面必须变红
 * （`docs/10` M1-12）。
 */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_NAME = 'dsh-context-redline'
const API_PREFIX = '/api/dsh-context-redline'
const DATA_DIR = 'dsh-context-redline'
const DSH_ENGINES = '>=0.2.0-rc.2 <0.3.0'
const BASELINE = '0.2.0-rc.2'

/** 上游的旧值（`docs/01` F1–F4 + `UPSTREAM.md` §3.1）。 */
const UPSTREAM_PREFIX = /\/api\/dsh-context\/(?!redline)/
const UPSTREAM_NS = /dsh-context(?!-redline)/
const UPSTREAM_PROJECTION_KEYS = ['contextTimeline', 'contextHeaders', 'contextActivity']
const UPSTREAM_SLOT_IDS = ['context', 'context-jump', 'context-modal', 'context-overview']

const results = []
const notes = []
const rel = p => relative(ROOT, p)

function check(face, name, fn) {
  try {
    const detail = fn()
    results.push({ face, name, ok: true, detail: detail ?? '' })
  } catch (error) {
    results.push({ face, name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function read(relPath) {
  const abs = join(ROOT, relPath)
  assert(existsSync(abs), `缺少文件：${relPath}`)
  return readFileSync(abs, 'utf8')
}

/**
 * Remove `//` and block comments while respecting string literals, so a scan of
 * "code only" never trips on the provenance comments that explain the rename.
 */
function stripCodeComments(source) {
  let out = ''
  let i = 0
  let quote = null
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 2; continue }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** A source file's CODE with comments removed (never the stored file). */
function codeOf(relPath) {
  return stripCodeComments(read(relPath))
}

/** Recursively list files under a directory (relative to ROOT). */
function walk(relDir, filter = /\.(ts|tsx)$/) {
  const abs = join(ROOT, relDir)
  if (!existsSync(abs)) return []
  const out = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs2 = join(dir, entry.name)
      if (entry.isDirectory()) visit(abs2)
      else if (filter.test(entry.name)) out.push(rel(abs2))
    }
  }
  visit(abs)
  return out.sort()
}

/** Every import / dynamic-import specifier in `source`. */
function importSpecifiers(source) {
  const out = []
  const staticRe = /(?:^|\n)\s*import\s[\s\S]*?from\s*['"]([^'"]+)['"]/g
  const bareRe = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const re of [staticRe, bareRe, dynamicRe]) {
    let m
    while ((m = re.exec(source)) !== null) out.push(m[1])
  }
  return out
}

/** Collect capture group 1 of every match. */
function matches(source, re) {
  const out = []
  let m
  while ((m = re.exec(source)) !== null) out.push(m[1])
  return out
}

/** Line-level hits over a file list; `code` strips comments first. */
function findHits(files, pattern, { code = false } = {}) {
  const hits = []
  for (const file of files) {
    const text = code ? codeOf(file) : read(file)
    text.split('\n').forEach((line, i) => {
      pattern.lastIndex = 0
      if (pattern.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  return hits
}

const pkg = JSON.parse(read('package.json'))
const hostFiles = walk('src/host')
const clientFiles = walk('src/client')
const sharedFiles = walk('src/shared')
const redlineFiles = walk('src/redline')
// The stylesheets carry the same class tokens as the TSX, and they are injected
// into the SAME document as upstream's — leaving them out of the scans made the
// `lc-` face a no-op on the one file kind that defines the collision
// (reverse verification caught this: mutating `.redline-root` to `.lc-root` in
// base.css kept the check green).
const styleFiles = walk('src/client/styles', /\.css$/)
const testFiles = walk('tests', /\.(ts|tsx)$/)
const sourceFiles = [...hostFiles, ...clientFiles, ...sharedFiles, ...redlineFiles, ...styleFiles]
const localeFiles = walk('locale', /\.json$/)

// ── Face 1: package name = client bundle registration id = loader row ───────
check('1 身份', 'package.name 是 dsh-context-redline', () => {
  assert(pkg.name === PKG_NAME, `package.json name = ${pkg.name}`)
  return pkg.name
})

check('1 身份', 'cordis.patch.yml 的 id/name 等于包名', () => {
  // Comment lines are dropped: the file explains the rule above the row.
  const yml = read('cordis.patch.yml').split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  const ids = matches(yml, /^[\s-]*id:\s*(\S+)/gm)
  const names = matches(yml, /^[\s-]*name:\s*(\S+)/gm)
  assert(ids.length === 1 && ids[0] === PKG_NAME, `id = ${JSON.stringify(ids)}`)
  assert(names.length === 1 && names[0] === PKG_NAME, `name = ${JSON.stringify(names)}`)
  return `${ids[0]} / ${names[0]}`
})

check('1 身份', 'tsdown 的客户端 banner 用 pkg.name（不写死）', () => {
  const cfg = read('tsdown.config.ts')
  assert(cfg.includes('name: pkg.name'), 'tsdown 配置里缺 `name: pkg.name`')
  assert(
    cfg.includes('load({ id: ${JSON.stringify(pkg.name)}, factory:'),
    '客户端 banner 不是由 pkg.name 生成的',
  )
  return 'banner id := pkg.name'
})

check('1 身份', '构建产物 lib/client.js 的注册 id 等于包名（有产物时）', () => {
  const built = join(ROOT, 'lib/client.js')
  if (!existsSync(built)) return '（没有 lib/client.js，跳过；先跑 pnpm run build）'
  const head = readFileSync(built, 'utf8').slice(0, 400)
  // The banner is pretty-printed across lines, hence the whitespace tolerance;
  // and the pattern is built with `new RegExp` because a regex LITERAL would
  // compare against the text `${PKG_NAME}` rather than the package name.
  assert(
    new RegExp(`load\\(\\{\\s*id:\\s*"${PKG_NAME}"`).test(head),
    `lib/client.js 的 banner 不是 ${PKG_NAME}：${head.slice(0, 120)}`,
  )
  return 'load({ id: "dsh-context-redline" })'
})

// ── Face 2: HTTP routes ────────────────────────────────────────────────────
check('2 路由', `src/host/** 里的 /api 字面量全部挂在 ${API_PREFIX} 下`, () => {
  const hits = findHits(hostFiles, /['"`]\/api\//, { code: true })
  const bad = hits.filter(line => !line.includes(`${API_PREFIX}/`))
  assert(bad.length === 0, `有路由不在我们的前缀下：\n      ${bad.join('\n      ')}`)
  return `${hits.length} 处 /api 字面量`
})

check('2 路由', 'src/client/** 里一个 /api 字面量都没有（必须走 shared 常量）', () => {
  // `docs/05` A12: the browser must POST the SAME constant the host registers, and
  // the only way to guarantee that is for the client to import it. A literal that
  // happens to be correct TODAY drifts the moment the constant moves — and the
  // failure mode is a silent 404, not an error. So the rule is zero literals.
  const hits = findHits(clientFiles, /['"`]\/api\//, { code: true })
  assert(
    hits.length === 0,
    `客户端里出现了手写路由（应 import REDLINE_*_ROUTE）：\n      ${hits.join('\n      ')}`,
  )
  return '0 处（客户端只 import shared 常量）'
})

check('2 路由', `src/shared/redline-route.ts 定义四条 ${API_PREFIX}/* 路由`, () => {
  const code = codeOf('src/shared/redline-route.ts')
  const routes = matches(code, /REDLINE_\w+_ROUTE = `\$\{REDLINE_API_PREFIX\}\/([a-z]+)`/g)
  assert(routes.length === 4, `期望 4 条路由，实际 ${routes.length}：${routes.join(', ')}`)
  assert(new Set(routes).size === 4, `路由名重复：${routes.join(', ')}`)
  // The prefix must KEEP the `/api` fence: `docs/01` F1 records that upstream's
  // own type comment claims otherwise, and dropping it yields a 404 rather than
  // the loud duplicate-registration error.
  assert(
    new RegExp(`REDLINE_API_PREFIX = '${API_PREFIX}'`).test(code),
    `REDLINE_API_PREFIX 不是 ${API_PREFIX}`,
  )
  return routes.map(r => `${API_PREFIX}/${r}`).join(' · ')
})

check('2 路由', '代码里没有任何上游路由路径残留', () => {
  const hits = findHits(sourceFiles, UPSTREAM_PREFIX, { code: true })
  assert(hits.length === 0, `仍有上游路由：\n      ${hits.join('\n      ')}`)
  return '0 命中（注释里的出处说明不计）'
})

// ── Face 3: projection keys ────────────────────────────────────────────────
check('3 投影', 'src/host/** 的每个投影 key 都是 redline*', () => {
  const hits = findHits(hostFiles, /^\s*key:\s*'[^']+'/, { code: true })
  assert(hits.length > 0, '一个投影 key 都没找到（解析方式可能过期）')
  const values = hits.map(line => /key:\s*'([^']+)'/.exec(line)[1])
  const bad = values.filter(v => !v.startsWith('redline'))
  assert(bad.length === 0, `不是 redline* 的 key：${bad.join(', ')}`)
  return values.join(' · ')
})

check('3 投影', '三个投影 key 恰好是 redlineTimeline/Headers/Activity', () => {
  const joined = hostFiles.map(f => codeOf(f)).join('\n')
  for (const key of ['redlineTimeline', 'redlineHeaders', 'redlineActivity']) {
    assert(joined.includes(`'${key}'`), `缺投影 key：${key}`)
  }
  for (const old of UPSTREAM_PROJECTION_KEYS) {
    assert(!joined.includes(old), `仍有上游投影 key：${old}`)
  }
  return 'redlineTimeline · redlineHeaders · redlineActivity'
})

// ── Face 4: client slot ids ────────────────────────────────────────────────
check('4 插槽', 'src/client/index.ts 注册的 slot id 全部是 redline*', () => {
  const ids = matches(codeOf('src/client/index.ts'), /\bid:\s*'([^']+)'/g)
  assert(ids.length > 0, '没有解析到 slot id')
  const bad = ids.filter(id => UPSTREAM_SLOT_IDS.includes(id))
  assert(bad.length === 0, `仍是上游 slot id：${bad.join(', ')}`)
  const notOurs = ids.filter(id => !id.startsWith('redline'))
  assert(notOurs.length === 0, `slot id 不是 redline*：${notOurs.join(', ')}`)
  assert(ids.includes('redline'), "conversation.view 的 id 必须是 'redline'")
  return [...new Set(ids)].join(' · ')
})

check('4 插槽', 'sidebar 的 tab 身份/kind 是我们的命名空间', () => {
  const text = codeOf('src/client/sidebar.ts')
  assert(
    text.includes(`export const SIDEBAR_CONTEXT_ID = '${PKG_NAME}'`),
    'SIDEBAR_CONTEXT_ID 不是我们的命名空间',
  )
  assert(
    text.includes(`export const SIDEBAR_CONTEXT_KIND = '${PKG_NAME}'`),
    'SIDEBAR_CONTEXT_KIND 不是我们的命名空间',
  )
  return PKG_NAME
})

check('4 插槽', '客户端斜杠命令不占用上游的 /context', () => {
  const text = codeOf('src/client/command.ts')
  assert(text.includes("const COMMAND = 'redline'"), "COMMAND 不是 'redline'")
  assert(!/const COMMAND = 'context'/.test(text), "COMMAND 仍是 'context'")
  return '/redline'
})

// ── Face 5: locale namespace ───────────────────────────────────────────────
check('5 文案', 'locale 命名空间 = 包名，且注册/绑定都用它', () => {
  const text = codeOf('src/client/index.ts')
  assert(text.includes(`const NS = '${PKG_NAME}'`), 'NS 不是包名')
  assert(/locale\.register\(NS,/.test(text), 'locale.register 没用 NS')
  assert(/locale\.bind\(NS\)/.test(text), 'locale.bind 没用 NS')
  return PKG_NAME
})

check('5 文案', '入口标签不与上游同名（用户 2026-10-04：对话轨迹/上下文那里要叫「上下文批改」）', () => {
  // The conversation-view tab, the right Sidebar's chip and the panel's own title
  // all read ONE label (`i18n` key `tab`). If any of them is the bare upstream word
  // the two plugins look like the same thing in the UI — which is exactly what the
  // user asked us to stop doing. The upstream words are banned OUTRIGHT; the label
  // must carry our product name.
  const text = read('src/client/i18n.ts')
  // Every label the USER sees as "this plugin's entry" —— the conversation tab, the
  // sidebar entry button, the overview panel title and the setting that toggles it.
  const entryKeys = ['tab', 'ov.entry', 'ov.title', 'settings.insightsEntry']
  const missing = entryKeys.filter((k) => !new RegExp(`'${k.replace('.', '\\.')}':`).test(text))
  assert(missing.length === 0, `入口标签的键丢了：${missing.join(', ')}`)
  const labels = []
  for (const k of entryKeys) {
    for (const v of matches(text, new RegExp(`'${k.replace('.', '\\.')}':\\s*'([^']+)'`, 'g'))) labels.push(v)
  }
  assert(labels.length >= 2, `expected a zh + en label, found ${labels.length}`)
  const banned = ['上下文', 'Context']
  for (const label of labels) {
    assert(!banned.includes(label), `入口标签 "${label}" 与上游同名 —— 必须写成「上下文批改」/「Context Redline」`)
    assert(/批改|Redline/.test(label), `入口标签 "${label}" 没带我们的产品名`)
  }
  return labels.join(' / ')
})

check('5 文案', 'locale/*.json 的展示名带我们的包名', () => {
  assert(localeFiles.length > 0, 'locale/ 下没有 json')
  for (const file of localeFiles) {
    const text = read(file)
    assert(!UPSTREAM_NS.test(text), `${file} 仍写着上游包名`)
    assert(text.includes(PKG_NAME), `${file} 没写我们的包名`)
  }
  return `${localeFiles.length} 个字典`
})

// ── Face 6: MessageSourceMap kind ──────────────────────────────────────────
check('6 消息来源', 'MessageSourceMap 的 kind 要么没有、要么是我们的', () => {
  const hits = []
  for (const file of sourceFiles) {
    const text = codeOf(file)
    if (!text.includes('MessageSourceMap')) continue
    for (const kind of matches(text, /MessageSourceMap[\s\S]{0,200}?\bkind\??:\s*'([^']+)'/g)) {
      hits.push(`${file}: ${kind}`)
    }
  }
  // Upstream declares no kind at all (`docs/01` F4), so zero hits is a legal
  // result; once anyone declares one it must be our namespace.
  const bad = hits.filter(h => !h.endsWith(`: ${PKG_NAME}`))
  assert(bad.length === 0, `声明了别人的消息来源 kind：\n      ${bad.join('\n      ')}`)
  if (hits.length === 0) {
    notes.push('面 6：src/** 里没有任何 MessageSourceMap kind（与上游一致：上游也不注册）')
    return '0 声明'
  }
  return hits.join(' · ')
})

// ── Face 7: data directory ─────────────────────────────────────────────────
check('7 数据目录', `数据目录常量 = ${DATA_DIR}`, () => {
  const text = read('src/shared/redline-paths.ts')
  assert(
    text.includes(`export const REDLINE_DATA_DIR_NAME = '${DATA_DIR}'`),
    'REDLINE_DATA_DIR_NAME 不是我们的目录名',
  )
  // Two kinds of file may touch the harness home: upstream's version probe
  // (which reads manifests), and OUR code — but ours must reach our directory
  // through the single constant, never with its own literal.
  const upstreamProbe = new Set(['src/host/version.ts'])
  const joins = sourceFiles.filter(f => /dshHomePath|DSH_HOME/.test(codeOf(f)))
  const strangers = joins.filter(f => !upstreamProbe.has(f) && !codeOf(f).includes('REDLINE_DATA_DIR_NAME'))
  assert(
    strangers.length === 0,
    `这些文件在拼 harness home，但既不是上游的版本探针、也没走 REDLINE_DATA_DIR_NAME：${strangers.join(', ')}`,
  )
  return `${DATA_DIR}（常量来源：src/shared/redline-paths.ts；拼接点：${joins.join(', ')}）`
})

// ── Face 8: upstream old values, zero hits in CODE ─────────────────────────
check('8 旧值', 'src/ locale/ 与 cordis.patch.yml 的代码里没有上游包名（带排除）', () => {
  const hits = findHits([...sourceFiles, ...localeFiles, 'cordis.patch.yml'], UPSTREAM_NS, { code: true })
  assert(hits.length === 0, `仍有上游包名：\n      ${hits.join('\n      ')}`)
  return '0 命中 /dsh-context(?!-redline)/'
})

check('8 旧值', '没有上游投影 key / slot id / localStorage key / SETTINGS_NAMESPACE', () => {
  const text = sourceFiles.map(f => codeOf(f)).join('\n')
  const bad = []
  for (const key of UPSTREAM_PROJECTION_KEYS) if (text.includes(key)) bad.push(`projection ${key}`)
  for (const id of UPSTREAM_SLOT_IDS) if (new RegExp(`id:\\s*'${id}'`).test(text)) bad.push(`slot ${id}`)
  if (text.includes("'dsh-context:platform-balance'")) bad.push('localStorage dsh-context:platform-balance')
  if (text.includes("SETTINGS_NAMESPACE = 'dsh-context'")) bad.push('SETTINGS_NAMESPACE')
  assert(bad.length === 0, `上游旧值残留：${bad.join(' · ')}`)
  return '0 命中'
})

check('8 旧值', 'CSS 类名不再共用上游的 lc- 前缀（.tsx 与 .css 都查）', () => {
  const hits = findHits([...sourceFiles, ...testFiles], /\blc-[a-z]/, { code: true })
  assert(
    hits.length === 0,
    `仍是上游的 lc-* 类名（两个插件的样式表都注入同一个 document，同特异性下后注者会顶掉先注者）：\n      ${hits.join('\n      ')}`,
  )
  return `0 命中（已统一成 redline-*；扫描 ${sourceFiles.length} 个源文件 + ${testFiles.length} 个测试）`
})

// ── Face 9: lane purity (docs/05 §1) ───────────────────────────────────────
check('9 纯度', 'src/redline/** 与 src/shared/redline-*.ts 不碰 node:/DOM/React', () => {
  const pure = [...redlineFiles, ...sharedFiles.filter(f => /redline-/.test(f))]
  assert(pure.length > 0, '没有找到需要检查的纯逻辑文件')
  const violations = []
  for (const file of pure) {
    const text = read(file)
    for (const spec of importSpecifiers(stripCodeComments(text))) {
      if (spec.startsWith('node:')) violations.push(`${file}: import '${spec}'`)
      if (/^react(-dom)?(\/|$)/.test(spec)) violations.push(`${file}: import '${spec}'`)
      if (spec.startsWith('../host') || spec.startsWith('../client')) violations.push(`${file}: import '${spec}'`)
    }
    if (/\b(document|window)\./.test(stripCodeComments(text))) violations.push(`${file}: 直接读了 DOM 全局`)
  }
  assert(violations.length === 0, `纯逻辑 lane 被污染：\n      ${violations.join('\n      ')}`)
  return `${pure.length} 个文件`
})

check('9 纯度', 'src/client/** 不 import src/host/** 与 src/redline/**（含动态 import）', () => {
  const violations = []
  for (const file of clientFiles) {
    const text = stripCodeComments(read(file))
    for (const spec of importSpecifiers(text)) {
      if (spec.startsWith('node:')) violations.push(`${file}: import '${spec}'`)
      if (!spec.startsWith('.')) continue
      const target = relative(ROOT, resolve(ROOT, dirname(file), spec))
      if (/^src\/(host|redline)(\/|$)/.test(target)) violations.push(`${file}: import '${spec}' → ${target}`)
    }
  }
  assert(violations.length === 0, `客户端 bundle 被污染：\n      ${violations.join('\n      ')}`)
  return `${clientFiles.length} 个文件`
})

// ── Face 10: dependency-install safety (docs/01 F14) ───────────────────────
check('10 依赖', 'node_modules/@deepseek-ai 不是符号链接（防 pnpm install 写穿）', () => {
  const link = join(ROOT, 'node_modules/@deepseek-ai')
  if (!existsSync(link)) return '（尚未安装依赖，跳过）'
  const st = lstatSync(link)
  assert(
    !st.isSymbolicLink(),
    'node_modules/@deepseek-ai 是符号链接；pnpm install 会写穿它（docs/01 F14）。'
    + `真实指向：${st.isSymbolicLink() ? 'symlink' : '?'} / ${statSync(link).isDirectory() ? '目录' : '?'}`,
  )
  return '真实目录，无写穿风险'
})

// ── Face 11: declared runtime versions ─────────────────────────────────────
check('11 版本', `engines.dsh = ${DSH_ENGINES}`, () => {
  const declared = pkg.engines?.dsh
  assert(declared === DSH_ENGINES, `package.json engines.dsh = ${declared}`)
  assert(
    pkg.dsh?.compatibility === undefined,
    'dsh.compatibility 是上游 0.1.x 时代的声明，已由 engines.dsh 取代（docs/11 D1）',
  )
  return declared
})

check('11 版本', `版本闸的基线 = ${BASELINE}`, () => {
  const found = /BASELINE_DSH_VERSION = '([^']+)'/.exec(codeOf('src/shared/version.ts'))
  assert(found !== null, '没找到 BASELINE_DSH_VERSION')
  assert(found[1] === BASELINE, `BASELINE_DSH_VERSION = ${found[1]}`)
  return found[1]
})

// ── Report ─────────────────────────────────────────────────────────────────
let failed = 0
let lastFace = null
for (const r of results) {
  if (r.face !== lastFace) {
    process.stdout.write(`\n【面 ${r.face}】\n`)
    lastFace = r.face
  }
  if (!r.ok) failed += 1
  process.stdout.write(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail === '' ? '' : `  → ${r.detail}`}\n`)
}

if (notes.length > 0) {
  process.stdout.write('\nℹ️  说明：\n')
  for (const n of notes) process.stdout.write(`   · ${n}\n`)
}

process.stdout.write(`\n共 ${results.length} 项，失败 ${failed} 项\n`)
if (failed > 0) {
  process.stdout.write('❌ 命名空间契约检查未通过\n')
  process.exit(1)
}
process.stdout.write('✅ 命名空间契约检查通过（身份 / 路由 / 投影 / 插槽 / 文案 / 消息来源 / 数据目录 / 旧值 / 纯度 / 依赖 / 版本）\n')
