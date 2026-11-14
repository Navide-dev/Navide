// Grid layout presets for the grid view mode. 'auto' shows every pane at once
// (column count derived from pane count); a fixed 'CxR' preset (e.g. '2x2',
// '4x2', cols/rows 1–9) keeps that exact frame per page and pages through the
// overflow.
export type GridPreset = string

const PRESET_RE = /^([1-9])x([1-9])$/

export function parseGridPreset(v: string | null | undefined): GridPreset {
  return v && PRESET_RE.test(v) ? v : 'auto'
}

export function gridPresetDims(preset: GridPreset): { cols: number; rows: number } | null {
  const m = PRESET_RE.exec(preset)
  if (!m) return null
  return { cols: Number(m[1]), rows: Number(m[2]) }
}

export function gridPageCount(paneCount: number, preset: GridPreset): number {
  const d = gridPresetDims(preset)
  if (!d) return 1
  return Math.max(1, Math.ceil(paneCount / (d.cols * d.rows)))
}

/** The page a pane sits on, from its index in the paged list. Jumping to a pane
 *  has to bring its page with it: under a fixed preset the pane is otherwise
 *  focused on a page nobody is looking at, and the jump appears to do nothing.
 *  'auto' pages nothing, so everything is on page 0. */
export function gridPageOf(index: number, preset: GridPreset): number {
  const d = gridPresetDims(preset)
  if (!d || index < 0) return 0
  return Math.floor(index / (d.cols * d.rows))
}

/** Panes on the given page. Out-of-range pages clamp to the last page. */
export function gridPageSlice<T>(panes: T[], preset: GridPreset, page: number): T[] {
  const d = gridPresetDims(preset)
  if (!d) return panes
  const cap = d.cols * d.rows
  const p = Math.min(Math.max(0, page), gridPageCount(panes.length, preset) - 1)
  return panes.slice(p * cap, p * cap + cap)
}
