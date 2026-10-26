// Bun compatibility setup (inert outside Bun), two independent parts:
//
// 1. Re-anchor relative Vitest mock ids on the caller file.
//
// Vitest resolves a relative `vi.mock('./x')` through the file it recovers from
// the calling frame (vitest's internal getImporter()). That lookup matches
// frames spelled `at Object.mock (...)` or `mock@...`. Bun's JSC frames are
// spelled `at mock (...)`, so the lookup misses, the importer comes back empty,
// and the mock is registered without a file anchor while the import of the same
// module resolves to its absolute id. The mock then never matches and the real
// module loads.
//
// Bun does print the calling file in the frame, so this setup recovers the
// importer from that frame and hands Vitest a pre-anchored id. Absolute and
// bare specifiers are passed through untouched.
//
// 2. Keep `electron-updater` from downloading the Electron binary during tests.
//
// electron-updater is a CommonJS package whose `autoUpdater` export is a lazy
// getter that builds the updater (and so require('electron')) on first read.
// Node's import leaves that getter unread until the code uses it; Bun's import
// of a CommonJS module reads every enumerable export at import time. Any test
// that imports src/main/updater.ts without mocking electron-updater (for
// example dockQuitProbe.test.ts through src/main/index.ts) therefore evaluates
// the real `electron` package, which downloads the binary with a synchronous
// spawnSync when it is not installed. That blocks the event loop for as long as
// the download takes, so the test timeouts fire late and a stray test body
// leaks into the next test. With the binary absent, point Electron's own
// override at a path that does not exist: the package then returns the path
// string at once and nothing is downloaded. An installed binary, or an override
// the caller already set, is left alone.
import { vi } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Extension probe order used by Vite's resolver (this project does not override
// resolve.extensions). Only consulted for an anchored id whose file name is not
// already spelled out, the same cases that need resolution for the import.

const isBun = Boolean((process.versions as Record<string, string | undefined>).bun)
// A query string can be suffixed to the setup module's own URL by the runner.
const ownFile = fileURLToPath(import.meta.url).split('?')[0].replace(/\\/g, '/')

// Extracts the file path from one stack frame (`at fn (/dir/file.ts:1:2)`,
// `at /dir/file.ts:1:2`, `fn@file:///dir/file.ts:1:2`, or a Windows drive path).
// The path starts at the first absolute-path start after the function name and
// runs to the trailing `:line:column`, so spaces and parentheses inside the path
// (`/Users/me/My Project (1)/x.ts`) survive.
export function callerPathFromFrame(line: string): string | undefined {
  const match = /(?:^|[\s(@])((?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/).*?):\d+:\d+\)?$/.exec(line.trim().replace(/^at\s+/, ''))
  if (!match) return undefined
  const raw = match[1]
  return (raw.startsWith('file://') ? fileURLToPath(raw) : raw).replace(/\\/g, '/')
}

function callerFile(): string | undefined {
  const stack = new Error().stack
  if (!stack) return undefined
  for (const line of stack.split('\n').slice(1)) {
    const path = callerPathFromFrame(line)
    if (!path || path === ownFile || path.includes('/node_modules/')) continue
    return path
  }
  return undefined
}

const RESOLVE_EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function resolveFrom(importer: string, specifier: string): string {
  const base = resolve(dirname(importer), specifier)
  if (isFile(base)) return base
  for (const extension of RESOLVE_EXTENSIONS) {
    if (isFile(base + extension)) return base + extension
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    const index = join(base, `index${extension}`)
    if (isFile(index)) return index
  }
  return base
}

function anchorPath(path: string): string {
  if (!path.startsWith('./') && !path.startsWith('../')) return path
  const caller = callerFile()
  return caller ? resolveFrom(caller, path) : path
}

if (isBun) {
  const mockMethods = ['mock', 'unmock', 'doMock', 'doUnmock', 'importActual', 'importMock'] as const
  for (const name of mockMethods) {
    const original = vi[name] as (path: string, ...rest: unknown[]) => unknown
    ;(vi as unknown as Record<string, unknown>)[name] = function (path: string, ...rest: unknown[]) {
      // The dynamic-import mock form passes a promise instead of an id; those
      // ids are already absolute for Vite, so they are delegated untouched.
      if (typeof path !== 'string') return original.call(vi, path, ...rest)
      return original.call(vi, anchorPath(path), ...rest)
    }
  }
}

function electronBinaryInstalled(): boolean {
  try {
    const dir = dirname(createRequire(import.meta.url).resolve('electron/package.json'))
    return existsSync(join(dir, 'dist', readFileSync(join(dir, 'path.txt'), 'utf8')))
  } catch {
    return false
  }
}

if (isBun && !process.env.ELECTRON_OVERRIDE_DIST_PATH && !electronBinaryInstalled()) {
  process.env.ELECTRON_OVERRIDE_DIST_PATH = join(tmpdir(), 'navide-bun-electron-binary-not-installed')
}
