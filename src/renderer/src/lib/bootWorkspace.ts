/**
 * Which workspace a freshly booted window should record in Recent, or '' for
 * none.
 *
 * A window carrying `workspace_path` skips Welcome's click handler, the only
 * other place that records a recent entry — so folders opened from outside the
 * app (Finder "Open With", the macOS Quick Action, CLI path args) would never
 * appear in the list. But only a window the user actively opened counts:
 * session restore, duplicates and detached children all re-open a workspace the
 * user already had, and every touch re-sorts Recent and stamps the entry "just
 * now" — restoring six windows would reorder the top of the list by whichever
 * backend happened to connect first.
 */
export function bootWorkspaceToRecord(search: string): string {
  const params = new URLSearchParams(search)
  const path = params.get('workspace_path') ?? ''
  if (!path) return ''
  if (params.get('duplicate') === '1') return ''
  if (params.get('skip_recent') === '1') return ''
  if (params.get('restore') === '1') return ''
  if ((params.get('detached_group') ?? '') !== '') return ''
  return path
}
