// The catalogue of movable content units.
//
// A view is one tab's worth of content — the Agents list, the Git panel, the
// token stats. The registry says what exists, where it lives by default and
// which slots it is allowed into; the layout state says where it actually is.
// Keeping the two apart is what lets a stored layout survive a view being
// renamed or withdrawn: `sanitize` drops what the registry no longer knows
// instead of leaving the shell rendering an empty tab.
//
// Every view is a singleton — one instance in the whole app, in exactly one
// slot. That is a product decision, not a limitation: it removes instance ids,
// per-instance params and scoped command registration in one stroke.
//
// Deliberately no `component` field yet. Three of these still live as inline
// markup inside ControlPane / TokenStatsPanel, so there is nothing to point at,
// and importing the whole component tree here would drag it into every module
// that only wants to ask "which slots may Git go in?".
//
// `allowedSlots` therefore says where a view can actually be *rendered* today,
// not where it would make sense eventually. A slot that cannot draw a view must
// not be offered as a destination: the move would succeed, the tab would vanish
// from its old home, and the new slot would show an empty panel. The three
// inline views are pinned to their host for that reason; widening them is the
// last step of extracting them, not something to do in advance.
//
// Two more pins have nothing to do with rendering. A view that something can
// *reveal* — a shortcut, a command, an agent push — only gets revealed in the
// host that knows how: `explorer` / `plans` / `git` / `agents` / `commanders` / `pipeline` are
// surfaced through ControlPane's `selectSidebarTab`, and `preview` through the
// right panel's watch on `usePreview().focusRequest`. Moved elsewhere they
// would still draw, but their shortcut would quietly stop working — which is
// worse than not offering the move. `git` additionally takes six emits and two
// lists that ControlPane computes for it.
//
// What is left genuinely travels: `history`, `tasker` and `messages` are
// self-contained panels nothing reaches into.
import type { SlotId } from './slots'

export type ViewId =
  | 'agents'
  | 'commanders'
  | 'pipeline'
  | 'explorer'
  | 'git'
  | 'plans'
  | 'history'
  | 'tokens'
  | 'time'
  | 'tasker'
  | 'messages'
  | 'preview'
  | 'cli-stage'

/** Where a view may live. `main` is not a SlotId — nothing may be put there. */
export type ViewHome = SlotId | 'main'

export interface ViewDescriptor {
  id: ViewId
  /** i18n key, not a literal — the tab strip and the move menu both render it. */
  titleKey: string
  icon: string
  defaultSlot: ViewHome
  /**
   * Compatibility whitelist. Empty means pinned: the view cannot be moved at
   * all, which is how `cli-stage` stays in `main`.
   */
  allowedSlots: readonly SlotId[]
  /** Which way the content wants to be long. Drives the move menu's ordering. */
  preferredAxis: 'vertical' | 'horizontal' | 'any'
  /** Smallest useful size along the host slot's own axis, in px. */
  minSize: number
}

const V = (d: ViewDescriptor): ViewDescriptor => d

/**
 * Declaration order is the default tab order within each slot, so this list is
 * also what `createDefaultLayout` reads — one place to change, not two.
 */
export const VIEWS: readonly ViewDescriptor[] = [
  V({ id: 'agents', titleKey: 'label.agents', icon: '\u{1F916}', defaultSlot: 'left', allowedSlots: ['left'], preferredAxis: 'vertical', minSize: 240 }),
  V({ id: 'commanders', titleKey: 'label.commanders', icon: '\u25CE', defaultSlot: 'left', allowedSlots: ['left'], preferredAxis: 'vertical', minSize: 240 }),
  V({ id: 'pipeline', titleKey: 'label.pipeline', icon: '\u{1F500}', defaultSlot: 'left', allowedSlots: ['left'], preferredAxis: 'vertical', minSize: 240 }),
  V({ id: 'explorer', titleKey: 'label.explorer', icon: '\u{1F4C1}', defaultSlot: 'left', allowedSlots: ['left'], preferredAxis: 'vertical', minSize: 220 }),
  V({ id: 'git', titleKey: 'label.git', icon: '\u{1F33F}', defaultSlot: 'left', allowedSlots: ['left'], preferredAxis: 'any', minSize: 260 }),
  V({ id: 'plans', titleKey: 'label.plans', icon: '\u{1F4CB}', defaultSlot: 'left', allowedSlots: ['left'], preferredAxis: 'any', minSize: 240 }),
  V({ id: 'history', titleKey: 'label.history', icon: '\u{1F4DC}', defaultSlot: 'right', allowedSlots: ['right', 'up', 'down'], preferredAxis: 'any', minSize: 220 }),
  V({ id: 'time', titleKey: 'label.time', icon: '\u23F1', defaultSlot: 'right', allowedSlots: ['right'], preferredAxis: 'any', minSize: 200 }),
  V({ id: 'tokens', titleKey: 'label.tokens', icon: '\u{1F4CA}', defaultSlot: 'right', allowedSlots: ['right'], preferredAxis: 'any', minSize: 200 }),
  V({ id: 'tasker', titleKey: 'label.tasker', icon: '\u{1F5D3}', defaultSlot: 'right', allowedSlots: ['right', 'up', 'down'], preferredAxis: 'any', minSize: 220 }),
  V({ id: 'messages', titleKey: 'label.messages', icon: '\u{2709}', defaultSlot: 'right', allowedSlots: ['right', 'up', 'down'], preferredAxis: 'any', minSize: 220 }),
  // Not in the original design table: the preview tab landed in the right panel
  // after that table was written. It is a view like any other.
  V({ id: 'preview', titleKey: 'label.preview', icon: '\u{1F441}', defaultSlot: 'right', allowedSlots: ['right'], preferredAxis: 'any', minSize: 240 }),
  // The CLI stage. Listed so Settings can show what `main` holds, pinned so
  // nothing — including itself — can be moved in or out.
  V({ id: 'cli-stage', titleKey: 'label.cli-stage', icon: '\u{1F5A5}', defaultSlot: 'main', allowedSlots: [], preferredAxis: 'any', minSize: 320 }),
]

const BY_ID = new Map<string, ViewDescriptor>(VIEWS.map((v) => [v.id, v]))

export function viewById(id: string): ViewDescriptor | undefined {
  return BY_ID.get(id)
}

/** A view with nowhere else to go is pinned to where it is. */
export function isMovable(id: string): boolean {
  return (viewById(id)?.allowedSlots.length ?? 0) > 0
}

export function canPlace(id: string, slot: SlotId): boolean {
  return viewById(id)?.allowedSlots.includes(slot) ?? false
}

/** The default occupants of a slot, in declaration order. */
export function defaultViewsFor(slot: SlotId): string[] {
  return VIEWS.filter((v) => v.defaultSlot === slot).map((v) => v.id)
}

/** Every slot a view may be moved to, excluding where it already is. */
export function moveTargetsFor(id: string, current: SlotId | null): SlotId[] {
  return (viewById(id)?.allowedSlots ?? []).filter((s) => s !== current)
}

/**
 * Reconciles a stored set of slot occupancies against the registry.
 *
 * Two jobs, both of which have to happen together:
 *
 *  1. Enforce the singleton invariant — drop ids the registry does not know,
 *     drop a view from a slot it is not allowed in, and where the same view
 *     somehow appears twice keep only the first occurrence. Slots are visited
 *     in the order given, so "first" means whichever slot the caller listed
 *     first.
 *  2. Re-home whatever fell out. A view that survived step 1 in no slot at all
 *     would be unreachable — no tab, no rail, no menu entry — so it goes back
 *     to its default slot. This is what makes narrowing a view's allowedSlots
 *     a safe change rather than one that silently loses a panel. Views the user
 *     removed on purpose are named in `hidden` and stay out.
 *
 * Runs on load rather than on write: the layout is shared across windows, and a
 * build that knows fewer views must not delete the others' entries from the
 * persisted state, only decline to render them.
 */
/**
 * `views` re-sorted into the order this registry declares them in.
 *
 * Declaration order IS the shipped tab order (see VIEWS), so this is what a
 * slot looks like before anyone has touched it. Ids the registry does not know
 * keep their relative places at the end rather than being dropped — a build
 * that knows fewer views must not rewrite the layout of one that knows more.
 */
export function sortByDeclaration(views: readonly string[]): string[] {
  const rank = new Map<string, number>(VIEWS.map((v, i) => [v.id as string, i]))
  return [...views].sort((a, b) => {
    const ra = rank.get(a)
    const rb = rank.get(b)
    if (ra === undefined && rb === undefined) return 0
    if (ra === undefined) return 1
    if (rb === undefined) return -1
    return ra - rb
  })
}


export function reconcileOccupancy(
  bySlot: readonly (readonly [SlotId, readonly string[]])[],
  hidden: readonly string[] = []
): Record<SlotId, string[]> {
  const seen = new Set<string>()
  const out = {} as Record<SlotId, string[]>
  for (const [slot, views] of bySlot) {
    out[slot] = []
    for (const v of views) {
      if (seen.has(v) || !canPlace(v, slot)) continue
      seen.add(v)
      out[slot].push(v)
    }
  }
  for (const v of VIEWS) {
    if (seen.has(v.id) || !isMovable(v.id) || hidden.includes(v.id)) continue
    const home = v.defaultSlot as SlotId
    if (out[home]) out[home].push(v.id)
  }
  return out
}
