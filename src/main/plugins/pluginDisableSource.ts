import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fsyncFileSync, syncDirectorySync } from './fsSync'
import { DISABLED_PLUGINS_FILE } from './pluginDisabledStore'

export const DISABLE_SOURCES_FILE = '.navide-disabled-source.json'

/** The agent that disabled a package, as the backend resolved it from its MCP credential. */
export interface DisablingAgent {
  callerKind: 'pane' | 'external' | 'host'
  paneId: string | null
  paneName: string | null
}

/** Who disabled an installed Marketplace package, and when. */
export interface DisableSource {
  by: 'user' | 'agent'
  /** Unix time in milliseconds; null for a package disabled before this was recorded. */
  at: number | null
  agent: DisablingAgent | null
}

/** What a disabled package with no entry counts as: the user, with no time
 *  (a package disabled before sources were recorded, or an entry lost). The
 *  conservative answer: an agent cannot turn it back on by itself. */
export const UNKNOWN_DISABLE_SOURCE: DisableSource = { by: 'user', at: null, agent: null }

/** A source as kept on disk: with the Disabled list's state when it was written. */
type StoredSource = DisableSource & { list?: string }

interface PersistedSources {
  schemaVersion: 1
  sources: Record<string, StoredSource>
}

function isAgent(value: unknown): value is DisablingAgent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const text = (v: unknown): boolean => v === null || typeof v === 'string'
  return ['pane', 'external', 'host'].includes(String(record.callerKind)) && text(record.paneId) && text(record.paneName)
}

function isSource(value: unknown): value is DisableSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const at = record.at === null || (typeof record.at === 'number' && Number.isFinite(record.at))
  if (record.by === 'user') return at && record.agent === null
  return record.by === 'agent' && at && isAgent(record.agent)
}

/**
 * Who disabled each installed Marketplace package (plan B, B2-c option B): the
 * user (Extensions switch, or the undo on an agent notice) or an agent
 * (plugins_disable). Kept beside the Disabled list, whose file format older
 * Navide versions read and which therefore stays as it is. Only an entry
 * saying "agent" lets an agent enable the package again by itself; a missing,
 * unreadable or malformed entry reads as the user.
 *
 * An entry is written right after the Disabled list changed, with that list
 * file's state (inode, size, modification time). An "agent" entry whose list
 * state no longer matches reads as the user: the list changed since, by this
 * version or by an older one that does not know this file, so the entry may
 * describe a disable that is gone.
 */
export class PluginDisableSourceStore {
  private readonly file: string

  constructor(private readonly root: string) {
    this.file = join(root, DISABLE_SOURCES_FILE)
  }

  /** Who disabled `pluginId`; UNKNOWN_DISABLE_SOURCE when not recorded. */
  get(pluginId: string): DisableSource {
    const source = this.read().sources[pluginId]
    if (!source || (source.by === 'agent' && source.list !== this.listState())) return UNKNOWN_DISABLE_SOURCE
    return { by: source.by, at: source.at, agent: source.agent ? { ...source.agent } : null }
  }

  set(pluginId: string, source: DisableSource): void {
    const state = this.read()
    const stored: StoredSource = { by: source.by, at: source.at, agent: source.agent, list: this.listState() }
    this.write({ schemaVersion: 1, sources: { ...state.sources, [pluginId]: stored } })
  }

  remove(pluginId: string): void {
    const state = this.read()
    if (!(pluginId in state.sources)) return
    const sources = { ...state.sources }
    delete sources[pluginId]
    this.write({ schemaVersion: 1, sources })
  }

  /** The Disabled list file's state; it changes with every write of the list. */
  private listState(): string {
    try {
      const entry = lstatSync(join(this.root, DISABLED_PLUGINS_FILE), { bigint: true })
      return `${entry.ino}:${entry.size}:${entry.mtimeNs}`
    } catch {
      return 'absent'
    }
  }

  private read(): PersistedSources {
    const empty: PersistedSources = { schemaVersion: 1, sources: {} }
    if (!existsSync(this.file)) return empty
    try {
      const entry = lstatSync(this.file)
      if (!entry.isFile() || entry.isSymbolicLink()) return empty
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty
      const record = parsed as Record<string, unknown>
      if (record.schemaVersion !== 1 || typeof record.sources !== 'object' || record.sources === null) return empty
      const sources: Record<string, StoredSource> = {}
      for (const [id, value] of Object.entries(record.sources as Record<string, unknown>)) {
        if (id && isSource(value)) {
          const list = (value as { list?: unknown }).list
          sources[id] = { ...value, list: typeof list === 'string' ? list : undefined }
        }
      }
      return { schemaVersion: 1, sources }
    } catch {
      // Unreadable: every package reads as disabled by the user.
      return empty
    }
  }

  private write(state: PersistedSources): void {
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
