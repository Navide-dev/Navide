/**
 * Which panes a window holds, remembered across a Reload of that window.
 *
 * project.json is per workspace, and the backend forgets who owned a PTY when
 * the window's connection drops, so after a Reload nothing else can say whose
 * a record is. That matters to a duplicate=1 window, which must not restore
 * the workspace's records: they may be another window's live sessions, or old
 * ones the user did not ask for. sessionStorage answers it: it survives a
 * Reload and no other window can read it, and a new window starts with an
 * empty list, which is how a first load is told from a Reload.
 *
 * Holds pane ids and session ids together. A restored pane gets a new id, and
 * project.json catches up only once its PTY is running; until then the session
 * id is what the pane and its record still share.
 */
const HELD_PANES_KEY = 'agentTeam.heldPanes'

export function readHeldPanes(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(HELD_PANES_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

export function writeHeldPanes(keys: readonly string[]): void {
  try {
    sessionStorage.setItem(HELD_PANES_KEY, JSON.stringify(keys))
  } catch {
    /* a lost list costs this window its panes on the next Reload, nothing else */
  }
}

export function heldPaneKeys(panes: readonly { id: string; pinnedSessionId?: string }[]): string[] {
  return panes.flatMap((p) => (p.pinnedSessionId ? [p.id, p.pinnedSessionId] : [p.id]))
}

export function isHeldRecord(
  record: { pane_id: string; session_id?: string },
  held: ReadonlySet<string>,
): boolean {
  const sessionId = (record.session_id ?? '').trim()
  return held.has(record.pane_id) || (sessionId !== '' && held.has(sessionId))
}
