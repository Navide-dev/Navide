// Two directories can claim one plugin id. Being on a newer API major is a
// verdict on one directory, so it must not take down the other.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrontendPluginManager } from './frontendPluginManager'
import type { InstalledRegistryTrustContext } from './pluginInstalledTrust'

vi.mock('./pluginInstalledTrust', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pluginInstalledTrust')>()),
  verifyInstalledRegistryPackage: () => ({ action: 'allow', artifactDigest: 'a'.repeat(64) }),
}))

const PLUGIN_ID = 'acme.dup'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writePackage(root: string, directory: string, version: string, apiVersion: string): string {
  const dir = join(root, directory)
  mkdirSync(join(dir, 'frontend'), { recursive: true })
  writeFileSync(join(dir, 'frontend', 'index.html'), '<!doctype html>')
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2,
    apiVersion,
    id: PLUGIN_ID,
    name: 'Duplicate',
    version,
    publisher: 'acme',
    permissions: {},
    marketplace: { description: 'Duplicate id test plugin', license: 'MIT' },
    contributes: {
      views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Duplicate', entry: 'frontend/index.html' }],
    },
  }))
  return dir
}

function load(root: string): { manager: FrontendPluginManager; result: ReturnType<FrontendPluginManager['loadInstalledPlugins']> } {
  const manager = new FrontendPluginManager()
  const trust = {} as InstalledRegistryTrustContext
  return { manager, result: manager.loadInstalledPlugins(root, { provenance: 'official-registry', trust }) }
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'navide-api-duplicate-'))
  roots.push(root)
  return root
}

describe('one plugin id in two directories', () => {
  it.each([
    ['sorted first', 'a-future', 'b-today'],
    ['sorted last', 'z-future', 'b-today'],
  ])('loads the ^1 package when the ^2 one is %s', (_label, blockedDir, runnableDir) => {
    const root = tempRoot()
    writePackage(root, blockedDir, '2.0.0', '^2.0.0')
    writePackage(root, runnableDir, '1.0.0', '^1.0.0')

    const { manager, result } = load(root)

    expect(result.loaded).toEqual([PLUGIN_ID])
    expect(result.activationCatalog.filter((entry) => entry.pluginId === PLUGIN_ID)).toHaveLength(1)
    expect(manager.getDescriptor(PLUGIN_ID)?.packageVersion).toBe('1.0.0')
    expect(manager.listInstalledPackages()).toMatchObject([{ id: PLUGIN_ID, packageVersion: '1.0.0' }])
    expect(manager.listInstalledPackages()[0].warning).toBeUndefined()
    expect(result.errors).toEqual([expect.stringContaining('requires plugin API ^2.0.0')])
  })

  it('still refuses two directories that can both run', () => {
    const root = tempRoot()
    writePackage(root, 'a', '1.0.0', '^1.0.0')
    writePackage(root, 'b', '1.1.0', '^1.0.0')

    const { manager, result } = load(root)

    expect(result.loaded).toEqual([])
    expect(result.errors).toEqual([expect.stringContaining('duplicate plugin packages')])
    expect(manager.getDescriptor(PLUGIN_ID)).toBeUndefined()
  })

  it('still refuses two directories that are both blocked', () => {
    const root = tempRoot()
    writePackage(root, 'a', '2.0.0', '^2.0.0')
    writePackage(root, 'b', '2.1.0', '^2.0.0')

    const { result } = load(root)

    expect(result.loaded).toEqual([])
    expect(result.errors).toContainEqual(expect.stringContaining('duplicate plugin packages'))
  })
})
