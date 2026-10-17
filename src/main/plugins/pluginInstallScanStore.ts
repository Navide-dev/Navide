import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fsyncFileSync, syncDirectorySync } from './fsSync'
import type { ScanReport } from '../../shared/pluginDisclosureScan'

// Plan B D-f: the scan report prepareInstall verified, kept per installed
// version so the periodic update check can tell the user when a rescan of
// that version finds new items. A record only: it decides nothing about
// install, trust or what a plugin may do. A missing or unreadable file is
// empty. Removing a plugin removes its records.
const INSTALL_SCANS_FILE = '.navide-install-scans.json'

interface VersionRecord {
  scan: ScanReport
  /** scanDigests of rescans the user was already told about. */
  noticed: string[]
}

interface PersistedState {
  schemaVersion: 1
  plugins: Record<string, Record<string, VersionRecord>>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function readState(path: string): PersistedState {
  const empty: PersistedState = { schemaVersion: 1, plugins: {} }
  if (!existsSync(path)) return empty
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) return empty
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.plugins)) return empty
    const plugins: PersistedState['plugins'] = {}
    for (const [id, versions] of Object.entries(parsed.plugins)) {
      if (!isRecord(versions)) continue
      for (const [version, record] of Object.entries(versions)) {
        if (!isRecord(record) || !isRecord(record.scan) || !Array.isArray(record.noticed)) continue
        const noticed = record.noticed.filter((digest): digest is string => typeof digest === 'string')
        ;(plugins[id] ??= {})[version] = { scan: record.scan as unknown as ScanReport, noticed }
      }
    }
    return { schemaVersion: 1, plugins }
  } catch {
    return empty
  }
}

export class PluginInstallScanStore {
  private readonly file: string

  constructor(private readonly root: string) {
    this.file = join(root, INSTALL_SCANS_FILE)
  }

  /** The scan verified when `version` was installed, or null. */
  get(pluginId: string, version: string): ScanReport | null {
    return readState(this.file).plugins[pluginId]?.[version]?.scan ?? null
  }

  record(pluginId: string, version: string, scan: ScanReport): void {
    const state = readState(this.file)
    ;(state.plugins[pluginId] ??= {})[version] = { scan, noticed: [] }
    this.write(state)
  }

  /** Drop records of versions no longer on disk (not active, previous or staged). */
  keepVersions(pluginId: string, versions: readonly string[]): void {
    const state = readState(this.file)
    const current = state.plugins[pluginId]
    if (!current) return
    const kept = Object.fromEntries(Object.entries(current).filter(([version]) => versions.includes(version)))
    if (Object.keys(kept).length === Object.keys(current).length) return
    if (Object.keys(kept).length === 0) delete state.plugins[pluginId]
    else state.plugins[pluginId] = kept
    this.write(state)
  }

  /** True the first time a rescan with `digest` is seen for a recorded version. */
  noticeOnce(pluginId: string, version: string, digest: string): boolean {
    const state = readState(this.file)
    const record = state.plugins[pluginId]?.[version]
    if (!record || record.noticed.includes(digest)) return false
    record.noticed.push(digest)
    this.write(state)
    return true
  }

  removePlugin(pluginId: string): void {
    const state = readState(this.file)
    if (!(pluginId in state.plugins)) return
    delete state.plugins[pluginId]
    this.write(state)
  }

  private write(state: PersistedState): void {
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
