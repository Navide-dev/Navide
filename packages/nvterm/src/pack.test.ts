import { describe, expect, it } from 'vitest'
import { HOT_LINES, Line, PackedLine } from './buffer'
import { findAll } from './search'
import { serialize } from './serialize'
import { TerminalCore } from './terminal'

function sameLine(a: Line, b: Line): void {
  expect(Array.from(b.codes)).toEqual(Array.from(a.codes))
  expect(Array.from(b.widths)).toEqual(Array.from(a.widths))
  expect(Array.from(b.styles)).toEqual(Array.from(a.styles))
  expect(b.wrapped).toBe(a.wrapped)
  expect(b.extra ? [...b.extra] : []).toEqual(a.extra ? [...a.extra] : [])
}

const mixed = (i: number): string =>
  `${i % 3 === 0 ? '\x1b[1;31m' : ''}line ${i} 中文 emoji 😀 é${i % 5 === 0 ? '\x1b[44m bg \x1b[K' : ''}\x1b[0m ${'x'.repeat(i % 70)}`

function filled(lines: number, cols = 60, rows = 10, scrollback = 5000): TerminalCore {
  const t = new TerminalCore({ cols, rows, scrollback })
  t.write(Array.from({ length: lines }, (_, i) => mixed(i)).join('\r\n'))
  return t
}

describe('packed scrollback', () => {
  it('pack then unpack gives back the identical line', () => {
    const t = filled(400)
    for (let i = 0; i < t.active.length; i++) {
      const line = t.active.absoluteLine(i)!
      sameLine(line, PackedLine.pack(line).unpack())
    }
  })

  it('packs only lines older than the hot window, never the screen', () => {
    const t = filled(1000)
    expect(t.packScrollback()).toBe(true)
    const sb = t.active.scrollbackLength
    expect(t.active.packedCount).toBe(sb - HOT_LINES)
    for (let r = 0; r < t.rows; r++) expect(t.active.line(r)).toBeInstanceOf(Line)
  })

  it('reading packed lines does not unpack them', () => {
    const t = filled(1000)
    t.packScrollback()
    const before = t.active.packedCount
    for (let i = 0; i < t.active.length; i++) t.active.absoluteLine(i)
    serialize(t)
    expect(t.active.packedCount).toBe(before)
  })

  it('serialize, search and the screen are the same before and after packing', () => {
    const a = filled(1200)
    const b = filled(1200)
    b.packScrollback()
    expect(serialize(b)).toBe(serialize(a))
    expect(findAll(b.active, 'line 42 ')).toEqual(findAll(a.active, 'line 42 '))
    expect(b.snapshot()).toEqual(a.snapshot())
  })

  it('output keeps scrolling over packed lines, and the cap still holds', () => {
    const t = filled(800, 60, 10, 600)
    t.packScrollback()
    t.write(Array.from({ length: 500 }, (_, i) => `\r\nmore ${i}`).join(''))
    expect(t.active.scrollbackLength).toBe(600)
    expect(t.active.line(t.rows - 1).chars(0)).toBe('m')
    t.packScrollback()
    expect(t.active.scrollbackLine(0)?.chars(0)).toBeDefined()
  })

  it('reflow works with packed lines and loses nothing', () => {
    const a = filled(900)
    const b = filled(900)
    b.packScrollback()
    a.resize(25, 10)
    b.resize(25, 10)
    a.resize(60, 10)
    b.resize(60, 10)
    expect(serialize(b)).toBe(serialize(a))
  })

  it('a time budget packs in slices until done', () => {
    const t = filled(3000)
    let slices = 1
    while (!t.packScrollback(0)) slices++
    expect(slices).toBeGreaterThan(1)
    expect(t.active.packedCount).toBe(t.active.scrollbackLength - HOT_LINES)
  })
})
