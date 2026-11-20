import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// A ratchet over the TS test tree, the shape backend/tests/test_osplat.py
// keeps over the product: a regex, an allowlist of today's offenders, a test
// that fails on new ones with the fix named, and a test that fails when an
// allowlist entry has become clean so the list can only shrink.
//
// The bug it guards: a test that mocks `node:fs` seeds its fake filesystem
// with a path written as a POSIX literal while the module under test builds
// the same path with `join()`. On macOS and Linux the two spellings agree; on
// Windows `join()` produces backslashes and the literal never matches, so the
// module reads an empty cache and the assertions fail — which is how
// `permissions.test.ts` went red on the Windows job the day it joined the
// gate (fixed in #69). Not a ban on forward slashes: a POSIX literal handed to
// a pure function, or used as inert fixture text, is fine and there are
// hundreds of those. The rule fires only on the shapes that become a fake-fs
// key — a declared path constant, or a literal returned from a mock such as
// `app.getPath` — inside a file that mocks `node:fs`.

const REPO_ROOT = resolve(__dirname, '..', '..')

// The vitest include globs, as directories to walk.
const TEST_DIRS = [
  'src',
  'packages/plugin-sdk/src',
  'packages/plugin-ui/src',
  'tests',
]
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'dist-plugins', '.git'])

function testFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      // This file quotes the shapes it bans; it is not a fake-fs test.
      else if (/\.(test|spec)\.tsx?$/.test(name) && full !== __filename) found.push(full)
    }
  }
  for (const dir of TEST_DIRS) walk(join(REPO_ROOT, dir))
  return found.sort()
}

/** Files whose fake filesystem is a `vi.mock('node:fs…')` factory. */
const MOCKS_FS_RE = /vi\.mock\(\s*['"]node:fs(?:\/promises)?['"]/
/** A tests/support/noFsync.ts factory only stubs the flush: the filesystem stays real. */
const FLUSH_ONLY_MOCK_RE = /\.without(?:FsyncSync|HandleSync)\(/g

const POSIX_ROOTS = '(?:tmp|usr|bin|etc|opt|var|home|Users|private|Applications)'
/**
 * The shapes that turn a POSIX literal into a fake-fs key:
 *  - a declared constant: `const CACHE = '/tmp/x/permissions.json'`
 *  - a literal returned from a mock: `getPath: () => '/tmp/x'`
 *  - a literal used directly as a Map key: `files.set('/tmp/x', …)`
 */
export const FAKE_FS_LITERAL_KEY_RE = new RegExp(
  [
    `\\b(?:const|let|var)\\s+\\w+(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*['"\`]/${POSIX_ROOTS}/`,
    `=>\\s*['"\`]/${POSIX_ROOTS}/`,
    `\\.(?:set|get|has|delete)\\(\\s*['"\`]/${POSIX_ROOTS}/`,
  ].join('|')
)

/** Offenders today, each with why it is acceptable. Empty: the one there
 *  was, `src/main/permissions.test.ts`, now builds its key with `join()`. */
export const FAKE_FS_LITERAL_KEY_ALLOWLIST: ReadonlySet<string> = new Set()

function offenders(files: string[]): Set<string> {
  const out = new Set<string>()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (!MOCKS_FS_RE.test(text)) continue
    const fsMocks = text.match(new RegExp(MOCKS_FS_RE.source, 'g'))?.length ?? 0
    if (fsMocks === (text.match(FLUSH_ONLY_MOCK_RE)?.length ?? 0)) continue
    if (FAKE_FS_LITERAL_KEY_RE.test(text)) out.add(relative(REPO_ROOT, file).split('\\').join('/'))
  }
  return out
}

describe('cross-platform test hygiene: fake-fs keys are built the way the module builds them', () => {
  it('only allowlisted tests declare a POSIX literal as a fake-fs key', () => {
    const fresh = [...offenders(testFiles())].filter((f) => !FAKE_FS_LITERAL_KEY_ALLOWLIST.has(f))
    expect(
      fresh,
      'these tests mock node:fs and write a fake-fs path as a POSIX literal; the ' +
        'module under test builds that path with join(), which produces backslashes ' +
        'on Windows, so the literal never matches and the test reads an empty fake ' +
        'filesystem there. Build the key the way the module does — ' +
        "join(tmpdir(), …) or join(app.getPath('userData'), …) — and let the same " +
        'expression seed the fake fs and drive the assertion'
    ).toEqual([])
  })

  it('has no stale allowlist entries', () => {
    const stale = [...FAKE_FS_LITERAL_KEY_ALLOWLIST].filter((f) => {
      const text = readFileSync(join(REPO_ROOT, f), 'utf8')
      return !(MOCKS_FS_RE.test(text) && FAKE_FS_LITERAL_KEY_RE.test(text))
    })
    expect(stale, 'already clean, drop from the allowlist').toEqual([])
  })

  it('still matches the shape it guards', () => {
    // The two lines from permissions.test.ts before #69, verbatim.
    expect(FAKE_FS_LITERAL_KEY_RE.test("const CACHE = '/tmp/navide-permissions-test/permissions.json'")).toBe(true)
    expect(FAKE_FS_LITERAL_KEY_RE.test("  app: { getPath: () => '/tmp/navide-permissions-test' },")).toBe(true)
    expect(FAKE_FS_LITERAL_KEY_RE.test("files.set('/tmp/x/settings.json', '{}')")).toBe(true)
    // What the rule asks for instead.
    expect(FAKE_FS_LITERAL_KEY_RE.test("const CACHE = join(userData, 'permissions.json')")).toBe(false)
    expect(FAKE_FS_LITERAL_KEY_RE.test("const root = mkdtempSync(join(tmpdir(), 'navide-'))")).toBe(false)
    // Inert POSIX literals that are not keys: an argument to a pure predicate,
    // a computed template key, fixture text.
    expect(FAKE_FS_LITERAL_KEY_RE.test("expect(isAllowedPlanDocumentPath('/etc/passwd', ws)).toBe(false)")).toBe(false)
    expect(FAKE_FS_LITERAL_KEY_RE.test('selections[`/tmp/navide-source-${index}`] = {}')).toBe(false)
    expect(FAKE_FS_LITERAL_KEY_RE.test("writeFileSync(file, '#!/bin/sh\\n')")).toBe(false)
  })

  it('scopes itself to files that mock node:fs', () => {
    expect(MOCKS_FS_RE.test("vi.mock('node:fs', () => ({}))")).toBe(true)
    expect(MOCKS_FS_RE.test("vi.mock('node:fs/promises', () => ({}))")).toBe(true)
    expect(MOCKS_FS_RE.test("vi.mock('node:child_process', () => ({}))")).toBe(false)
  })
})
