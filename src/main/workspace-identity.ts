import { realpathSync } from 'node:fs'

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
