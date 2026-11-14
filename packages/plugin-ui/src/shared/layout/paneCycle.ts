/** Browser-tab style pane cycling: Ctrl+Tab / Ctrl+Shift+Tab walk the visible
 *  pane list and wrap around at both ends. */

export type CycleDirection = 1 | -1

/** Next pane id in `orderedIds` relative to `currentId`, wrapping around.
 *  Returns null for an empty list. When `currentId` is absent from the list
 *  (never focused, minimized, or on another tab) the walk starts from the end
 *  the user is heading towards. */
export function nextPaneId(
  orderedIds: string[],
  currentId: string | null,
  direction: CycleDirection,
): string | null {
  if (orderedIds.length === 0) return null
  const idx = currentId ? orderedIds.indexOf(currentId) : -1
  if (idx === -1) return direction === 1 ? orderedIds[0] : orderedIds[orderedIds.length - 1]
  return orderedIds[(idx + direction + orderedIds.length) % orderedIds.length]
}

export interface PaneCycleInput {
  /** Pane ids in the order the surface renders them. */
  orderedIds: string[]
  currentId: string | null
  direction: CycleDirection
  /** Grid dimensions when a fixed preset paginates the stage, else null
   *  (auto preset or a non-grid layout — nothing is hidden behind a page). */
  gridDims: { cols: number; rows: number } | null
  currentPage: number
}

export interface PaneCyclePlan {
  targetId: string
  /** Page to switch to, or null when the current page already shows the target. */
  page: number | null
}

/** Decide where a cycle keystroke lands. Returns null when the keystroke is a
 *  no-op: no panes to cycle, or a lone pane that would cycle back to itself
 *  (re-selecting it would re-run its restore realization for nothing). */
export function planPaneCycle(input: PaneCycleInput): PaneCyclePlan | null {
  const { orderedIds, currentId, direction, gridDims, currentPage } = input
  const targetId = nextPaneId(orderedIds, currentId, direction)
  if (!targetId || targetId === currentId) return null
  if (!gridDims) return { targetId, page: null }
  const page = Math.floor(orderedIds.indexOf(targetId) / (gridDims.cols * gridDims.rows))
  return { targetId, page: page === currentPage ? null : page }
}
