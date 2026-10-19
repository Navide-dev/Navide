import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fsyncFileSync, syncDirectorySync } from './fsSync'
import type { HostCapabilityGrant } from './pluginCapabilityBroker'

const GRANTS_FILE = '.navide-capability-grants.json'
const SYSTEM_NAMESPACES = new Set(['fs', 'ui', 'aiCli', 'web'])

interface PersistedGrantState {
  schemaVersion: 1
  grants: Record<string, HostCapabilityGrant>
}

function validGrant(value: unknown): value is HostCapabilityGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const grant = value as Record<string, unknown>
  const keys = Object.keys(grant)
  if (keys.some((key) => !['packageVersion', 'system', 'shell', 'highRiskShellConfirmed', 'storage'].includes(key))) {
    return false
  }
  if (typeof grant.packageVersion !== 'string' || grant.packageVersion.length === 0) return false
  if (
    !Array.isArray(grant.system) ||
    grant.system.some((namespace) => typeof namespace !== 'string' || !SYSTEM_NAMESPACES.has(namespace))
  ) return false
  if (new Set(grant.system).size !== grant.system.length) return false
  if (grant.shell !== undefined && grant.shell !== 'allowlist' && grant.shell !== 'full') return false
  if (grant.highRiskShellConfirmed !== undefined && typeof grant.highRiskShellConfirmed !== 'boolean') return false
  if (grant.storage !== undefined && typeof grant.storage !== 'boolean') return false
  return true
}

function parseState(path: string): PersistedGrantState {
  if (!existsSync(path)) return { schemaVersion: 1, grants: {} }
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe grant store')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid state')
    const state = parsed as Record<string, unknown>
    if (state.schemaVersion !== 1 || !state.grants || typeof state.grants !== 'object' || Array.isArray(state.grants)) {
      throw new Error('invalid state')
    }
    const grants: Record<string, HostCapabilityGrant> = {}
    for (const [pluginId, grant] of Object.entries(state.grants as Record<string, unknown>)) {
      if (!pluginId || !validGrant(grant)) throw new Error('invalid grant')
      grants[pluginId] = grant
    }
    return { schemaVersion: 1, grants }
  } catch {
    return { schemaVersion: 1, grants: {} }
  }
}

export class PluginCapabilityGrantStore {
  private readonly file: string

  constructor(private readonly root: string) {
    this.file = join(root, GRANTS_FILE)
  }

  get(pluginId: string, packageVersion: string): HostCapabilityGrant | null {
    const grant = parseState(this.file).grants[pluginId]
    if (!grant || grant.packageVersion !== packageVersion) return null
    return {
      ...grant,
      system: [...grant.system],
    }
  }

  set(pluginId: string, grant: HostCapabilityGrant): void {
    if (!pluginId || !validGrant(grant)) throw new Error('invalid capability grant')
    const state = parseState(this.file)
    state.grants[pluginId] = { ...grant, system: [...grant.system] }
    this.write(state)
  }

  remove(pluginId: string): void {
    const state = parseState(this.file)
    if (!(pluginId in state.grants)) return
    delete state.grants[pluginId]
    this.write(state)
  }

  private write(state: PersistedGrantState): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
      chmodSync(temporary, 0o600)
      fsyncFileSync(temporary)
      renameSync(temporary, this.file)
      chmodSync(this.file, 0o600)
      syncDirectorySync(this.root)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
