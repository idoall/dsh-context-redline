// 孤儿 i18n 键检查：`src/client/i18n.ts` 里**没有任何人引用**的键 = 删卡/删功能留下的死文案。
//
// 用法：`node scripts/i18n-orphans.mjs`（`--verbose` 打印全部孤儿键与它们的家族）
//
// 为什么要有这条门禁（`docs/10` **M6-17** 第三批的教训）：
// 每删一张卡/一个面板，它的文案键就没人引用了，但**不会报错、也不会被任何测试抓到** ——
// 只能靠人记得去删。三轮死代码收口里，i18n 是最后才被清的那一层（第一批 17 个、第二批 35 个、
// 第三批 93 个，一共 145 个孤儿键）。这条门禁把"记住去删"变成机械判定。
//
// 判据（**故意的宽松方向**：宁可漏报，不可误报 —— 误删会让界面显示原始键名）：
//   · 语料 = `src/` `tests/` `demo/` `scripts/` 的全部 ts/tsx/js/mjs（测试也算引用者：
//     有的键只被"这些字不该出现"的断言用着，那是有意义的用法）
//   · **动态拼接**按三种写法认前缀并**整族放过**：`'prefix.'`、`` `prefix.${…}` ``、`t('prefix.' + x)`
//     （`redline.err.*` 就是这么拼的 —— 第一版只认第一种，差点把 21 个错误码文案全判成孤儿）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose')
const I18N = join(ROOT, 'src/client/i18n.ts')

/** 语料里所有可能引用文案键的源文件（i18n.ts 自己不算引用者）。 */
function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|mjs|js)$/.test(p) && p !== I18N) out.push(p)
  }
  return out
}

const files = [join(ROOT, 'src'), join(ROOT, 'tests'), join(ROOT, 'demo'), join(ROOT, 'scripts')].flatMap((d) => walk(d))
const dict = readFileSync(I18N, 'utf8')
const keys = [...new Set([...dict.matchAll(/^ {2}'([^']+)':/gm)].map((m) => m[1]))]
const corpus = files.map((f) => readFileSync(f, 'utf8')).join('\n')

const dynamicPrefixes = new Set([
  ...[...corpus.matchAll(/'([A-Za-z][\w.-]*\.)'/g)].map((m) => m[1]),
  ...[...corpus.matchAll(/`([A-Za-z][\w.-]*\.)\$\{/g)].map((m) => m[1]),
  ...[...corpus.matchAll(/\('([A-Za-z][\w.-]*\.)'\s*\+/g)].map((m) => m[1]),
])

const orphans = keys.filter((k) => !corpus.includes(`'${k}'`)
  && !corpus.includes(`"${k}"`)
  && ![...dynamicPrefixes].some((p) => k.startsWith(p)))

console.log('孤儿 i18n 键检查（死文案）')
console.log(`  · 词典里 ${keys.length} 个键 · 语料 ${files.length} 个文件 · 动态前缀 ${dynamicPrefixes.size} 个（整族放过）`)
if (VERBOSE) {
  const fam = new Map()
  for (const k of orphans) {
    const f = k.split('.')[0]
    if (!fam.has(f)) fam.set(f, [])
    fam.get(f).push(k)
  }
  for (const [f, ks] of [...fam].sort((a, b) => b[1].length - a[1].length)) console.log(`    ${f}: ${ks.join(', ')}`)
}
if (orphans.length > 0) {
  console.log(`❌ 失败：${orphans.length} 个键没有任何引用（删卡/删功能留下的死文案）`)
  for (const k of orphans.slice(0, 30)) console.log('  ❌ ' + k)
  if (orphans.length > 30) console.log(`  … 还有 ${orphans.length - 30} 个（用 --verbose 看全部）`)
  process.exit(1)
}
console.log(`✅ 通过：${keys.length} 个键全部有引用（或落在动态前缀族里）`)
console.log('  · 语料范围：' + ['src', 'tests', 'demo', 'scripts'].map((d) => relative(ROOT, join(ROOT, d))).join(' / '))
