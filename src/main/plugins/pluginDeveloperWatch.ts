import { statSync, watch } from 'node:fs'
import { join, sep } from 'node:path'

// DESIGN-A2 G1: reload a developer folder when a file in it changes. The
// watch only says "something changed"; what a reload may do (load again, or
// stop at "needs consent" when permissions or the backend changed) is
// decided by the same checks as the Reload button. Nothing here limits how
// many files, folders or events there are: a burst of events is merged into
// one call after it settles.

export interface FolderWatch {
  close(): void
}

/** Watches `dir` and calls `onChange` once a burst of changes settles;
 *  `onError` when the watch stops working (the folder went, the system ran
 *  out of watches), after which it calls nothing more. */
export type WatchDeveloperFolder = (dir: string, onChange: () => void, onError?: (error: Error) => void) => FolderWatch

/** How long a folder must be quiet before one reload runs: one save often
 *  writes several files and events. Merges events; drops none. */
export const DEVELOPER_FOLDER_SETTLE_MS = 400

/** Version control writes are not plugin content and come in large bursts. */
export function ignoredDeveloperFolderChange(relativePath: string | null): boolean {
  if (!relativePath) return false
  const parts = relativePath.split(/[\\/]/)
  return parts.includes('.git')
}

/** Plan 4a05af P1: a build that writes this file into the folder last marks
 *  its output complete. Once the folder has it, only a newer copy of it
 *  reloads, so a build still writing never loads half its files. A folder
 *  without it reloads on any change, as before. */
export const DEVELOPER_FOLDER_BUILD_MARKER = '.navide-build-complete'

/** Decides, per change event, whether `dir` may reload: always until the
 *  marker is seen (at the start or later), then only when its modification
 *  time has moved since the last reload it allowed. */
export function developerFolderBuildGate(dir: string): () => boolean {
  const stamp = (): number | null => {
    try {
      return statSync(join(dir, DEVELOPER_FOLDER_BUILD_MARKER)).mtimeMs
    } catch {
      return null
    }
  }
  let marked = stamp() !== null
  let last = stamp()
  return () => {
    const now = stamp()
    if (!marked) {
      if (now === null) return true
      marked = true
    }
    if (now === null || now === last) return false
    last = now
    return true
  }
}

export const watchDeveloperFolder: WatchDeveloperFolder = (dir, onChange, onError) => {
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  const buildComplete = developerFolderBuildGate(dir)
  const watcher = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
    const relative = filename === null ? null : String(filename).split(sep).join('/')
    if (closed || ignoredDeveloperFolderChange(relative) || !buildComplete()) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!closed) onChange()
    }, DEVELOPER_FOLDER_SETTLE_MS)
  })
  // A folder that disappears ends its watch; the Host says so on the card.
  watcher.on('error', (error) => {
    console.warn(`[plugins] watching developer folder ${dir} stopped: ${error instanceof Error ? error.message : String(error)}`)
    closed = true
    if (timer) clearTimeout(timer)
    onError?.(error instanceof Error ? error : new Error(String(error)))
  })
  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      watcher.close()
    },
  }
}
