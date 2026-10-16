import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// readdir order is filesystem- and runtime-dependent (APFS and ext4 differ,
// and so do Node and other runtimes). Pin a deliberately unsorted order so the
// listing's own ordering is what the assertions observe.
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

import { PluginActivationSelector } from './pluginActivationSelector'

const candidate = {
  packageVersion: '1.0.0',
  target: 'universal',
  artifactDigest: 'a'.repeat(64),
} as const

describe('PluginActivationSelector.list ordering', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plugin-lifecycle-order-'))
  })
  afterEach(() => {
    readdirOrder.reverseFor = undefined
    rmSync(root, { recursive: true, force: true })
  })

  it('lists records sorted by plugin id regardless of readdir order', () => {
    const selector = new PluginActivationSelector(root)
    for (const id of ['beta.other', 'zeta.last', 'acme.demo']) selector.stageCandidate(id, candidate)
    readdirOrder.reverseFor = join(root, '.navide-lifecycle')

    expect(selector.list().map((record) => record.pluginId)).toEqual([
      'acme.demo',
      'beta.other',
      'zeta.last',
    ])
  })
})
