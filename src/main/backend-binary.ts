import { statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The packaged backend executable under `<resources>/bin`.
 *
 * The backend ships as a PyInstaller onedir build: a directory
 * `bin/agent_team_backend/` holding the executable (plus `.exe` on Windows)
 * and its `_internal/` libraries, so nothing is unpacked into a temp directory
 * at start. A single-file build at `bin/agent_team_backend[.exe]` is still
 * accepted, so going back to onefile needs no change here.
 */
export function packagedBackendBinary(resourcesPath: string, windows: boolean): string {
  const name = windows ? 'agent_team_backend.exe' : 'agent_team_backend'
  const bundle = join(resourcesPath, 'bin', 'agent_team_backend')
  try {
    if (statSync(bundle).isDirectory()) return join(bundle, name)
  } catch {
    // Not there: fall through to the single-file layout.
  }
  return join(resourcesPath, 'bin', name)
}
