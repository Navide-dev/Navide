/** The tab strip above the stage, as structure only.
 *
 *  One tab per run group that this window shows, plus a synthetic tab for
 *  panes that belong to no group. No live status is read here — the strip
 *  renders these shapes and looks each pane's status up separately, so a
 *  status dot ticking does not rebuild the strip.
 */

export interface TabPane {
  id: string
  runGroupId?: string
}

export interface RunGroupLike {
  id: string
  name: string
}

export interface StageTabShape {
  key: string
  label: string
  count: number
  type: 'stage' | 'manual'
  paneIds: string[]
}

export interface StageTabInput {
  /** The panes of the workspace on screen — already workspace-filtered, so a
   *  tab never counts a pane the stage will not show. */
  panes: readonly TabPane[]
  /** Run groups of the workspace on screen. */
  groups: readonly RunGroupLike[]
  /** True in a detached child window. */
  isDetached: boolean
  /** The group a detached window was detached for. */
  detachedGroupId: string
  /** Groups this main window has handed off to detached children. */
  detachedGroupIds: ReadonlySet<string>
  /** Label for the synthetic tab holding ungrouped panes. */
  manualLabel: string
  /** Label for a tab rebuilt from panes whose group record is missing. */
  orphanLabel: string
  /** Label for the default tab while it still has the name it was created with. */
  defaultLabel: string
}

/** The default tab is created with a fixed id and a Chinese name that
 *  project.json keeps. Until the user renames it, it shows in the UI language. */
const DEFAULT_GROUP_ID = 'rg-default'
const DEFAULT_GROUP_STORED_NAME = '預設'

export function groupLabel(group: RunGroupLike, defaultLabel: string): string {
  return group.id === DEFAULT_GROUP_ID && group.name === DEFAULT_GROUP_STORED_NAME
    ? defaultLabel
    : group.name
}

export function buildStageTabs(input: StageTabInput): StageTabShape[] {
  const {
    panes,
    groups,
    isDetached,
    detachedGroupId,
    detachedGroupIds,
    manualLabel,
    orphanLabel,
    defaultLabel,
  } = input

  const byGroup = new Map<string, string[]>()
  const ungrouped: string[] = []
  for (const p of panes) {
    if (!p.runGroupId) {
      ungrouped.push(p.id)
      continue
    }
    const list = byGroup.get(p.runGroupId)
    if (list) list.push(p.id)
    else byGroup.set(p.runGroupId, [p.id])
  }

  const shapes: StageTabShape[] = []
  for (const group of groups) {
    // A detached child shows ONLY its own group; a main window hides any group
    // it has handed off to one. Both are inert for an ordinary window
    // (isDetached false, no detached ids).
    if (isDetached) {
      if (group.id !== detachedGroupId) continue
    } else if (detachedGroupIds.has(group.id)) {
      continue
    }
    const paneIds = byGroup.get(group.id) ?? []
    shapes.push({ key: group.id, label: groupLabel(group, defaultLabel), count: paneIds.length, type: 'stage', paneIds })
  }

  // Every pane must be reachable from some tab.
  //
  // A pane keeps its run_group_id even when the matching group record does
  // not survive — a lost ui_run_groups write, a group deleted while its panes
  // lived on. This used to leave the pane on no tab at all, deliberately: a
  // pane on no tab means something is wrong, and the manual tab would have
  // hidden the fault. But it hid the pane too — listed in the sidebar,
  // running, and unreachable from the one place that opens it, with the whole
  // strip gone when every pane was in that state. Surfacing the tab shows the
  // fault AND keeps the panes usable; the repair that puts the record back
  // then renames it.
  //
  // Skipped in a detached window, which is one group's view. A group handed to
  // a detached child normally has no panes left here either, so nothing gets
  // rebuilt for it; if any DO remain the two states disagree, and skipping
  // them for the sake of the hand-off is exactly what puts a pane on no tab.
  // Reachability wins over the book-keeping.
  if (!isDetached) {
    for (const [gid, paneIds] of byGroup) {
      if (shapes.some((s) => s.key === gid)) continue
      shapes.push({ key: gid, label: orphanLabel, count: paneIds.length, type: 'stage', paneIds })
    }
  }

  // The synthetic tab exists only while something needs it, and never in a
  // detached window: that window is one group's view and has no ungrouped
  // panes of its own to show.
  if (!isDetached && ungrouped.length > 0) {
    shapes.push({
      key: 'manual',
      label: manualLabel,
      count: ungrouped.length,
      type: 'manual',
      paneIds: ungrouped,
    })
  }
  return shapes
}
