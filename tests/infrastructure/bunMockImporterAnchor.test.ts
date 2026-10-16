import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { callerPathFromFrame } from '../support/bunMockImporterAnchor'

// The helper reads a file URL with fileURLToPath, which on Windows rejects a URL
// without a drive letter. Build the URL from a path resolved on this platform so
// the fixture is valid on every runner (resolve() adds the drive on Windows).
const spacedFile = resolve('/Users/dev/My Project/src/a.test.ts')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('callerPathFromFrame', () => {
  it.each([
    ['V8 frame with a function name', '    at mock (/work/repo/src/a.test.ts:12:34)', '/work/repo/src/a.test.ts'],
    ['frame without a function name', '    at /work/repo/src/a.test.ts:12:34', '/work/repo/src/a.test.ts'],
    ['JavaScriptCore frame', 'mock@/work/repo/src/a.test.ts:12:34', '/work/repo/src/a.test.ts'],
    ['path with spaces', '    at mock (/Users/dev/My Project/src/a.test.ts:12:34)', '/Users/dev/My Project/src/a.test.ts'],
    ['path with parentheses', '    at mock (/Users/dev/repo (1)/src/a.test.ts:12:34)', '/Users/dev/repo (1)/src/a.test.ts'],
    ['path with spaces and parentheses', '    at Object.mock (/Users/dev/My Project (copy)/src/a.test.ts:12:34)', '/Users/dev/My Project (copy)/src/a.test.ts'],
    ['unwrapped path with spaces and parentheses', '    at /Users/dev/My Project (copy)/src/a.test.ts:12:34', '/Users/dev/My Project (copy)/src/a.test.ts'],
    ['file URL with an encoded space', `    at mock (${pathToFileURL(spacedFile).href}:12:34)`, spacedFile.replace(/\\/g, '/')],
    ['Windows path with spaces and parentheses', '    at mock (C:\\Program Files (x86)\\My Project\\a.test.ts:12:34)', 'C:/Program Files (x86)/My Project/a.test.ts'],
  ])('reads the whole path from a %s', (_label, frame, expected) => {
    expect(callerPathFromFrame(frame)).toBe(expected)
  })

  it.each([
    '    at new Promise (<anonymous>)',
    '    at processTicksAndRejections (native)',
    'Error',
  ])('ignores a frame without a file location: %s', (frame) => {
    expect(callerPathFromFrame(frame)).toBeUndefined()
  })

  it('recovers a real stack frame from a directory with spaces and parentheses', () => {
    // Stack frames carry the real path (macOS TMPDIR sits behind a symlink).
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'navide-anchor-')))
    roots.push(root)
    const directory = join(root, 'My Project (copy)')
    mkdirSync(directory)
    const file = join(directory, 'frame.cjs')
    writeFileSync(file, 'module.exports = () => new Error().stack\n')
    const stack = (createRequire(import.meta.url)(file) as () => string)()
    const paths = stack.split('\n').map((line) => callerPathFromFrame(line))
    expect(paths).toContain(file.replace(/\\/g, '/'))
  })
})
