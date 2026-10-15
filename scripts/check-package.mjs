#!/usr/bin/env node
/** Verify the exact npm package contract, either from this tree or a .tgz. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_FILES = [
  'CHANGELOG.md',
  'LICENSE',
  'LICENSE-Apache-2.0',
  'NOTICE',
  'README.md',
  'README.zh.md',
  'UPSTREAM.md',
  'cordis.patch.yml',
  'icon.svg',
  'lib/client.js',
  'lib/client.js.map',
  'lib/index.d.ts',
  'lib/index.js',
  'locale/en.json',
  'locale/zh.json',
  'package.json',
].sort()

function fail(message) {
  console.error(`❌ npm package contract: ${message}`)
  process.exit(1)
}

function parseJson(text, label) {
  try { return JSON.parse(text) } catch (error) {
    fail(`${label} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function validateManifest(pkg, label) {
  if (pkg === null || typeof pkg !== 'object') fail(`${label} is not an object`)
  if (pkg.name !== 'dsh-context-redline') fail(`${label} has wrong name: ${String(pkg.name)}`)
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    fail(`${label} has invalid version: ${String(pkg.version)}`)
  }
  if (pkg.main !== 'lib/index.js' || pkg.types !== 'lib/index.d.ts') fail(`${label} has wrong Host entrypoints`)
  if (pkg.exports?.['./client'] !== './lib/client.js') fail(`${label} has wrong Client export`)
  if (pkg.exports?.['./package.json'] !== './package.json') fail(`${label} does not export package.json`)
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail(`${label} has wrong DSH bundle patch`)
  if (pkg.engines?.dsh !== '>=0.2.1-alpha.2 <0.3.0') fail(`${label} has wrong DSH compatibility range`)
  if (pkg.publishConfig?.access !== 'public') fail(`${label} is not configured for public publishing`)
  if (pkg.publishConfig?.provenance !== undefined) fail(`${label} forces provenance outside supported CI providers`)
  if (pkg.license !== 'MIT AND Apache-2.0') fail(`${label} has wrong license expression`)
  return pkg
}

function validateFiles(actual, sizes) {
  const files = [...new Set(actual)].sort()
  if (JSON.stringify(files) !== JSON.stringify(EXPECTED_FILES)) {
    const missing = EXPECTED_FILES.filter(path => !files.includes(path))
    const extra = files.filter(path => !EXPECTED_FILES.includes(path))
    fail(`file whitelist mismatch; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`)
  }
  for (const path of ['lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'cordis.patch.yml']) {
    if ((sizes.get(path) ?? 0) <= 0) fail(`${path} is empty`)
  }
}

function validateBuiltText(client, patch) {
  if (!/window\.__ModuleLoader__\.load\(\{\s*id:\s*["']dsh-context-redline["']/.test(client)) {
    fail('Client bundle does not register id dsh-context-redline')
  }
  if (!/^\s*-\s+id:\s*dsh-context-redline$/m.test(patch) || !/^\s+name:\s*dsh-context-redline$/m.test(patch)) {
    fail('cordis.patch.yml identity is not dsh-context-redline')
  }
}

function verifyTree() {
  const pkg = validateManifest(parseJson(readFileSync(join(ROOT, 'package.json'), 'utf8'), 'package.json'), 'package.json')
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const parsed = parseJson(raw, 'npm pack --json output')
  const report = Array.isArray(parsed) ? parsed[0] : parsed?.[pkg.name]
  if (report?.name !== pkg.name || report?.version !== pkg.version) fail('npm pack reports the wrong package identity')
  const rows = Array.isArray(report.files) ? report.files : []
  const sizes = new Map(rows.map(row => [row.path, row.size]))
  validateFiles(rows.map(row => row.path), sizes)
  validateBuiltText(
    readFileSync(join(ROOT, 'lib/client.js'), 'utf8'),
    readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8'),
  )
  console.log(`✅ npm package contract passed (${pkg.name}@${pkg.version}, ${EXPECTED_FILES.length} files, dry-run)`)
}

function tarRead(tarball, path) {
  return execFileSync('tar', ['-xOzf', tarball, `package/${path}`], { encoding: 'utf8' })
}

function verifyTarball(input) {
  const tarball = resolve(input)
  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
  const files = listing.filter(path => !path.endsWith('/')).map(path => path.replace(/^package\//, ''))
  const sizes = new Map(files.map(path => [path, Buffer.byteLength(tarRead(tarball, path))]))
  validateFiles(files, sizes)
  const pkg = validateManifest(parseJson(tarRead(tarball, 'package.json'), 'tarball package.json'), 'tarball package.json')
  if (basename(tarball) !== `${pkg.name}-${pkg.version}.tgz`) fail(`tarball filename does not match ${pkg.name}@${pkg.version}`)
  validateBuiltText(tarRead(tarball, 'lib/client.js'), tarRead(tarball, 'cordis.patch.yml'))
  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  console.log(`✅ npm package contract passed (${pkg.name}@${pkg.version}, ${EXPECTED_FILES.length} files, sha256=${sha256})`)
}

const input = process.argv[2]
if (input === undefined) verifyTree()
else verifyTarball(input)
