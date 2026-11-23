import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'vitest'
import { BASELINE_DSH_VERSION, meetsBaseline } from '../../src/shared/version'

const read = (path: string) => readFileSync(path, 'utf8')
const pkg = JSON.parse(read('package.json')) as {
  version: string
  engines: { node: string; dsh: string }
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('release metadata stays synchronized', () => {
  test('publishes a fresh patch with the current DSH and Node baseline', () => {
    assert.equal(pkg.version, '0.8.4')
    assert.equal(BASELINE_DSH_VERSION, '0.2.3-alpha.2')
    assert.equal(pkg.engines.dsh, '>=0.2.3-alpha.2 <0.3.0-0')
    assert.equal(pkg.engines.node, '^24.22.3 || >=26.13.1')
    assert.equal(meetsBaseline('0.2.3-alpha.2'), true)
    assert.equal(meetsBaseline('0.2.2-rc.5'), false)
    assert.equal(meetsBaseline('0.2.3-alpha.1'), false)
    assert.equal(meetsBaseline('0.2.2-alpha.3'), false)
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, BASELINE_DSH_VERSION, name)
    }
    for (const [name, range] of Object.entries(pkg.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(range, pkg.engines.dsh, name)
    }
  })

  test('both READMEs and release notes name the same package, runtime and version', () => {
    for (const file of ['README.md', 'README.zh.md', `docs/releases/v${pkg.version}.md`]) {
      const text = read(file)
      for (const expected of [pkg.version, pkg.engines.dsh, '24.22.3', `dsh-context-redline@${pkg.version}`]) {
        assert.ok(text.includes(expected), `${file} is missing ${expected}`)
      }
    }
    const notes = read(`docs/releases/v${pkg.version}.md`)
    for (const locale of ['cn', 'en']) assert.ok(notes.includes(`<h3 id="${locale}-v${pkg.version}">`))
    assert.ok(read('CHANGELOG.md').includes(`## [${pkg.version}] — 2026-11-23`))
    assert.ok(!read('CHANGELOG.md').includes('Unreleased'))
  })

  test('GitHub Release waits for successful npm publication', () => {
    assert.match(read('.github/workflows/release.yml'), /github-release:\n\s+name: GitHub release\n\s+needs: \[package, publish\]/)
  })
})
