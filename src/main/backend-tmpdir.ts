import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the packaged backend keeps its temporary files: a directory of its
 * own under the data dir, not the OS temp directory.
 *
 * The frozen backend is a PyInstaller onefile binary. It unpacks itself into
 * the temp directory at start and keeps reading from there for as long as it
 * runs -- package metadata, data files and rarely imported extensions are
 * only read on first use. The OS temp cleaners do not know that: macOS removes
 * files under $TMPDIR that have not been accessed for three days, and on
 * 2026-11-08 that took every bundled package's METADATA out from under a
 * backend that had been up since 11-04, after which no MCP session could
 * initialize until the app was restarted. Nothing sweeps the data dir.
 */
export function persistentBackendTmpDir(dataDir: string): string {
  return join(dataDir, 'backend-tmp')
}

/**
 * Where one plugin's packaged backend children keep their temporary files:
 * `backend-tmp/plugins/<pluginId>/`. Bundled plugin backends (Plans and the
 * like) are PyInstaller onefile binaries too, and the same three-day temp
 * sweep applies to them. All instances of one plugin share the directory;
 * each child unpacks into its own uniquely named `_MEI*` inside it.
 *
 * Returns `null` for an id that is not one plain path component, so a bad id
 * can never point a child outside its own directory.
 */
export function pluginBackendTmpDir(dataDir: string, pluginId: string): string | null {
  if (pluginId === '' || pluginId === '.' || pluginId === '..' || /[/\\\0]/.test(pluginId)) return null
  return join(persistentBackendTmpDir(dataDir), 'plugins', pluginId)
}

/**
 * Create `dir` and drop extraction directories (`_MEI*`) a backend left behind
 * when it did not exit cleanly; a clean exit removes its own. Called right
 * before a backend is spawned, when no earlier backend of this app is running.
 *
 * Only `dir`'s own entries are looked at: plugin backends live in
 * `plugins/` below the main backend's directory and may still be running.
 * With `sweep` false the directory is only created -- for a plugin whose
 * other instances may be running and reading their own `_MEI*`.
 *
 * Returns `dir`, or `null` when it cannot be created -- the caller then leaves
 * the OS default temp directory alone rather than point the backend at a path
 * it cannot unpack into.
 */
export function prepareBackendTmpDir(dir: string, sweep = true): string | null {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return null
  }
  if (!sweep) return dir
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return dir
  }
  for (const name of entries) {
    if (!name.startsWith('_MEI')) continue
    try {
      rmSync(join(dir, name), { recursive: true, force: true })
    } catch {
      // Still in use or already gone; either way not ours to fight over.
    }
  }
  return dir
}
