import type { LineageRow } from './workspaceGroups'

export type { LineageRow }

/** The only fields of a pane this file reads. */
export interface LineagePane {
  id: string
  /** The pane that spawned this one, when it was spawned by another. */
  spawnedBy?: string
}

/** Flatten the spawn tree into the order the sidebar renders it.
 *
 *  Depth-first from the roots, each pane followed by its descendants. Three
 *  situations decide the shape, and each is a real state rather than a
 *  defensive guess:
 *
 *  - **A parent that is not present** — closed in another window, or a record
 *    that predates lineage being persisted. Its child becomes a root rather
 *    than disappearing with it.
 *  - **A collapsed pane** — its descendants are left out entirely, which is
 *    what makes range selection over this list collapse-aware for free.
 *  - **A cycle** the backend's guard did not catch (hand-edited state, or a
 *    record from an older build). The walk cannot reach those panes, so they
 *    are appended as roots — listing them wrongly beats dropping them.
 */
export function buildPaneLineage(
  panes: readonly LineagePane[],
  collapsed: ReadonlySet<string>,
): LineageRow[] {
  const parents = effectiveParents(panes)
  const childrenOf = new Map<string, string[]>()
  for (const p of panes) {
    const parent = parents.get(p.id) ?? ''
    const bucket = childrenOf.get(parent)
    if (bucket) bucket.push(p.id)
    else childrenOf.set(parent, [p.id])
  }

  // Subtree sizes, computed over the whole tree rather than over the rows:
  // a folded row shows this number instead of the children it hides, so it
  // must not depend on whether they are currently drawn. Seeding the cache
  // before recursing is what keeps a hand-edited cycle from recursing
  // forever — though effectiveParents has already rerooted those.
  const descendants = new Map<string, number>()
  const countOf = (id: string): number => {
    const cached = descendants.get(id)
    if (cached !== undefined) return cached
    descendants.set(id, 0)
    let total = 0
    for (const child of childrenOf.get(id) ?? []) total += 1 + countOf(child)
    descendants.set(id, total)
    return total
  }

  const rows: LineageRow[] = []
  const seen = new Set<string>()
  // Descendants of a collapsed pane. The walk does not reach them, and the
  // unreachable sweep at the end must not mistake that for a cycle: appending
  // them as roots put a folded subtree back on screen, unindented, at the
  // bottom of the list.
  const folded = new Set<string>()
  const fold = (parent: string): void => {
    for (const id of childrenOf.get(parent) ?? []) {
      if (folded.has(id)) continue
      folded.add(id)
      fold(id)
    }
  }

  const walk = (parent: string, depth: number, ancestors: readonly string[]): void => {
    for (const id of childrenOf.get(parent) ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      const isCollapsed = collapsed.has(id)
      rows.push({
        id,
        depth,
        hasChildren: (childrenOf.get(id)?.length ?? 0) > 0,
        collapsed: isCollapsed,
        ancestors,
        descendantCount: countOf(id),
      })
      if (isCollapsed) fold(id)
      else walk(id, depth + 1, [...ancestors, id])
    }
  }
  walk('', 0, [])

  for (const p of panes) {
    if (seen.has(p.id) || folded.has(p.id)) continue
    rows.push({ id: p.id, depth: 0, hasChildren: false, collapsed: false, ancestors: [], descendantCount: 0 })
  }
  return rows
}

/** Where each pane actually hangs, `''` for a root.
 *
 *  Applies the same three rules `buildPaneLineage` walks by — a parent that is
 *  not present, a pane parented to itself, and a pane caught in a cycle all
 *  count as roots — so ordering and rendering can never disagree about which
 *  row is whose sibling. A cycle is decided by walking up: ancestry that never
 *  reaches a root is a cycle, which is exactly the set the tree walk cannot
 *  reach and appends as roots.
 */
export function effectiveParents(panes: readonly LineagePane[]): Map<string, string> {
  const ids = new Set(panes.map((pane) => pane.id))
  const raw = new Map<string, string>()
  for (const pane of panes) {
    const parent = pane.spawnedBy && ids.has(pane.spawnedBy) && pane.spawnedBy !== pane.id ? pane.spawnedBy : ''
    raw.set(pane.id, parent)
  }

  const parents = new Map<string, string>()
  for (const pane of panes) {
    const seen = new Set<string>([pane.id])
    let cur = raw.get(pane.id) ?? ''
    let rooted = true
    while (cur) {
      if (seen.has(cur)) {
        rooted = false
        break
      }
      seen.add(cur)
      cur = raw.get(cur) ?? ''
    }
    parents.set(pane.id, rooted ? raw.get(pane.id) ?? '' : '')
  }
  return parents
}

/** `ids` plus every pane descended from them, in `panes` order.
 *
 *  A drag carries a whole subtree. Pane order lives in one flat array that the
 *  sidebar rebuilds the tree from, so moving a parent without its children
 *  would only move the parent — the next walk puts the children straight back
 *  underneath it, wherever it landed, and the two rows the user saw together
 *  end up apart.
 *
 *  Unknown ids are dropped rather than carried, and a pane listed both
 *  explicitly and as someone's descendant appears once.
 */
export function withDescendants(ids: readonly string[], panes: readonly LineagePane[]): string[] {
  const parents = effectiveParents(panes)
  const childrenOf = new Map<string, string[]>()
  for (const pane of panes) {
    const parent = parents.get(pane.id) ?? ''
    const bucket = childrenOf.get(parent)
    if (bucket) bucket.push(pane.id)
    else childrenOf.set(parent, [pane.id])
  }

  const carried = new Set<string>()
  const queue = ids.filter((id) => parents.has(id))
  while (queue.length) {
    const id = queue.shift() as string
    if (carried.has(id)) continue // also the cycle guard
    carried.add(id)
    queue.push(...(childrenOf.get(id) ?? []))
  }
  return panes.filter((pane) => carried.has(pane.id)).map((pane) => pane.id)
}

/** The row a drag from `fromId` onto `toId` really lands on, or `null` when the
 *  drop cannot be honoured.
 *
 *  Reordering never re-parents a pane, so a drop is only meaningful among the
 *  dragged pane's own siblings. Dropping onto a row nested inside some other
 *  group therefore means "put me where that group is": the target is lifted up
 *  its ancestry until it sits at the dragged pane's level. When no ancestor
 *  does — dropping a child onto an unrelated tree — there is no honest answer,
 *  and refusing beats silently moving the pane somewhere the user did not aim.
 */
export function resolveSiblingDrop(
  fromId: string,
  toId: string,
  panes: readonly LineagePane[],
): string | null {
  if (!fromId || !toId || fromId === toId) return null
  const parents = effectiveParents(panes)
  if (!parents.has(fromId) || !parents.has(toId)) return null

  const home = parents.get(fromId) ?? ''
  const seen = new Set<string>()
  let cur = toId
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    if ((parents.get(cur) ?? '') === home) return cur === fromId ? null : cur
    cur = parents.get(cur) ?? ''
  }
  return null
}

/** Point every item whose parent is `oldId` at `newId`; true if any moved.
 *
 *  A self-reference is dropped rather than kept: a pane that became its own
 *  parent would make the lineage walk loop. Mirrors the backend's
 *  _rekey_spawned_by, which has already rewritten the records. */
export function rekeyChildren<T extends { spawnedBy?: string }>(
  items: readonly T[],
  idOf: (item: T) => string,
  oldId: string,
  newId: string,
): boolean {
  if (!oldId || oldId === newId) return false
  let moved = false
  for (const item of items) {
    if (item.spawnedBy !== oldId) continue
    item.spawnedBy = idOf(item) === newId ? undefined : newId
    moved = true
  }
  return moved
}

/** The ids a `pane.lineage_rekeyed` event hands over (a chat wake that opened
 *  a conversation in a new pane retired the record that held it), or null. */
export function lineageHandoff(raw: unknown): { oldId: string; newId: string } | null {
  const ev = (raw ?? {}) as { old_pane_id?: unknown; new_pane_id?: unknown }
  const oldId = typeof ev.old_pane_id === 'string' ? ev.old_pane_id : ''
  const newId = typeof ev.new_pane_id === 'string' ? ev.new_pane_id : ''
  return oldId && newId && oldId !== newId ? { oldId, newId } : null
}
