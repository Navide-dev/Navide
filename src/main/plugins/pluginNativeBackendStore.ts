import { join } from 'node:path'
import { OwnerOnlyJsonPersistence } from './ownerOnlyJsonPersistence'

/**
 * Durable user decisions about third-party native backends:
 * - the global "allow third-party native backends" switch (off by default);
 * - per plugin: the consented (binary digest, permission set) pair, a
 *   user "disabled" switch, and the workspaces where file changes are allowed.
 *
 * A consent is valid only for the exact binary and permission set it was
 * given for, so a new version that changes either needs a new consent.
 * Anything unreadable reads as "nothing allowed".
 */

export interface NativeBackendConsent {
  binarySha256: string
  permissionsKey: string
  packageVersion: string
  grantedAt: string
}

export interface NativeBackendPluginRecord {
  consent?: NativeBackendConsent
  disabled?: boolean
  /** Canonical workspace paths where workspace writes are allowed. */
  workspaceWrite?: string[]
  /** When the user first allowed a version of the package that declares
   * agent tools (ISO 8601, unique across packages): the DB1 name-collision
   * order. Cleared when a version declares no tools, and on uninstall. */
  agentToolsSince?: string
}

export interface NativeBackendState {
  schemaVersion: 1
  enabled: boolean
  plugins: Record<string, NativeBackendPluginRecord>
}

const FILE_NAME = 'native-backends.json'
const MAX_BYTES = 256 * 1024

function emptyState(): NativeBackendState {
  return { schemaVersion: 1, enabled: false, plugins: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseConsent(value: unknown): NativeBackendConsent | undefined {
  if (!isRecord(value)) return undefined
  const { binarySha256, permissionsKey, packageVersion, grantedAt } = value
  if (
    typeof binarySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(binarySha256) ||
    typeof permissionsKey !== 'string' ||
    typeof packageVersion !== 'string' ||
    typeof grantedAt !== 'string'
  ) return undefined
  return { binarySha256, permissionsKey, packageVersion, grantedAt }
}

function parseState(value: unknown): NativeBackendState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.plugins)) return emptyState()
  const plugins: Record<string, NativeBackendPluginRecord> = {}
  for (const [pluginId, raw] of Object.entries(value.plugins)) {
    if (!isRecord(raw)) continue
    const record: NativeBackendPluginRecord = {}
    const consent = parseConsent(raw.consent)
    if (consent) record.consent = consent
    if (raw.disabled === true) record.disabled = true
    if (Array.isArray(raw.workspaceWrite)) {
      const paths = raw.workspaceWrite.filter((path): path is string => typeof path === 'string')
      if (paths.length > 0) record.workspaceWrite = [...new Set(paths)]
    }
    if (typeof raw.agentToolsSince === 'string') record.agentToolsSince = raw.agentToolsSince
    plugins[pluginId] = record
  }
  return { schemaVersion: 1, enabled: value.enabled === true, plugins }
}

export class NativeBackendStore {
  private readonly persistence: OwnerOnlyJsonPersistence
  private readonly file: string
  private state: NativeBackendState

  constructor(directory: string) {
    this.persistence = new OwnerOnlyJsonPersistence(directory, MAX_BYTES, MAX_BYTES)
    this.file = join(directory, FILE_NAME)
    this.state = this.load()
  }

  private load(): NativeBackendState {
    if (this.persistence.ensureDirectory(false) !== 'ready') return emptyState()
    const read = this.persistence.read(this.file, 'native backend decisions')
    return read.kind === 'present' ? parseState(read.value) : emptyState()
  }

  /**
   * Persist a decision. A decision that allows more takes effect only once it
   * is saved. A decision that allows less (`restricting`) takes effect in
   * memory first, so a failed save still stops the backend for the rest of
   * the session; the save error is still thrown for the UI.
   */
  private save(next: NativeBackendState, restricting = false): void {
    if (restricting) this.state = next
    if (this.persistence.ensureDirectory(true) !== 'ready') {
      throw new Error('native backend decision store is unavailable')
    }
    this.persistence.write(this.file, next)
    this.state = next
  }

  private update(
    pluginId: string,
    change: (record: NativeBackendPluginRecord) => NativeBackendPluginRecord,
    restricting = false,
  ): void {
    const current = this.state.plugins[pluginId] ?? {}
    const nextRecord = change({ ...current })
    const plugins = { ...this.state.plugins }
    if (Object.keys(nextRecord).length === 0) delete plugins[pluginId]
    else plugins[pluginId] = nextRecord
    this.save({ ...this.state, plugins }, restricting)
  }

  snapshot(): NativeBackendState {
    return structuredClone(this.state)
  }

  isEnabled(): boolean {
    return this.state.enabled
  }

  setEnabled(enabled: boolean): void {
    this.save({ ...this.state, enabled }, !enabled)
  }

  record(pluginId: string): NativeBackendPluginRecord {
    return structuredClone(this.state.plugins[pluginId] ?? {})
  }

  grantConsent(pluginId: string, consent: Omit<NativeBackendConsent, 'grantedAt'>, now = new Date()): void {
    this.update(pluginId, (record) => ({ ...record, consent: { ...consent, grantedAt: now.toISOString() } }))
  }

  revokeConsent(pluginId: string): void {
    this.update(pluginId, (record) => {
      delete record.consent
      return record
    })
  }

  setDisabled(pluginId: string, disabled: boolean): void {
    this.update(pluginId, (record) => {
      if (disabled) record.disabled = true
      else delete record.disabled
      return record
    }, disabled)
  }

  allowsWorkspaceWrite(pluginId: string, workspacePath: string): boolean {
    return this.state.plugins[pluginId]?.workspaceWrite?.includes(workspacePath) ?? false
  }

  setWorkspaceWrite(pluginId: string, workspacePath: string, allowed: boolean): void {
    this.update(pluginId, (record) => {
      const paths = new Set(record.workspaceWrite ?? [])
      if (allowed) paths.add(workspacePath)
      else paths.delete(workspacePath)
      if (paths.size > 0) record.workspaceWrite = [...paths].sort()
      else delete record.workspaceWrite
      return record
    })
  }

  /** Record the first consent to a tool-declaring version; later calls keep
   * the first time (no save). The time is made strictly later than every
   * recorded one, so two packages never tie however fast they are allowed. */
  noteAgentToolsSince(pluginId: string, now = new Date()): void {
    if (this.state.plugins[pluginId]?.agentToolsSince !== undefined) return
    let at = now.getTime()
    for (const record of Object.values(this.state.plugins)) {
      const since = record.agentToolsSince === undefined ? Number.NaN : Date.parse(record.agentToolsSince)
      if (since >= at) at = since + 1
    }
    this.update(pluginId, (record) => ({ ...record, agentToolsSince: new Date(at).toISOString() }))
  }

  /** The package declares no tools any more: it gives up its DB1 place. */
  clearAgentToolsSince(pluginId: string): void {
    if (this.state.plugins[pluginId]?.agentToolsSince === undefined) return
    this.update(pluginId, (record) => {
      delete record.agentToolsSince
      return record
    })
  }

  /** Uninstall: forget every decision about the plugin. */
  forget(pluginId: string): void {
    if (!this.state.plugins[pluginId]) return
    this.update(pluginId, () => ({}))
  }
}
