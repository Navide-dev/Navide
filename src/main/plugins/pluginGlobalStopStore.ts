import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fsyncFileSync, syncDirectorySync } from './fsSync'
import { parsePluginGlobalStopRecord, type PluginGlobalStopRecord } from '../../shared/pluginStop'

export const GLOBAL_STOP_FILE = '.navide-plugins-global-stop.json'

/**
 * Plan P3: the global stop in effect, if any (owner-only, beside the Disabled
 * list). The per-plugin disables and the switches it turned off are kept by
 * their own stores; this file is what lets the status bar say "every
 * third-party plugin is stopped" after a restart, and what "Resume all"
 * reads. A missing, unreadable or malformed file reads as no global stop:
 * the disables and switches it made stay as they are either way.
 */
export class PluginGlobalStopStore {
  private readonly file: string

  constructor(private readonly root: string) {
    this.file = join(root, GLOBAL_STOP_FILE)
  }

  get(): PluginGlobalStopRecord | null {
    if (!existsSync(this.file)) return null
    try {
      const entry = lstatSync(this.file)
      if (!entry.isFile() || entry.isSymbolicLink()) return null
      return parsePluginGlobalStopRecord(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return null
    }
  }

  set(record: PluginGlobalStopRecord): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, ...record })}\n`, { encoding: 'utf8', mode: 0o600 })
      chmodSync(temporary, 0o600)
      fsyncFileSync(temporary)
      renameSync(temporary, this.file)
      chmodSync(this.file, 0o600)
      syncDirectorySync(this.root)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  clear(): void {
    rmSync(this.file, { force: true })
    syncDirectorySync(this.root)
  }
}
