import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PARTITION_FILE_BYTES,
  NodePluginStorageFileSystem,
  PluginStorageError,
  PluginStorageStore,
  STORAGE_LIMITS,
  type StorageExecution,
} from './pluginStorage'

// Many real fsyncs per test that no assertion can observe; see tests/support/noFsync.ts.
vi.mock('node:fs', async (importOriginal) =>
  (await import('../../../tests/support/noFsync')).withoutFsyncSync(await importOriginal()))
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('../../../tests/support/noFsync')).withoutHandleSync(await importOriginal()))

const directories: string[] = []
const pluginId = 'acme.plugin'
const workspaceId = 'workspace-1'

class FailingCloneFileSystem extends NodePluginStorageFileSystem {
  failStagingWrites = false

  override async writeAtomic(path: string, content: string): Promise<void> {
    if (this.failStagingWrites && path.includes('.staging-')) {
      throw new Error('injected clone write failure')
    }
    return super.writeAtomic(path, content)
  }
}

class BlockingReadFileSystem extends NodePluginStorageFileSystem {
  blockNextRead = false
  private resolveBlockedReadEntered!: () => void
  private resolveBlockedReadReleased!: () => void
  private readonly blockedReadEntered = new Promise<void>((resolve) => {
    this.resolveBlockedReadEntered = resolve
  })
  private readonly blockedReadReleased = new Promise<void>((resolve) => {
    this.resolveBlockedReadReleased = resolve
  })

  waitForBlockedRead(): Promise<void> {
    return this.blockedReadEntered
  }

  releaseBlockedRead(): void {
    this.resolveBlockedReadReleased()
  }

  override async stat(path: string): Promise<{ kind: 'file' | 'directory'; size: number } | null> {
    if (this.blockNextRead) {
      this.blockNextRead = false
      this.resolveBlockedReadEntered()
      await this.blockedReadReleased
    }
    return super.stat(path)
  }
}

class BlockingReaddirFileSystem extends NodePluginStorageFileSystem {
  blockNextReaddir = false
  private resolveBlockedReaddirEntered!: () => void
  private resolveBlockedReaddirReleased!: () => void
  private readonly blockedReaddirEntered = new Promise<void>((resolve) => {
    this.resolveBlockedReaddirEntered = resolve
  })
  private readonly blockedReaddirReleased = new Promise<void>((resolve) => {
    this.resolveBlockedReaddirReleased = resolve
  })

  waitForBlockedReaddir(): Promise<void> {
    return this.blockedReaddirEntered
  }

  releaseBlockedReaddir(): void {
    this.resolveBlockedReaddirReleased()
  }

  override async readdir(path: string): Promise<string[]> {
    if (this.blockNextReaddir) {
      this.blockNextReaddir = false
      this.resolveBlockedReaddirEntered()
      await this.blockedReaddirReleased
    }
    return super.readdir(path)
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function partitionFile(
  root: string,
  packageVersion = '1.0.0',
  tier: 'candidate' | 'active' | 'previous' = 'active',
  scope: 'plugin' | 'workspace' = 'plugin',
  workspace = workspaceId
): string {
  const directory = join(root, hash(pluginId), hash(packageVersion), tier)
  return scope === 'plugin'
    ? join(directory, 'plugin.json')
    : join(directory, 'workspaces', `${hash(workspace)}.json`)
}

async function storageFixture(): Promise<{
  store: PluginStorageStore
  root: string
  execution: (overrides?: Partial<StorageExecution>) => StorageExecution
}> {
  const root = await mkdtemp(join(tmpdir(), 'navide-plugin-storage-'))
  directories.push(root)
  const execution = (overrides: Partial<StorageExecution> = {}): StorageExecution => ({
    address: 'storage.get',
    args: { scope: 'plugin', key: 'setting' },
    partition: { pluginId, workspaceId: null, key: 'setting' },
    snapshot: { pluginId, tier: 'active', packageVersion: '1.0.0' },
    ...overrides,
  })
  return { store: new PluginStorageStore(root), root, execution }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PluginStorageStore', () => {
  it('persists values in the partition-file layout and distinguishes null from missing', async () => {
    const { store, root, execution } = await storageFixture()
    await store.execute(execution({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'setting', value: null },
    }))
    await store.execute(execution({
      address: 'storage.set',
      args: { scope: 'workspace', key: 'setting', value: 'workspace' },
      partition: { pluginId, workspaceId, key: 'setting' },
    }))

    const restarted = new PluginStorageStore(root)
    await expect(restarted.execute(execution())).resolves.toEqual({ found: true, value: null })
    await expect(
      restarted.execute(execution({
        args: { scope: 'plugin', key: 'missing' },
        partition: { pluginId, workspaceId: null, key: 'missing' },
      }))
    ).resolves.toEqual({ found: false, value: null })
    await expect(readFile(partitionFile(root), 'utf8')).resolves.toContain('"workspaceId":null')
    await expect(readFile(partitionFile(root, '1.0.0', 'active', 'workspace'), 'utf8')).resolves.toContain(
      '"workspaceId":"workspace-1"'
    )
    await expect(readdir(root)).resolves.toHaveLength(1)
  })

  it('isolates plugins, workspaces, package versions, and duplicate-version tiers', async () => {
    const { store, execution } = await storageFixture()
    const set = async (
      value: string,
      options: {
        plugin?: string
        workspace?: string | null
        packageVersion?: string
        tier?: 'candidate' | 'active' | 'previous'
      } = {}
    ) => {
      const id = options.plugin ?? pluginId
      const workspace = options.workspace === undefined ? null : options.workspace
      const key = value
      await store.execute(execution({
        address: 'storage.set',
        args: { scope: workspace === null ? 'plugin' : 'workspace', key, value },
        partition: { pluginId: id, workspaceId: workspace, key },
        snapshot: {
          pluginId: id,
          packageVersion: options.packageVersion ?? '1.0.0',
          tier: options.tier ?? 'active',
        },
      }))
    }
    await set('active')
    await set('candidate', { tier: 'candidate' })
    await set('workspace', { workspace: workspaceId })
    await set('other-workspace', { workspace: 'workspace-2' })
    await set('other-plugin', { plugin: 'other.plugin' })
    await set('other-version', { packageVersion: '2.0.0' })

    const get = (value: string, options: Parameters<typeof set>[1] = {}) => {
      const id = options.plugin ?? pluginId
      const workspace = options.workspace === undefined ? null : options.workspace
      const scope = workspace === null ? 'plugin' : 'workspace'
      return store.execute(execution({
        args: { scope, key: value },
        partition: { pluginId: id, workspaceId: workspace, key: value },
        snapshot: {
          pluginId: id,
          packageVersion: options.packageVersion ?? '1.0.0',
          tier: options.tier ?? 'active',
        },
      }))
    }
    await expect(get('active')).resolves.toMatchObject({ value: 'active' })
    await expect(get('candidate', { tier: 'candidate' })).resolves.toMatchObject({ value: 'candidate' })
    await expect(get('workspace', { workspace: workspaceId })).resolves.toMatchObject({ value: 'workspace' })
    await expect(get('other-workspace', { workspace: 'workspace-2' })).resolves.toMatchObject({ value: 'other-workspace' })
    await expect(get('other-plugin', { plugin: 'other.plugin' })).resolves.toMatchObject({ value: 'other-plugin' })
    await expect(get('other-version', { packageVersion: '2.0.0' })).resolves.toMatchObject({ value: 'other-version' })
    await expect(get('candidate')).resolves.toEqual({ found: false, value: null })
  })

  it('does not create a partition during get or delete of a missing key', async () => {
    const { store, root, execution } = await storageFixture()
    await expect(store.execute(execution())).resolves.toEqual({ found: false, value: null })
    await expect(store.execute(execution({ address: 'storage.delete' }))).resolves.toBe(false)
    await expect(readdir(root)).resolves.toHaveLength(0)
  })

  it('enforces the snapshot quota across partition files but not across plugins', async () => {
    const { store, execution } = await storageFixture()
    const value = 'x'.repeat(950_000)
    for (let index = 0; index < 11; index += 1) {
      const key = `quota-${index}`
      await store.execute(execution({
        address: 'storage.set',
        args: { scope: 'workspace', key, value },
        partition: { pluginId, workspaceId: `workspace-${index}`, key },
      }))
    }
    const overflow = 'quota-overflow'
    await expect(
      store.execute(execution({
        address: 'storage.set',
        args: { scope: 'workspace', key: overflow, value },
        partition: { pluginId, workspaceId: 'workspace-overflow', key: overflow },
      }))
    ).rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' })
    await expect(
      store.execute(execution({
        address: 'storage.set',
        args: { scope: 'workspace', key: overflow, value },
        partition: { pluginId: 'other.plugin', workspaceId: 'workspace-overflow', key: overflow },
        snapshot: { pluginId: 'other.plugin', tier: 'active', packageVersion: '1.0.0' },
      }))
    ).resolves.toBeNull()
  })

  it('keeps a valid existing value readable after a value-policy reduction', async () => {
    const { store, root, execution } = await storageFixture()
    const large = 'x'.repeat(STORAGE_LIMITS.maxValueBytes + 1)
    const path = partitionFile(root)
    await mkdir(join(root, hash(pluginId), hash('1.0.0'), 'active'), { recursive: true })
    await writeFile(path, JSON.stringify({
      schemaVersion: 2,
      pluginId,
      packageVersion: '1.0.0',
      tier: 'active',
      scope: 'plugin',
      workspaceId: null,
      entries: [{ key: 'legacy-large', value: large }],
    }))
    await expect(store.execute(execution({
      args: { scope: 'plugin', key: 'legacy-large' },
      partition: { pluginId, workspaceId: null, key: 'legacy-large' },
    }))).resolves.toEqual({ found: true, value: large })
    await expect(store.execute(execution({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'new-large', value: large },
      partition: { pluginId, workspaceId: null, key: 'new-large' },
    }))).rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' })
  })

  it('rejects depth overflow, cycles, and non-finite numbers without RangeError', async () => {
    const { store, execution } = await storageFixture()
    const nested = (layers: number): unknown => {
      let value: unknown = null
      for (let index = 0; index < layers; index += 1) value = [value]
      return value
    }
    await expect(store.execute(execution({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'depth-ok', value: nested(128) },
      partition: { pluginId, workspaceId: null, key: 'depth-ok' },
    }))).resolves.toBeNull()
    await expect(store.execute(execution({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'depth-bad', value: nested(129) },
      partition: { pluginId, workspaceId: null, key: 'depth-bad' },
    }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(store.execute(execution({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'cycle', value: cyclic },
      partition: { pluginId, workspaceId: null, key: 'cycle' },
    }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(store.execute(execution({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'nan', value: Number.NaN },
      partition: { pluginId, workspaceId: null, key: 'nan' },
    }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('writes canonical object ordering and isolates corruption to the target partition', async () => {
    const { store, root, execution } = await storageFixture()
    await store.execute(execution({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'canonical', value: { b: 2, a: 1 } },
      partition: { pluginId, workspaceId: null, key: 'canonical' },
    }))
    await store.execute(execution({
      address: 'storage.set',
      args: { scope: 'workspace', key: 'healthy', value: true },
      partition: { pluginId, workspaceId, key: 'healthy' },
    }))
    const workspacePath = partitionFile(root, '1.0.0', 'active', 'workspace')
    await writeFile(workspacePath, '{not-json')
    await expect(readFile(partitionFile(root), 'utf8')).resolves.toContain('"a":1,"b":2')
    await expect(store.execute(execution({
      args: { scope: 'plugin', key: 'canonical' },
      partition: { pluginId, workspaceId: null, key: 'canonical' },
    }))).resolves.toEqual({ found: true, value: { a: 1, b: 2 } })
    await expect(store.execute(execution({
      args: { scope: 'workspace', key: 'healthy' },
      partition: { pluginId, workspaceId, key: 'healthy' },
    }))).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(readFile(workspacePath, 'utf8')).resolves.toBe('{not-json')
  })

  it('rejects duplicate raw JSON object keys without replacing the file', async () => {
    const { store, root, execution } = await storageFixture()
    const path = partitionFile(root)
    await mkdir(join(root, hash(pluginId), hash('1.0.0'), 'active'), { recursive: true })
    const raw = JSON.stringify({
      schemaVersion: 2,
      pluginId,
      packageVersion: '1.0.0',
      tier: 'active',
      scope: 'plugin',
      workspaceId: null,
      entries: [],
    }).replace('"entries":[]', '"entries":[],"entries":[]')
    await writeFile(path, raw)
    await expect(store.execute(execution())).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(readFile(path, 'utf8')).resolves.toBe(raw)
  })

  it('clones a Host-selected snapshot atomically, supports GC, and cleans on uninstall', async () => {
    const { store, root, execution } = await storageFixture()
    await store.execute(execution({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'setting', value: 'active' },
    }))
    await store.execute(execution({
      address: 'storage.set',
      args: { scope: 'workspace', key: 'setting', value: 'workspace' },
      partition: { pluginId, workspaceId, key: 'setting' },
    }))
    await store.cloneSnapshot(
      { pluginId, packageVersion: '1.0.0', tier: 'active' },
      { pluginId, packageVersion: '1.0.0', tier: 'candidate' }
    )
    const candidate = (overrides: Partial<StorageExecution> = {}) => execution({
      ...overrides,
      snapshot: { pluginId, packageVersion: '1.0.0', tier: 'candidate' },
    })
    await expect(store.execute(candidate())).resolves.toMatchObject({ value: 'active' })
    await expect(store.cloneSnapshot(
      { pluginId, packageVersion: '1.0.0', tier: 'active' },
      { pluginId, packageVersion: '1.0.0', tier: 'candidate' }
    )).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await store.gcSnapshots(pluginId, [{ pluginId, packageVersion: '1.0.0', tier: 'active' }])
    await expect(store.execute(candidate())).resolves.toEqual({ found: false, value: null })
    await store.cleanupPlugin(pluginId)
    await expect(store.execute(execution())).resolves.toEqual({ found: false, value: null })
    await expect(readdir(root)).resolves.toHaveLength(0)
  })

  it('rejects cloning a snapshot across plugin identities', async () => {
    const { store, execution } = await storageFixture()
    await store.execute(execution({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'setting', value: 'source' },
    }))

    await expect(store.cloneSnapshot(
      { pluginId, packageVersion: '1.0.0', tier: 'active' },
      { pluginId: 'other.plugin', packageVersion: '1.0.0', tier: 'candidate' }
    )).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('waits for in-flight storage operations before removing plugin storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'navide-plugin-storage-cleanup-race-'))
    directories.push(root)
    const fileSystem = new BlockingReadFileSystem()
    const store = new PluginStorageStore(root, fileSystem)
    const execution = (value: string): StorageExecution => ({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'setting', value },
      partition: { pluginId, workspaceId: null, key: 'setting' },
      snapshot: { pluginId, packageVersion: '1.0.0', tier: 'active' },
    })

    await store.execute(execution('before'))
    fileSystem.blockNextRead = true
    const write = store.execute(execution('after'))
    await fileSystem.waitForBlockedRead()

    const cleanup = store.cleanupPlugin(pluginId)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    fileSystem.releaseBlockedRead()
    await Promise.all([write, cleanup])

    await expect(readdir(root)).resolves.toHaveLength(0)
  })

  it('blocks new storage and clone operations during garbage collection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'navide-plugin-storage-gc-barrier-'))
    directories.push(root)
    const fileSystem = new BlockingReaddirFileSystem()
    const store = new PluginStorageStore(root, fileSystem)
    const execution = (
      tier: 'candidate' | 'active' | 'previous',
      address: 'storage.get' | 'storage.set' = 'storage.get',
      value?: string
    ): StorageExecution => ({
      address,
      args: {
        scope: 'plugin',
        key: 'setting',
        ...(address === 'storage.set' ? { value } : {}),
      },
      partition: { pluginId, workspaceId: null, key: 'setting' },
      snapshot: { pluginId, packageVersion: '1.0.0', tier },
    })
    const active = { pluginId, packageVersion: '1.0.0', tier: 'active' as const }

    await store.execute(execution('active', 'storage.set', 'active'))
    await store.execute(execution('candidate', 'storage.set', 'candidate'))
    fileSystem.blockNextReaddir = true
    const gc = store.gcSnapshots(pluginId, [active])
    await fileSystem.waitForBlockedReaddir()

    const lateSet = store.execute(execution('candidate', 'storage.set', 'late'))
    const lateClone = store.cloneSnapshot(
      active,
      { pluginId, packageVersion: '1.0.0', tier: 'previous' }
    )
    const [setResult, cloneResult] = await Promise.allSettled([lateSet, lateClone])
    expect(setResult).toMatchObject({
      status: 'rejected',
      reason: { code: 'INTERNAL_ERROR' },
    })
    expect(cloneResult).toMatchObject({
      status: 'rejected',
      reason: { code: 'INTERNAL_ERROR' },
    })

    fileSystem.releaseBlockedReaddir()
    await gc
    await expect(store.execute(execution('candidate'))).resolves.toEqual({ found: false, value: null })
    await expect(store.execute(execution('previous'))).resolves.toEqual({ found: false, value: null })
  })

  it('waits for an in-flight storage operation before garbage collection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'navide-plugin-storage-gc-drain-'))
    directories.push(root)
    const fileSystem = new BlockingReadFileSystem()
    const store = new PluginStorageStore(root, fileSystem)
    const execution = (tier: 'candidate' | 'active', value: string): StorageExecution => ({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'setting', value },
      partition: { pluginId, workspaceId: null, key: 'setting' },
      snapshot: { pluginId, packageVersion: '1.0.0', tier },
    })
    const active = { pluginId, packageVersion: '1.0.0', tier: 'active' as const }

    await store.execute(execution('active', 'active'))
    await store.execute(execution('candidate', 'before'))
    fileSystem.blockNextRead = true
    const inFlightSet = store.execute(execution('candidate', 'during'))
    await fileSystem.waitForBlockedRead()

    let gcFinished = false
    const gc = store.gcSnapshots(pluginId, [active]).then(() => {
      gcFinished = true
    })
    await Promise.resolve()
    expect(gcFinished).toBe(false)

    fileSystem.releaseBlockedRead()
    await inFlightSet
    await gc
    await expect(store.execute({
      address: 'storage.get',
      args: { scope: 'plugin', key: 'setting' },
      partition: { pluginId, workspaceId: null, key: 'setting' },
      snapshot: { pluginId, packageVersion: '1.0.0', tier: 'candidate' },
    })).resolves.toEqual({ found: false, value: null })
  })

  it('keeps source and target absent when clone staging fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'navide-plugin-storage-clone-failure-'))
    directories.push(root)
    const fileSystem = new FailingCloneFileSystem()
    const store = new PluginStorageStore(root, fileSystem)
    const execution = (overrides: Partial<StorageExecution> = {}): StorageExecution => ({
      address: 'storage.get',
      args: { scope: 'plugin', key: 'setting' },
      partition: { pluginId, workspaceId: null, key: 'setting' },
      snapshot: { pluginId, packageVersion: '1.0.0', tier: 'active' },
      ...overrides,
    })
    await store.execute(execution({
      address: 'storage.set',
      args: { scope: 'plugin', key: 'setting', value: 'source' },
    }))
    fileSystem.failStagingWrites = true
    await expect(store.cloneSnapshot(
      { pluginId, packageVersion: '1.0.0', tier: 'active' },
      { pluginId, packageVersion: '1.0.0', tier: 'candidate' }
    )).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(store.execute(execution())).resolves.toMatchObject({ value: 'source' })
    await expect(store.execute(execution({
      snapshot: { pluginId, packageVersion: '1.0.0', tier: 'candidate' },
    }))).resolves.toEqual({ found: false, value: null })
    await expect(readdir(join(root, hash(pluginId), hash('1.0.0')))).resolves.toEqual(['active'])
  })

  it('uses the physical partition bound independently from the current quota', () => {
    expect(MAX_PARTITION_FILE_BYTES).toBeGreaterThan(STORAGE_LIMITS.maxSnapshotBytes)
  })

  it('performs file fsync, rename, and parent-directory fsync in order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'navide-plugin-storage-fsync-'))
    directories.push(root)
    const events: Array<{ event: string; path: string }> = []
    const store = new PluginStorageStore(
      root,
      new NodePluginStorageFileSystem((event, path) => events.push({ event, path }))
    )
    const pluginDirectory = join(root, hash(pluginId))
    const versionDirectory = join(pluginDirectory, hash('1.0.0'))
    const snapshotDirectory = join(versionDirectory, 'active')
    const workspaceDirectory = join(snapshotDirectory, 'workspaces')
    const execution: StorageExecution = {
      address: 'storage.set',
      args: { scope: 'workspace', key: 'durable', value: true },
      partition: { pluginId, workspaceId, key: 'durable' },
      snapshot: { pluginId, packageVersion: '1.0.0', tier: 'active' },
    }
    await store.execute(execution)
    expect(events.filter(({ event }) => event === 'sync-directory').map(({ path }) => path)).toEqual([
      root,
      pluginDirectory,
      versionDirectory,
      snapshotDirectory,
      workspaceDirectory,
    ])
    expect(events.map(({ event }) => event).slice(-4)).toEqual([
      'write-temp',
      'sync-file',
      'rename',
      'sync-directory',
    ])
  })
})

describe('carryViewState (H1)', () => {
  const set = (store: PluginStorageStore, packageVersion: string, key: string, value: string, workspace: string | null = null) =>
    store.execute({
      address: 'storage.set',
      args: { scope: workspace === null ? 'plugin' : 'workspace', key, value },
      partition: { pluginId, workspaceId: workspace, key },
      snapshot: { pluginId, tier: 'active', packageVersion },
    })
  const get = (store: PluginStorageStore, packageVersion: string, key: string, workspace: string | null = null) =>
    store.execute({
      address: 'storage.get',
      args: { scope: workspace === null ? 'plugin' : 'workspace', key },
      partition: { pluginId, workspaceId: workspace, key },
      snapshot: { pluginId, tier: 'active', packageVersion },
    })

  it('copies only view-state keys of every partition, over the same keys of the target', async () => {
    const { store } = await storageFixture()
    await set(store, '1.0.0', 'view-state:left', 'old-left')
    await set(store, '1.0.0', 'setting', 'old-setting')
    await set(store, '1.0.0', 'view-state:panel', 'old-panel', workspaceId)
    await set(store, '1.0.0', 'draft', 'old-draft', workspaceId)
    await set(store, '2.0.0', 'view-state:left', 'new-left')
    await set(store, '2.0.0', 'view-state:only-new', 'kept')
    await set(store, '2.0.0', 'setting', 'new-setting')

    await store.carryViewState(pluginId, '1.0.0', '2.0.0')

    expect(await get(store, '2.0.0', 'view-state:left')).toEqual({ found: true, value: 'old-left' })
    expect(await get(store, '2.0.0', 'view-state:only-new')).toEqual({ found: true, value: 'kept' })
    expect(await get(store, '2.0.0', 'setting')).toEqual({ found: true, value: 'new-setting' })
    // The target had no workspace partition: it is created with the view state only.
    expect(await get(store, '2.0.0', 'view-state:panel', workspaceId)).toEqual({ found: true, value: 'old-panel' })
    expect(await get(store, '2.0.0', 'draft', workspaceId)).toEqual({ found: false, value: null })
    // The source is read, never changed.
    expect(await get(store, '1.0.0', 'view-state:left')).toEqual({ found: true, value: 'old-left' })
    expect(await get(store, '1.0.0', 'setting')).toEqual({ found: true, value: 'old-setting' })
  })

  it('writes nothing when the source has no view state or no snapshot', async () => {
    const { store, root } = await storageFixture()
    await store.carryViewState(pluginId, '1.0.0', '2.0.0')
    await set(store, '1.0.0', 'setting', 'old')
    await store.carryViewState(pluginId, '1.0.0', '2.0.0')
    expect(await readdir(join(root, hash(pluginId)))).toEqual([hash('1.0.0')])
  })

  it('refuses the same version, and writes nothing when the target would exceed its quota', async () => {
    const { store, root } = await storageFixture()
    await expect(store.carryViewState(pluginId, '1.0.0', '1.0.0')).rejects.toThrow(/must differ/)
    const large = 'x'.repeat(STORAGE_LIMITS.maxValueBytes - 64)
    for (let index = 0; index < 6; index += 1) await set(store, '1.0.0', `view-state:${index}`, large, `ws-${index}`)
    for (let index = 0; index < 6; index += 1) await set(store, '2.0.0', `other-${index}`, large, `other-${index}`)
    const before = await readFile(partitionFile(root, '2.0.0', 'active', 'workspace', 'other-0'), 'utf8')
    await expect(store.carryViewState(pluginId, '1.0.0', '2.0.0')).rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' })
    expect(await get(store, '2.0.0', 'view-state:0', 'ws-0')).toEqual({ found: false, value: null })
    expect(await readFile(partitionFile(root, '2.0.0', 'active', 'workspace', 'other-0'), 'utf8')).toBe(before)
  })
})
