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

const OPT_OUTS_FILE = '.navide-factory-plugin-opt-outs.json'

interface PersistedFactoryOptOutState {
  schemaVersion: 1
  pluginIds: string[]
}

interface ParsedFactoryOptOutState {
  state: PersistedFactoryOptOutState
  valid: boolean
}

function parseState(path: string): ParsedFactoryOptOutState {
  if (!existsSync(path)) {
    return { state: { schemaVersion: 1, pluginIds: [] }, valid: true }
  }
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe opt-out store')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid state')
    const state = parsed as Record<string, unknown>
    if (
      state.schemaVersion !== 1 ||
      !Array.isArray(state.pluginIds) ||
      state.pluginIds.some((id) => typeof id !== 'string' || id.length === 0)
    ) {
      throw new Error('invalid state')
    }
    return {
      state: { schemaVersion: 1, pluginIds: [...new Set(state.pluginIds)] },
      valid: true,
    }
  } catch {
    return { state: { schemaVersion: 1, pluginIds: [] }, valid: false }
  }
}

/** What a read of the store found. `restored`: the file was unreadable and
 *  was rebuilt from its `.bak` this session. `unreadable`: neither the file
 *  nor its `.bak` could be read; nothing was changed on disk. */
export type PluginIdStoreStatus = 'ok' | 'restored' | 'unreadable'

interface StoreRead {
  state: PersistedFactoryOptOutState
  status: PluginIdStoreStatus
}

function fileStamp(path: string): string {
  try {
    const entry = lstatSync(path)
    return `${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.isFile() ? 'f' : 'x'}`
  } catch {
    return 'absent'
  }
}

/** Last read per store file in this process, valid while neither the file nor
 *  its `.bak` changed on disk (checked with one lstat each, no read or parse).
 *  A write by any instance in this process replaces the entry. */
const readCache = new Map<string, { stamp: string; read: StoreRead }>()
/** Store files this process rebuilt from their `.bak`. */
const restoredFiles = new Set<string>()
/** Store files last read as unreadable, warned about once until they read again. */
const unreadableFiles = new Set<string>()

export class PluginFactoryOptOutStore {
  private readonly file: string
  private readonly backup: string

  constructor(private readonly root: string, fileName = OPT_OUTS_FILE) {
    this.file = join(root, fileName)
    this.backup = `${this.file}.bak`
  }

  /** What `has()` answers for any id while the store cannot be read at all.
   *  The factory opt-outs read as empty, as they always have. */
  protected unreadableAnswer(_pluginId: string): boolean {
    return false
  }

  has(pluginId: string): boolean {
    const read = this.read()
    if (read.status === 'unreadable') {
      // Once per change of state: the built-in switch checks every 15 s.
      if (!unreadableFiles.has(this.file)) {
        unreadableFiles.add(this.file)
        console.warn(`[plugins] unreadable plugin id store at ${this.file} and its backup`)
      }
      return this.unreadableAnswer(pluginId)
    }
    if (unreadableFiles.delete(this.file)) {
      console.warn(`[plugins] plugin id store at ${this.file} is readable again`)
    }
    return read.state.pluginIds.includes(pluginId)
  }

  /** Whether the last read was normal, restored from the backup, or failed. */
  status(): PluginIdStoreStatus {
    const read = this.read()
    if (read.status === 'unreadable') return 'unreadable'
    return restoredFiles.has(this.file) ? 'restored' : 'ok'
  }

  add(pluginId: string): void {
    if (!pluginId) throw new Error('invalid plugin id')
    const state = this.writableState()
    if (state.pluginIds.includes(pluginId)) return
    this.write({ schemaVersion: 1, pluginIds: [...state.pluginIds, pluginId] })
  }

  remove(pluginId: string): void {
    const state = this.writableState()
    const pluginIds = state.pluginIds.filter((id) => id !== pluginId)
    if (pluginIds.length === state.pluginIds.length) return
    this.write({ schemaVersion: 1, pluginIds })
  }

  /** The user's explicit reset of a store that cannot be read: both files are
   *  kept aside as `.corrupt-<time>` and a fresh, empty store is written. */
  resetUnreadable(): void {
    if (this.read().status !== 'unreadable') return
    this.setAside(this.file)
    this.setAside(this.backup)
    this.write({ schemaVersion: 1, pluginIds: [] })
  }

  /** The state a change may build on. An unreadable store is never
   *  overwritten: the change is refused, so no other plugin's entry is lost. */
  private writableState(): PersistedFactoryOptOutState {
    const read = this.read()
    if (read.status === 'unreadable') {
      throw new Error(`plugin id store at ${this.file} is unreadable; reset it in Settings → Navide Plugins`)
    }
    return read.state
  }

  private read(): StoreRead {
    const stamp = `${fileStamp(this.file)}|${fileStamp(this.backup)}`
    const cached = readCache.get(this.file)
    if (cached && cached.stamp === stamp) return cached.read
    const read = this.readFromDisk()
    readCache.set(this.file, { stamp: `${fileStamp(this.file)}|${fileStamp(this.backup)}`, read })
    return read
  }

  private readFromDisk(): StoreRead {
    const mainPresent = existsSync(this.file)
    const main = parseState(this.file)
    if (main.valid && mainPresent) return { state: main.state, status: 'ok' }
    const backupPresent = existsSync(this.backup)
    if (!mainPresent && !backupPresent) return { state: main.state, status: 'ok' }
    const backup = backupPresent ? parseState(this.backup) : null
    if (backup?.valid) {
      // Rebuild the store from its backup; an unreadable file is kept aside,
      // never overwritten.
      try {
        if (mainPresent) this.setAside(this.file)
        this.write(backup.state)
        restoredFiles.add(this.file)
        console.warn(`[plugins] plugin id store at ${this.file} was restored from its backup`)
      } catch (error) {
        console.warn(`[plugins] restoring ${this.file} from its backup failed: ${String(error)}`)
      }
      return { state: backup.state, status: 'ok' }
    }
    // Neither copy can be read. Nothing on disk is touched until the user resets.
    return { state: { schemaVersion: 1, pluginIds: [] }, status: 'unreadable' }
  }

  private setAside(path: string): void {
    if (!existsSync(path)) return
    renameSync(path, `${path}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`)
  }

  private write(state: PersistedFactoryOptOutState): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    // The file first, then its backup, each written whole and renamed in.
    this.writeAtomically(this.file, state)
    this.writeAtomically(this.backup, state)
    readCache.set(this.file, {
      stamp: `${fileStamp(this.file)}|${fileStamp(this.backup)}`,
      read: { state: { schemaVersion: 1, pluginIds: [...state.pluginIds] }, status: 'ok' },
    })
  }

  private writeAtomically(target: string, state: PersistedFactoryOptOutState): void {
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
      chmodSync(temporary, 0o600)
      fsyncFileSync(temporary)
      renameSync(temporary, target)
      chmodSync(target, 0o600)
      syncDirectorySync(this.root)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
