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
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fsyncFileSync, syncDirectorySync } from './fsSync'
import { canonicalContractJson } from '../../shared/pluginDisclosure'

// The Developer Mode switch (DX report A2, card K4) and the developer folders
// the user consented to. The main process owns this file; inside Navide the
// renderer can only ask the main window's settings page to change it, so no
// plugin frame, sandboxed plugin backend or page script can turn it on. The
// file itself is unsigned and only shape-checked: any unsandboxed process of
// the same user, an agent CLI included, can write it to turn Developer Mode
// on and add a consented folder, without an activity log entry (disclosed in
// plugin-development-v2.md; Navide Guard grades an agent's write to it as
// critical where its hooks run; a signed consent is 0.2.27). Off by default:
// a missing or unreadable file means Developer Mode is off and no folder is
// loaded.
const DEVELOPER_MODE_FILE = '.navide-plugin-developer-mode.json'

/** One developer folder and the permission set the user consented to. The
 * consent is bound to the folder and the manifest's `permissions` and
 * `backend` declarations, not to file content, which changes all the time
 * during development. */
export interface DeveloperFolderConsent {
  path: string
  pluginId: string
  /** sha256 hex of the canonical `{permissions, backend}` of the manifest. */
  permissionsDigest: string
  consentedAt: string
}

interface PersistedDeveloperModeState {
  schemaVersion: 1
  enabled: boolean
  folders: DeveloperFolderConsent[]
}

const EMPTY: PersistedDeveloperModeState = { schemaVersion: 1, enabled: false, folders: [] }

function validFolder(value: unknown): value is DeveloperFolderConsent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const folder = value as Record<string, unknown>
  return (
    Object.keys(folder).length === 4 &&
    typeof folder.path === 'string' && folder.path.length > 0 &&
    typeof folder.pluginId === 'string' && folder.pluginId.length > 0 &&
    typeof folder.permissionsDigest === 'string' && /^[0-9a-f]{64}$/.test(folder.permissionsDigest) &&
    typeof folder.consentedAt === 'string'
  )
}

function readState(path: string): { state: PersistedDeveloperModeState; valid: boolean } {
  if (!existsSync(path)) return { state: EMPTY, valid: true }
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe developer mode store')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid state')
    const state = parsed as Record<string, unknown>
    if (
      state.schemaVersion !== 1 ||
      typeof state.enabled !== 'boolean' ||
      !Array.isArray(state.folders) ||
      !state.folders.every(validFolder)
    ) {
      throw new Error('invalid state')
    }
    return { state: { schemaVersion: 1, enabled: state.enabled, folders: state.folders as DeveloperFolderConsent[] }, valid: true }
  } catch {
    return { state: EMPTY, valid: false }
  }
}

/** What a developer folder's consent covers: its declared permissions and
 * backend, canonically encoded. Any change to either asks again. */
export function developerPermissionsDigest(manifest: { permissions?: unknown; backend?: unknown }): string {
  return createHash('sha256')
    .update(canonicalContractJson({ permissions: manifest.permissions ?? null, backend: manifest.backend ?? null }))
    .digest('hex')
}

export class PluginDeveloperModeStore {
  private readonly file: string

  constructor(private readonly root: string) {
    this.file = join(root, DEVELOPER_MODE_FILE)
  }

  /** The switch; off when the file is missing or unusable. */
  isEnabled(): boolean {
    return this.read().enabled
  }

  setEnabled(enabled: boolean): void {
    const current = this.read()
    if (current.enabled === enabled) return
    this.write({ ...current, enabled })
  }

  folders(): DeveloperFolderConsent[] {
    return this.read().folders.map((folder) => ({ ...folder }))
  }

  folder(pluginId: string): DeveloperFolderConsent | undefined {
    return this.folders().find((folder) => folder.pluginId === pluginId)
  }

  /** Record (or replace) the consent for one plugin id's developer folder. */
  consent(folder: DeveloperFolderConsent): void {
    const current = this.read()
    this.write({
      ...current,
      folders: [...current.folders.filter((entry) => entry.pluginId !== folder.pluginId), { ...folder }],
    })
  }

  forget(pluginId: string): void {
    const current = this.read()
    if (!current.folders.some((entry) => entry.pluginId === pluginId)) return
    this.write({ ...current, folders: current.folders.filter((entry) => entry.pluginId !== pluginId) })
  }

  private read(): PersistedDeveloperModeState {
    const parsed = readState(this.file)
    if (!parsed.valid) console.warn(`[plugins] invalid Developer Mode settings at ${this.file}; Developer Mode is off`)
    return parsed.state
  }

  private write(state: PersistedDeveloperModeState): void {
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

/** The digest a developer folder's native backend consent is bound to: the
 * folder and its consented permission set, never its content. Null for any
 * package that is not a consented developer folder. */
export function developerFolderBackendDigest(
  folders: readonly DeveloperFolderConsent[],
  spec: { pluginId: string; packageDir: string },
): string | null {
  const folder = folders.find((entry) => entry.pluginId === spec.pluginId && resolve(entry.path) === resolve(spec.packageDir))
  if (!folder) return null
  return createHash('sha256')
    .update(`developer-folder\u0000${resolve(folder.path)}\u0000${folder.permissionsDigest}`)
    .digest('hex')
}
