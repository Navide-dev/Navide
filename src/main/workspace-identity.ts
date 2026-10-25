import { realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/** The key "is this folder already open in a window?" compares on.
 *
 *  `realpathSync.native` asks the OS, which answers with the folder's real
 *  case: on macOS and Windows "/Users/me/Proj" and "/users/me/proj" are one
 *  folder, and the JS `realpathSync` keeps whatever case it was given, so two
 *  spellings of one checkout could be open in two windows. Symlinks and a
 *  trailing slash settle the same way. Falls back to the trimmed string when
 *  the folder no longer exists. */
export function workspaceIdentityKey(p: string): string {
  const trimmed = (p ?? '').trim().replace(/[/\\]+$/, '')
  if (!trimmed) return ''
  try {
    return realpathSync.native(trimmed)
  } catch {
    return trimmed
  }
}

/** The open-workspace list with each folder once, first spelling and order
 *  kept. A window's primary can also sit in its adopted list (#448), and the
 *  Welcome badges and ui_snapshot's openWorkspaces read this list as is.
 *  Compared by resolved path (no trailing slash), case-insensitively on
 *  Windows; `~` is not expanded. */
export function uniqueOpenWorkspaces(paths: string[], platform: NodeJS.Platform = process.platform): string[] {
  const win = platform === 'win32'
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    const resolved = (win ? win32 : posix).resolve(p)
    const key = win ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}
