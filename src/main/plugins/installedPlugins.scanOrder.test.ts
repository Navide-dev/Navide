import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// readdir order is filesystem- and runtime-dependent (APFS and ext4 differ,
// and so do Node and other runtimes). Pin a deliberately unsorted order so the
// scan's own ordering is what the assertions observe.
const readdirOrder = vi.hoisted(() => ({ reverseFor: undefined as string | undefined }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: ((path: Parameters<typeof actual.readdirSync>[0], ...rest: unknown[]) => {
      const names = (actual.readdirSync as (...args: unknown[]) => string[])(path, ...rest)
      return path === readdirOrder.reverseFor ? [...names].sort().reverse() : names
    }) as typeof actual.readdirSync,
  }
})

import { scanInstalledPlugins } from './installedPlugins'

function writePlugin(root: string, name: string): string {
  const dir = join(root, name)
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ id: name, version: '1.0.0', entry: 'dist/main.js', requires: [] }),
  )
  return dir
}

describe('scanInstalledPlugins ordering', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plugins-order-'))
    readdirOrder.reverseFor = root
  })
  afterEach(() => {
    readdirOrder.reverseFor = undefined
    rmSync(root, { recursive: true, force: true })
  })

  it('returns plugins sorted by directory name regardless of readdir order', () => {
    const dirs = ['beta.other', 'zeta.last', 'acme.demo'].map((name) => writePlugin(root, name))

    expect(scanInstalledPlugins(root).map((scanned) => scanned.dir)).toEqual([
      dirs[2],
      dirs[0],
      dirs[1],
    ])
  })
})
