/**
 * Whether a message a spawned pane sent through the MCP `cli_send` tool is the
 * report it owes its parent.
 *
 * cli_open_agent tells the child to report back with cli_send. That send never
 * passes through the turn-text parser that settles the debt, so without this a
 * child that did exactly what it was told still "owes" its parent a report and
 * cannot be reclaimed. A delivered ordinary message to the parent settles it;
 * an ack does not, because the parent agent never reads one.
 */

export interface SpawnReportChild {
  id: string
  spawnReportPending?: boolean
  /** Parent pane id, when the lineage recorded one. */
  spawnedBy?: string
  /** Parent messaging handle the report is owed to. */
  spawnedByName?: string
}

export interface SpawnReportSendEvent {
  fromPaneId?: string
  targetPaneId?: string
  targetName?: string
  targetWorkspacePath?: string
  kind?: string
}

export function isSpawnReportSend(
  child: SpawnReportChild | undefined,
  ev: SpawnReportSendEvent,
  /** Messaging handle → pane id, for the panes this window owns. */
  paneIdByName: (name: string) => string | undefined,
): boolean {
  if (!child?.spawnReportPending || !child.spawnedByName) return false
  if (ev.fromPaneId !== child.id || ev.kind === 'ack' || !ev.targetPaneId) return false
  if (child.spawnedBy && ev.targetPaneId === child.spawnedBy) return true
  if (paneIdByName(child.spawnedByName) === ev.targetPaneId) return true
  // A parent in another workspace is addressed `<folder>/<pane>`; the event
  // names the target by its bare handle and its workspace path.
  const slash = child.spawnedByName.lastIndexOf('/')
  if (slash < 0 || !ev.targetName || !ev.targetWorkspacePath) return false
  const folder = child.spawnedByName.slice(0, slash)
  const pane = child.spawnedByName.slice(slash + 1)
  const wsBase = ev.targetWorkspacePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return ev.targetName === pane && wsBase === folder
}
