import type { WindowEntry } from './window-registry'

/** What reopening one closed window comes down to. */
export interface ReopenPlan {
  /** The window to create, or null when every workspace is open or gone. */
  open: WindowEntry | null
  /** Workspaces already open in another window: focused, never reopened. */
  focus: string[]
  /** Workspaces whose folder no longer exists: skipped and reported. */
  missing: string[]
}

/** Split a closed window's workspaces into what to open, focus and skip.
 *
 *  A workspace already open elsewhere is focused instead of opened again — two
 *  windows on one folder means two sets of PTY and git operations on one
 *  checkout. When the window's own workspace is open or gone, the first one
 *  still available takes its place, so the rest still come back together in
 *  one window with the saved bounds. */
export function planReopen(
  entry: WindowEntry,
  probe: { exists: (path: string) => boolean; isOpen: (path: string) => boolean },
): ReopenPlan {
  const plan: ReopenPlan = { open: null, focus: [], missing: [] }
  const available: string[] = []
  for (const path of [entry.workspace_path, ...(entry.adopted_workspaces ?? [])]) {
    if (available.includes(path) || plan.focus.includes(path) || plan.missing.includes(path)) continue
    if (probe.isOpen(path)) plan.focus.push(path)
    else if (!probe.exists(path)) plan.missing.push(path)
    else available.push(path)
  }
  const [primary, ...adopted] = available
  if (primary) {
    plan.open = {
      workspace_path: primary,
      ...(entry.bounds ? { bounds: entry.bounds } : {}),
      ...(adopted.length ? { adopted_workspaces: adopted } : {}),
    }
  }
  return plan
}
