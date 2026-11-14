import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, readdir, rename, rm, stat, unlink, mkdir } from 'node:fs/promises'
import { syncDirectory } from './fsSync'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { JsonValue, StorageGetResult } from '../../../packages/plugin-contracts/src/index'
import type {
  AuthenticatedInitiator,
  StoragePartition,
  StorageSnapshotRef,
  StorageSnapshotTier,
} from './pluginCapabilityBroker'
import { STORAGE_LIMITS } from './pluginCapabilityCatalog'
import {
  normalizeJsonValue,
  type NormalizedJsonValue,
  MAX_JSON_DEPTH,
  utf8ByteLength,
} from './pluginStorageJson'

export { STORAGE_LIMITS } from './pluginCapabilityCatalog'
export { MAX_JSON_DEPTH } from './pluginStorageJson'

export type StorageExecutionAddress = 'storage.get' | 'storage.set' | 'storage.delete'

export interface StorageExecution {
  address: StorageExecutionAddress
  args: Record<string, unknown>
  partition: StoragePartition
  snapshot: StorageSnapshotRef
  /** Host-authenticated operation origin, retained for internal adapters. */
  initiator?: AuthenticatedInitiator
}

export type PluginStorageErrorCode =
  | 'INVALID_ARGUMENT'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'INTERNAL_ERROR'

export class PluginStorageError extends Error {
  constructor(
    readonly code: PluginStorageErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PluginStorageError'
  }
}

/** Host lifecycle signal; only an absent snapshot can seed empty storage. */
export class MissingStorageSnapshotError extends PluginStorageError {
  constructor() {
    super('INTERNAL_ERROR', 'storage clone source snapshot does not exist')
  }
}

/** Host lifecycle signal for the idempotent rerun: the target snapshot this
 * clone would create is already there. Callers must branch on this type, never
 * on the message text. */
export class StorageSnapshotExistsError extends PluginStorageError {
  constructor() {
    super('INVALID_ARGUMENT', 'storage clone target snapshot already exists')
  }
}

export interface HostStorageSnapshotIdentity {
  pluginId: string
  packageVersion: string
  tier: StorageSnapshotTier
}

export interface StorageSnapshotIdentitySummary extends HostStorageSnapshotIdentity {}

/** A format-level guard independent from the current snapshot quota. */
export const MAX_PARTITION_FILE_BYTES = 12 * 1024 * 1024

interface StorageEntry {
  key: string
  value: JsonValue
}

interface PartitionDocument {
  schemaVersion: 2
  pluginId: string
  packageVersion: string
  tier: StorageSnapshotTier
  scope: 'plugin' | 'workspace'
  workspaceId: string | null
  entries: StorageEntry[]
}

interface StorageArgs {
  scope: 'plugin' | 'workspace'
  key: string
  value?: JsonValue
}

interface ReadPartition {
  document: PartitionDocument
  size: number
}

interface PluginOperationState {
  active: number
  closing: boolean
  maintenanceRequested: boolean
  idle: Promise<void>
  resolveIdle: () => void
  maintenance?: Promise<void>
  cleanup?: Promise<void>
}

export interface StorageFileStat {
  kind: 'file' | 'directory'
  size: number
}

/**
 * Narrow filesystem seam for durability and failure-order tests. The Node
 * implementation below performs file fsync before rename and parent-directory
 * fsync after rename; tests can inject an implementation that records those
 * operations without touching the host filesystem.
 */
export interface PluginStorageFileSystem {
  readFile(path: string): Promise<string>
  stat(path: string): Promise<StorageFileStat | null>
  readdir(path: string): Promise<string[]>
  mkdir(path: string): Promise<void>
  writeAtomic(path: string, content: string): Promise<void>
  removeFile(path: string): Promise<void>
  removeDirectory(path: string): Promise<void>
  renameDirectory(source: string, target: string): Promise<void>
  syncDirectory(path: string): Promise<void>
}

export type StorageDurabilityEvent = 'write-temp' | 'sync-file' | 'rename' | 'sync-directory'

/**
 * Undo `path.toNamespacedPath`. On Windows a recursive `mkdir` reports the
 * first directory it created in `\\?\` form, which `relative` cannot compare
 * against the plain path it was asked for: the result is the whole absolute
 * path again, and every ancestor gets "flushed" under a nonsense name.
 */
function fromNamespacedPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  if (path.startsWith('\\\\?\\')) return path.slice('\\\\?\\'.length)
  return path
}

export class NodePluginStorageFileSystem implements PluginStorageFileSystem {
  constructor(private readonly observe?: (event: StorageDurabilityEvent, path: string) => void) {}

  async readFile(path: string): Promise<string> {
    return readFile(path, 'utf8')
  }

  async stat(path: string): Promise<StorageFileStat | null> {
    try {
      const result = await stat(path)
      return {
        kind: result.isDirectory() ? 'directory' : 'file',
        size: result.size,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async readdir(path: string): Promise<string[]> {
    try {
      return await readdir(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async mkdir(path: string): Promise<void> {
    const first = await mkdir(path, { recursive: true, mode: 0o700 })
    if (!first) return
    const created = fromNamespacedPath(first)
    let directory = created
    await this.syncDirectory(dirname(directory))
    for (const segment of relative(created, path).split(sep).filter(Boolean)) {
      directory = join(directory, segment)
      await this.syncDirectory(dirname(directory))
    }
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    const parent = dirname(path)
    await this.mkdir(parent)
    const temporary = `${path}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(content, 'utf8')
      this.observe?.('write-temp', temporary)
      await handle.sync()
      this.observe?.('sync-file', temporary)
      await handle.close()
      handle = null
      await rename(temporary, path)
      this.observe?.('rename', path)
      await this.syncDirectory(parent)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async removeFile(path: string): Promise<void> {
    try {
      await unlink(path)
      await this.syncDirectory(dirname(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }

  async removeDirectory(path: string): Promise<void> {
    try {
      const existing = await stat(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!existing) return
      await rm(path, { recursive: true, force: true })
      await this.syncDirectory(dirname(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }

  async renameDirectory(source: string, target: string): Promise<void> {
    await rename(source, target)
    await this.syncDirectory(dirname(target))
  }

  async syncDirectory(path: string): Promise<void> {
    this.observe?.('sync-directory', path)
    await syncDirectory(path)
  }
}

const VALID_TIERS: readonly StorageSnapshotTier[] = ['candidate', 'active', 'previous']

/** The SDK's createPluginViewState keeps each value under this prefix. */
const VIEW_STATE_KEY_PREFIX = 'view-state:'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTier(value: unknown): value is StorageSnapshotTier {
  return typeof value === 'string' && VALID_TIERS.includes(value as StorageSnapshotTier)
}

function invalid(message: string): never {
  throw new PluginStorageError('INVALID_ARGUMENT', message)
}

function internal(message: string): never {
  throw new PluginStorageError('INTERNAL_ERROR', message)
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a non-empty string`)
}

function assertIdentity(identity: HostStorageSnapshotIdentity): void {
  assertNonEmptyString(identity.pluginId, 'storage snapshot plugin id')
  assertNonEmptyString(identity.packageVersion, 'storage snapshot package version')
  if (!isTier(identity.tier)) invalid('storage snapshot tier is invalid')
}

function identityOf(snapshot: StorageSnapshotRef): HostStorageSnapshotIdentity {
  const identity = {
    pluginId: snapshot.pluginId,
    packageVersion: snapshot.packageVersion,
    tier: snapshot.tier,
  }
  assertIdentity(identity)
  return identity
}

function identityKey(identity: HostStorageSnapshotIdentity): string {
  return JSON.stringify([identity.pluginId, identity.packageVersion, identity.tier])
}

function safeKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** The directory under the storage root that holds every snapshot of one
 * plugin id (card K3: a source change sets it aside as a whole). */
export function pluginStorageDirName(pluginId: string): string {
  return safeKey(pluginId)
}

function snapshotDirectory(root: string, identity: HostStorageSnapshotIdentity): string {
  return join(root, safeKey(identity.pluginId), safeKey(identity.packageVersion), identity.tier)
}

function partitionPath(
  root: string,
  identity: HostStorageSnapshotIdentity,
  partition: Pick<StoragePartition, 'workspaceId'>
): string {
  const directory = snapshotDirectory(root, identity)
  return partition.workspaceId === null
    ? join(directory, 'plugin.json')
    : join(directory, 'workspaces', `${safeKey(partition.workspaceId)}.json`)
}

function expectedDocumentKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key)) &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function requestKey(value: unknown): string {
  assertNonEmptyString(value, 'storage key')
  if (utf8ByteLength(value) > STORAGE_LIMITS.maxKeyBytes) {
    throw new PluginStorageError('STORAGE_QUOTA_EXCEEDED', 'storage key exceeds the Host limit')
  }
  return value
}

function storedKey(value: unknown): string {
  assertNonEmptyString(value, 'stored storage key')
  return value
}

function normalizeStoredValue(value: unknown): JsonValue {
  const normalized = normalizeJsonValue(value)
  if (!normalized) internal('stored storage value is invalid')
  return normalized.value
}

function validateEntry(value: unknown, label: string): StorageEntry {
  if (!isRecord(value) || !expectedDocumentKeys(value, ['key', 'value'])) {
    internal(`${label} is invalid`)
  }
  return { key: storedKey(value.key), value: normalizeStoredValue(value.value) }
}

function validateUniqueEntries(entries: StorageEntry[], label: string): void {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.key)) internal(`${label} contains duplicate keys`)
    seen.add(entry.key)
  }
}

function assertNoDuplicateJsonKeys(raw: string): void {
  const end = scanJsonValue(raw, 0, 0)
  if (skipJsonWhitespace(raw, end) !== raw.length) throw new Error('trailing JSON data')
}

function scanJsonValue(raw: string, start: number, depth: number): number {
  const index = skipJsonWhitespace(raw, start)
  if (depth > MAX_JSON_DEPTH + 16) throw new Error('JSON is too deeply nested')
  const character = raw[index]
  if (character === '{') {
    let cursor = skipJsonWhitespace(raw, index + 1)
    const keys = new Set<string>()
    if (raw[cursor] === '}') return cursor + 1
    while (true) {
      const keyStart = cursor
      cursor = scanJsonString(raw, cursor)
      const key = JSON.parse(raw.slice(keyStart, cursor)) as string
      if (keys.has(key)) throw new Error('duplicate JSON object key')
      keys.add(key)
      cursor = skipJsonWhitespace(raw, cursor)
      if (raw[cursor] !== ':') throw new Error('missing JSON object colon')
      cursor = scanJsonValue(raw, cursor + 1, depth + 1)
      cursor = skipJsonWhitespace(raw, cursor)
      if (raw[cursor] === '}') return cursor + 1
      if (raw[cursor] !== ',') throw new Error('missing JSON object comma')
      cursor = skipJsonWhitespace(raw, cursor + 1)
    }
  }
  if (character === '[') {
    let cursor = skipJsonWhitespace(raw, index + 1)
    if (raw[cursor] === ']') return cursor + 1
    while (true) {
      cursor = scanJsonValue(raw, cursor, depth + 1)
      cursor = skipJsonWhitespace(raw, cursor)
      if (raw[cursor] === ']') return cursor + 1
      if (raw[cursor] !== ',') throw new Error('missing JSON array comma')
      cursor = skipJsonWhitespace(raw, cursor + 1)
    }
  }
  if (character === '"') return scanJsonString(raw, index)
  let cursor = index
  while (cursor < raw.length && !/[\s,\]}]/.test(raw[cursor]!)) cursor += 1
  if (cursor === index) throw new Error('invalid JSON value')
  return cursor
}

function scanJsonString(raw: string, start: number): number {
  if (raw[start] !== '"') throw new Error('invalid JSON string')
  let cursor = start + 1
  while (cursor < raw.length) {
    const character = raw[cursor]
    if (character === '\\') {
      cursor += raw[cursor + 1] === 'u' ? 6 : 2
      continue
    }
    if (character === '"') return cursor + 1
    cursor += 1
  }
  throw new Error('unterminated JSON string')
}

function skipJsonWhitespace(raw: string, start: number): number {
  let cursor = start
  while (cursor < raw.length && /\s/.test(raw[cursor]!)) cursor += 1
  return cursor
}

function parsePartition(
  raw: string,
  identity: HostStorageSnapshotIdentity,
  expectedScope: 'plugin' | 'workspace',
  expectedWorkspaceId: string | null
): PartitionDocument {
  let parsed: unknown
  try {
    assertNoDuplicateJsonKeys(raw)
    parsed = JSON.parse(raw)
  } catch {
    internal('storage partition is not valid JSON')
  }
  if (
    !isRecord(parsed) ||
    !expectedDocumentKeys(parsed, [
      'schemaVersion',
      'pluginId',
      'packageVersion',
      'tier',
      'scope',
      'workspaceId',
      'entries',
    ]) ||
    parsed.schemaVersion !== 2 ||
    parsed.pluginId !== identity.pluginId ||
    parsed.packageVersion !== identity.packageVersion ||
    parsed.tier !== identity.tier ||
    parsed.scope !== expectedScope ||
    parsed.workspaceId !== expectedWorkspaceId ||
    !Array.isArray(parsed.entries)
  ) {
    internal('storage partition identity or schema is invalid')
  }
  const entries = parsed.entries.map((entry, index) => validateEntry(entry, `storage entry ${index}`))
  validateUniqueEntries(entries, 'storage partition')
  return {
    schemaVersion: 2,
    pluginId: identity.pluginId,
    packageVersion: identity.packageVersion,
    tier: identity.tier,
    scope: expectedScope,
    workspaceId: expectedWorkspaceId,
    entries,
  }
}

function canonicalPartition(document: PartitionDocument): { json: string; bytes: number } {
  const ordered = {
    schemaVersion: 2 as const,
    pluginId: document.pluginId,
    packageVersion: document.packageVersion,
    tier: document.tier,
    scope: document.scope,
    workspaceId: document.workspaceId,
    entries: [...document.entries]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => ({ key: entry.key, value: entry.value })),
  }
  const json = JSON.stringify(ordered)
  return { json, bytes: utf8ByteLength(json) }
}

function validateExecution(execution: StorageExecution): { args: StorageArgs; value?: NormalizedJsonValue } {
  try {
    const expectedKeys = execution.address === 'storage.set' ? ['scope', 'key', 'value'] : ['scope', 'key']
    if (!isRecord(execution.args) || !expectedDocumentKeys(execution.args, expectedKeys)) {
      invalid('storage request shape is invalid')
    }
    if (execution.args.scope !== 'plugin' && execution.args.scope !== 'workspace') {
      invalid('storage scope is invalid')
    }
    const key = requestKey(execution.args.key)
    assertIdentity(identityOf(execution.snapshot))
    assertNonEmptyString(execution.partition.pluginId, 'partition plugin id')
    if (execution.partition.pluginId !== execution.snapshot.pluginId) {
      internal('storage partition plugin id does not match snapshot identity')
    }
    if (execution.partition.key !== key) {
      internal('storage partition key does not match request')
    }
    if (execution.args.scope === 'plugin' && execution.partition.workspaceId !== null) {
      internal('plugin storage partition has a workspace id')
    }
    if (execution.args.scope === 'workspace') {
      assertNonEmptyString(execution.partition.workspaceId, 'partition workspace id')
    } else if (execution.partition.workspaceId !== null) {
      internal('workspace storage partition has an unexpected workspace id')
    }
    if (execution.address !== 'storage.set') {
      return { args: { scope: execution.args.scope, key } }
    }
    const normalized = normalizeJsonValue(execution.args.value)
    if (!normalized) invalid('storage value must be a JSON value')
    if (normalized.bytes > STORAGE_LIMITS.maxValueBytes) {
      throw new PluginStorageError('STORAGE_QUOTA_EXCEEDED', 'storage value exceeds the Host limit')
    }
    return { args: { scope: execution.args.scope, key, value: normalized.value }, value: normalized }
  } catch (error) {
    if (error instanceof PluginStorageError) throw error
    invalid('storage request is invalid')
  }
}

function sameIdentity(left: HostStorageSnapshotIdentity, right: HostStorageSnapshotIdentity): boolean {
  return (
    left.pluginId === right.pluginId &&
    left.packageVersion === right.packageVersion &&
    left.tier === right.tier
  )
}

function maintenanceError(error: unknown, message: string): never {
  if (error instanceof PluginStorageError) throw error
  throw new PluginStorageError('INTERNAL_ERROR', message)
}

export class PluginStorageStore {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly pluginOperations = new Map<string, PluginOperationState>()
  private readonly fs: PluginStorageFileSystem

  constructor(
    private readonly rootPath: string | (() => string),
    fileSystem: PluginStorageFileSystem = new NodePluginStorageFileSystem()
  ) {
    this.fs = fileSystem
  }

  private resolvedRoot(): string {
    return typeof this.rootPath === 'function' ? this.rootPath() : this.rootPath
  }

  async execute(execution: StorageExecution): Promise<StorageGetResult | boolean | null> {
    const identity = identityOf(execution.snapshot)
    return this.withPluginOperation(identity.pluginId, async () => {
      const validated = validateExecution(execution)
      return this.withLocks([identity], async () => {
        if (execution.address === 'storage.get') {
          return this.get(identity, execution.partition, validated.args.key)
        }
        if (execution.address === 'storage.delete') {
          return this.delete(identity, execution.partition, validated.args.key)
        }
        return this.set(identity, execution.partition, validated.args, validated.value!)
      })
    })
  }

  /** Host-only create-once write used by migrations that must never replace a
   * value written by the active package or another Host surface. The presence
   * check and write share the same partition lock, so this is atomic with
   * respect to normal storage execution. */
  async setIfAbsent(execution: StorageExecution): Promise<boolean> {
    if (execution.address !== 'storage.set') {
      invalid('create-once storage writes require storage.set')
    }
    const identity = identityOf(execution.snapshot)
    return this.withPluginOperation(identity.pluginId, async () => {
      const validated = validateExecution(execution)
      return this.withLocks([identity], async () => {
        const result = await this.set(
          identity,
          execution.partition,
          validated.args,
          validated.value!,
          true,
        )
        return result === true
      })
    })
  }

  /** Validate exactly one Host-selected recovery source without creating or
   * modifying any snapshot. An absent source is distinct from empty storage. */
  async assertSnapshotReadable(identity: HostStorageSnapshotIdentity): Promise<void> {
    assertIdentity(identity)
    return this.withPluginOperation(identity.pluginId, () => this.withLocks([identity], async () => {
      const stat = await this.fs.stat(snapshotDirectory(this.resolvedRoot(), identity))
      if (!stat) throw new MissingStorageSnapshotError()
      if (stat.kind !== 'directory') internal('storage recovery snapshot is not a directory')
      for (const file of await this.partitionFiles(identity)) {
        await this.readPartitionFile(file.path, file.identity, file.scope, file.workspaceId)
      }
    }))
  }

  /** Copy one Host-selected snapshot without overwriting an existing target. */
  async cloneSnapshot(
    source: HostStorageSnapshotIdentity,
    target: HostStorageSnapshotIdentity
  ): Promise<void> {
    assertIdentity(source)
    assertIdentity(target)
    if (source.pluginId !== target.pluginId) {
      invalid('storage clone source and target must belong to the same plugin')
    }
    if (sameIdentity(source, target)) invalid('storage clone source and target must differ')
    return this.withPluginOperation(source.pluginId, async () => {
      const ordered = [source, target].sort((left, right) =>
        identityKey(left).localeCompare(identityKey(right))
      )
      await this.withLocks(ordered, async () => {
        const root = this.resolvedRoot()
        const sourceDirectory = snapshotDirectory(root, source)
        const targetDirectory = snapshotDirectory(root, target)
        try {
          const sourceStat = await this.fs.stat(sourceDirectory)
          if (!sourceStat) throw new MissingStorageSnapshotError()
          if (sourceStat.kind !== 'directory') internal('storage clone source snapshot is not a directory')
          if (await this.fs.stat(targetDirectory)) {
            throw new StorageSnapshotExistsError()
          }
          const files = await this.partitionFiles(source)
          let usage = 0
          const staged = `${targetDirectory}.staging-${randomUUID()}`
          try {
            await this.fs.mkdir(staged)
            for (const file of files) {
              const parsed = await this.readPartitionFile(file.path, file.identity, file.scope, file.workspaceId)
              const targetDocument: PartitionDocument = {
                ...parsed.document,
                pluginId: target.pluginId,
                packageVersion: target.packageVersion,
                tier: target.tier,
              }
              const canonical = canonicalPartition(targetDocument)
              usage += canonical.bytes
              if (canonical.bytes > MAX_PARTITION_FILE_BYTES) {
                internal('storage clone source partition exceeds the physical format bound')
              }
              const targetPath =
                file.scope === 'plugin'
                  ? join(staged, 'plugin.json')
                  : join(staged, 'workspaces', `${safeKey(file.workspaceId!)}.json`)
              await this.fs.writeAtomic(targetPath, canonical.json)
            }
            if (usage > STORAGE_LIMITS.maxSnapshotBytes) {
              throw new PluginStorageError('STORAGE_QUOTA_EXCEEDED', 'storage snapshot exceeds the Host limit')
            }
            await this.fs.syncDirectory(staged)
            await this.fs.renameDirectory(staged, targetDirectory)
          } catch (error) {
            await this.fs.removeDirectory(staged).catch(() => undefined)
            maintenanceError(error, 'storage snapshot clone failed')
          }
        } catch (error) {
          maintenanceError(error, 'storage snapshot clone failed')
        }
      })
    })
  }

  /** H1: a version switch within one source hands the SDK view state of the
   * version that ran to the one that runs next. Only `view-state:` keys of
   * every partition of `fromVersion`'s active snapshot are written, over the
   * same keys of `toVersion`'s; every other key of the target stays as it was.
   * Nothing is written unless every target partition fits. */
  async carryViewState(pluginId: string, fromVersion: string, toVersion: string): Promise<void> {
    const source: HostStorageSnapshotIdentity = { pluginId, packageVersion: fromVersion, tier: 'active' }
    const target: HostStorageSnapshotIdentity = { pluginId, packageVersion: toVersion, tier: 'active' }
    assertIdentity(source)
    assertIdentity(target)
    if (sameIdentity(source, target)) invalid('view state source and target must differ')
    return this.withPluginOperation(pluginId, async () => {
      const ordered = [source, target].sort((left, right) =>
        identityKey(left).localeCompare(identityKey(right))
      )
      await this.withLocks(ordered, async () => {
        const root = this.resolvedRoot()
        const writes: Array<{ path: string; json: string }> = []
        let added = 0
        for (const file of await this.partitionFiles(source)) {
          const carried = (await this.readPartitionFile(file.path, source, file.scope, file.workspaceId))
            .document.entries.filter((entry) => entry.key.startsWith(VIEW_STATE_KEY_PREFIX))
          if (carried.length === 0) continue
          const path = partitionPath(root, target, { workspaceId: file.workspaceId })
          const current = (await this.fs.stat(path))
            ? await this.readPartitionFile(path, target, file.scope, file.workspaceId)
            : null
          const carriedKeys = new Set(carried.map((entry) => entry.key))
          const document: PartitionDocument = {
            schemaVersion: 2,
            pluginId,
            packageVersion: toVersion,
            tier: 'active',
            scope: file.scope,
            workspaceId: file.workspaceId,
            entries: [
              ...(current?.document.entries ?? []).filter((entry) => !carriedKeys.has(entry.key)),
              ...carried,
            ],
          }
          const canonical = canonicalPartition(document)
          if (canonical.bytes > MAX_PARTITION_FILE_BYTES) {
            throw new PluginStorageError('STORAGE_QUOTA_EXCEEDED', 'storage partition exceeds the physical format bound')
          }
          added += canonical.bytes - (current?.size ?? 0)
          writes.push({ path, json: canonical.json })
        }
        if (writes.length === 0) return
        if (await this.snapshotUsage(target) + added > STORAGE_LIMITS.maxSnapshotBytes) {
          throw new PluginStorageError('STORAGE_QUOTA_EXCEEDED', 'storage snapshot exceeds the Host limit')
        }
        for (const write of writes) await this.fs.writeAtomic(write.path, write.json)
      })
    })
  }

  /** List snapshot identities discovered by the Host from durable partition
   * metadata. Package code never receives this method; it exists so a Host
   * lifecycle can select the previous active version before opening a new
   * candidate without guessing from hashed directory names. */
  async listSnapshotIdentities(pluginId: string): Promise<StorageSnapshotIdentitySummary[]> {
    assertNonEmptyString(pluginId, 'plugin id')
    return this.withPluginOperation(pluginId, async () => {
      const result: StorageSnapshotIdentitySummary[] = []
      const pluginDirectory = join(this.resolvedRoot(), safeKey(pluginId))
      for (const packageDirectoryName of await this.fs.readdir(pluginDirectory)) {
        const packageDirectory = join(pluginDirectory, packageDirectoryName)
        const packageStat = await this.fs.stat(packageDirectory)
        if (!packageStat || packageStat.kind !== 'directory') continue
        for (const tier of VALID_TIERS) {
          const tierDirectory = join(packageDirectory, tier)
          const tierStat = await this.fs.stat(tierDirectory)
          if (!tierStat || tierStat.kind !== 'directory') continue
          const paths = [join(tierDirectory, 'plugin.json')]
          const workspaceDirectory = join(tierDirectory, 'workspaces')
          for (const name of await this.fs.readdir(workspaceDirectory)) {
            if (name.endsWith('.json')) paths.push(join(workspaceDirectory, name))
          }
          for (const path of paths) {
            const fileStat = await this.fs.stat(path)
            if (!fileStat || fileStat.kind !== 'file') continue
            try {
              const parsed = JSON.parse(await this.fs.readFile(path)) as Record<string, unknown>
              if (
                parsed.pluginId === pluginId &&
                typeof parsed.packageVersion === 'string' &&
                parsed.packageVersion.length > 0 &&
                parsed.tier === tier
              ) {
                result.push({ pluginId, packageVersion: parsed.packageVersion, tier })
              }
            } catch {
              // A malformed partition is surfaced by a normal storage read;
              // discovery skips it so an unrelated broken tier cannot select
              // itself as an upgrade source.
            }
            break
          }
        }
      }
      return [...new Map(result.map((identity) => [
        JSON.stringify(identity), identity,
      ])).values()]
    })
  }

  /** Remove every version, tier, and workspace partition for a plugin.
   * Callers should stop the plugin runtime first; admitted storage operations
   * are drained here and new operations are refused until removal finishes. */
  async cleanupPlugin(pluginId: string): Promise<void> {
    assertNonEmptyString(pluginId, 'plugin id')
    const state = this.pluginOperationState(pluginId)
    if (state.cleanup) return state.cleanup
    state.closing = true
    const cleanup = (async () => {
      try {
        await state.idle
        if (state.maintenance) await state.maintenance
        await this.fs.removeDirectory(join(this.resolvedRoot(), safeKey(pluginId)))
      } catch (error) {
        maintenanceError(error, 'plugin storage cleanup failed')
      } finally {
        if (this.pluginOperations.get(pluginId) === state) {
          this.pluginOperations.delete(pluginId)
        }
      }
    })()
    state.cleanup = cleanup
    return cleanup
  }

  /** Remove only snapshots outside the explicit Host lifecycle retention set. */
  async gcSnapshots(
    pluginId: string,
    retained: readonly HostStorageSnapshotIdentity[]
  ): Promise<void> {
    assertNonEmptyString(pluginId, 'plugin id')
    return this.withPluginMaintenance(pluginId, async () => {
      const retainedPaths = new Set<string>()
      for (const identity of retained) {
        assertIdentity(identity)
        if (identity.pluginId !== pluginId) invalid('retained storage identity belongs to another plugin')
        retainedPaths.add(snapshotDirectory(this.resolvedRoot(), identity))
      }
      const pluginDirectory = join(this.resolvedRoot(), safeKey(pluginId))
      try {
        for (const packageDirectoryName of await this.fs.readdir(pluginDirectory)) {
          const packageDirectory = join(pluginDirectory, packageDirectoryName)
          const packageStat = await this.fs.stat(packageDirectory)
          if (!packageStat || packageStat.kind !== 'directory') continue
          for (const tier of VALID_TIERS) {
            const candidate = join(packageDirectory, tier)
            const candidateStat = await this.fs.stat(candidate)
            if (!candidateStat) continue
            if (!retainedPaths.has(candidate)) await this.fs.removeDirectory(candidate)
          }
          for (const name of await this.fs.readdir(packageDirectory)) {
            if (name.includes('.staging-')) {
              await this.fs.removeDirectory(join(packageDirectory, name))
            }
          }
        }
      } catch (error) {
        maintenanceError(error, 'plugin storage garbage collection failed')
      }
    })
  }

  private async get(
    identity: HostStorageSnapshotIdentity,
    partition: StoragePartition,
    key: string
  ): Promise<StorageGetResult> {
    const current = await this.readPartition(identity, partition)
    const entry = current?.document.entries.find((candidate) => candidate.key === key)
    return entry ? { found: true, value: entry.value } : { found: false, value: null }
  }

  private async set(
    identity: HostStorageSnapshotIdentity,
    partition: StoragePartition,
    args: StorageArgs,
    normalized: NormalizedJsonValue,
    onlyIfAbsent = false,
  ): Promise<null | boolean> {
    const current = await this.readPartition(identity, partition)
    const document = current?.document ?? {
      schemaVersion: 2 as const,
      pluginId: identity.pluginId,
      packageVersion: identity.packageVersion,
      tier: identity.tier,
      scope: args.scope,
      workspaceId: partition.workspaceId,
      entries: [],
    }
    if (document.scope !== args.scope || document.workspaceId !== partition.workspaceId) {
      internal('storage partition scope does not match request')
    }
    const existing = document.entries.find((entry) => entry.key === args.key)
    if (existing) {
      if (onlyIfAbsent) return false
      existing.value = normalized.value
    }
    else document.entries.push({ key: args.key, value: normalized.value })
    validateUniqueEntries(document.entries, 'storage partition')
    const canonical = canonicalPartition(document)
    if (canonical.bytes > MAX_PARTITION_FILE_BYTES) {
      throw new PluginStorageError('STORAGE_QUOTA_EXCEEDED', 'storage partition exceeds the physical format bound')
    }
    let total: number
    try {
      total = await this.snapshotUsage(identity)
    } catch (error) {
      if (error instanceof PluginStorageError) throw error
      throw new PluginStorageError('INTERNAL_ERROR', 'storage snapshot usage could not be read')
    }
    const nextTotal = total - (current?.size ?? 0) + canonical.bytes
    if (nextTotal > STORAGE_LIMITS.maxSnapshotBytes) {
      throw new PluginStorageError('STORAGE_QUOTA_EXCEEDED', 'storage snapshot exceeds the Host limit')
    }
    try {
      await this.fs.writeAtomic(partitionPath(this.resolvedRoot(), identity, partition), canonical.json)
    } catch (error) {
      if (error instanceof PluginStorageError) throw error
      throw new PluginStorageError('INTERNAL_ERROR', 'storage partition could not be written')
    }
    return onlyIfAbsent ? true : null
  }

  private async delete(
    identity: HostStorageSnapshotIdentity,
    partition: StoragePartition,
    key: string
  ): Promise<boolean> {
    const current = await this.readPartition(identity, partition)
    if (!current) return false
    const index = current.document.entries.findIndex((entry) => entry.key === key)
    if (index < 0) return false
    current.document.entries.splice(index, 1)
    const path = partitionPath(this.resolvedRoot(), identity, partition)
    try {
      if (current.document.entries.length === 0) await this.fs.removeFile(path)
      else await this.fs.writeAtomic(path, canonicalPartition(current.document).json)
    } catch (error) {
      if (error instanceof PluginStorageError) throw error
      throw new PluginStorageError('INTERNAL_ERROR', 'storage partition could not be deleted')
    }
    return true
  }

  private async readPartition(
    identity: HostStorageSnapshotIdentity,
    partition: StoragePartition
  ): Promise<ReadPartition | null> {
    const path = partitionPath(this.resolvedRoot(), identity, partition)
    const expectedScope = partition.workspaceId === null ? 'plugin' : 'workspace'
    let metadata: StorageFileStat | null
    try {
      metadata = await this.fs.stat(path)
    } catch {
      throw new PluginStorageError('INTERNAL_ERROR', 'storage partition could not be read')
    }
    if (!metadata) return null
    return this.readPartitionFile(path, identity, expectedScope, partition.workspaceId)
  }

  private async readPartitionFile(
    path: string,
    identity: HostStorageSnapshotIdentity,
    expectedScope: 'plugin' | 'workspace',
    workspaceId: string | null
  ): Promise<ReadPartition> {
    try {
      const metadata = await this.fs.stat(path)
      if (!metadata) internal('storage partition does not exist')
      if (metadata.kind !== 'file' || metadata.size > MAX_PARTITION_FILE_BYTES) {
        internal('storage partition is not readable')
      }
      const raw = await this.fs.readFile(path)
      return {
        document: parsePartition(raw, identity, expectedScope, workspaceId),
        size: metadata.size,
      }
    } catch (error) {
      if (error instanceof PluginStorageError) throw error
      throw new PluginStorageError('INTERNAL_ERROR', 'storage partition could not be read')
    }
  }

  private async snapshotUsage(identity: HostStorageSnapshotIdentity): Promise<number> {
    let total = 0
    for (const file of await this.partitionFilePaths(identity)) {
      const metadata = await this.fs.stat(file)
      if (metadata?.kind === 'file') total += metadata.size
    }
    return total
  }

  private async partitionFilePaths(identity: HostStorageSnapshotIdentity): Promise<string[]> {
    const directory = snapshotDirectory(this.resolvedRoot(), identity)
    const paths: string[] = []
    const pluginPath = join(directory, 'plugin.json')
    if ((await this.fs.stat(pluginPath))?.kind === 'file') paths.push(pluginPath)
    const workspaceDirectory = join(directory, 'workspaces')
    for (const name of await this.fs.readdir(workspaceDirectory)) {
      if (!name.endsWith('.json')) continue
      const path = join(workspaceDirectory, name)
      if ((await this.fs.stat(path))?.kind === 'file') paths.push(path)
    }
    return paths
  }

  private async partitionFiles(identity: HostStorageSnapshotIdentity): Promise<Array<{
    path: string
    identity: HostStorageSnapshotIdentity
    scope: 'plugin' | 'workspace'
    workspaceId: string | null
  }>> {
    const paths = await this.partitionFilePaths(identity)
    const result: Array<{
      path: string
      identity: HostStorageSnapshotIdentity
      scope: 'plugin' | 'workspace'
      workspaceId: string | null
    }> = []
    for (const path of paths) {
      if (basename(path) === 'plugin.json') {
        result.push({ path, identity, scope: 'plugin', workspaceId: null })
        continue
      }
      const raw = await this.fs.readFile(path)
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        internal('storage workspace partition is not valid JSON')
      }
      if (!isRecord(parsed) || typeof parsed.workspaceId !== 'string' || parsed.workspaceId.length === 0) {
        internal('storage workspace partition identity is invalid')
      }
      const expectedName = `${safeKey(parsed.workspaceId)}.json`
      if (!path.endsWith(join('workspaces', expectedName))) {
        internal('storage workspace partition filename is invalid')
      }
      result.push({ path, identity, scope: 'workspace', workspaceId: parsed.workspaceId })
    }
    return result
  }

  private async withLocks<T>(
    identities: readonly HostStorageSnapshotIdentity[],
    operation: () => Promise<T>
  ): Promise<T> {
    const keys = [...new Map(identities.map((identity) => [identityKey(identity), identity])).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
    const held: Array<{ key: string; previous: Promise<void>; current: Promise<void>; release: () => void }> = []
    for (const [key] of keys) {
      const previous = this.queues.get(key) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      this.queues.set(key, current)
      held.push({ key, previous, current, release })
    }
    try {
      for (const lock of held) await lock.previous
      return await operation()
    } finally {
      for (const lock of held) {
        if (this.queues.get(lock.key) === lock.current) this.queues.delete(lock.key)
        lock.release()
      }
    }
  }

  private pluginOperationState(pluginId: string): PluginOperationState {
    const existing = this.pluginOperations.get(pluginId)
    if (existing) return existing
    const state: PluginOperationState = {
      active: 0,
      closing: false,
      maintenanceRequested: false,
      idle: Promise.resolve(),
      resolveIdle: () => undefined,
    }
    this.pluginOperations.set(pluginId, state)
    return state
  }

  private async withPluginOperation<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    const state = this.pluginOperationState(pluginId)
    if (state.closing || state.maintenanceRequested) {
      internal('plugin storage is unavailable during maintenance')
    }
    if (state.active === 0) {
      state.idle = new Promise<void>((resolve) => {
        state.resolveIdle = resolve
      })
    }
    state.active += 1
    try {
      return await operation()
    } finally {
      state.active -= 1
      if (state.active === 0) {
        state.resolveIdle()
        state.resolveIdle = () => undefined
      }
    }
  }

  private async withPluginMaintenance(
    pluginId: string,
    operation: () => Promise<void>
  ): Promise<void> {
    const state = this.pluginOperationState(pluginId)
    if (state.closing) internal('plugin storage is unavailable during cleanup')
    if (state.maintenanceRequested) internal('plugin storage maintenance is already running')
    state.maintenanceRequested = true
    const drain = state.idle
    const maintenance = (async () => {
      try {
        await drain
        await operation()
      } finally {
        if (this.pluginOperations.get(pluginId) !== state) return
        state.maintenance = undefined
        state.maintenanceRequested = false
        if (!state.closing) this.pluginOperations.delete(pluginId)
      }
    })()
    state.maintenance = maintenance
    return maintenance
  }
}
