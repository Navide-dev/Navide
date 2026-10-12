export type SubmenuPlacement = 'right' | 'left' | 'below'

// Gap between a row and its flyout, matching the CSS margin.
const GAP = 2

/**
 * Pick where a hover submenu opens. A plugin view cannot draw outside its
 * own viewport, so a flyout that would cross an edge gets cut off: prefer the
 * right, fall back to the left, and drop below the row when neither fits.
 */
export function chooseSubmenuPlacement(
  row: { left: number; right: number },
  submenuWidth: number,
  viewportWidth: number,
): SubmenuPlacement {
  if (row.right + GAP + submenuWidth <= viewportWidth) return 'right'
  if (row.left - GAP - submenuWidth >= 0) return 'left'
  return 'below'
}

/** mouseenter handler for a `.has-sub` row: records the placement on the row. */
export function placeSubmenu(event: MouseEvent, submenuSelector: string): void {
  const row = event.currentTarget as HTMLElement | null
  const submenu = row?.querySelector<HTMLElement>(submenuSelector)
  if (!row || !submenu) return
  // The flyout is display:none until hover applies; force it on to measure.
  const display = submenu.style.display
  submenu.style.display = 'block'
  const width = submenu.offsetWidth
  submenu.style.display = display
  row.dataset.subPlace = chooseSubmenuPlacement(row.getBoundingClientRect(), width, window.innerWidth)
}
