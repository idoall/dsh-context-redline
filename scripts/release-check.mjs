#!/usr/bin/env node
/**
 * 发布前自检——一条命令跑完全部门禁，并逐项打印判定行原文。
 *
 * 每一步同时检查退出码和判定行，避免错误输出被截断或误报为成功。
 * （`tail -1` 拿到 `Finished in …`，于是"23 个 error"被写成"0 error"）。所以每一步都必须
 * 声明它**期望看到的那一行**，不看那一行就不算通过。
 *
 * 三条纪律：
 *   · **只读**：绝不写任何文件（用例静态断言本文件里没有写 API）。
 *   · **两条都要**：退出码 + 判定行。只看退出码会漏掉"退 0 但有 error"的写法；
 *     只看行会漏掉"行对了但命令本身崩了"。
 *   · **`dsh --dump-config` 默认不跑**（几秒且依赖 profile），`--with-dsh` 才加。
 *
 * 用法：
 *   node scripts/release-check.mjs            # 全部门禁 + 两条 demo 自检
 *   node scripts/release-check.mjs --with-dsh # 另加 dsh --profile web --dump-config（只读）
 *   node scripts/release-check.mjs --list     # 只打印计划，不执行
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 项目真正依赖的门禁清单。**少一个就会把"全绿"变成"除了你忘掉的那件事都绿"**，
 * 所以这份清单本身也被用例断言（`tests/edit/release-check.spec.ts`）。
 */
export const REQUIRED_GATES = [
  { gate: 'check-docs', why: '当前文档完整、本地链接有效、历史设计档案清零' },
  { gate: 'workflow-contract', why: 'CI/Release 固定 SHA、最小权限、OIDC、哈希、SBOM 与并发规则' },
  { gate: 'namespace-contract', why: '命名空间契约 11 个面（与参考插件并存的机械保障）' },
  { gate: 'tsc', why: '类型检查（exit 0 是底线，含 tests/**）' },
  { gate: 'oxlint', why: '风格与类型感知规则（必须 0 error）' },
  { gate: 'tsdown', why: '构建 lib/（宿主半边 + 客户端半边）' },
  { gate: 'package-contract', why: 'npm tarball 精确白名单、元数据、入口与 bundle 身份' },
  { gate: 'lanes', why: '4 个自有门禁 lane（edit / channel / client-logic / client-ui）' },
  { gate: 'suite', why: '全量 vitest（含上游 lane，防止我改坏复制基线）' },
  { gate: 'css-closure', why: 'CSS 闭包：我们的样式出不去、别人的样式删了也影响不到我们（用户 2026-10-05）' },
  { gate: 'i18n-orphans', why: 'i18n 里没有孤儿键（删卡/删功能留下的死文案，用户 2026-10-06 三轮清掉 145 个）' },
  { gate: 'demo-static', why: '交互 demo 的静态契约（id/class/讲解词）' },
  { gate: 'demo-runtime', why: '交互 demo 的最小 DOM 桩真渲染' },
  { gate: 'release-ready', why: '发布就绪：临时探针已清零 + npm 发布前提齐备（探针还在时**就该红**）' },
]

/**
 * 计划。`expect` 是**判定行**里必须出现的那一段（不是"最后一行"）。
 *
 * @param {{ withDsh?: boolean }} [opts]
 */
export function planSteps(opts = {}) {
  const steps = [
    { label: '当前文档完整性', gate: 'check-docs', command: 'node scripts/check-docs.mjs', expect: '文档一致性检查通过' },
    { label: '工作流供应链契约', gate: 'workflow-contract', command: 'node scripts/check-workflows.mjs', expect: 'workflow security contract passed' },
    { label: '命名空间契约', gate: 'namespace-contract', command: 'node scripts/namespace-contract.mjs', expect: '命名空间契约检查通过' },
    { label: '类型检查', gate: 'tsc', command: './node_modules/.bin/tsc --noEmit', expect: '__NO_OUTPUT__' },
    { label: '风格/类型感知', gate: 'oxlint', command: './node_modules/.bin/oxlint', expect: 'Found 0 warnings and 0 errors.' },
    { label: '构建', gate: 'tsdown', command: './node_modules/.bin/tsdown', expect: '__NO_OUTPUT__' },
    { label: 'npm 包精确契约', gate: 'package-contract', command: 'node scripts/check-package.mjs', expect: 'npm package contract passed' },
    {
      label: '门禁 lane ×4',
      gate: 'lanes',
      command: './node_modules/.bin/vitest run --project edit --project channel --project client-logic --project client-ui',
      expect: 'Test Files',
    },
    { label: '全量 vitest', gate: 'suite', command: './node_modules/.bin/vitest run', expect: 'Test Files' },
    { label: 'CSS 闭包（出不去/进不来/自足）', gate: 'css-closure', command: 'node scripts/css-closure.mjs', expect: '✅ 通过' },
    { label: '孤儿 i18n 键（死文案）', gate: 'i18n-orphans', command: 'node scripts/i18n-orphans.mjs', expect: '✅ 通过' },
    { label: 'demo 静态契约', gate: 'demo-static', command: 'node demo/check-static.mjs', expect: '__EXIT0__' },
    { label: 'demo 真渲染', gate: 'demo-runtime', command: 'node demo/check-runtime.mjs', expect: '失败 0 项' },
    { label: '发布就绪（探针清零 + npm 前提）', gate: 'release-ready', command: 'node scripts/check-release-ready.mjs', expect: '✅ 发布就绪检查通过' },
  ]
  if (opts.withDsh === true) {
    steps.push({
      label: '组成树（插件并排无冲突）',
      gate: 'dump-config',
      command: 'dsh --profile web --dump-config',
      expect: 'dsh-context-redline',
    })
  }
  return steps
}

/** 跑一步；返回它是否达到判定行。**不写任何东西。** */
function runStep(step) {
  let out = ''
  let ok = true
  try {
    out = execFileSync(step.command, { cwd: ROOT, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    ok = false
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  if (step.expect === '__NO_OUTPUT__') return { ok, line: ok ? '(exit 0，无输出)' : lastLine(out) }
  if (step.expect === '__EXIT0__') return { ok, line: ok ? '(exit 0)' : lastLine(out) }
  if (step.expect === '__PROGRESS__') {
    const m = /共 (\d+) 条\nDONE (\d+) · DOING (\d+) · TODO (\d+) · WAIT🙋 (\d+)/.exec(out)
    const line = m === null ? lastLine(out) : `共 ${m[1]} 条 · DONE ${m[2]} · DOING ${m[3]} · TODO ${m[4]} · WAIT🙋 ${m[5]}`
    return { ok: ok && m !== null, line }
  }
  const hit = out.split('\n').filter(l => l.includes(step.expect))
  return { ok: ok && hit.length > 0, line: hit.length > 0 ? hit[hit.length - 1].trim() : lastLine(out) }
}

const lastLine = (text) => text.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 100) ?? '(无输出)'

function main(argv) {
  const withDsh = argv.includes('--with-dsh')
  const plan = planSteps({ withDsh })
  if (argv.includes('--list')) {
    for (const s of plan) process.stdout.write(`${s.label}\n  $ ${s.command}\n  判定行：${s.expect}\n`)
    return 0
  }
  process.stdout.write(`发布前自检（只读）—— ${plan.length} 步${withDsh ? '（含 dump-config）' : ''}\n\n`)
  let failed = 0
  for (const step of plan) {
    const { ok, line } = runStep(step)
    if (!ok) failed += 1
    process.stdout.write(`${ok ? '✅' : '❌'} ${step.label}\n   ${line}\n`)
  }
  process.stdout.write(`\n${failed === 0 ? '全部通过' : `${failed} 步未通过`}（共 ${plan.length} 步）\n`)
  return failed === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
