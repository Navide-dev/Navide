import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadPluginDir } from '../../../src/main/plugins/installedPlugins'
import { parseManifestV2 } from '../../../src/main/plugins/pluginManifestV2'

const sourceDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const stagedDir = resolve(fileURLToPath(new URL('../../../dist-plugins/navide-mini-ide/', import.meta.url)))
const expectedMarketplace = {
  description: 'Edit workspace files, review changes and run AI CLI sessions in an independent IDE window.',
  license: 'MIT',
  repository: 'https://github.com/Navide-dev/Navide',
  categories: ['productivity', 'development'],
}

function readManifest(directory: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${directory}/manifest.json`, 'utf8')) as Record<string, unknown>
}

function expectMiniIdeManifest(directory: string, version?: string): void {
  const parsed = parseManifestV2(readManifest(directory))
  expect(parsed.id).toBe('navide.mini-ide')
  expect(parsed.marketplace).toEqual(expectedMarketplace)
  const view = parsed.contributes?.views?.find((candidate) => candidate.id === 'window')
  expect(view).toMatchObject({
    id: 'window', kind: 'custom', location: 'window',
    entry: 'frontend/window/index.html',
  })
  if (version) expect(parsed.version).toBe(version)

  const scanned = loadPluginDir(directory)
  expect(scanned.error).toBeUndefined()
  expect(scanned.descriptor).toMatchObject({
    id: 'navide.mini-ide', packageDir: directory,
    entryFile: join(directory, 'frontend/window/index.html'), devUrl: '',
  })
}

describe('navide.mini-ide manifest', () => {
  it('validates the checked-in source manifest through the production parser and loader', () => {
    expectMiniIdeManifest(sourceDir, '0.1.0')
  })

  it('validates the actual staged v2 build manifest through the production loader', () => {
    expect(existsSync(join(stagedDir, 'manifest.json'))).toBe(true)
    expect(existsSync(join(stagedDir, 'frontend/window/index.html'))).toBe(true)
    expectMiniIdeManifest(stagedDir)
  })
})
