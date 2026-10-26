import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { createVitest } from 'vitest/node'
import { describe, expect, it } from 'vitest'
import { repositoryTestFiles } from '../support/testInventory'

// A test that starts the real Marketplace Registry skips without its Python
// env (marketplace/registry/.venv). Of the Vitest jobs, only Frontend tests
// installs that env and sets NAVIDE_REGISTRY_E2E_REQUIRED=1 (ci.yml), and it
// runs the unit project. A Registry test elsewhere, or one that ignores the
// flag, would skip on CI and look green.

const SELF = resolve(__filename)

/** The source without its comments (line and block); string and template
 *  literals are kept as they are, so a `//` inside a URL stays code. Known
 *  limit: regex literals are not parsed, so a quote or `//` inside one can
 *  make the rest of that line read as a string or a comment. */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      out += ' '
    } else if (c === '"' || c === "'" || c === '`') {
      const start = i++
      while (i < source.length && source[i] !== c) i += source[i] === '\\' ? 2 : 1
      out += source.slice(start, ++i)
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Whether code (comments stripped) starts the Registry or runs from its
 *  Python env, however the module name or the env path is put together. */
function startsRegistry(code: string): boolean {
  return /registry\.app\b/.test(code) || /\buvicorn\b/.test(code) ||
    (/marketplace/.test(code) && /registry/.test(code) && /\.venv\b/.test(code))
}

// Read from the environment in code, not only named in a comment.
const READS_FLAG = /process\.env(\.NAVIDE_REGISTRY_E2E_REQUIRED\b|\[\s*['"]NAVIDE_REGISTRY_E2E_REQUIRED['"]\s*\])/

/** The relative imports of a module (static, dynamic, re-exports). */
function relativeImports(code: string): string[] {
  const found: string[] = []
  for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g)) found.push(match[2])
  return found
}

interface Sources {
  /** The code (comments stripped) of a module, by absolute path; undefined when it is not there. */
  code(path: string): string | undefined
}

/** A relative import resolved to the module file it names, if that file exists. */
function resolveImport(from: string, specifier: string, sources: Sources): string | undefined {
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, resolve(base, 'index.ts')]) {
    if (candidate.endsWith('.ts') && sources.code(candidate) !== undefined) return candidate
  }
  return undefined
}

/** The modules that start the Registry for `test`: the test itself, or any
 *  helper it imports, directly or through other helpers. */
function registryStarters(test: string, sources: Sources): string[] {
  const starters: string[] = []
  const seen = new Set<string>()
  const visit = (path: string): void => {
    if (seen.has(path)) return
    seen.add(path)
    const code = sources.code(path)
    if (code === undefined) return
    if (startsRegistry(code)) starters.push(path)
    for (const specifier of relativeImports(code)) {
      const target = resolveImport(path, specifier, sources)
      if (target) visit(target)
    }
  }
  visit(test)
  return starters
}

/** What is wrong with the repository's Registry tests: every module that starts
 *  the Registry must read the flag itself, and every test that starts it (or
 *  imports a helper that does) must run in the unit project. */
function registryProblems(
  tests: readonly string[],
  sources: Sources,
  projectOf: (test: string) => string | undefined,
  name: (path: string) => string,
): string[] {
  const problems = new Set<string>()
  for (const test of tests) {
    const starters = registryStarters(test, sources)
    if (starters.length === 0) continue
    for (const starter of starters) {
      if (!READS_FLAG.test(sources.code(starter)!)) {
        problems.add(`${name(starter)}: starts the Registry but never reads NAVIDE_REGISTRY_E2E_REQUIRED, so a missing env skips it`)
      }
    }
    const project = projectOf(test)
    if (project !== 'unit') {
      problems.add(`${name(test)}: starts the Registry in the ${project ?? 'no'} project; only the unit project runs where the Registry env is installed`)
    }
  }
  return [...problems]
}

/** The repository's modules, read once each. */
function diskSources(): Sources {
  const cache = new Map<string, string | undefined>()
  return {
    code(path) {
      if (!cache.has(path)) cache.set(path, existsSync(path) ? stripComments(readFileSync(path, 'utf8')) : undefined)
      return cache.get(path)
    },
  }
}

/** The same over an in-memory set of modules. */
function memorySources(files: Record<string, string>): Sources {
  return { code: (path) => (path in files ? stripComments(files[path]) : undefined) }
}

describe('tests that start the Marketplace Registry', () => {
  it('read NAVIDE_REGISTRY_E2E_REQUIRED and run in the unit project', async () => {
    const root = process.cwd()
    const sources = diskSources()
    const tests = repositoryTestFiles(root).map((file) => resolve(file)).filter((file) => file !== SELF)
    // Found the ones known today, wherever they live: a scanner that finds
    // nothing checks nothing.
    const found = tests.filter((test) => registryStarters(test, sources).length > 0)
    expect(found.map((file) => basename(file))).toEqual(expect.arrayContaining([
      'pluginRegistry.e2e.test.ts',
      'pluginB2Registry.e2e.test.ts',
    ]))

    const runner = await createVitest('test', { watch: false, config: 'vitest.config.ts' })
    try {
      const owner = new Map((await runner.globTestSpecifications())
        .map((specification) => [resolve(specification.moduleId), specification.project.name]))
      expect(registryProblems(found, sources, (test) => owner.get(test), (path) => relative(root, path))).toEqual([])
    } finally {
      await runner.close()
    }
  }, 30_000)

  describe('the guard itself', () => {
    const GUARD = "if (process.env.NAVIDE_REGISTRY_E2E_REQUIRED === '1') throw new Error('no Registry env')"
    const unit = (): string => 'unit'
    // Paths as the platform resolves them, so the same cases hold on Windows.
    const ROOT = resolve('/repo')
    const problems = (files: Record<string, string>, project: (test: string) => string = unit): string[] => {
      const absolute = Object.fromEntries(Object.entries(files).map(([path, code]) => [resolve(ROOT, path), code]))
      const tests = Object.keys(absolute).filter((file) => file.endsWith('.test.ts'))
      return registryProblems(tests, memorySources(absolute), project, (path) => relative(ROOT, path).split('\\').join('/'))
    }

    it('strips line and block comments, never a // inside a string', () => {
      expect(stripComments("a // registry.app:app\nb")).toBe('a \nb')
      expect(stripComments('a /* uvicorn\nregistry.app */ b')).toBe('a   b')
      expect(stripComments("const url = 'http://127.0.0.1/x' // note")).toBe("const url = 'http://127.0.0.1/x' ")
      expect(stripComments('const t = `a // b ${1}` /* c */')).toBe('const t = `a // b ${1}`  ')
      expect(stripComments("'it\\'s // kept'")).toBe("'it\\'s // kept'")
    })

    it('finds a launch however the module name or the env path is written', () => {
      for (const code of [
        "spawn(python, ['-m', 'uvicorn', 'registry.app:app'])",
        "spawn(python, ['-m', 'uvicorn', 'registry.app' + ':app'])",
        "const app = ['registry', 'app'].join('.'); spawn(python, ['-m', 'uvicorn', app])",
        "join(resolve(__dirname, '../../marketplace/registry'), '.venv', 'bin', 'python')",
        "join(root, 'marketplace', 'registry', '.venv', 'bin', 'python')",
      ]) expect(startsRegistry(stripComments(code)), code).toBe(true)
      for (const code of [
        '// Same ids as marketplace/registry/tests/test_web_identity.py.',
        '/* spawn uvicorn registry.app:app from marketplace/registry/.venv */',
        "const registry = new Map(); const market = 'marketplace'",
      ]) expect(startsRegistry(stripComments(code)), code).toBe(false)
    })

    it('accepts a Registry test in unit that reads the flag', () => {
      expect(problems({ 'a.test.ts': `spawn('registry.app:app')\n${GUARD}` })).toEqual([])
      expect(problems({ 'a.test.ts': "spawn('registry.app:app')\nprocess.env['NAVIDE_REGISTRY_E2E_REQUIRED']" })).toEqual([])
    })

    it('refuses a Registry test that only names the flag in a comment', () => {
      for (const comment of [
        '// NAVIDE_REGISTRY_E2E_REQUIRED=1 makes it fail',
        '// see process.env.NAVIDE_REGISTRY_E2E_REQUIRED',
        '/* process.env.NAVIDE_REGISTRY_E2E_REQUIRED */',
      ]) {
        expect(problems({ 'a.test.ts': `spawn('registry.app:app')\n${comment}` }), comment)
          .toEqual(['a.test.ts: starts the Registry but never reads NAVIDE_REGISTRY_E2E_REQUIRED, so a missing env skips it'])
      }
    })

    it('refuses a launch assembled from pieces that never reads the flag', () => {
      const code = "spawn(join(root, 'marketplace', 'registry', '.venv', 'bin', 'python'), ['-m', 'uvicorn', 'registry.app' + ':app'])"
      expect(problems({ 'a.test.ts': code })).toHaveLength(1)
      expect(problems({ 'a.test.ts': `${code}\n${GUARD}` })).toEqual([])
    })

    it('refuses a Registry test outside the unit project', () => {
      expect(problems({ 'a.test.ts': `spawn('registry.app:app')\n${GUARD}` }, () => 'artifacts'))
        .toEqual(['a.test.ts: starts the Registry in the artifacts project; only the unit project runs where the Registry env is installed'])
    })

    it('holds a shared helper that starts the Registry to the flag, and its tests to the unit project', () => {
      const helper = "export function startRegistry() { return spawn(python, ['-m', 'uvicorn', 'registry.app:app']) }"
      const test = "import { startRegistry } from '../support/registry'\nstartRegistry()"
      // The helper never reads the flag: refused, wherever its test runs.
      expect(problems({ 'support/registry.ts': helper, 'plugins/a.test.ts': test }))
        .toEqual(['support/registry.ts: starts the Registry but never reads NAVIDE_REGISTRY_E2E_REQUIRED, so a missing env skips it'])
      // It reads it: fine in unit, refused elsewhere.
      const guarded = { 'support/registry.ts': `${helper}\n${GUARD}`, 'plugins/a.test.ts': test }
      expect(problems(guarded)).toEqual([])
      expect(problems(guarded, () => 'artifacts')).toEqual([
        'plugins/a.test.ts: starts the Registry in the artifacts project; only the unit project runs where the Registry env is installed',
      ])
      // Through another helper, and through index.ts.
      expect(problems({
        'support/registry/index.ts': helper,
        'support/e2e.ts': "export * from './registry'",
        'plugins/a.test.ts': "import { startRegistry } from '../support/e2e'",
      })).toEqual(['support/registry/index.ts: starts the Registry but never reads NAVIDE_REGISTRY_E2E_REQUIRED, so a missing env skips it'])
      // A test that imports an unrelated helper is not a Registry test.
      expect(problems({ 'support/other.ts': 'export const x = 1', 'plugins/a.test.ts': "import { x } from '../support/other'" }, () => 'artifacts'))
        .toEqual([])
    })
  })
})
