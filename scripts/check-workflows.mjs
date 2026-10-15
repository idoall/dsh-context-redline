#!/usr/bin/env node
/** Read-only supply-chain contract for CI and release workflows. */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(join(ROOT, path), 'utf8')
const ci = read('.github/workflows/ci.yml')
const release = read('.github/workflows/release.yml')
const problems = []

for (const [path, text] of [['.github/workflows/ci.yml', ci], ['.github/workflows/release.yml', release]]) {
  for (const match of text.matchAll(/^\s*-\s+uses:\s+([^\s#]+)(?:\s+#.*)?$/gm)) {
    const spec = match[1]
    if (spec.startsWith('./')) continue
    const at = spec.lastIndexOf('@')
    const ref = at === -1 ? '' : spec.slice(at + 1)
    if (!/^[0-9a-f]{40}$/.test(ref)) problems.push(`${path}: action is not pinned to a full commit SHA: ${spec}`)
  }
  if (/pull_request_target\s*:/.test(text)) problems.push(`${path}: pull_request_target is forbidden for this repository`)
}

const ciRequired = [
  'pnpm install --frozen-lockfile',
  'pnpm run typecheck',
  'pnpm run lint',
  'node scripts/check-docs.mjs',
  'node scripts/namespace-contract.mjs',
  'node scripts/css-closure.mjs',
  'node scripts/i18n-orphans.mjs',
  'pnpm run build',
  'pnpm run test',
  './node_modules/.bin/vitest run',
  'node scripts/check-package.mjs',
  'node scripts/check-workflows.mjs',
  'node demo/check-static.mjs',
  'node demo/check-runtime.mjs',
  'node scripts/check-release-ready.mjs',
]
for (const command of ciRequired) if (!ci.includes(command)) problems.push(`CI is missing: ${command}`)
if (!/concurrency:[\s\S]*cancel-in-progress:\s*true/.test(ci)) problems.push('CI must cancel superseded runs')

const releaseRequired = [
  "tags: ['v*']",
  'id-token: write',
  'NODE_AUTH_TOKEN is intentionally unset',
  'npm publish "$package" --access public --provenance',
  'node scripts/check-package.mjs "$package"',
  'sha256sum -c',
  'npm sbom --sbom-format cyclonedx --omit dev',
  'docs/releases/${GITHUB_REF_NAME}.md',
  'require(\'./package.json\').version',
]
for (const contract of releaseRequired) if (!release.includes(contract)) problems.push(`Release is missing: ${contract}`)
if (!/concurrency:[\s\S]*cancel-in-progress:\s*false/.test(release)) problems.push('Release must serialize the same tag without canceling it')
if (/NPM_TOKEN\s*:|NODE_AUTH_TOKEN\s*:/.test(release)) problems.push('Release must not inject a long-lived npm token')
if (/npm publish[^\n]*--ignore-scripts/.test(release)) problems.push('Release must not bypass package lifecycle checks')

if (problems.length > 0) {
  console.error(`❌ workflow security contract found ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  · ${problem}`)
  process.exit(1)
}
console.log('✅ workflow security contract passed (SHA pins, full CI, OIDC, checksum, SBOM, concurrency)')
