import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseInstalledManifest,
  parseManifestJson,
  manifestToDescriptor,
  manifestToActivation,
  manifestToInstalledPackageSummary,
  buildActivationCatalog,
  loadPluginDir,
  scanInstalledPlugins,
  InstalledPluginError,
  backendEntryOnDisk,
  isManifestV2,
} from './installedPlugins'
import { immutablePluginPackageDir, PluginActivationSelector } from './pluginActivationSelector'
import { isMethodName } from './pluginBackendSupervisor'
import { isWindows } from '../../shared/osplat'

const VALID = { id: 'acme.demo', version: '1.2.3', entry: 'dist/main.js', requires: ['fs', 'git'] }

const CONTRACT_FIXTURES = join(process.cwd(), 'docs/plugin-contracts/fixtures')
const VALID_V2_FIXTURES = readdirSync(join(CONTRACT_FIXTURES, 'valid'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const INVALID_V2_FIXTURES = readdirSync(join(CONTRACT_FIXTURES, 'invalid'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const ISSUE_02_FIXTURES = [
  ['valid', 'backend-only-skills.json'],
  ['valid', 'combined-files.json'],
  ['invalid', 'backend-raw-script.json'],
  ['invalid', 'backend-raw-script-uppercase.json'],
  ['invalid', 'backend-unknown-activation.json'],
  ['invalid', 'backend-unknown-field.json'],
  ['invalid', 'backend-unknown-protocol.json'],
  ['invalid', 'metadata-only.json'],
] as const

function readFixture(group: string, name: string): string {
  return readFileSync(join(CONTRACT_FIXTURES, group, name), 'utf8')
}

describe('parseInstalledManifest', () => {
  it('accepts a valid manifest', () => {
    const m = parseInstalledManifest(VALID)
    expect(m.id).toBe('acme.demo')
    expect(m.requires).toEqual(['fs', 'git'])
  })

  it('rejects a bad id', () => {
    expect(() => parseInstalledManifest({ ...VALID, id: 'NotValid' })).toThrow(InstalledPluginError)
  })

  it('rejects a non-semver version', () => {
    expect(() => parseInstalledManifest({ ...VALID, version: '1.0' })).toThrow(/semver/)
  })

  it('rejects a missing entry', () => {
    const { entry: _e, ...noEntry } = VALID
    expect(() => parseInstalledManifest(noEntry)).toThrow(/entry/)
  })

  it('rejects an unknown capability (scope over-reach)', () => {
    expect(() => parseInstalledManifest({ ...VALID, requires: ['fs', 'network'] })).toThrow(/network/)
  })

  it('keeps the v2 storage permission out of the legacy manifest path', () => {
    expect(() => parseInstalledManifest({ ...VALID, requires: ['storage'] })).toThrow(
      /unsupported capability/
    )
  })

  it.each(['../escape.js', 'a/../../etc/passwd', '/abs/main.js', '..\\win.js', 'C:/win.js'])(
    'rejects a path-traversal entry %j',
    (entry) => {
      expect(() => parseInstalledManifest({ ...VALID, entry })).toThrow(InstalledPluginError)
      expect(() => parseInstalledManifest({ ...VALID, entry })).toThrow(/unsafe entry path/)
    }
  )
})

describe('Manifest v2 contract corpus', () => {
  it.each(ISSUE_02_FIXTURES)('uses empty permissions in %s/%s', (group, name) => {
    expect(JSON.parse(readFixture(group, name)).permissions).toEqual({})
  })

  it.each(VALID_V2_FIXTURES)(
    'accepts valid fixture %s',
    (name) => {
      const manifest = parseInstalledManifest(JSON.parse(readFixture('valid', name)))
      expect(manifest.schemaVersion).toBe(2)
    }
  )

  it.each(INVALID_V2_FIXTURES)('rejects invalid fixture %s', (name) => {
    expect(() => parseInstalledManifest(JSON.parse(readFixture('invalid', name)))).toThrow()
  })

  it.each(['1.2.3-.', '1.2.3-a..b', '1.2.3-01', '1.2.3-0.01', '01.02.03'])(
    'rejects malformed v2 version %s',
    (version) => {
      const manifest = JSON.parse(readFixture('valid', 'frontend-multi-view.json')) as Record<
        string,
        unknown
      >
      manifest.version = version
      expect(() => parseInstalledManifest(manifest)).toThrow(/semver/)
    }
  )

  it('accepts a valid v2 prerelease version', () => {
    const manifest = JSON.parse(readFixture('valid', 'frontend-multi-view.json')) as Record<
      string,
      unknown
    >
    manifest.version = '1.2.3-0.3.7'
    expect(parseInstalledManifest(manifest).version).toBe('1.2.3-0.3.7')
  })

  it('accepts v2 build metadata', () => {
    const manifest = JSON.parse(readFixture('valid', 'frontend-multi-view.json')) as Record<
      string,
      unknown
    >
    manifest.version = '1.2.3-alpha.1+build.4'
    expect(parseInstalledManifest(manifest).version).toBe('1.2.3-alpha.1+build.4')
  })

  it.each([
    ['name', 'x'.repeat(81)],
    ['name', 'line\nname'],
    ['name', '<name>'],
    ['title', 'x'.repeat(81)],
    ['title', 'line\ntitle'],
    ['title', '<title>'],
  ])('rejects unsafe or oversized v2 display text %s', (field, value) => {
    const manifest = JSON.parse(readFixture('valid', 'frontend-multi-view.json')) as Record<
      string,
      any
    >
    if (field === 'name') manifest.name = value
    else manifest.contributes.views[0].title = value
    expect(() => parseInstalledManifest(manifest)).toThrow(new RegExp(field))
  })

  it('accepts sixteen v2 views and rejects seventeen', () => {
    const manifest = JSON.parse(readFixture('valid', 'frontend-multi-view.json')) as Record<
      string,
      any
    >
    manifest.contributes.views = Array.from({ length: 16 }, (_, index) => ({
      id: `view-${index}`,
      kind: 'custom',
      location: 'main',
      title: `View ${index}`,
      entry: `frontend/view-${index}/index.html`,
    }))
    const parsed = parseInstalledManifest(manifest)
    expect(parsed.schemaVersion).toBe(2)
    if (parsed.schemaVersion === 2) {
      expect(parsed.contributes?.views).toHaveLength(16)
    }
    manifest.contributes.views.push({
      id: 'view-16',
      kind: 'custom',
      location: 'main',
      title: 'View 16',
      entry: 'frontend/view-16/index.html',
    })
    expect(() => parseInstalledManifest(manifest)).toThrow(/views/)
  })

  it('rejects duplicate object keys before manifest validation', () => {
    expect(() => parseManifestJson(readFixture('invalid-raw', 'duplicate-permission-key.json'))).toThrow(
      /duplicate JSON object key: system/
    )
  })

  it('rejects a UTF-8 BOM before manifest validation', () => {
    expect(() => parseManifestJson(readFixture('invalid-raw', 'manifest-utf8-bom.json'))).toThrow(
      /BOM/
    )
  })

  it('derives the Host view catalog from v2 contributions', () => {
    const manifest = parseInstalledManifest(
      JSON.parse(readFixture('valid', 'frontend-multi-view.json'))
    )
    const descriptor = manifestToDescriptor(manifest, '/plugins/acme.files')
    expect(descriptor.requires).toEqual(['fs', 'ui', 'shell'])
    expect(descriptor.capabilityPolicy).toEqual({
      kind: 'manifest-v2',
      system: ['fs', 'ui'],
      shell: 'allowlist',
      grants: [
        { permission: 'system', namespace: 'fs' },
        { permission: 'system', namespace: 'ui' },
        { permission: 'shell', mode: 'allowlist' },
      ],
    })
    expect(descriptor.views).toHaveLength(6)
    expect(descriptor.views?.find((view) => view.id === 'left')).toMatchObject({
      contributionKey: 'acme.files.left',
      kind: 'custom',
      location: 'left',
      iconFile: join('/plugins', 'acme.files', 'assets', 'files.png'),
      entryFile: join('/plugins', 'acme.files', 'frontend', 'left', 'index.html'),
    })
  })

  it('exposes Manifest v2 permissions separately in the installed package summary', () => {
    const manifest = parseInstalledManifest(
      JSON.parse(readFixture('valid', 'frontend-multi-view.json'))
    )
    expect(manifestToInstalledPackageSummary(manifest)).toEqual({
      id: 'acme.files',
      requires: ['fs', 'ui', 'shell'],
      packageVersion: '1.0.0',
      manifestPermissions: { system: ['fs', 'ui'], shell: 'allowlist' },
      apiVersion: '^1.0.0',
    })
  })

  it('derives backend-only and combined activation entries from one package version', () => {
    const backendOnly = parseInstalledManifest(
      JSON.parse(readFixture('valid', 'backend-only-skills.json'))
    )
    const combined = parseInstalledManifest(
      JSON.parse(readFixture('valid', 'combined-files.json'))
    )
    if (backendOnly.schemaVersion !== 2 || combined.schemaVersion !== 2) {
      throw new Error('expected Manifest v2 fixtures')
    }

    expect(manifestToActivation(backendOnly, '/plugins/navide.skills')).toEqual({
      pluginId: 'navide.skills',
      packageVersion: '1.0.0',
      packageDir: '/plugins/navide.skills',
      views: [],
      backend: {
        entryFile: join('/plugins', 'navide.skills', backendEntryOnDisk('backend/navide-skills')),
        protocolVersion: 1,
        activation: 'startup',
      },
    })
    const combinedActivation = manifestToActivation(combined, '/plugins/acme.files')
    expect(combinedActivation.packageVersion).toBe('1.0.0')
    expect(combinedActivation.views[0]).toMatchObject({
      contributionKey: 'acme.files.left',
      entryFile: join('/plugins', 'acme.files', 'frontend', 'left', 'index.html'),
    })
    expect(combinedActivation.backend?.entryFile).toBe(
      join('/plugins', 'acme.files', backendEntryOnDisk('backend/acme-files'))
    )
  })

  it('rejects an activation catalog containing two active versions of one package', () => {
    const manifest = parseInstalledManifest(
      JSON.parse(readFixture('valid', 'combined-files.json'))
    )
    if (manifest.schemaVersion !== 2) throw new Error('expected Manifest v2 fixture')
    const otherVersion = { ...manifest, version: '2.0.0' }
    const first = manifestToActivation(manifest, '/plugins/acme.files/1.0.0')
    const second = manifestToActivation(otherVersion, '/plugins/acme.files/2.0.0')

    expect(() => buildActivationCatalog([first, second])).toThrow(/multiple active versions/)
  })

  it('rejects an activation catalog containing one package version twice', () => {
    const manifest = parseInstalledManifest(
      JSON.parse(readFixture('valid', 'combined-files.json'))
    )
    if (manifest.schemaVersion !== 2) throw new Error('expected Manifest v2 fixture')

    expect(() =>
      buildActivationCatalog([
        manifestToActivation(manifest, '/plugins/acme.files/first'),
        manifestToActivation(manifest, '/plugins/acme.files/second'),
      ])
    ).toThrow(/appears more than once/)
  })
})

describe('manifestToDescriptor', () => {
  it('resolves entry against the plugin dir and empties devUrl', () => {
    const d = manifestToDescriptor(parseInstalledManifest(VALID), '/plugins/acme.demo')
    expect(d.id).toBe('acme.demo')
    expect(d.packageVersion).toBeUndefined()
    expect(d.devUrl).toBe('')
    expect(d.entryFile).toBe(join('/plugins', 'acme.demo', 'dist', 'main.js'))
    expect(d.requires).toEqual(['fs', 'git'])
  })
})

describe('loadPluginDir', () => {
  let root: string
  let outside: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plugin-dir-'))
    outside = mkdtempSync(join(tmpdir(), 'plugin-outside-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('rejects a UTF-8 BOM when loading an installed manifest from disk', () => {
    writeFileSync(
      join(root, 'manifest.json'),
      readFileSync(join(CONTRACT_FIXTURES, 'invalid-raw', 'manifest-utf8-bom.json'))
    )
    expect(loadPluginDir(root).error).toMatch(/BOM/)
  })

  it('returns a descriptor for a valid plugin dir', () => {
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(VALID))
    const loaded = loadPluginDir(root)
    expect(loaded.error).toBeUndefined()
    expect(loaded.descriptor?.id).toBe('acme.demo')
    expect(loaded.descriptor?.entryFile).toBe(join(root, 'dist/main.js'))
  })

  it('loads a v2 custom view from its contribution entry and placement', () => {
    const manifest = {
      schemaVersion: 2,
      apiVersion: '^1.0.0',
      id: 'acme.viewer',
      name: 'Viewer',
      version: '1.0.0',
      publisher: 'acme',
      permissions: {},
      marketplace: { description: 'A viewer.', license: 'MIT' },
      contributes: {
        views: [
          {
            id: 'left',
            kind: 'custom',
            location: 'left',
            title: 'Viewer',
            entry: 'frontend/left/index.html',
          },
        ],
      },
    }
    mkdirSync(join(root, 'frontend', 'left'), { recursive: true })
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    writeFileSync(join(root, 'frontend', 'left', 'index.html'), '<!doctype html>')

    const loaded = loadPluginDir(root)
    expect(loaded.error).toBeUndefined()
    expect(loaded.descriptor?.views).toEqual([
      expect.objectContaining({
        contributionKey: 'acme.viewer.left',
        location: 'left',
        entryFile: join(root, 'frontend', 'left', 'index.html'),
      }),
    ])
    expect(loaded.descriptor?.packageVersion).toBe('1.0.0')
  })

  it('loads composition metadata and rejects a missing target schema asset', () => {
    const manifest = {
      schemaVersion: 2,
      apiVersion: '^1.0.0',
      id: 'acme.composed',
      name: 'Composed',
      version: '1.0.0',
      publisher: 'acme',
      permissions: {},
      marketplace: { description: 'A composed plugin.', license: 'MIT' },
      contributes: {
        views: [
          {
            id: 'left', kind: 'custom', location: 'left', title: 'Left',
            entry: 'frontend/left/index.html', detailView: 'detail',
          },
          {
            id: 'detail', kind: 'custom', location: 'detail', title: 'Detail',
            entry: 'frontend/detail/index.html', targetSchema: 'schemas/item.json',
          },
          {
            id: 'window', kind: 'custom', location: 'window', title: 'Window',
            entry: 'frontend/window/index.html',
            receives: { protocolVersion: 1, locations: ['left', 'detail'], editorTargets: { protocolVersion: 1 } },
          },
        ],
      },
    }
    mkdirSync(join(root, 'frontend', 'left'), { recursive: true })
    mkdirSync(join(root, 'frontend', 'detail'), { recursive: true })
    mkdirSync(join(root, 'frontend', 'window'), { recursive: true })
    mkdirSync(join(root, 'schemas'), { recursive: true })
    for (const entry of ['frontend/left/index.html', 'frontend/detail/index.html', 'frontend/window/index.html']) {
      writeFileSync(join(root, entry), '<!doctype html>')
    }
    writeFileSync(join(root, 'schemas/item.json'), '{}')
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))

    const loaded = loadPluginDir(root)
    expect(loaded.error).toBeUndefined()
    expect(loaded.descriptor?.views).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'left', detailView: 'detail' }),
      expect.objectContaining({ id: 'detail', targetSchema: 'schemas/item.json' }),
      expect.objectContaining({
        id: 'window',
        receives: { protocolVersion: 1, locations: ['left', 'detail'], editorTargets: { protocolVersion: 1 } },
      }),
    ]))

    rmSync(join(root, 'schemas/item.json'))
    expect(loadPluginDir(root).error).toMatch(/referenced file is missing or unsafe.*schemas\/item\.json/)
  })

  it('loads a backend-only v2 package into the activation catalog', () => {
    const manifest = JSON.parse(readFixture('valid', 'backend-only-skills.json'))
    mkdirSync(join(root, 'backend'), { recursive: true })
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    const backendPath = join(root, backendEntryOnDisk('backend/navide-skills'))
    writeFileSync(backendPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    chmodSync(backendPath, 0o700)

    const loaded = loadPluginDir(root)
    expect(loaded.error).toBeUndefined()
    expect(loaded.descriptor).toBeUndefined()
    expect(loaded.activation).toMatchObject({
      pluginId: 'navide.skills',
      packageVersion: '1.0.0',
      views: [],
      backend: { protocolVersion: 1, activation: 'startup' },
    })
  })

  it('loads an installed package with camelCase backend names and no agent tools exactly as main does', () => {
    // Main's rule for backend.methods / events: the package and its views
    // load; only activation refuses the camelCase name (isMethodName). The
    // lower-case rule applies to agentTools[].method only.
    const manifest = JSON.parse(readFixture('valid', 'backend-declared-methods.json'))
    manifest.backend.methods = ['files.search', 'files.indexNow']
    manifest.backend.events = ['files.indexProgress']
    mkdirSync(join(root, 'backend'), { recursive: true })
    mkdirSync(join(root, 'frontend', 'left'), { recursive: true })
    writeFileSync(join(root, 'frontend', 'left', 'index.html'), '<!doctype html>')
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    const backendPath = join(root, backendEntryOnDisk('backend/acme-indexer'))
    writeFileSync(backendPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    chmodSync(backendPath, 0o700)

    const loaded = loadPluginDir(root)
    expect(loaded.error).toBeUndefined()
    expect(loaded.activation?.views.map((view) => view.id)).toEqual(['left'])
    expect(loaded.activation?.backend).toMatchObject({ protocolVersion: 1, activation: 'startup' })
    expect(loaded.packageSummary).toBeDefined()
    expect(isMethodName('files.indexNow')).toBe(false)
  })

  // The exec-bit arm is POSIX-only: on Windows executability is the `.exe`
  // extension, which this fixture name carries, so the mode cannot fail it.
  it.skipIf(isWindows())('rejects a non-executable backend during disk loading', () => {
    const manifest = JSON.parse(readFixture('valid', 'backend-only-skills.json'))
    mkdirSync(join(root, 'backend'), { recursive: true })
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    const backendPath = join(root, backendEntryOnDisk('backend/navide-skills'))
    writeFileSync(backendPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    chmodSync(backendPath, 0o600)

    const loaded = loadPluginDir(root)
    expect(loaded.error).toMatch(/not executable/)
    expect(loaded.activation).toBeUndefined()
  })

  it.each([
    ['empty', Buffer.alloc(0), 0o700, /empty/],
    ['shebang', Buffer.from('#!/bin/sh\n'), 0o700, /must not be a script/],
    [
      'BOM plus shebang',
      Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x21, 0x0a]),
      0o700,
      /must not be a script/,
    ],
  ])('rejects a %s backend during disk loading', (_label, content, mode, error) => {
    const manifest = JSON.parse(readFixture('valid', 'backend-only-skills.json'))
    mkdirSync(join(root, 'backend'), { recursive: true })
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    const backendPath = join(root, backendEntryOnDisk('backend/navide-skills'))
    writeFileSync(backendPath, content)
    chmodSync(backendPath, mode)

    const loaded = loadPluginDir(root)
    expect(loaded.error).toMatch(error)
    expect(loaded.activation).toBeUndefined()
  })

  it('returns an error (never throws) for a missing or invalid manifest', () => {
    expect(loadPluginDir(join(root, 'nope')).error).toBeTruthy()
    writeFileSync(join(root, 'manifest.json'), '{ not json')
    expect(loadPluginDir(root).error).toBeTruthy()
    expect(loadPluginDir(root).descriptor).toBeUndefined()
  })

  it('rejects a symlinked contribution path', () => {
    const manifest = {
      schemaVersion: 2,
      apiVersion: '^1.0.0',
      id: 'acme.viewer',
      name: 'Viewer',
      version: '1.0.0',
      publisher: 'acme',
      permissions: {},
      marketplace: { description: 'A viewer.', license: 'MIT' },
      contributes: {
        views: [
          {
            id: 'left',
            kind: 'custom',
            location: 'left',
            title: 'Viewer',
            entry: 'frontend/left/index.html',
          },
        ],
      },
    }
    mkdirSync(join(outside, 'left'), { recursive: true })
    writeFileSync(join(outside, 'left', 'index.html'), '<!doctype html>')
    symlinkSync(outside, join(root, 'frontend'))
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))

    expect(loadPluginDir(root).error).toMatch(/referenced file is missing or unsafe/)
  })
})

describe('scanInstalledPlugins', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plugins-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns [] for a non-existent root', () => {
    expect(scanInstalledPlugins(join(root, 'nope'))).toEqual([])
  })

  it('parses valid plugins and reports bad ones without throwing', () => {
    const good = join(root, 'acme.demo')
    mkdirSync(good)
    writeFileSync(join(good, 'manifest.json'), JSON.stringify(VALID))

    const bad = join(root, 'broken')
    mkdirSync(bad)
    writeFileSync(join(bad, 'manifest.json'), '{ not json')

    const scanned = scanInstalledPlugins(root)
    const ok = scanned.find((s) => s.descriptor?.id === 'acme.demo')
    const err = scanned.find((s) => s.error)
    expect(ok?.descriptor?.entryFile).toBe(join(good, 'dist/main.js'))
    expect(err?.error).toBeTruthy()
  })

  it('keeps a legacy package in an arbitrary unpacker directory when no selector exists', () => {
    const legacyDir = join(root, 'frontend-only')
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, 'manifest.json'), JSON.stringify(VALID))

    expect(scanInstalledPlugins(root)).toEqual([
      expect.objectContaining({ dir: legacyDir, descriptor: expect.objectContaining({ id: 'acme.demo' }) }),
    ])
  })

  it('loads only the exact active package selected by a valid durable selector', () => {
    const legacyDir = join(root, 'acme.demo')
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, 'manifest.json'), JSON.stringify({ ...VALID, version: '9.9.9' }))
    const selected = {
      packageVersion: '1.2.3',
      target: 'universal',
      artifactDigest: 'a'.repeat(64),
    }
    const packageDir = immutablePluginPackageDir(root, 'acme.demo', selected.packageVersion, selected.target)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify(VALID))
    new PluginActivationSelector(root).stageCandidate('acme.demo', selected)
    new PluginActivationSelector(root).activateCandidate('acme.demo')

    expect(scanInstalledPlugins(root)).toEqual([
      expect.objectContaining({
        dir: packageDir,
        descriptor: expect.objectContaining({ id: 'acme.demo', packageDir }),
      }),
    ])
  })

  it('fails closed instead of falling back to a legacy root when its lifecycle selector is unreadable', () => {
    const pluginDir = join(root, 'acme.demo')
    mkdirSync(pluginDir)
    writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(VALID))
    const selector = new PluginActivationSelector(root)
    selector.stageCandidate('acme.demo', {
      packageVersion: '1.0.0',
      target: 'universal',
      artifactDigest: 'a'.repeat(64),
    })
    writeFileSync(join(root, '.navide-lifecycle', 'acme.demo.json'), '{bad')

    expect(scanInstalledPlugins(root)).toEqual([{
      dir: pluginDir,
      error: 'plugin lifecycle selector is unreadable',
    }])
  })
})

describe('Manifest v2 filesystem scope declarations', () => {
  function scopedManifest(scopes: unknown): Record<string, any> {
    const manifest = JSON.parse(readFixture('valid', 'fs-scopes-declared.json')) as Record<string, any>
    manifest.permissions.scopes = scopes
    return manifest
  }

  it('carries the declared scopes into the installed package summary as a copy', () => {
    const manifest = parseInstalledManifest(
      JSON.parse(readFixture('valid', 'fs-scopes-declared.json'))
    )
    const summary = manifestToInstalledPackageSummary(manifest)
    const read = ['**/.acme/notes/*', '**/.acme/notes/.history/**', 'docs/*.md']
    expect(summary.manifestPermissions).toEqual({
      system: ['fs'],
      scopes: { fs: { root: 'repository', read, write: ['**/.acme/notes/*'] } },
    })
    summary.manifestPermissions!.scopes!.fs!.read!.push('mutated')
    if (!isManifestV2(manifest)) throw new Error('expected a Manifest v2 package')
    expect(manifest.permissions.scopes?.fs.read).toEqual(read)
  })

  it.each([
    [{ fs: { write: ['../outside'] } }, /manifest permissions\.scopes\.fs\.write\[0\] is not a safe relative path pattern/],
    [{ fs: { read: ['/etc'] } }, /manifest permissions\.scopes\.fs\.read\[0\] is not a safe relative path pattern/],
    [{ fs: { read: ['docs/'] } }, /manifest permissions\.scopes\.fs\.read\[0\] is not a safe relative path pattern/],
    [{ fs: { read: ['docs/a**'] } }, /manifest permissions\.scopes\.fs\.read\[0\] is not a safe relative path pattern/],
    [{ fs: { read: ['docs', '***'] } }, /manifest permissions\.scopes\.fs\.read\[1\] is not a safe relative path pattern/],
    [{ fs: { root: 'home', read: ['docs/*'] } }, /manifest permissions\.scopes\.fs\.root must be workspace or repository/],
    [{ fs: { root: 'repository' } }, /manifest permissions\.scopes\.fs must declare read or write/],
    [{ fs: { delete: ['docs'] } }, /manifest permissions\.scopes\.fs has unknown field 'delete'/],
    [{ fs: {} }, /manifest permissions\.scopes\.fs must declare read or write/],
    [{ fs: { read: [] } }, /manifest permissions\.scopes\.fs\.read must contain 1-16 item\(s\)/],
    [{ fs: { read: ['docs', 'docs'] } }, /manifest permissions\.scopes\.fs\.read must not contain duplicate items/],
    [{}, /manifest permissions\.scopes is missing required field 'fs'/],
    [{ network: { read: ['example.com'] } }, /manifest permissions\.scopes has unknown field 'network'/],
  ])('rejects malformed scope declaration %j with a field-specific error', (scopes, message) => {
    expect(() => parseInstalledManifest(scopedManifest(scopes))).toThrow(message)
  })

  it('rejects a scope declaration on an Extension Pack like any other permission', () => {
    expect(() =>
      parseInstalledManifest(JSON.parse(readFixture('invalid', 'extension-pack-with-scopes.json')))
    ).toThrow(/an extension pack must not request permissions/)
  })

  // The Plans declaration must match what its backend actually reaches:
  // - root: src/main/plugins/plansRoot.ts resolvePlansRootPath (nearest
  //   ancestor containing .git, else the workspace);
  // - documents: plugins/navide-plans/backend/plans_backend.py PLAN_DOC_DIRS
  //   and _plan_path (a document directly inside one of those directories,
  //   which may sit at any depth under the root);
  // - `.plans/<doc>`: _manual_document and _manual_write_path;
  // - read-only history: the `/.history/` branch of _manual_document.
  // When the backend's reach changes, change the manifest and this list.
  const PLANS_DOC_DIRS = [
    '.agent-team/plans',
    '.agent-team/reports',
    '.claude/loop-reports',
    '.claude/plans',
    '.cursor/plans',
    'docs/plans',
    'docs/reports',
  ]

  it('declares exactly the plan document locations the Plans backend reads and writes', () => {
    const manifest = parseInstalledManifest(
      JSON.parse(readFileSync(join(process.cwd(), 'plugins/navide-plans/manifest.json'), 'utf8'))
    )
    expect(manifestToInstalledPackageSummary(manifest).manifestPermissions).toEqual({
      system: ['fs', 'ui', 'aiCli'],
      scopes: {
        fs: {
          root: 'repository',
          read: [
            ...PLANS_DOC_DIRS.map((dir) => `**/${dir}/*`),
            ...PLANS_DOC_DIRS.map((dir) => `**/${dir}/.history/**`),
            '.plans/*',
          ],
          // Versions are written only by the backend's dedicated history
          // path, and only under the Plans directory.
          write: [
            ...PLANS_DOC_DIRS.flatMap((dir) => dir === '.agent-team/plans'
              ? [`**/${dir}/*`, `**/${dir}/.history/**`]
              : [`**/${dir}/*`]),
            '.plans/*',
          ],
        },
      },
    })
  })

  it('keeps the declared Plans document directories in step with the backend', () => {
    const backend = readFileSync(
      join(process.cwd(), 'plugins/navide-plans/backend/plans_backend.py'),
      'utf8'
    )
    const tuple = /^PLAN_DOC_DIRS: tuple\[str, \.\.\.\] = \(\n([\s\S]*?)\n\)/m.exec(backend)
    expect(tuple, 'PLAN_DOC_DIRS not found in plans_backend.py').not.toBeNull()
    expect([...tuple![1].matchAll(/"([^"]+)"/g)].map((match) => match[1])).toEqual(PLANS_DOC_DIRS)
  })

  it('leaves the descriptor, activation and capability policy unchanged by a scope declaration', () => {
    const scoped = parseInstalledManifest(
      JSON.parse(readFixture('valid', 'fs-scopes-declared.json'))
    )
    const unscopedRaw = JSON.parse(readFixture('valid', 'fs-scopes-declared.json')) as Record<string, any>
    delete unscopedRaw.permissions.scopes
    const unscoped = parseInstalledManifest(unscopedRaw)
    if (!isManifestV2(scoped) || !isManifestV2(unscoped)) throw new Error('expected Manifest v2 packages')

    expect(manifestToDescriptor(scoped, '/plugins/acme.notes')).toEqual(
      manifestToDescriptor(unscoped, '/plugins/acme.notes')
    )
    expect(manifestToActivation(scoped, '/plugins/acme.notes')).toEqual(
      manifestToActivation(unscoped, '/plugins/acme.notes')
    )
  })
})
