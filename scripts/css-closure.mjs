#!/usr/bin/env node
/**
 * CSS「闭包」门禁（用户 2026-10-05 的要求）：
 *
 *   「所有我们自己的 CSS 和样式可以做成闭包 …… 就是我们自己的样式自己用，
 *     改了不会影响别人；别人的删了，也不会影响到我们。」
 *
 * 这三句话落成三条**可机械检验**的性质：
 *
 *   ① **出不去**：`src/client/styles/*.css` 里每条规则的选择器都只命中我们自己的类
 *      （`redline-` 前缀）。不许裸元素选择器（`button{}`）、不许 `.dsh-*`、不许上游的 `.lc-*`、
 *      不许通用类名 —— 否则我们的样式会漏到别人的 DOM 上。
 *   ② **进不来**：`redline-` 前缀只在我们自己的样式文件里**定义**（规则体里出现 `{`）。
 *      别处（TSX 的内联 `<style>`、别的目录）不许定义 —— 样式只有一个来源，别人删自己的不会牵连我们。
 *   ③ **自足**：组件里用到的 `redline-` 类**必须**在某份样式里有定义（否则那一块是裸样式）。
 *      （反向的"定义了没人用"只报告、不判失败：允许动态拼类名。）
 *
 * 只读、退出码 0/1。用法：node scripts/css-closure.mjs [--verbose]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STYLES = join(ROOT, 'src/client/styles')
const VERBOSE = process.argv.includes('--verbose')

const problems = []
const notes = []

/**
 * **标记类**（有意不写样式）白名单 —— 只有写明理由才准进这里。
 * 布局/外观由 Tailwind 工具类或宿主令牌承担，类名本身只作语义标记（测试/调试也会选它）。
 */
const MARKER_CLASSES = new Map([
  ['redline-col-stats', '列身份标记：外观与列宽由同行的 Tailwind 工具类（flex-[3] 等）承担'],
  ['redline-cols-main', '主列容器标记（`.redline-cols` 已有规则）；有测试按它选元素'],
  ['redline-agent-track', 'SVG 轨道标记：fill/stroke 由同行的 Tailwind 工具类承担'],
  ['redline-down', '与基础色相同（基础色=成功色，只有 `.redline-up` 需要改成告警色）；保留语义标记'],
])

/** 去掉注释与字符串，避免把注释里的选择器当规则。 */
function stripCss(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 收集一份 CSS 里的**规则选择器**。要处理三件事（第一版没做，结果全是假报）：
 *   · `@media` / `@container` / `@supports` 里的**嵌套**规则要照收；
 *   · `@keyframes` 里的 `0%` / `from` **不是**选择器，跳过；
 *   · `:is(a, b)` / `:where(a, b)` 里的逗号**不能**当选择器分隔符（只按括号深度 0 的逗号拆）。
 */
function selectorsOf(css) {
  const body = stripCss(css)
  const out = []
  let i = 0
  let depth = 0
  const atStack = []
  let prelude = ''
  while (i < body.length) {
    const ch = body[i]
    if (ch === '{') {
      const head = prelude.trim()
      const inKeyframes = atStack[atStack.length - 1] === '@keyframes'
      if (head.startsWith('@')) {
        const name = head.split(/[\s(]/, 1)[0]
        atStack.push(name === '@keyframes' ? '@keyframes' : name)
      } else if (!inKeyframes && !head.startsWith('@')) {
        for (const sel of splitTopLevel(head)) out.push(sel.trim())
      }
      depth += 1
      prelude = ''
    } else if (ch === '}') {
      depth -= 1
      if (atStack.length > depth) atStack.length = depth
      prelude = ''
    } else if (ch === ';') {
      prelude = ''                       // 声明（含 `@theme` 里的令牌与 `@import`）不是选择器
    } else {
      prelude += ch
    }
    i += 1
  }
  return out
}

/** 按**括号深度 0** 的逗号拆（`:is(a, b)` 保持完整）。 */
function splitTopLevel(text) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur.trim() !== '') out.push(cur)
  return out
}

/** 选择器里出现的类名。 */
const classesIn = (sel) => [...sel.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1])

const cssFiles = readdirSync(STYLES).filter((f) => f.endsWith('.css')).sort()
const definedClasses = new Map() // class -> file
// ── ① 出不去 + 收集我们定义的类 ────────────────────────────────────────────────
for (const file of cssFiles) {
  const path = join(STYLES, file)
  const css = readFileSync(path, 'utf8')
  for (const sel of selectorsOf(css)) {
    const classes = classesIn(sel)
    if (classes.length === 0) {
      // 没有类名的选择器：只允许 `:root`（宿主令牌）与纯伪类/属性选择器？
      if (sel === ':root' || sel.startsWith(':root ') || sel.startsWith('@')) continue
      problems.push(`[①出不去] ${file}: 选择器没有我们自己的类名 → \`${sel}\``)
      continue
    }
    for (const c of classes) {
      if (!c.startsWith('redline-')) {
        problems.push(`[①出不去] ${file}: 命中别人的类/通用类 \`.${c}\` → \`${sel}\``)
      } else if (!definedClasses.has(c)) {
        definedClasses.set(c, file)
      }
    }
  }
}
notes.push(`我们定义的样式类：${definedClasses.size} 个（分布在 ${cssFiles.length} 份样式里）`)

// ── ② 进不来：别处不许定义 redline- 规则 ──────────────────────────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'lib' || name === 'demo') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(tsx?|jsx?|css)$/.test(name)) out.push(p)
  }
  return out
}
for (const path of walk(join(ROOT, 'src'))) {
  if (path.startsWith(STYLES)) continue
  const text = stripCss(readFileSync(path, 'utf8'))
  const hit = /\.redline-[a-z0-9-]+\s*(?:,|\{)/i.exec(text)
  if (hit !== null) problems.push(`[②进不来] ${relative(ROOT, path)}: 在样式目录之外定义了规则 \`${hit[0].slice(0, 40)}\``)
}

// ── ③ 自足：组件 `className` 里用到的 redline- 类必须在样式里有定义 ─────────────
// ⚠️ 第一版直接 grep 整个 TSX，把**模块路径**（`redline-channel`）、**动画名**
// （`animate-redline-bar-in`）都当成了类名 → 34 条误报。所以这里只从 className 上下文取：
// 字符串里按空白拆 token，接受 `redline-*` 与 `animate-redline-*`（后者是 Tailwind 由
// `--animate-redline-*` 令牌生成的工具类，改为核对令牌是否存在）。
const animateTokens = new Set()
for (const file of cssFiles) {
  for (const m of readFileSync(join(STYLES, file), 'utf8').matchAll(/--animate-(redline-[\w-]+)\s*:/g)) animateTokens.add(m[1])
}
const usedClasses = new Set()
const dynamicOk = new Set()
for (const path of walk(join(ROOT, 'src'))) {
  if (path.startsWith(STYLES) || !/\.tsx$/.test(path)) continue
  const text = readFileSync(path, 'utf8')
  for (const m of text.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)) {
    const raw = m[1] ?? m[2] ?? ''
    for (const tok of raw.split(/[\s'"`+]+/)) {
      if (!/^[a-z]/.test(tok)) continue
      if (tok.startsWith('animate-redline-')) {
        const name = tok.slice('animate-'.length)
        if (!animateTokens.has(name)) problems.push(`[③自足] 组件用了 Tailwind 动画工具类 \`.${tok}\`，但样式里没有 \`--animate-${name}\` 令牌`)
        continue
      }
      if (!tok.startsWith('redline-')) continue
      if (tok.endsWith('-')) { dynamicOk.add(tok); continue }   // 动态拼：`redline-br-delta-${...}`
      usedClasses.add(tok)
    }
  }
}
for (const c of [...usedClasses].sort()) {
  if (definedClasses.has(c)) continue
  if (MARKER_CLASSES.has(c)) continue
  // 模板字符串会拼类名（`` `redline-agents-link-${live}` ``），拆出来是一段**定义过的类的前缀**：
  // 认成"动态构造"而不是"裸样式"（否则全是误报）；只有前缀也对不上才是真裸样式。
  const dynamic = [...definedClasses.keys()].some((d) => d.startsWith(c + '-') || d.startsWith(c))
  if (dynamic) { dynamicOk.add(c); continue }
  problems.push(`[③自足] 组件 className 用了 \`.${c}\`，但没有任何样式定义它（裸样式）`)
}
if (VERBOSE) {
  const unused = [...definedClasses.keys()].filter((c) => !usedClasses.has(c)).sort()
  notes.push(`动态拼出来的前缀（只报告）：${[...dynamicOk].join(', ') || '无'}`)
  notes.push(`定义了但组件里没直接出现的类（动态拼类名常见，仅报告）：${unused.length} 个${unused.length > 0 ? ' → ' + unused.slice(0, 8).join(', ') : ''}`)
}

console.log('CSS 闭包检查（出不去 / 进不来 / 自足）')
for (const n of notes) console.log('  · ' + n)
console.log(`  · 标记类白名单（有意不写样式）：${MARKER_CLASSES.size} 个 —— ${[...MARKER_CLASSES.keys()].join(', ')}`)
if (problems.length === 0) {
  console.log(`✅ 通过：${cssFiles.length} 份样式、${definedClasses.size} 个类、组件用到 ${usedClasses.size} 个 redline- 类，全部自足且不外泄`)
  process.exit(0)
}
for (const p of problems.slice(0, 40)) console.log('  ❌ ' + p)
if (problems.length > 40) console.log(`  … 还有 ${problems.length - 40} 条`)
console.log(`❌ 失败：${problems.length} 条`)
process.exit(1)
