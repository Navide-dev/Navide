import { describe, expect, it } from 'vitest'
import { diffKey, diffSnapshots, type CellSnapshot, type ScreenSnapshot } from './snapshot.ts'

const blank: CellSnapshot = { chars: '', width: 1, fg: 'd', bg: 'd', flags: 0 }

function screen(cols: number, rows: number, patch: Partial<ScreenSnapshot> = {}): ScreenSnapshot {
  return {
    cols,
    rows,
    buffer: 'normal',
    cursor: { x: 0, y: 0 },
    modes: {},
    scrollbackLength: 0,
    lines: Array.from({ length: rows }, () => ({ wrapped: false, cells: Array.from({ length: cols }, () => ({ ...blank })) })),
    ...patch,
  }
}

describe('diffSnapshots', () => {
  it('reports nothing for identical screens', () => {
    expect(diffSnapshots(screen(4, 2), screen(4, 2))).toEqual([])
  })

  it('stops at a size mismatch instead of diffing every cell', () => {
    expect(diffSnapshots(screen(4, 2), screen(5, 2))).toEqual([{ kind: 'size', a: '4x2', b: '5x2' }])
  })

  it('reports cell, cursor, mode, wrap and buffer differences with stable keys', () => {
    const a = screen(3, 2)
    const b = screen(3, 2, { cursor: { x: 1, y: 0 }, buffer: 'alternate', modes: { bracketedPaste: true } })
    b.lines[1]!.wrapped = true
    b.lines[0]!.cells[2] = { ...blank, chars: 'x', fg: 'p:1' }
    const keys = diffSnapshots(a, b).map(diffKey)
    expect(keys).toEqual(['buffer', 'cursor', 'mode:bracketedPaste', 'cell:0:2', 'wrap:1'])
  })
})
