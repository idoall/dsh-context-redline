#!/usr/bin/env node
/** Final-repository documentation integrity check. Read-only. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const required = [
  'AGENTS.md', 'README.md', 'README.zh.md', 'CHANGELOG.md', 'NOTICE', 'UPSTREAM.md',
  'docs/12-user-guide.md', 'docs/13-context-migration.md',
  'docs/14-system-prompt-and-injection.md', 'docs/15-carrier-lifecycle.md',
]
const removedHistory = [
  'docs/00-scope.md', 'docs/01-platform-facts.md', 'docs/02-architecture.md', 'docs/03-ui-spec.md',
  'docs/04-roadmap.md', 'docs/05-test-plan.md', 'docs/06-orchestration.md',
  'docs/08-open-questions.md', 'docs/09-requirements-traceability.md',
  'docs/10-execution-checklist.md', 'docs/11-session-handoff.md', 'docs/16-current-decisions.md',
  'demo/DESIGN-BRIEF.md', 'demo/V0-PROMPT.md', 'demo/screenshots/measure-log.md',
]

for (const path of required) if (!existsSync(join(ROOT, path))) problems.push(`缺少当前文档：${path}`)
for (const path of removedHistory) if (existsSync(join(ROOT, path))) problems.push(`历史文档仍存在：${path}`)

const documents = required.filter(path => existsSync(join(ROOT, path)))
const markdownLink = /\[[^\]]*\]\(([^)]+)\)/g
for (const path of documents) {
  const text = readFileSync(join(ROOT, path), 'utf8')
  for (const match of text.matchAll(markdownLink)) {
    const target = match[1]?.trim() ?? ''
    if (target === '' || target.startsWith('#') || /^[a-z]+:/i.test(target)) continue
    const plain = target.replace(/^<|>$/g, '').split('#', 1)[0]
    if (plain === '') continue
    const absolute = resolve(ROOT, dirname(path), plain)
    if (!existsSync(absolute)) problems.push(`${path} 链接不存在：${target}`)
  }
}

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const readmeZh = readFileSync(join(ROOT, 'README.zh.md'), 'utf8')
for (const heading of ['Features', 'Images and attachments', 'Install', 'License']) {
  if (!readme.includes(`## ${heading}`)) problems.push(`README.md 缺少章节：${heading}`)
}
for (const heading of ['能做什么', '图片和附件', '安装', '许可']) {
  if (!readmeZh.includes(`## ${heading}`)) problems.push(`README.zh.md 缺少章节：${heading}`)
}

const all = documents.map(path => `${path}\n${readFileSync(join(ROOT, path), 'utf8')}`).join('\n')
for (const stale of ['当前代码 = 旧的', '等待用户重启加载', '唯一执行清单', '301 项', 'V15–V19 未']) {
  if (all.includes(stale)) problems.push(`当前文档残留历史状态：${stale}`)
}

if (problems.length > 0) {
  console.log(`❌ 文档一致性检查发现 ${problems.length} 个问题：`)
  for (const problem of problems) console.log(`  · ${problem}`)
  process.exit(1)
}
console.log(`✅ 文档一致性检查通过（${required.length} 份当前文档、本地链接、双语章节、历史档案清零）`)
