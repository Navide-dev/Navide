import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OFFICIAL_PLUGIN_SOURCES,
  checkRecord,
  fingerprint,
  nextRecord,
  readRecord,
} from '../../scripts/official-plugin-fingerprints.mjs'
import { OFFICIAL_PLUGIN_VERSIONS } from '../../src/main/plugins/officialPluginVersions'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })

/** A repository whose first commit is the released baseline at 1.0.0. */
function releasedFixture() {
  const root = mkdtempSync(join(tmpdir(), 'navide-plugin-fingerprints-'))
  roots.push(root)
  git(root, 'init', '-q')
  const file = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
    git(root, 'add', '--', path)
  }
  const setVersion = (pluginId: string, version: string) =>
    file(`${OFFICIAL_PLUGIN_SOURCES[pluginId].directory}/manifest.json`, JSON.stringify({ id: pluginId, version }))
  for (const [pluginId, source] of Object.entries(OFFICIAL_PLUGIN_SOURCES)) {
    setVersion(pluginId, '1.0.0')
    file(`${source.directory}/src/index.ts`, 'export {}')
    for (const extra of source.extra) file(extra, '# shared')
  }
  file('packages/plugin-ui/src/index.ts', 'export {}')
  const record = {
    baseline: 'v1.0.0',
    plugins: Object.fromEntries(Object.keys(OFFICIAL_PLUGIN_SOURCES).map((pluginId) =>
      [pluginId, { version: '1.0.0', fingerprint: fingerprint(root, pluginId) }])),
  }
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'release')
  return { root, file, setVersion, record }
}

describe('official plugin release baseline', () => {
  it('holds for every bundled first-party plugin in this repository', () => {
    const record = readRecord(process.cwd())
    expect(record.baseline).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(Object.keys(record.plugins).sort()).toEqual(Object.keys(OFFICIAL_PLUGIN_VERSIONS).sort())
    expect(checkRecord(process.cwd())).toEqual([])
  })

  it('accepts unchanged content at the released version', () => {
    const { root, record } = releasedFixture()
    expect(checkRecord(root, record)).toEqual([])
  })

  it.each([
    ['its own source', 'plugins/navide-git/src/index.ts'],
    ['a workspace package it bundles', 'packages/plugin-ui/src/index.ts'],
  ])('refuses changed content in %s at the released version', (_label, path) => {
    const { root, file, record } = releasedFixture()
    file(path, 'export const changed = true')
    expect(checkRecord(root, record)).toEqual(expect.arrayContaining([
      expect.stringContaining('navide.git: content changed since v1.0.0 but the version is still 1.0.0'),
    ]))
  })

  it('refuses a change to a core module the Plans backend bundles', () => {
    const { root, file, record } = releasedFixture()
    file('backend/agent_team_backend/path_guard.py', '# changed')
    expect(checkRecord(root, record)).toEqual([
      expect.stringContaining('navide.plans: content changed since v1.0.0'),
    ])
  })

  it('ignores tests, fixtures and Markdown', () => {
    const { root, file, record } = releasedFixture()
    file('plugins/navide-git/tests/boundary.test.ts', 'it()')
    file('plugins/navide-plans/src/view.test.ts', 'it()')
    file('packages/plugin-sdk/test-fixtures/a.json', '{}')
    file('plugins/navide-mini-ide/README.md', '# notes')
    expect(checkRecord(root, record)).toEqual([])
  })

  it('needs one bump per release cycle, not one per change', () => {
    const { root, file, setVersion, record } = releasedFixture()
    file('plugins/navide-git/src/index.ts', 'export const first = true')
    setVersion('navide.git', '1.0.1')
    expect(checkRecord(root, record)).toEqual([])
    file('plugins/navide-git/src/index.ts', 'export const second = true')
    file('packages/plugin-ui/src/index.ts', 'export const shared = true')
    setVersion('navide.mini-ide', '1.1.0')
    setVersion('navide.plans', '1.0.1')
    expect(checkRecord(root, record)).toEqual([])
  })

  it('always refuses a version lower than the released one', () => {
    const { root, setVersion, record } = releasedFixture()
    setVersion('navide.plans', '0.9.0')
    expect(checkRecord(root, record)).toEqual([
      expect.stringContaining('navide.plans: 0.9.0 is lower than 1.0.0 released in v1.0.0'),
    ])
  })

  it('records a release only when the rule holds, as release.sh does', () => {
    const { root, file, setVersion, record } = releasedFixture()
    file('plugins/navide-git/src/index.ts', 'export const changed = true')
    expect(nextRecord(root, 'v1.1.0', record).problems).toEqual([
      expect.stringContaining('navide.git: content changed since v1.0.0'),
    ])
    setVersion('navide.git', '1.0.1')
    const next = nextRecord(root, 'v1.1.0', record)
    expect(next.problems).toEqual([])
    expect(next.record.baseline).toBe('v1.1.0')
    expect(next.record.plugins['navide.git']).toEqual({ version: '1.0.1', fingerprint: fingerprint(root, 'navide.git') })
    expect(checkRecord(root, next.record)).toEqual([])
  })

  it('reads the same fingerprint from a release tag as from the index', () => {
    const { root } = releasedFixture()
    git(root, 'tag', 'v1.0.0')
    for (const pluginId of Object.keys(OFFICIAL_PLUGIN_SOURCES)) {
      expect(fingerprint(root, pluginId, 'v1.0.0')).toBe(fingerprint(root, pluginId))
    }
  })
})
