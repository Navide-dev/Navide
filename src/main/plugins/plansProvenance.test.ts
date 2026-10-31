import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendPlansProvenanceQuery, FrontendPluginManager, registerBundledPlans } from './frontendPluginManager'
import { backendEntryOnDisk, loadPluginDir } from './installedPlugins'

const PLANS_BACKEND = backendEntryOnDisk('backend/navide-plans')

function packageFixture(directory: string): string {
  mkdirSync(join(directory, 'frontend/left'), { recursive: true })
  mkdirSync(join(directory, 'frontend/window'), { recursive: true })
  mkdirSync(join(directory, 'backend'), { recursive: true })
  writeFileSync(join(directory, 'manifest.json'), readFileSync('plugins/navide-plans/manifest.json'))
  writeFileSync(join(directory, 'frontend/left/index.html'), '<!doctype html>')
  writeFileSync(join(directory, 'frontend/window/index.html'), '<!doctype html>')
  // A tiny stand-in with the executable bit: the provenance scan only stats
  // the entry, and copying the real Node binary into every fixture is slow.
  writeFileSync(join(directory, PLANS_BACKEND), Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  chmodSync(join(directory, PLANS_BACKEND), 0o700)
  return realpathSync(directory)
}

describe('Plans Host provenance query', () => {
  it.each(['official-registry', 'factory-bundled'] as const)('reports installed catalog selection independently of %s acquisition', async (provenance) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'plans-provenance-')))
    const manager = new FrontendPluginManager()
    try {
      const installedDirectory = packageFixture(join(root, 'installed'))
      packageFixture(join(root, 'dist-plugins/navide-plans'))
      const scanned = loadPluginDir(installedDirectory)
      expect(scanned.error).toBeUndefined()
      manager.registerInstalledPackage({ ...scanned.packageSummary!, provenance }, scanned.descriptor!, { official: true })
      expect(registerBundledPlans(manager, {
        isPackaged: false,
        resourcesPath: '',
        artifactVersion: '1.1.0',
        devRoot: root,
        installedActivation: { ...scanned.activation!, provenance },
      })).toEqual({ registered: true })
      expect(manager.getPlansProvenance()).toMatchObject({
        descriptorSource: 'installed-catalog', selectionOrigin: 'installed-catalog',
        acquisitionProvenance: provenance, packageDirectory: installedDirectory,
        packageVersion: '1.1.0', frontendEntry: join(installedDirectory, 'frontend/left/index.html'),
        backendExecutable: join(installedDirectory, PLANS_BACKEND),
        frontendEntries: { 'navide.plans.window': join(installedDirectory, 'frontend/window/index.html') },
      })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('selects the factory frontend and exact backend tuple with an empty catalog', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'plans-provenance-')))
    const manager = new FrontendPluginManager()
    try {
      const directory = packageFixture(join(
        root,
        'dist-plugins',
        'official-artifacts/factory-resources/navide.plans/1.1.0',
        `${process.platform}-${process.arch}`,
        'package',
      ))
      expect(registerBundledPlans(manager, {
        isPackaged: false,
        resourcesPath: '',
        artifactVersion: '1.1.0',
        devRoot: root,
      })).toEqual({ registered: true })
      expect(manager.getPlansProvenance()).toMatchObject({
        descriptorSource: 'factory-bundle', selectionOrigin: 'factory-bundle',
        acquisitionProvenance: 'factory-bundled', packageDirectory: directory,
        packageVersion: '1.1.0', backendExecutable: join(directory, PLANS_BACKEND),
      })
      manager.replaceBuiltinForRecovery({ id: 'navide.plans', requires: [], devUrl: '', entryFile: '/legacy.html' })
      expect(manager.getPlansProvenance()).toMatchObject({ selectionOrigin: 'host-bundled', backendExecutable: null })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a same-version backend from a different package directory', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'plans-provenance-')))
    const manager = new FrontendPluginManager()
    try {
      const selected = loadPluginDir(packageFixture(join(root, 'selected')))
      const other = loadPluginDir(packageFixture(join(root, 'other')))
      manager.registerInstalledPackage({ ...selected.packageSummary!, provenance: 'official-registry' }, selected.descriptor!, { official: true })
      expect(registerBundledPlans(manager, {
        isPackaged: false,
        resourcesPath: '',
        artifactVersion: '1.1.0',
        devRoot: root,
        installedActivation: other.activation!,
      })).toEqual({
        registered: false,
        reason: 'selected installed Plans backend activation rejected: Backend activation does not match the selected package descriptor.',
      })
      expect(manager.getPlansProvenance()?.backendExecutable).toBeNull()
      expect(manager.getPlansProvenance()?.packageDirectory).toBe(selected.descriptor?.packageDir)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports the selected descriptor rather than equating equal versions with equal packages', () => {
    const manager = new FrontendPluginManager()
    manager.registerInstalledPackage({
      id: 'navide.plans', packageVersion: '2.0.0', requires: [], provenance: 'official-registry',
    }, {
      id: 'navide.plans', packageVersion: '2.0.0', packageDir: process.cwd(),
      requires: [], devUrl: '', entryFile: `${process.cwd()}/installed.html`,
    }, { official: true })
    manager.registerDescriptor({
      id: 'navide.plans', packageVersion: '2.0.0', packageDir: '/different-package',
      requires: [], devUrl: '', entryFile: '/different-package/frontend.html',
    }, { builtin: true })
    expect(manager.getPlansProvenance()).toMatchObject({
      descriptorSource: 'host-bundled', selectionOrigin: 'host-bundled',
      packageVersion: '2.0.0', packageDirectory: null,
      frontendEntry: '/different-package/frontend.html', backendExecutable: null,
      acquisitionProvenance: null,
    })
  })

  it('adds the Host-selected package identity without changing launch parameters', () => {
    const query = appendPlansProvenanceQuery(
      '?workspace_path=%2Fworkspace&contribution=window',
      '0.1.93',
      'factory-dev',
    )
    const params = new URLSearchParams(query)

    expect(params.get('workspace_path')).toBe('/workspace')
    expect(params.get('contribution')).toBe('window')
    expect(params.get('plans_package_version')).toBe('0.1.93')
    expect(params.get('plans_package_source')).toBe('factory-dev')
  })

  it('overrides caller-supplied provenance values with the Host selection', () => {
    const params = new URLSearchParams(appendPlansProvenanceQuery(
      '?plans_package_version=spoofed&plans_package_source=spoofed',
      '0.1.93',
      'official-registry',
    ))

    expect(params.get('plans_package_version')).toBe('0.1.93')
    expect(params.get('plans_package_source')).toBe('official-registry')
  })
})
