// A renderer-independent picture of a terminal screen. Golden comparison
// reduces every terminal implementation to this shape and diffs the results.

/** 'd' = default, 'p:<index>' = palette (0-255), 'r:<rrggbb>' = truecolor. */
export type ColorSpec = string

export const CellFlag = {
  Bold: 1 << 0,
  Dim: 1 << 1,
  Italic: 1 << 2,
  Underline: 1 << 3,
  Blink: 1 << 4,
  Inverse: 1 << 5,
  Invisible: 1 << 6,
  Strikethrough: 1 << 7,
  Overline: 1 << 8,
} as const

export interface CellSnapshot {
  /** The cell's text: '' for an empty cell or the trailing half of a wide character. */
  chars: string
  /** 1 for a normal cell, 2 for the leading half of a wide character, 0 for its trailing half. */
  width: 0 | 1 | 2
  fg: ColorSpec
  bg: ColorSpec
  flags: number
}

export interface LineSnapshot {
  /** True when this line continues the previous one because of autowrap. */
  wrapped: boolean
  cells: CellSnapshot[]
}

export interface ScreenSnapshot {
  cols: number
  rows: number
  buffer: 'normal' | 'alternate'
  cursor: { x: number; y: number }
  modes: Record<string, boolean | string>
  /** Lines in the scrollback above the viewport (normal buffer only). */
  scrollbackLength: number
  /** The visible rows, top to bottom. */
  lines: LineSnapshot[]
}

export type SnapshotDiff =
  | { kind: 'size'; a: string; b: string }
  | { kind: 'buffer'; a: string; b: string }
  | { kind: 'cursor'; a: string; b: string }
  | { kind: 'scrollback'; a: number; b: number }
  | { kind: 'mode'; mode: string; a: string; b: string }
  | { kind: 'wrap'; row: number; a: boolean; b: boolean }
  | { kind: 'cell'; row: number; col: number; a: string; b: string }

export function describeCell(cell: CellSnapshot | undefined): string {
  if (!cell) return '<none>'
  return `${JSON.stringify(cell.chars)} w${cell.width} fg=${cell.fg} bg=${cell.bg} f=${cell.flags}`
}

/** Stable key for a diff, used to look up triage decisions. */
export function diffKey(diff: SnapshotDiff): string {
  switch (diff.kind) {
    case 'mode': return `mode:${diff.mode}`
    case 'wrap': return `wrap:${diff.row}`
    case 'cell': return `cell:${diff.row}:${diff.col}`
    default: return diff.kind
  }
}

export function diffSnapshots(a: ScreenSnapshot, b: ScreenSnapshot): SnapshotDiff[] {
  const diffs: SnapshotDiff[] = []
  if (a.cols !== b.cols || a.rows !== b.rows) {
    diffs.push({ kind: 'size', a: `${a.cols}x${a.rows}`, b: `${b.cols}x${b.rows}` })
    return diffs
  }
  if (a.buffer !== b.buffer) diffs.push({ kind: 'buffer', a: a.buffer, b: b.buffer })
  if (a.cursor.x !== b.cursor.x || a.cursor.y !== b.cursor.y) {
    diffs.push({ kind: 'cursor', a: `${a.cursor.x},${a.cursor.y}`, b: `${b.cursor.x},${b.cursor.y}` })
  }
  if (a.scrollbackLength !== b.scrollbackLength) {
    diffs.push({ kind: 'scrollback', a: a.scrollbackLength, b: b.scrollbackLength })
  }
  for (const mode of new Set([...Object.keys(a.modes), ...Object.keys(b.modes)])) {
    const av = String(a.modes[mode] ?? '<unset>')
    const bv = String(b.modes[mode] ?? '<unset>')
    if (av !== bv) diffs.push({ kind: 'mode', mode, a: av, b: bv })
  }
  for (let row = 0; row < a.rows; row++) {
    const la = a.lines[row]
    const lb = b.lines[row]
    if ((la?.wrapped ?? false) !== (lb?.wrapped ?? false)) {
      diffs.push({ kind: 'wrap', row, a: la?.wrapped ?? false, b: lb?.wrapped ?? false })
    }
    for (let col = 0; col < a.cols; col++) {
      const ca = describeCell(la?.cells[col])
      const cb = describeCell(lb?.cells[col])
      if (ca !== cb) diffs.push({ kind: 'cell', row, col, a: ca, b: cb })
    }
  }
  return diffs
}
