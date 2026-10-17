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
 *
 * It also keeps the two agent-tool switches (plan B, DB8 and DB4), both off
 * by default: "let agents call tools from third-party Navide plugins", and
 * "external MCP clients may call them too". They are written only once the
 * user changes one, so a profile that never did keeps its file as on main.
 */

export interface NativeBackendConsent {
  binarySha256: string
  permissionsKey: string
  packageVersion: string
  grantedAt: string
  /** SHA-256 of the canonical agent-tool list the user was shown and allowed
   * (plan B, contract 2.8). Absent = the consent never covered agent tools. */
  agentToolsSha256?: string
  /** When the consent first covered agent tools (B1-a); orders name collisions. */
  agentToolsSince?: string
}

/** DB3: workspaces where the user allowed agent write-risk tools of one
 * package version under one consent. A new version or consent drops it. */
export interface AgentToolWriteGrant {
  packageVersion: string
  consentGrantedAt: string
  workspaces: string[]
}

export interface NativeBackendPluginRecord {
  consent?: NativeBackendConsent
  disabled?: boolean
  /** Canonical workspace paths where workspace writes are allowed. */
  workspaceWrite?: string[]
  /** DB3 agent write-tool confirmations; separate from `workspaceWrite`. */
  agentToolWrite?: AgentToolWriteGrant
}

export interface AgentToolSwitches {
  /** DB8: agents may call consented third-party agent tools. */
  enabled: boolean
  /** DB4: external MCP clients (and the Host credential) may call them too. */
  externalCallers: boolean
}

export interface NativeBackendState {
  schemaVersion: 1
  enabled: boolean
  plugins: Record<string, NativeBackendPluginRecord>
  agentTools?: AgentToolSwitches
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
  const { binarySha256, permissionsKey, packageVersion, grantedAt, agentToolsSha256, agentToolsSince } = value
  if (
    typeof binarySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(binarySha256) ||
    typeof permissionsKey !== 'string' ||
    typeof packageVersion !== 'string' ||
    typeof grantedAt !== 'string'
  ) return undefined
  return {
    binarySha256,
    permissionsKey,
    packageVersion,
    grantedAt,
    ...(typeof agentToolsSha256 === 'string' && /^[0-9a-f]{64}$/.test(agentToolsSha256) ? { agentToolsSha256 } : {}),
    ...(typeof agentToolsSince === 'string' ? { agentToolsSince } : {}),
  }
}

function parseAgentToolWrite(value: unknown): AgentToolWriteGrant | undefined {
  if (!isRecord(value)) return undefined
  const { packageVersion, consentGrantedAt, workspaces } = value
  if (typeof packageVersion !== 'string' || typeof consentGrantedAt !== 'string' || !Array.isArray(workspaces)) return undefined
  const paths = [...new Set(workspaces.filter((path): path is string => typeof path === 'string'))].sort()
  return paths.length > 0 ? { packageVersion, consentGrantedAt, workspaces: paths } : undefined
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
    const agentToolWrite = parseAgentToolWrite(raw.agentToolWrite)
    if (agentToolWrite) record.agentToolWrite = agentToolWrite
    plugins[pluginId] = record
  }
  const agentTools = isRecord(value.agentTools)
    ? { enabled: value.agentTools.enabled === true, externalCallers: value.agentTools.externalCallers === true }
    : undefined
  return { schemaVersion: 1, enabled: value.enabled === true, plugins, ...(agentTools ? { agentTools } : {}) }
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

  agentToolSwitches(): AgentToolSwitches {
    return { enabled: this.state.agentTools?.enabled === true, externalCallers: this.state.agentTools?.externalCallers === true }
  }

  /** Turning a switch off takes effect in memory even when the save fails. */
  setAgentToolSwitches(change: Partial<AgentToolSwitches>): void {
    const current = this.agentToolSwitches()
    const next = { ...current, ...change }
    // DB4 never outlives DB8: turning agents off also turns external clients
    // off, so turning agents on again never silently re-enables them.
    if (change.enabled === false) next.externalCallers = false
    const restricting = (current.enabled && !next.enabled) || (current.externalCallers && !next.externalCallers)
    this.save({ ...this.state, agentTools: next }, restricting)
  }

  record(pluginId: string): NativeBackendPluginRecord {
    return structuredClone(this.state.plugins[pluginId] ?? {})
  }

  grantConsent(pluginId: string, consent: Omit<NativeBackendConsent, 'grantedAt'>, now = new Date()): void {
    this.update(pluginId, (record) => {
      // A new consent asks the agent write-tool questions again (DB3).
      delete record.agentToolWrite
      return { ...record, consent: { ...consent, grantedAt: now.toISOString() } }
    })
  }

  /** DB3: the user allowed agent write-risk tools of this exact package version,
   * under the consent granted at `consentGrantedAt`, in `workspacePath`. */
  allowsAgentToolWrite(pluginId: string, packageVersion: string, consentGrantedAt: string, workspacePath: string): boolean {
    const grant = this.state.plugins[pluginId]?.agentToolWrite
    return Boolean(
      grant &&
      grant.packageVersion === packageVersion &&
      grant.consentGrantedAt === consentGrantedAt &&
      grant.workspaces.includes(workspacePath),
    )
  }

  setAgentToolWrite(pluginId: string, packageVersion: string, consentGrantedAt: string, workspacePath: string): void {
    this.update(pluginId, (record) => {
      const current = record.agentToolWrite
      const same = current?.packageVersion === packageVersion && current.consentGrantedAt === consentGrantedAt
      const workspaces = new Set(same ? current!.workspaces : [])
      workspaces.add(workspacePath)
      record.agentToolWrite = { packageVersion, consentGrantedAt, workspaces: [...workspaces].sort() }
      return record
    })
  }

  /** Drop every DB3 confirmation of the package (update, disable, removal). */
  forgetAgentToolWrites(pluginId: string): void {
    if (!this.state.plugins[pluginId]?.agentToolWrite) return
    this.update(pluginId, (record) => {
      delete record.agentToolWrite
      return record
    }, true)
  }

  revokeConsent(pluginId: string): void {
    this.update(pluginId, (record) => {
      delete record.consent
      return record
    })
  }

  setDisabled(pluginId: string, disabled: boolean): void {
    this.update(pluginId, (record) => {
      if (disabled) {
        record.disabled = true
        delete record.agentToolWrite
      } else delete record.disabled
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

  /** Uninstall: forget every decision about the plugin. */
  forget(pluginId: string): void {
    if (!this.state.plugins[pluginId]) return
    this.update(pluginId, () => ({}))
  }
}
