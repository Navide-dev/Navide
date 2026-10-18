import { lstatSync, readdirSync, rmSync, type Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// A third-party native backend's private data directory (its HOME, TMPDIR and
// XDG_* dirs) is <dataRoot>/<pluginId>/. Removing a plugin may delete exactly
// that directory when the user chooses to. Nothing here follows a symbolic
// link, so the deletion can never reach the user's workspace or any other
// file outside the data root.

export interface NativeBackendDataInfo {
  /** A real (non-symlink) data directory exists for this plugin. */
  exists: boolean
  /** Total size of the regular files in it; symlinks are not followed. */
  bytes: number
  /** Where it lives, shown to the user. */
  path: string
}

/** The plugin's data directory, refusing any id that is not one plain path
 *  component directly under the data root. */
function dataDirFor(dataRoot: string, pluginId: string): string {
  if (
    typeof pluginId !== 'string' ||
    pluginId === '' ||
    pluginId === '.' ||
    pluginId === '..' ||
    /[/\\\0]/.test(pluginId)
  ) {
    throw new Error('invalid plugin id')
  }
  const root = resolve(dataRoot)
  const target = resolve(root, pluginId)
  if (dirname(target) !== root) throw new Error('invalid plugin id')
  return target
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function sizeOf(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += sizeOf(path)
    else if (entry.isFile()) total += lstatSync(path).size
  }
  return total
}

export function inspectNativeBackendData(dataRoot: string, pluginId: string): NativeBackendDataInfo {
  const path = dataDirFor(dataRoot, pluginId)
  const stat = lstatOrNull(path)
  if (!stat || !stat.isDirectory()) return { exists: false, bytes: 0, path }
  return { exists: true, bytes: sizeOf(path), path }
}

/** Delete the plugin's data directory. A missing directory is a no-op; a
 *  symlinked data root or data directory is refused rather than followed. */
export function removeNativeBackendData(dataRoot: string, pluginId: string): void {
  const path = dataDirFor(dataRoot, pluginId)
  const rootStat = lstatOrNull(resolve(dataRoot))
  if (!rootStat) return
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('refusing to delete native backend data: the data root is a symbolic link or not a directory')
  }
  const stat = lstatOrNull(path)
  if (!stat) return
  if (stat.isSymbolicLink()) {
    throw new Error('refusing to delete native backend data: the data directory is a symbolic link')
  }
  if (!stat.isDirectory()) {
    throw new Error('refusing to delete native backend data: the data path is not a directory')
  }
  // rmSync unlinks symlinks found inside the tree; it does not follow them.
  rmSync(path, { recursive: true, force: true })
}
