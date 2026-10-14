import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const publicVueRoot = join(repositoryRoot, 'packages/plugin-ui/src')
const pluginRoot = join(repositoryRoot, 'plugins/navide-git/src')

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|vue)$/.test(entry.name) ? [path] : []
  })
}

function importSpecifiers(source: string): string[] {
  const script = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true)
  const imports: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ) imports.push(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
    ) imports.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(script)
  return imports
}

// Parsing is the CPU-bound part of these scans. A file whose text never
// mentions a forbidden specifier cannot import it, so only those are parsed.
function importSpecifiersMentioning(path: string, needles: readonly string[]): string[] {
  const source = readFileSync(path, 'utf8')
  return needles.some((needle) => source.includes(needle)) ? importSpecifiers(source) : []
}

describe('public Vue plugin ownership boundary', () => {
  it('publishes explicit shared and foundation subpaths', () => {
    const manifest = JSON.parse(
      readFileSync(join(repositoryRoot, 'packages/plugin-ui/package.json'), 'utf8'),
    ) as { exports: Record<string, unknown> }

    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './editor',
      './file-picker',
      './foundation',
      './shared',
      './styles.css',
    ])
  })

  it('keeps the public Vue package independent from Host implementation paths', () => {
    for (const path of sourceFiles(publicVueRoot)) {
      const imports = importSpecifiersMentioning(path, ['@navide/plugin-ui/shared', 'src/renderer', 'electron'])
      expect(imports, relative(repositoryRoot, path)).not.toContain('@navide/plugin-ui/shared')
      expect(
        imports.some((specifier) => specifier.includes('src/renderer')),
        relative(repositoryRoot, path),
      ).toBe(false)
      expect(
        imports.some((specifier) => specifier === 'electron'),
        relative(repositoryRoot, path),
      ).toBe(false)
    }
  })

  it('limits navide.git to public packages and package-local Git modules', () => {
    const forbidden = [
      '@navide/terminal',
      '@navide/plugin-shell',
      '@navide/git-feature',
    ]
    for (const path of sourceFiles(pluginRoot)) {
      const imports = importSpecifiersMentioning(path, [...forbidden, 'src/renderer'])
      for (const specifier of imports) {
        expect(
          forbidden.includes(specifier),
          `${relative(repositoryRoot, path)}: ${specifier}`,
        ).toBe(false)
        expect(
          specifier.includes('src/renderer'),
          `${relative(repositoryRoot, path)}: ${specifier}`,
        ).toBe(false)
      }
    }
  })
})
