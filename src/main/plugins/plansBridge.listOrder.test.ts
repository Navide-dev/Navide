import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

import { createTestPlansFilesystemPort, type PlansBridgeContext } from './plansBridge'

describe('local Plans filesystem port listing order', () => {
  let root: string
  let bridgeContext: PlansBridgeContext
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'plans-list-order-')))
    for (const name of ['b.md', 'c.md', 'a.md', 'no-extension']) writeFileSync(join(root, name), '')
    readdirOrder.reverseFor = root
    bridgeContext = {
      runtime: {
        pluginId: 'navide.plans',
        packageVersion: '0.1.93',
        workspaceId: 'workspace-1',
        instanceId: 'view-1',
        contributionKey: 'navide.plans.window',
        hostWindowId: 'window-1',
        initiator: { kind: 'user', id: 'user-1' },
      },
      workspacePath: root,
      authorizedPlanRoot: root,
      requestId: 'bridge:test',
      signal: new AbortController().signal,
      emit: () => undefined,
    }
  })
  afterEach(() => {
    readdirOrder.reverseFor = undefined
    rmSync(root, { recursive: true, force: true })
  })

  it('returns list_dir entries sorted regardless of readdir order', async () => {
    await expect(createTestPlansFilesystemPort().listDir({ rel_path: '' }, bridgeContext))
      .resolves.toEqual({ entries: ['a.md', 'b.md', 'c.md', 'no-extension'] })
  })

  it('returns list_files_flat entries sorted regardless of readdir order', async () => {
    await expect(createTestPlansFilesystemPort().listFilesFlat({ rel_path: '' }, bridgeContext))
      .resolves.toEqual({ entries: ['a.md', 'b.md', 'c.md'] })
  })
})
