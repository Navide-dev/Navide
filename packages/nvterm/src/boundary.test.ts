import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// CLEAN_ROOM.md: src/ is self-contained. It may import only node: builtins
// (in tests) and other files inside src/.
const pkgRoot = join(import.meta.dirname, '..')
const srcRoot = join(pkgRoot, 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

function forbiddenImports(file: string, text: string): string[] {
  const specifiers = [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]!)
  const isTest = /\.test\.ts$/.test(file)
  return specifiers.filter((spec) => {
    if (spec.startsWith('./') || spec.startsWith('../')) {
      return relative(srcRoot, join(file, '..', spec)).startsWith('..')
    }
    if (isTest && (spec === 'vitest' || spec.startsWith('node:'))) return false
    return true
  })
}

describe('package boundary', () => {
  it('src/ imports nothing outside itself (no @xterm, no Navide code, no packages)', () => {
    const offenders = sourceFiles(srcRoot).flatMap((file) =>
      forbiddenImports(file, readFileSync(file, 'utf8')).map((spec) => `${relative(pkgRoot, file)} -> ${spec}`),
    )
    expect(offenders).toEqual([])
  })

  it('catches the imports it exists to catch', () => {
    const file = join(srcRoot, 'parser.ts')
    // Quotes are spliced in so this file's own source does not look like the imports it tests.
    const q = "'"
    expect(forbiddenImports(file, `import { Terminal } from ${q}@xterm/xterm${q}`)).toEqual(['@xterm/xterm'])
    expect(forbiddenImports(file, `import x from ${q}../../../src/renderer/src/App.vue${q}`)).toHaveLength(1)
    expect(forbiddenImports(file, `const m = await import(${q}@xterm/headless${q})`)).toEqual(['@xterm/headless'])
    expect(forbiddenImports(file, `import { a } from ${q}./screen.ts${q}`)).toEqual([])
    expect(forbiddenImports(file, `import { readFileSync } from ${q}node:fs${q}`)).toEqual(['node:fs'])
  })

  it('package.json declares no dependencies of any kind', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as Record<string, unknown>
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
      expect(pkg[field], field).toBeUndefined()
    }
  })
})
