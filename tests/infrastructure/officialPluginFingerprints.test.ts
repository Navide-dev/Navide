import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OFFICIAL_PLUGIN_SOURCES,
  checkRecord,
  nextRecord,
  readRecord,
} from '../../scripts/official-plugin-fingerprints.mjs'
import { OFFICIAL_PLUGIN_VERSIONS } from '../../src/main/plugins/officialPluginVersions'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A git index holding every plugin's manifest, one source file and its extras. */
function repoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'navide-plugin-fingerprints-'))
  roots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  const file = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
    execFileSync('git', ['add', '--', path], { cwd: root })
  }
  const setVersion = (pluginId: string, version: string) =>
    file(`${OFFICIAL_PLUGIN_SOURCES[pluginId].directory}/manifest.json`, JSON.stringify({ id: pluginId, version }))
  for (const [pluginId, source] of Object.entries(OFFICIAL_PLUGIN_SOURCES)) {
    setVersion(pluginId, '1.0.0')
    file(`${source.directory}/src/index.ts`, 'export {}')
    for (const extra of source.extra) file(extra, '# shared')
  }
  file('packages/plugin-ui/src/index.ts', 'export {}')
  const record = nextRecord(root, {}).record
  return { root, file, setVersion, record }
}

describe('official plugin fingerprints', () => {
  it('match the recorded version and content of every bundled first-party plugin', () => {
    const record = readRecord(process.cwd())
    expect(Object.keys(record).sort()).toEqual(Object.keys(OFFICIAL_PLUGIN_VERSIONS).sort())
    for (const [pluginId, version] of Object.entries(OFFICIAL_PLUGIN_VERSIONS)) {
      expect(record[pluginId].version).toBe(version)
    }
    expect(checkRecord(process.cwd())).toEqual([])
  })

  it('accepts an unchanged plugin', () => {
    const { root, record } = repoFixture()
    expect(checkRecord(root, record)).toEqual([])
  })

  it.each([
    ['its own source', 'plugins/navide-git/src/index.ts'],
    ['a workspace package it bundles', 'packages/plugin-ui/src/index.ts'],
  ])('fails a content change in %s without a version bump', (_label, path) => {
    const { root, file, record } = repoFixture()
    file(path, 'export const changed = true')
    expect(checkRecord(root, record)).toEqual(
      expect.arrayContaining([expect.stringContaining('navide.git: content changed but the version is still 1.0.0')]),
    )
    expect(nextRecord(root, record).problems).toEqual(
      expect.arrayContaining([expect.stringContaining('navide.git: content changed')]),
    )
  })

  it('fails a change to a core module the Plans backend bundles', () => {
    const { root, file, record } = repoFixture()
    file('backend/agent_team_backend/path_guard.py', '# changed')
    expect(checkRecord(root, record)).toEqual([
      expect.stringContaining('navide.plans: content changed but the version is still 1.0.0'),
    ])
  })

  it('ignores tests, fixtures and Markdown', () => {
    const { root, file, record } = repoFixture()
    file('plugins/navide-git/tests/boundary.test.ts', 'it()')
    file('plugins/navide-plans/src/view.test.ts', 'it()')
    file('packages/plugin-sdk/test-fixtures/a.json', '{}')
    file('plugins/navide-mini-ide/README.md', '# notes')
    expect(checkRecord(root, record)).toEqual([])
  })

  it('asks to record a bumped version, then accepts it', () => {
    const { root, file, setVersion, record } = repoFixture()
    file('plugins/navide-git/src/index.ts', 'export const changed = true')
    setVersion('navide.git', '1.0.1')
    expect(checkRecord(root, record)).toEqual([expect.stringContaining('navide.git: version 1.0.1 is not recorded')])
    const next = nextRecord(root, record)
    expect(next.problems).toEqual([])
    expect(next.record['navide.git'].version).toBe('1.0.1')
    expect(checkRecord(root, next.record)).toEqual([])
  })

  it('refuses to record a version that goes backwards', () => {
    const { root, setVersion, record } = repoFixture()
    setVersion('navide.plans', '0.9.0')
    expect(nextRecord(root, record).problems).toEqual([
      expect.stringContaining('navide.plans: 0.9.0 is not newer than the recorded 1.0.0'),
    ])
  })
})
