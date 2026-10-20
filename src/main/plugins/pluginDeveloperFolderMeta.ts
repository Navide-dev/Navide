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
import { join, resolve } from 'node:path'
import { fsyncFileSync, syncDirectorySync } from './fsSync'
import { canonicalContractJson } from '../../shared/pluginDisclosure'

// What Navide discloses about each developer folder beyond its consent
// (DESIGN-A2 §2.0): who had it loaded, whether it reloads on file changes,
// and its last load. It lives beside the Developer Mode store, never in it:
// that store accepts exactly four fields per folder, so a release that does
// not know this file keeps reading the store as before (downgrade-safe).
// Disclosure only: nothing here decides whether a folder loads, so a missing
// or damaged file shows "unknown", and a write that fails never blocks a load.
// Review MED-1 on #536: who loaded a folder is signed with the Developer
// Mode store's key (G5). A loader another program wrote, or one without a
// signature, reads as "unknown, the record may have been changed"; the load
// is not affected. Without secure storage there is no key and the record
// reads as written, as the Developer Mode store does then.
const DEVELOPER_FOLDER_META_FILE = '.navide-plugin-developer-folders-meta.json'

/** Who had a developer folder loaded: the user's own pick in the main window,
 *  or an agent's request the user approved there. `unknown` is a folder
 *  consented to before this record existed. */
export type DeveloperFolderLoadedBy =
  | { kind: 'user' }
  | { kind: 'agent'; callerKind: string; paneName?: string; approvedAt: string }
  | { kind: 'unknown' }

export type DeveloperFolderLoadTrigger =
  | 'user-load'
  | 'manual-reload'
  | 'auto-reload'
  | 'startup'
  | 'developer-mode-on'

export interface DeveloperFolderLastLoad {
  at: string
  trigger: DeveloperFolderLoadTrigger
  /** Content fingerprint of what was loaded (A2-3); disclosed, never compared. */
  fingerprint?: string
  fileCount?: number
}

/** Signs the loader record; the Developer Mode store with its key. */
export interface DeveloperFolderRecordSigner {
  entryMac(entry: string): string | null
}

export interface DeveloperFolderMeta {
  path: string
  loadedBy: DeveloperFolderLoadedBy
  /** HMAC of the loader record (pluginId, folder, loadedBy). */
  loadedByMac?: string
  /** Set on read when the loader did not verify; never stored. */
  loadedByUnverified?: true
  /** Reload when a file in the folder changes (A2-4); on unless turned off. */
  autoReload: boolean
  lastLoad?: DeveloperFolderLastLoad
}

interface PersistedFolderMeta {
  schemaVersion: 1
  folders: Record<string, DeveloperFolderMeta>
}

const TRIGGERS: ReadonlySet<string> = new Set([
  'user-load', 'manual-reload', 'auto-reload', 'startup', 'developer-mode-on',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function validLoadedBy(value: unknown): value is DeveloperFolderLoadedBy {
  if (!isRecord(value)) return false
  if (value.kind === 'user' || value.kind === 'unknown') return true
  return value.kind === 'agent' &&
    typeof value.callerKind === 'string' &&
    (value.paneName === undefined || typeof value.paneName === 'string') &&
    typeof value.approvedAt === 'string'
}

function validLastLoad(value: unknown): value is DeveloperFolderLastLoad {
  return isRecord(value) &&
    typeof value.at === 'string' &&
    typeof value.trigger === 'string' && TRIGGERS.has(value.trigger) &&
    (value.fingerprint === undefined || typeof value.fingerprint === 'string') &&
    (value.fileCount === undefined || typeof value.fileCount === 'number')
}

function validMeta(value: unknown): value is DeveloperFolderMeta {
  return isRecord(value) &&
    typeof value.path === 'string' && value.path.length > 0 &&
    validLoadedBy(value.loadedBy) &&
    (value.loadedByMac === undefined || typeof value.loadedByMac === 'string') &&
    typeof value.autoReload === 'boolean' &&
    (value.lastLoad === undefined || validLastLoad(value.lastLoad))
}

/** Read entry by entry: one damaged folder entry leaves the others shown. */
function readFolders(path: string): Record<string, DeveloperFolderMeta> {
  if (!existsSync(path)) return {}
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.folders)) return {}
    const folders: Record<string, DeveloperFolderMeta> = {}
    for (const [pluginId, meta] of Object.entries(parsed.folders)) {
      if (validMeta(meta)) folders[pluginId] = meta
    }
    return folders
  } catch {
    return {}
  }
}

export class PluginDeveloperFolderMetaStore {
  private readonly file: string

  constructor(private readonly root: string, private readonly signer?: DeveloperFolderRecordSigner) {
    this.file = join(root, DEVELOPER_FOLDER_META_FILE)
  }

  /** The record of `pluginId` loaded from `path`; a record of another folder
   *  is stale and reads as the default. A loader that does not verify reads
   *  as unknown and says so. */
  get(pluginId: string, path: string): DeveloperFolderMeta {
    const { loadedByMac, ...meta } = this.stored(pluginId, path)
    const expected = this.loaderMac(pluginId, path, meta.loadedBy)
    if (expected === null || meta.loadedBy.kind === 'unknown' || loadedByMac === expected) return meta
    return { ...meta, loadedBy: { kind: 'unknown' }, loadedByUnverified: true }
  }

  setLoadedBy(pluginId: string, path: string, loadedBy: DeveloperFolderLoadedBy): void {
    const loadedByMac = this.loaderMac(pluginId, path, loadedBy)
    this.update(pluginId, path, ({ loadedByMac: _old, ...meta }) => ({ ...meta, loadedBy, ...(loadedByMac ? { loadedByMac } : {}) }))
  }

  private stored(pluginId: string, path: string): DeveloperFolderMeta {
    const meta = readFolders(this.file)[pluginId]
    if (meta && resolve(meta.path) === resolve(path)) return structuredClone(meta)
    return { path, loadedBy: { kind: 'unknown' }, autoReload: true }
  }

  private loaderMac(pluginId: string, path: string, loadedBy: DeveloperFolderLoadedBy): string | null {
    try {
      return this.signer?.entryMac(canonicalContractJson({ pluginId, path: resolve(path), loadedBy })) ?? null
    } catch {
      return null
    }
  }

  setAutoReload(pluginId: string, path: string, autoReload: boolean): void {
    this.update(pluginId, path, (meta) => ({ ...meta, autoReload }))
  }

  recordLoad(pluginId: string, path: string, lastLoad: DeveloperFolderLastLoad): void {
    this.update(pluginId, path, (meta) => ({ ...meta, lastLoad }))
  }

  forget(pluginId: string): void {
    const folders = readFolders(this.file)
    if (!(pluginId in folders)) return
    delete folders[pluginId]
    this.write({ schemaVersion: 1, folders })
  }

  private update(pluginId: string, path: string, change: (meta: DeveloperFolderMeta) => DeveloperFolderMeta): void {
    const folders = readFolders(this.file)
    folders[pluginId] = change(this.stored(pluginId, path))
    this.write({ schemaVersion: 1, folders })
  }

  /** Best effort (review MED-2 on #536): the record only discloses, so a
   *  write that fails (disk full, permissions, a directory where the file
   *  belongs) is logged and never fails the load or consent around it. */
  private write(state: PersistedFolderMeta): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
      chmodSync(temporary, 0o600)
      fsyncFileSync(temporary)
      renameSync(temporary, this.file)
      chmodSync(this.file, 0o600)
      syncDirectorySync(this.root)
    } catch (error) {
      console.warn(`[plugins] developer folder record not saved at ${this.file}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
