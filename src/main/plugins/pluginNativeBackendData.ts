import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Stats } from 'node:fs'
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
  // Data a source change set aside is the plugin's too, and goes with it.
  const setAside = setAsideNames(dataRoot, pluginId)
    .map((name) => join(resolve(dataRoot), name))
    // Review LOW-9: a set-aside entry that is not a plain directory is never followed.
    .filter((dir) => lstatOrNull(dir)?.isDirectory() === true)
  if ((!stat || !stat.isDirectory()) && setAside.length === 0) return { exists: false, bytes: 0, path }
  const own = stat?.isDirectory() ? sizeOf(path) : 0
  return { exists: true, bytes: setAside.reduce((total, dir) => total + sizeOf(dir), own), path }
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
  rmSync(keptSourcePath(dataRoot, pluginId), { force: true })
  for (const dir of [path, ...setAsideNames(dataRoot, pluginId).map((name) => join(resolve(dataRoot), name))]) {
    const stat = lstatOrNull(dir)
    if (!stat) continue
    if (stat.isSymbolicLink()) {
      throw new Error('refusing to delete native backend data: the data directory is a symbolic link')
    }
    if (!stat.isDirectory()) {
      throw new Error('refusing to delete native backend data: the data path is not a directory')
    }
    // rmSync unlinks symlinks found inside the tree; it does not follow them.
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Every data directory set aside for this plugin (card K3, D7). */
function setAsideNames(dataRoot: string, pluginId: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(resolve(dataRoot))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return entries.filter((name) => SET_ASIDE_RE.exec(name)?.[1] === pluginId)
}

/** Card K3 (D7): which source a set-aside data directory belonged to. */
export type SetAsideSource = 'marketplace' | 'local-unsigned'

const SET_ASIDE_RE = /^(.+)@set-aside-(marketplace|local-unsigned)-(\d+)(?:-(\d+))?$/

/** Move the plugin's data directory aside when a package of another source
 *  replaces it, so the new one starts empty and never reads the old one's
 *  data. The directory is kept, renamed `<id>@set-aside-<source>-<ms>` (no
 *  plugin id contains `@`, so no plugin can claim it as its own); a name that
 *  exists gets a counter, never an overwrite. Returns the new name, or null
 *  when there was nothing to move. Any failure throws: the caller stops. */
export function setAsideNativeBackendData(
  dataRoot: string,
  pluginId: string,
  source: SetAsideSource,
  now = Date.now(),
): string | null {
  const path = dataDirFor(dataRoot, pluginId)
  const stat = lstatOrNull(path)
  if (!stat) return null
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('refusing to set native backend data aside: the data path is not a plain directory')
  }
  const base = `${pluginId}@set-aside-${source}-${now}`
  let name = base
  for (let n = 1; existsSync(join(resolve(dataRoot), name)); n++) name = `${base}-${n}`
  renameSync(path, join(resolve(dataRoot), name))
  return name
}

/** The most recent data directory set aside from `source` for this plugin. */
export function latestSetAsideNativeBackendData(
  dataRoot: string,
  pluginId: string,
  source: SetAsideSource,
): string | null {
  dataDirFor(dataRoot, pluginId)
  let entries: string[]
  try {
    entries = readdirSync(resolve(dataRoot))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const matches = entries
    .map((name) => ({ name, match: SET_ASIDE_RE.exec(name) }))
    .filter((entry) => entry.match?.[1] === pluginId && entry.match[2] === source)
    .filter((entry) => lstatOrNull(join(resolve(dataRoot), entry.name))?.isDirectory() === true)
    .sort((a, b) =>
      Number(a.match![3]) - Number(b.match![3]) || Number(a.match![4] ?? 0) - Number(b.match![4] ?? 0))
  return matches.at(-1)?.name ?? null
}

/** Put a set-aside data directory back as the plugin's own, only when the
 *  user chose to and the plugin has no data directory now. */
export function reattachNativeBackendData(dataRoot: string, pluginId: string, setAsideName: string): void {
  const path = dataDirFor(dataRoot, pluginId)
  const match = SET_ASIDE_RE.exec(setAsideName)
  if (!match || match[1] !== pluginId) throw new Error('not a set-aside data directory of this plugin')
  if (lstatOrNull(path)) throw new Error('the plugin already has a data directory; nothing was reattached')
  const from = join(resolve(dataRoot), setAsideName)
  const stat = lstatOrNull(from)
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('the set-aside data directory is gone')
  renameSync(from, path)
}


/** Undo a reattach: put the plugin's data directory back under the set-aside
 *  name it came from (a restart that failed after reattaching it). */
export function returnReattachedNativeBackendData(dataRoot: string, pluginId: string, setAsideName: string): void {
  const path = dataDirFor(dataRoot, pluginId)
  const match = SET_ASIDE_RE.exec(setAsideName)
  if (!match || match[1] !== pluginId) throw new Error('not a set-aside data directory of this plugin')
  const to = join(resolve(dataRoot), setAsideName)
  if (lstatOrNull(to)) throw new Error('the set-aside name is taken; nothing was moved')
  renameSync(path, to)
}

// Review HIGH-3 on #425: data a removal kept goes to the next install of the
// same id only when that install has the same source. The source is recorded
// beside (never inside) the data folder, where the sandboxed backend cannot
// write: `<dataRoot>/<id>@kept-source.json`. Data kept by a release before
// this one has no record and is taken as Marketplace data, the only source
// that could run a third-party backend then.
function keptSourcePath(dataRoot: string, pluginId: string): string {
  dataDirFor(dataRoot, pluginId)
  return join(resolve(dataRoot), `${pluginId}@kept-source.json`)
}

/** After a removal that kept the data: record which source it belongs to. */
export function recordKeptNativeBackendDataSource(dataRoot: string, pluginId: string, source: SetAsideSource): void {
  const stat = lstatOrNull(dataDirFor(dataRoot, pluginId))
  if (!stat?.isDirectory()) return
  const path = keptSourcePath(dataRoot, pluginId)
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, source }), { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

/** The source of data a removal kept, or null when there is no data folder. */
export function keptNativeBackendDataSource(dataRoot: string, pluginId: string): SetAsideSource | null {
  const stat = lstatOrNull(dataDirFor(dataRoot, pluginId))
  if (!stat?.isDirectory()) return null
  try {
    const parsed = JSON.parse(readFileSync(keptSourcePath(dataRoot, pluginId), 'utf8')) as { source?: unknown }
    if (parsed.source === 'local-unsigned' || parsed.source === 'marketplace') return parsed.source
  } catch {
    // No record: data from before records existed.
  }
  return 'marketplace'
}

/** The source a removal recorded for kept data, or null when there is no
 * record (or no data folder). Unlike keptNativeBackendDataSource, no default. */
export function recordedNativeBackendDataSource(dataRoot: string, pluginId: string): SetAsideSource | null {
  const stat = lstatOrNull(dataDirFor(dataRoot, pluginId))
  if (!stat?.isDirectory() || !existsSync(keptSourcePath(dataRoot, pluginId))) return null
  return keptNativeBackendDataSource(dataRoot, pluginId)
}

/** The data now belongs to an installed package again: drop the record. */
export function forgetKeptNativeBackendDataSource(dataRoot: string, pluginId: string): void {
  rmSync(keptSourcePath(dataRoot, pluginId), { force: true })
}
