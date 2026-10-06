#!/usr/bin/env node
/**
 * 发布就绪检查（**临时探针必须先删掉**）—— `docs/10` M6 的门禁半边。
 *
 * 存在理由（Code Review P1-5）：M4.5 期间加过两个**临时只读探针**，两条独立审阅线都
 * 指出"发布前必须删"却**没有任何机械门禁**：
 *   ① 宿主侧只读 op `probe.services`（`src/host/redline-channel.ts` 的 op 表）；
 *   ② 客户端 `?redline-probe=1`（`src/client/components/contextView.tsx` 里写 DOM 的那段）。
 * 它们不是未授权面（在认证边界之后），但它们是**临时诊断能力**：带进发布包就等于把
 * "内部服务面 + 诊断输出"当成产品能力长期保留。
 *
 * 语义很重要：**本脚本在探针还在时就是红的 —— 这是对的**，它在说"现在还不能发布"。
 * 删掉两个探针后它自动转绿，不需要改这个文件。
 *
 * 只读；退出码 0/1。用法：node scripts/check-release-ready.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '')
const problems = []

/** ① 宿主侧临时 op */
const channel = read('src/host/redline-channel.ts')
const opDef = /\[\s*'probe\.services'\s*,/.test(channel)
const opImpl = /const probeServices\b/.test(channel)
if (opDef || opImpl) {
  problems.push('src/host/redline-channel.ts 仍注册着临时只读探针 op `probe.services`'
    + `（op 表命中=${String(opDef)} · 实现命中=${String(opImpl)}）—— 发布前必须整段删除`)
}

/** ② 客户端一次性探针 */
const view = read('src/client/components/contextView.tsx')
if (/redline-probe=1/.test(view) || /redline-probe-out/.test(view)) problems.push('src/client/components/contextView.tsx 仍有 `?redline-probe=1` 的临时探针（写 DOM 那段）—— 发布前必须删除')

/** ③ 发布包的最小前提（顺手把 Code Review P2 的几条一起机械检查） */
const pkgText = read('package.json')
let pkg = null
try { pkg = JSON.parse(pkgText) } catch { problems.push('package.json 不是合法 JSON') }
if (pkg !== null) {
  if (typeof pkg.repository !== 'object' || pkg.repository === null || typeof pkg.repository.url !== 'string' || pkg.repository.url === '') {
    problems.push('package.json 缺 `repository.url`：客户端 meta 会编出空仓库链接，插件信息卡显示空白')
  }
  if (pkg.scripts?.prepack === undefined && pkg.scripts?.prepare === undefined && pkg.scripts?.prepublishOnly === undefined) {
    problems.push('package.json 没有 prepack/prepare/prepublishOnly：lib/ 被 gitignore，干净 clone 直接发布＝空壳')
  }
  for (const f of ['README.zh.md', 'CHANGELOG.md', 'NOTICE', 'UPSTREAM.md']) {
    if (!Array.isArray(pkg.files) || !pkg.files.includes(f)) problems.push(`npm 包缺 ${f}（README 里有指向它的链接/说明）`)
  }
}

if (problems.length === 0) {
  console.log('✅ 发布就绪检查通过（临时探针已清零、发布前提齐备）')
  process.exit(0)
}
console.log(`❌ 发布就绪检查发现 ${problems.length} 个问题（**现在还不能发布**）：\n`)
for (const p of problems) console.log('  · ' + p)
console.log('\n（本脚本只读；删掉探针/补齐前提后自动转绿）')
process.exit(1)
