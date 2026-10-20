import { watch } from 'node:fs'
import { sep } from 'node:path'

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

export const watchDeveloperFolder: WatchDeveloperFolder = (dir, onChange, onError) => {
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  const watcher = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
    const relative = filename === null ? null : String(filename).split(sep).join('/')
    if (closed || ignoredDeveloperFolderChange(relative)) return
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
