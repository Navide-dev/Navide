import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// The plugin developer docs must keep compiling against the public SDK. Every
// ```ts / ```js block in these files is either typechecked against
// packages/plugin-sdk/src and packages/plugin-contracts/src, or carries an
// explicit marker on the line before its fence:
//
//   <!-- docs-typecheck: skip (reason) -->            not checked (legacy v1, other runtime, ...)
//   <!-- docs-typecheck: mirrors <SdkExport> -->      checked, and the block's declaration of
//                                                     <SdkExport> must be mutually assignable
//                                                     with the real SDK export (structural: a
//                                                     renamed optional property can slip through)
//   <!-- docs-typecheck: smoke-test-only (reason) --> checked; the only place definePlugin may appear
//
// A block without a marker is checked only if it imports from @navide/plugin-sdk
// or @navide/plugin-contracts; any other unmarked block fails, so a new example
// cannot silently go unchecked. `definePlugin` is not an activation path (Navide
// never calls it), so it fails in every block that is not smoke-test-only.

const repoRoot = resolve(__dirname, '../..')
const pluginDocFiles = [
  'docs/en-US/plugin-development-v2.md',
  'docs/en-US/plugin-development.md',
  'docs/en-US/marketplace-publishing.md',
  'packages/plugin-sdk/README.md',
]

const codeLanguages = new Map([
  ['ts', '.ts'],
  ['typescript', '.ts'],
  ['js', '.js'],
  ['javascript', '.js'],
])
const markerPattern = /^<!--\s*docs-typecheck:\s*(.*?)\s*-->$/
const navideImport = /\bfrom\s+['"]@navide\/plugin-(sdk|contracts)['"]/

type Marker =
  | { kind: 'none' }
  | { kind: 'skip'; reason: string }
  | { kind: 'mirrors'; exportName: string }
  | { kind: 'smoke-test-only'; reason: string }

interface DocBlock {
  doc: string
  line: number
  extension: string
  code: string
  marker: Marker
}

function parseMarker(text: string): Marker | string {
  const skip = /^skip\s+\((.+)\)$/.exec(text)
  if (skip) return { kind: 'skip', reason: skip[1] }
  const smoke = /^smoke-test-only\s+\((.+)\)$/.exec(text)
  if (smoke) return { kind: 'smoke-test-only', reason: smoke[1] }
  const mirrors = /^mirrors\s+([A-Za-z_$][\w$]*)$/.exec(text)
  if (mirrors) return { kind: 'mirrors', exportName: mirrors[1] }
  return `unknown docs-typecheck marker "${text}" (use "skip (reason)", "mirrors <SdkExport>" or "smoke-test-only (reason)")`
}

function extractBlocks(doc: string, markdown: string, problems: string[]): DocBlock[] {
  const lines = markdown.split(/\r?\n/)
  const blocks: DocBlock[] = []
  for (let index = 0; index < lines.length; index++) {
    const open = /^(\s*)(`{3,})\s*([\w-]*)\s*$/.exec(lines[index])
    if (!open) continue
    const [, indent, fence, language] = open
    let end = index + 1
    while (end < lines.length && lines[end].trim() !== fence) end++
    const extension = codeLanguages.get(language.toLowerCase())
    if (extension) {
      let previous = index - 1
      while (previous >= 0 && lines[previous].trim() === '') previous--
      const markerText = previous >= 0 ? markerPattern.exec(lines[previous].trim())?.[1] : undefined
      const parsed: Marker | string = markerText === undefined ? { kind: 'none' } : parseMarker(markerText)
      if (typeof parsed === 'string') problems.push(`${doc}:${index + 1}: ${parsed}`)
      const code = lines.slice(index + 1, end).map((line) => line.startsWith(indent) ? line.slice(indent.length) : line).join('\n')
      blocks.push({ doc, line: index + 1, extension, code, marker: typeof parsed === 'string' ? { kind: 'none' } : parsed })
    }
    index = end
  }
  return blocks
}

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowJs: true,
  checkJs: true,
  resolveJsonModule: true,
  esModuleInterop: true,
  types: [],
  baseUrl: repoRoot,
  paths: {
    '@navide/plugin-sdk': ['packages/plugin-sdk/src/index.ts'],
    '@navide/plugin-contracts': ['packages/plugin-contracts/src/index.ts'],
  },
}

/** Returns one message per violation; an empty list means the docs are current. */
function checkDocExamples(docs: { path: string; markdown: string }[]): { problems: string[]; checked: number } {
  const problems: string[] = []
  const virtualFiles = new Map<string, { block: DocBlock; source: string }>()
  for (const { path, markdown } of docs) {
    for (const block of extractBlocks(path, markdown, problems)) {
      const where = `${block.doc}:${block.line}`
      if (/\bdefinePlugin\b/.test(block.code) && block.marker.kind !== 'smoke-test-only') {
        problems.push(`${where}: uses definePlugin, which Navide never calls; use the view factories (createPluginCapabilityClient, ...) or mark the block "<!-- docs-typecheck: smoke-test-only (reason) -->"`)
      }
      if (block.marker.kind === 'skip') continue
      if (block.marker.kind === 'none' && !navideImport.test(block.code)) {
        problems.push(`${where}: example neither imports from @navide/plugin-sdk / @navide/plugin-contracts nor carries a "<!-- docs-typecheck: skip (reason) -->" marker`)
        continue
      }
      let source = block.code
      if (block.marker.kind === 'mirrors') {
        const name = block.marker.exportName
        source += `\nimport type { ${name} as __DocsReal } from '@navide/plugin-sdk'\n` +
          `declare const __docsReal: __DocsReal\ndeclare const __docsDoc: ${name}\n` +
          `export const __docsToDoc: ${name} = __docsReal\nexport const __docsToReal: __DocsReal = __docsDoc\n`
      }
      // TypeScript hands the host forward-slash paths on every platform, so the keys must match.
      const fileName = join(repoRoot, '.docs-typecheck', `${block.doc.replace(/[^\w]+/g, '_')}_L${block.line}${block.extension}`).replace(/\\/g, '/')
      virtualFiles.set(fileName, { block, source })
    }
  }

  const host = ts.createCompilerHost(compilerOptions, true)
  const readFile = host.readFile.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.fileExists = (fileName) => virtualFiles.has(fileName) || ts.sys.fileExists(fileName)
  host.readFile = (fileName) => virtualFiles.get(fileName)?.source ?? readFile(fileName)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const virtual = virtualFiles.get(fileName)
    return virtual
      ? ts.createSourceFile(fileName, virtual.source, languageVersion, true)
      : getSourceFile(fileName, languageVersion, onError, shouldCreate)
  }
  const program = ts.createProgram([...virtualFiles.keys()], compilerOptions, host)
  const diagnostics = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]
  for (const fileName of virtualFiles.keys()) {
    const sourceFile = program.getSourceFile(fileName)!
    diagnostics.push(...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile))
  }
  for (const diagnostic of diagnostics) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    const virtual = diagnostic.file ? virtualFiles.get(diagnostic.file.fileName) : undefined
    if (!virtual || diagnostic.start === undefined) {
      problems.push(`${diagnostic.file?.fileName ?? 'compiler'}: TS${diagnostic.code} ${message}`)
      continue
    }
    const { line } = diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start)
    const blockLines = virtual.block.code.split('\n').length
    const where = line < blockLines
      ? `${virtual.block.doc}:${virtual.block.line + 1 + line}`
      : `${virtual.block.doc}:${virtual.block.line} (mirrors ${virtual.block.marker.kind === 'mirrors' ? virtual.block.marker.exportName : ''})`
    problems.push(`${where}: TS${diagnostic.code} ${message}`)
  }
  return { problems, checked: virtualFiles.size }
}

describe('plugin developer doc examples', () => {
  it('typecheck against the public SDK and avoid the non-working definePlugin entry', () => {
    const docs = pluginDocFiles.map((path) => ({ path, markdown: readFileSync(join(repoRoot, path), 'utf8') }))
    const { problems, checked } = checkDocExamples(docs)
    expect(problems).toEqual([])
    // Guards the guard: a parser regression that finds no blocks must not pass.
    expect(checked).toBeGreaterThanOrEqual(3)
  }, 60_000)

  it('rejects removed APIs, definePlugin activation, unmarked fragments and drifted mirrors', () => {
    const fence = '```'
    const markdown = [
      `${fence}ts`,
      `import { createPluginContext } from '@navide/plugin-sdk'`,
      `createPluginContext()`,
      fence,
      `${fence}ts`,
      `import { definePlugin } from '@navide/plugin-sdk'`,
      `export default definePlugin(() => {})`,
      fence,
      `${fence}js`,
      `window.nav.ready()`,
      fence,
      '<!-- docs-typecheck: mirrors PluginBackendClient -->',
      `${fence}ts`,
      `import type { JsonValue } from '@navide/plugin-sdk'`,
      `interface PluginBackendClient { call(name: string, args: JsonValue): Promise<JsonValue> }`,
      fence,
      '<!-- docs-typecheck: skip -->',
      `${fence}ts`,
      `anything()`,
      fence,
    ].join('\n')
    const { problems } = checkDocExamples([{ path: 'sample.md', markdown }])
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/^sample\.md:2: TS\d+ .*createPluginContext/),
      expect.stringMatching(/^sample\.md:5: uses definePlugin/),
      expect.stringMatching(/^sample\.md:9: example neither imports/),
      expect.stringMatching(/^sample\.md:13 \(mirrors PluginBackendClient\): TS\d+ /),
      expect.stringMatching(/^sample\.md:18: unknown docs-typecheck marker "skip"/),
    ]))
  }, 60_000)
})
