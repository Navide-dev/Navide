import { join } from 'node:path'
import { OwnerOnlyJsonPersistence } from './ownerOnlyJsonPersistence'

/**
 * Durable user decisions about third-party native backends:
 * - the global "allow third-party native backends" switch: on for a profile
 *   that has no decision file yet; once the file exists, its `enabled` is the
 *   answer, so an earlier version's "off" stays off;
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
  /** A consent was taken away (revoked, or forgotten to fail closed): the
   * next start asks again instead of counting the install as consent.
   * Cleared by the next consent; uninstalling drops it with the record. */
  consentRevoked?: true
  /** 0.2.31: the user confirmed the install dialog of this version, which
   * discloses its native backend, so its first start counts as consent. A
   * package installed earlier, or of another version, is asked instead. */
  installConsent?: { packageVersion: string }
  disabled?: boolean
  /** Canonical workspace paths where workspace writes are allowed. */
  workspaceWrite?: string[]
  /** When the user first allowed a version of the package that declares
   * agent tools (ISO 8601, unique across packages): the DB1 name-collision
   * order for a name without its own time below. Cleared when a version
   * declares no tools, and on uninstall. */
  agentToolsSince?: string
  /** Per tool name, when the user first allowed a version declaring it (ISO
   * 8601, unique across packages): a name added by an update ranks from that
   * update's consent, so it cannot take over a name another package already
   * holds. Names the package no longer declares are dropped. */
  agentToolNamesSince?: Record<string, string>
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

function emptyState(enabled = false): NativeBackendState {
  return { schemaVersion: 1, enabled, plugins: {} }
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
    if (raw.consentRevoked === true) record.consentRevoked = true
    if (isRecord(raw.installConsent) && typeof raw.installConsent.packageVersion === 'string') {
      record.installConsent = { packageVersion: raw.installConsent.packageVersion }
    }
    if (raw.disabled === true) record.disabled = true
    if (Array.isArray(raw.workspaceWrite)) {
      const paths = raw.workspaceWrite.filter((path): path is string => typeof path === 'string')
      if (paths.length > 0) record.workspaceWrite = [...new Set(paths)]
    }
    const agentToolWrite = parseAgentToolWrite(raw.agentToolWrite)
    if (agentToolWrite) record.agentToolWrite = agentToolWrite
    if (typeof raw.agentToolsSince === 'string') record.agentToolsSince = raw.agentToolsSince
    if (isRecord(raw.agentToolNamesSince)) {
      const names = Object.entries(raw.agentToolNamesSince).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      )
      if (names.length > 0) record.agentToolNamesSince = Object.fromEntries(names)
    }
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
    // A fresh profile (no directory, or no file in it) has never decided:
    // the switch is on. Anything unreadable still reads as nothing allowed.
    const directory = this.persistence.ensureDirectory(false)
    if (directory === 'missing') return emptyState(true)
    if (directory !== 'ready') return emptyState()
    const read = this.persistence.read(this.file, 'native backend decisions')
    if (read.kind === 'missing') return emptyState(true)
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
      delete record.consentRevoked
      return { ...record, consent: { ...consent, grantedAt: now.toISOString() } }
    })
  }

  /** The user confirmed the install dialog of this version: a new disclosure,
   * so an earlier revocation no longer applies. */
  noteInstallConsent(pluginId: string, packageVersion: string): void {
    this.update(pluginId, (record) => {
      delete record.consentRevoked
      return { ...record, installConsent: { packageVersion } }
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
      delete record.installConsent
      return { ...record, consentRevoked: true }
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

  /** Record the first consent to a tool-declaring version, and for each of
   * `names` (the consented tool set) the first consent that declared it;
   * names no longer declared are dropped. Times already recorded are kept, so
   * an unchanged set saves nothing. Every new time is strictly later than
   * every recorded one, so two packages never tie however fast they are
   * allowed. */
  noteAgentToolsSince(pluginId: string, now = new Date(), names: readonly string[] = []): void {
    const current = this.state.plugins[pluginId]
    const known = current?.agentToolNamesSince ?? {}
    const added = names.filter((name) => known[name] === undefined)
    const dropped = Object.keys(known).some((name) => !names.includes(name))
    if (current?.agentToolsSince !== undefined && added.length === 0 && !dropped) return
    let at = now.getTime()
    for (const record of Object.values(this.state.plugins)) {
      for (const recorded of [record.agentToolsSince, ...Object.values(record.agentToolNamesSince ?? {})]) {
        const since = recorded === undefined ? Number.NaN : Date.parse(recorded)
        if (since >= at) at = since + 1
      }
    }
    const stamp = new Date(at).toISOString()
    this.update(pluginId, (record) => {
      const namesSince = Object.fromEntries(names.map((name) => [name, known[name] ?? stamp]))
      if (names.length > 0) record.agentToolNamesSince = namesSince
      else delete record.agentToolNamesSince
      return { ...record, agentToolsSince: record.agentToolsSince ?? stamp }
    })
  }

  /** The package declares no tools any more: it gives up its DB1 place. */
  clearAgentToolsSince(pluginId: string): void {
    const current = this.state.plugins[pluginId]
    if (current?.agentToolsSince === undefined && current?.agentToolNamesSince === undefined) return
    this.update(pluginId, (record) => {
      delete record.agentToolsSince
      delete record.agentToolNamesSince
      return record
    })
  }

  /** Card K3 (D7): the package was replaced by one from another source
   * (Marketplace ↔ local file). Forget every permission given to the replaced
   * one: its consent, every workspace it may change files in, its agent write
   * answers and its agent tool place. Only the user's own Disabled switch for
   * the id stays, and the install consent of `keepInstallConsentFor`: the
   * replacing version's own install dialog, not the replaced one's consent.
   * Without it (failing closed), the next start is asked. */
  forgetGrants(pluginId: string, keepInstallConsentFor?: string): void {
    const current = this.state.plugins[pluginId]
    const kept = keepInstallConsentFor !== undefined && current?.installConsent?.packageVersion === keepInstallConsentFor
      ? { installConsent: { packageVersion: keepInstallConsentFor } }
      : { consentRevoked: true as const }
    // Restricting: even if the file cannot be written, nothing stays granted
    // for the rest of this run. The mark is written even with no record, so
    // the next start asks instead of counting the install as consent.
    this.update(pluginId, () => ({ ...(current?.disabled ? { disabled: true as const } : {}), ...kept }), true)
  }

  /** Uninstall: forget every decision about the plugin. */
  forget(pluginId: string): void {
    if (!this.state.plugins[pluginId]) return
    this.update(pluginId, () => ({}))
  }
}
