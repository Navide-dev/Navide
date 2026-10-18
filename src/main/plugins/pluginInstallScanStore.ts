import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fsyncFileSync, syncDirectorySync } from './fsSync'
import type { ScanReport } from '../../shared/pluginDisclosureScan'
import { scanReport } from './marketplaceQuery'

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
  /** When each id was installed since its last removal (Unix ms; #373's
   *  report request `installedAt`). Not changed by updates or rollbacks. */
  installedAt: Record<string, number>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function readState(path: string): PersistedState {
  const empty: PersistedState = { schemaVersion: 1, plugins: {}, installedAt: {} }
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
        if (!isRecord(record) || !Array.isArray(record.noticed)) continue
        // Rebuilt from validated fields; a record whose scan is not a valid
        // report reads as no record (review L2 on #371).
        const scan = scanReport(record.scan)
        if (!scan) continue
        const noticed = record.noticed.filter((digest): digest is string => typeof digest === 'string')
        ;(plugins[id] ??= {})[version] = { scan, noticed }
      }
    }
    const installedAt: PersistedState['installedAt'] = {}
    if (isRecord(parsed.installedAt)) {
      for (const [id, at] of Object.entries(parsed.installedAt)) {
        if (typeof at === 'number' && Number.isSafeInteger(at) && at >= 0) installedAt[id] = at
      }
    }
    return { schemaVersion: 1, plugins, installedAt }
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

  /** When this id was installed since its last removal, or null when unknown
   *  (installed before this was recorded). */
  installedAt(pluginId: string): number | null {
    return readState(this.file).installedAt[pluginId] ?? null
  }

  /** Record a fresh install's time; an existing time is kept (updates and
   *  rollbacks never call this, and a second call changes nothing). */
  markInstalled(pluginId: string, at: number): void {
    const state = readState(this.file)
    if (pluginId in state.installedAt) return
    state.installedAt[pluginId] = at
    this.write(state)
  }

  removePlugin(pluginId: string): void {
    const state = readState(this.file)
    if (!(pluginId in state.plugins) && !(pluginId in state.installedAt)) return
    delete state.plugins[pluginId]
    delete state.installedAt[pluginId]
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
