/**
 * "Undo create" for the Memory page: move an instruction file Navide created
 * to the system Trash.
 *
 * The backend writes these files but cannot reach the Trash, so the move
 * happens here. What may be moved is decided by the backend's own record, not
 * by the renderer: when `native_memory.save` creates a file it keeps
 * `<data dir>/memory-backups/<key>.created.json` with the path and the exact
 * text it wrote, and only a path with such a record is accepted. That save
 * went through the backend's allow-list, so this stays inside it too.
 *
 * Never a permanent delete: when the Trash refuses, the file stays put and
 * the caller gets the reason.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Under the backend data dir; equal to `native_memory.BACKUP_DIR_NAME`. */
export const MEMORY_BACKUP_DIR = 'memory-backups'

export type TrashCreatedResult =
  | { ok: true }
  /** The file is no longer what Navide wrote; nothing was moved. */
  | { ok: false; code: 'changed'; created: string; current: string }
  | { ok: false; code: 'not-created' | 'missing' | 'trash-failed'; error: string }

/** The record file for `path`; the key matches `native_memory._backup_paths`. */
export function createdRecordPath(dataDir: string, path: string): string {
  const key = createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 32)
  return join(dataDir, MEMORY_BACKUP_DIR, `${key}.created.json`)
}

interface CreatedRecord {
  text: string
  sha256: string
}

function readRecord(recordPath: string, path: string): CreatedRecord | null {
  try {
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
    if (record.path !== path) return null
    if (typeof record.text !== 'string' || typeof record.sha256 !== 'string') return null
    return { text: record.text, sha256: record.sha256 }
  } catch {
    return null
  }
}

/**
 * Move `path` to the Trash if Navide created it. A file that changed since is
 * moved only with `acceptChanged`, after the user has seen the difference.
 */
export async function trashCreatedMemoryFile(
  dataDir: string,
  path: string,
  acceptChanged: boolean,
  trashItem: (path: string) => Promise<void>,
): Promise<TrashCreatedResult> {
  const recordPath = createdRecordPath(dataDir, path)
  const record = typeof path === 'string' && path ? readRecord(recordPath, path) : null
  if (!record) {
    return { ok: false, code: 'not-created', error: 'Navide did not create this file.' }
  }
  let current: Buffer
  try {
    if (!lstatSync(path).isFile()) {
      return { ok: false, code: 'missing', error: 'The file is no longer a regular file.' }
    }
    current = readFileSync(path)
  } catch {
    return { ok: false, code: 'missing', error: 'The file no longer exists.' }
  }
  const unchanged = createHash('sha256').update(current).digest('hex') === record.sha256
  if (!unchanged && !acceptChanged) {
    return { ok: false, code: 'changed', created: record.text, current: current.toString('utf8') }
  }
  try {
    await trashItem(path)
  } catch (err) {
    return {
      ok: false,
      code: 'trash-failed',
      error: `The Trash is unavailable, so the file was left in place: ${String((err as Error)?.message ?? err)}`,
    }
  }
  rmSync(recordPath, { force: true })
  return { ok: true }
}
