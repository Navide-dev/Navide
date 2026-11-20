import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OFFICIAL_PLUGIN_SOURCES,
  WORKSPACE_PACKAGES,
  checkRecord,
  fingerprint,
  nextRecord,
  probe,
  readRecord,
} from '../../scripts/official-plugin-fingerprints.mjs'
import { OFFICIAL_PLUGIN_VERSIONS, REGISTRY_SOURCED_OFFICIAL_PLUGINS } from '../../src/main/plugins/officialPluginVersions'

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
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const file = (path: string, content: string) => {
    write(path, content)
    git(root, 'add', '--', path)
  }
  const manifest = (pluginId: string, version: string) =>
    [`${OFFICIAL_PLUGIN_SOURCES[pluginId].directory}/manifest.json`, JSON.stringify({ id: pluginId, version })] as const
  const setVersion = (pluginId: string, version: string) => file(...manifest(pluginId, version))
  // The baseline is staged with one `git add`: a spawn per file made this
  // fixture slow enough on a loaded Windows runner to hit the 5 s test timeout.
  for (const [pluginId, source] of Object.entries(OFFICIAL_PLUGIN_SOURCES)) {
    write(...manifest(pluginId, '1.0.0'))
    write(`${source.directory}/src/index.ts`, 'export {}')
    for (const extra of source.extra) write(extra, '# shared')
  }
  write('packages/plugin-ui/src/index.ts', 'export {}')
  write('src/renderer/src/i18n/locales/en-US.json', '{}')
  write('backend/agent_team_backend/path_guard.py', '# core')
  write('packages/plugin-sdk/bin/navide-plugin.mjs', '// cli')
  git(root, 'add', '-A')
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
    // A plugin the installer takes from the Registry is not fingerprinted here.
    expect(Object.keys(record.plugins).sort()).toEqual(
      Object.keys(OFFICIAL_PLUGIN_VERSIONS).filter((id) => !REGISTRY_SOURCED_OFFICIAL_PLUGINS.includes(id)).sort(),
    )
    expect(Object.keys(OFFICIAL_PLUGIN_SOURCES).sort()).toEqual(Object.keys(record.plugins).sort())
    expect(checkRecord(process.cwd())).toEqual([])
  }, 30_000)

  it('accepts unchanged content at the released version', () => {
    const { root, record } = releasedFixture()
    expect(checkRecord(root, record)).toEqual([])
  }, 30_000)

  it.each([
    ['its own source', 'plugins/navide-browser/src/index.ts'],
    ['a workspace package it bundles', 'packages/plugin-ui/src/index.ts'],
  ])('refuses changed content in %s at the released version', (_label, path) => {
    const { root, file, record } = releasedFixture()
    file(path, 'export const changed = true')
    expect(checkRecord(root, record)).toEqual(expect.arrayContaining([
      expect.stringContaining('navide.browser: content changed since v1.0.0 but the version is still 1.0.0'),
    ]))
  }, 30_000)

  it('refuses a change to the Python plugin SDK the Plans backend bundles', () => {
    const { root, file, record } = releasedFixture()
    file('backend/navide_plugin_sdk/path_guard.py', '# changed')
    expect(checkRecord(root, record)).toEqual([
      expect.stringContaining('navide.plans: content changed since v1.0.0'),
    ])
  }, 30_000)

  it('ignores the Host: its strings, its backend and the plugin-sdk command line', () => {
    const { root, file, record } = releasedFixture()
    file('src/renderer/src/i18n/locales/en-US.json', '{"msg":{"changed":"Changed"}}')
    file('backend/agent_team_backend/path_guard.py', '# the core name for the SDK module')
    file('packages/plugin-sdk/bin/navide-plugin.mjs', '// changed')
    expect(checkRecord(root, record)).toEqual([])
  }, 30_000)

  it('ignores tests, fixtures and Markdown', () => {
    const { root, file, record } = releasedFixture()
    file('plugins/navide-browser/tests/boundary.test.ts', 'it()')
    file('plugins/navide-plans/src/view.test.ts', 'it()')
    file('packages/plugin-sdk/test-fixtures/a.json', '{}')
    file('plugins/navide-browser/README.md', '# notes')
    expect(checkRecord(root, record)).toEqual([])
  }, 30_000)

  it('needs one bump per release cycle, not one per change', () => {
    const { root, file, setVersion, record } = releasedFixture()
    file('plugins/navide-browser/src/index.ts', 'export const first = true')
    setVersion('navide.browser', '1.0.1')
    expect(checkRecord(root, record)).toEqual([])
    file('plugins/navide-browser/src/index.ts', 'export const second = true')
    file('packages/plugin-ui/src/index.ts', 'export const shared = true')
    setVersion('navide.browser', '1.1.0')
    setVersion('navide.plans', '1.0.1')
    expect(checkRecord(root, record)).toEqual([])
  }, 30_000)

  it('always refuses a version lower than the released one', () => {
    const { root, setVersion, record } = releasedFixture()
    setVersion('navide.plans', '0.9.0')
    expect(checkRecord(root, record)).toEqual([
      expect.stringContaining('navide.plans: 0.9.0 is lower than 1.0.0 released in v1.0.0'),
    ])
  }, 30_000)

  it('records a release only when the rule holds, as release.sh does', () => {
    const { root, file, setVersion, record } = releasedFixture()
    file('plugins/navide-browser/src/index.ts', 'export const changed = true')
    expect(nextRecord(root, 'v1.1.0', record).problems).toEqual([
      expect.stringContaining('navide.browser: content changed since v1.0.0'),
    ])
    setVersion('navide.browser', '1.0.1')
    const next = nextRecord(root, 'v1.1.0', record)
    expect(next.problems).toEqual([])
    expect(next.record.baseline).toBe('v1.1.0')
    expect(next.record.plugins['navide.browser']).toEqual({ version: '1.0.1', fingerprint: fingerprint(root, 'navide.browser') })
    expect(checkRecord(root, next.record)).toEqual([])
  }, 30_000)

  it('reads the same fingerprint from a release tag as from the index', () => {
    const { root } = releasedFixture()
    git(root, 'tag', 'v1.0.0')
    for (const pluginId of Object.keys(OFFICIAL_PLUGIN_SOURCES)) {
      expect(fingerprint(root, pluginId, 'v1.0.0')).toBe(fingerprint(root, pluginId))
    }
  }, 30_000)
})

describe('official plugin fingerprint inputs', () => {
  it('leave every plugin unchanged by a Host-only string', () => {
    // The P0 acceptance check of the bundled-plugin split, against the real
    // index: Host strings live outside packages/plugin-ui.
    expect(probe(process.cwd(), 'src/renderer/src/i18n/locales/en-US.json')).toEqual([])
    expect(probe(process.cwd(), 'src/renderer/src/App.vue')).toEqual([])
    expect(probe(process.cwd(), 'packages/plugin-ui/src/foundation/i18n/locales/en-US.json'))
      .toEqual(Object.keys(OFFICIAL_PLUGIN_SOURCES))
    expect(probe(process.cwd(), 'plugins/navide-browser/src/locales/en-US.json')).toEqual(['navide.browser'])
  }, 60_000)

  it('keep the Plans backend off the core backend', () => {
    const inputs = OFFICIAL_PLUGIN_SOURCES['navide.plans'].extra
    expect(inputs.filter((path) => path.startsWith('backend/agent_team_backend/'))).toEqual([])
    const build = readFileSync('scripts/build-plans-v2-backend.mjs', 'utf8')
    expect(build).not.toContain('agent_team_backend/')
  })

  it.each(Object.entries(OFFICIAL_PLUGIN_SOURCES))('list every workspace package %s really bundles', (_id, source) => {
    // Import specifiers name a package (`@navide/plugin-ui/foundation` is
    // plugin-ui); a package's own imports join the closure, so plugin-ui
    // brings plugin-sdk and plugin-sdk brings plugin-contracts.
    const imported = (directory: string): string[] => {
      const files = git(process.cwd(), 'ls-files', '--', directory).split('\n')
        .filter((path) => /\.(ts|vue|mjs|js)$/.test(path))
        .filter((path) => !/(^|\/)(tests?|__tests__|test-fixtures|bin)\/|\.test\.|\/testing\.ts$/.test(path))
      const names = files.flatMap((path) =>
        [...readFileSync(path, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](@navide\/plugin-[a-z]+)/g)].map((m) => m[1]))
      return [...new Set(names)].filter((name) => name in WORKSPACE_PACKAGES)
    }
    const closure = new Set<string>()
    const pending = imported(source.directory)
    while (pending.length) {
      const name = pending.pop()!
      if (closure.has(name)) continue
      closure.add(name)
      pending.push(...imported(WORKSPACE_PACKAGES[name].directory))
    }
    expect([...source.packages].sort()).toEqual([...closure].sort())
  }, 30_000)
})
