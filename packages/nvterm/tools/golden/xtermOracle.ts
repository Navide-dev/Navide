// xterm.js as a black-box oracle (CLEAN_ROOM.md): bytes go in through
// write(), results come out through the public buffer / modes API only.
import { createRequire } from 'node:module'
import type { IBufferCell, Terminal as XtermTerminal } from '@xterm/headless'
import { CellFlag, type CellSnapshot, type ColorSpec, type LineSnapshot, type ScreenSnapshot } from '../../src/snapshot.ts'
import type { TerminalDriver, TerminalStream } from './driver.ts'

// Both packages are CommonJS bundles whose named exports Node's ESM loader
// cannot detect, so load them with require().
const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless')
const { Unicode11Addon } = require('@xterm/addon-unicode11') as typeof import('@xterm/addon-unicode11')

const MODE_KEYS = [
  'applicationCursorKeysMode',
  'applicationKeypadMode',
  'bracketedPasteMode',
  'insertMode',
  'mouseTrackingMode',
  'originMode',
  'reverseWraparoundMode',
  'sendFocusMode',
  'wraparoundMode',
] as const

/** Same options Navide's CLI pane uses where they affect parsing (useTerminal.ts). */
function createTerminal(cols: number, rows: number): XtermTerminal {
  const term = new Terminal({ cols, rows, scrollback: 10000, convertEol: false, allowProposedApi: true })
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  return term
}

function color(isDefault: boolean, isRgb: boolean, value: number): ColorSpec {
  if (isDefault) return 'd'
  if (isRgb) return `r:${value.toString(16).padStart(6, '0')}`
  return `p:${value}`
}

function cellSnapshot(cell: IBufferCell): CellSnapshot {
  let flags = 0
  if (cell.isBold()) flags |= CellFlag.Bold
  if (cell.isDim()) flags |= CellFlag.Dim
  if (cell.isItalic()) flags |= CellFlag.Italic
  if (cell.isUnderline()) flags |= CellFlag.Underline
  if (cell.isBlink()) flags |= CellFlag.Blink
  if (cell.isInverse()) flags |= CellFlag.Inverse
  if (cell.isInvisible()) flags |= CellFlag.Invisible
  if (cell.isStrikethrough()) flags |= CellFlag.Strikethrough
  if (cell.isOverline()) flags |= CellFlag.Overline
  return {
    chars: cell.getChars(),
    width: cell.getWidth() as 0 | 1 | 2,
    fg: color(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor()),
    bg: color(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor()),
    flags,
  }
}

export function snapshotOf(term: XtermTerminal): ScreenSnapshot {
  const buffer = term.buffer.active
  const lines: LineSnapshot[] = []
  for (let row = 0; row < term.rows; row++) {
    const line = buffer.getLine(buffer.baseY + row)
    const cells: CellSnapshot[] = []
    for (let col = 0; col < term.cols; col++) {
      const cell = line?.getCell(col)
      cells.push(cell ? cellSnapshot(cell) : { chars: '', width: 1, fg: 'd', bg: 'd', flags: 0 })
    }
    lines.push({ wrapped: line?.isWrapped ?? false, cells })
  }
  const modes: Record<string, boolean | string> = {}
  for (const key of MODE_KEYS) modes[key] = term.modes[key]
  return {
    cols: term.cols,
    rows: term.rows,
    buffer: buffer.type,
    cursor: { x: buffer.cursorX, y: buffer.cursorY },
    modes,
    scrollbackLength: buffer.type === 'normal' ? buffer.baseY : 0,
    lines,
  }
}

function writeAsync(term: XtermTerminal, data: Uint8Array | string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

export const xtermDriver: TerminalDriver = {
  name: 'xterm.js',
  async run(fixture) {
    const term = createTerminal(fixture.cols, fixture.rows)
    try {
      for (const chunk of fixture.chunks) await writeAsync(term, chunk)
      return snapshotOf(term)
    } finally {
      term.dispose()
    }
  },
}

export function createXtermStream(cols: number, rows: number): TerminalStream {
  const term = createTerminal(cols, rows)
  return {
    write: (chunk) => term.write(chunk),
    flush: () => writeAsync(term, ''),
    dispose: () => term.dispose(),
  }
}
