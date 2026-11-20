import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname)
const repositoryRoot = resolve(root, '../../..')
function sources(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? sources(path) : /\.(ts|vue)$/.test(path) ? [path] : []
  })
}

describe('public editor ownership', () => {
  it('exposes an explicit editor subpath without a private Host graph', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, '../package.json'), 'utf8'))
    expect(manifest.exports['./editor']).toEqual({
      types: './dist/editor/index.d.ts', import: './dist/editor/index.js',
    })
    expect(existsSync(resolve(root, 'editor/EditorPane.vue'))).toBe(true)
  })

  it('keeps a single implementation and makes consumers use the editor export', () => {
    expect(existsSync(resolve(repositoryRoot, 'src/renderer/src/editor/EditorPane.vue'))).toBe(false)
    expect(existsSync(resolve(repositoryRoot, 'src/renderer/src/editor/view/EditorViewMonaco.vue'))).toBe(false)
    for (const path of sources(resolve(repositoryRoot, 'src/renderer'))) {
      if (/\.test\.ts$|__tests__/.test(path)) continue
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)['"]/g)) {
        const specifier = match[1]
        expect(specifier, relative(repositoryRoot, path)).not.toMatch(/@navide\/plugin-ui\/(?:src\/|editor\/)/)
        if (!specifier.startsWith('.')) continue
        expect(resolve(dirname(path), specifier).startsWith(resolve(root, 'editor') + sep), `${path}: ${specifier}`).toBe(false)
      }
    }
  })

  it('keeps editor implementation independent of Host transports and application state', () => {
    for (const path of sources(resolve(root, 'editor'))) {
      if (/\.test\.ts$|__tests__/.test(path)) continue
      const source = readFileSync(path, 'utf8')
      expect(source, relative(root, path)).not.toMatch(/useBackend|window\.(nav|agentTeam)|WebSocket|diagnosticsStore/)
      for (const match of source.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)['"]/g)) {
        const specifier = match[1]
        expect(specifier, relative(root, path)).not.toMatch(/src\/renderer|@navide\/(terminal|plugin-shell)/)
        if (!specifier.startsWith('.')) continue
        expect(resolve(dirname(path), specifier).startsWith(root + sep), `${path}: ${specifier}`).toBe(true)
      }
    }
  })
})
