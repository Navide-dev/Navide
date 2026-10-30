import { describe, expect, it } from 'vitest'
import { serialize } from '../../src/serialize.ts'
import { diffSnapshots } from '../../src/snapshot.ts'
import { TerminalCore } from '../../src/terminal.ts'
import { fixtures } from '../fixtures/fixtures.ts'
import { readFileSync } from 'node:fs'
import type { Triage } from './compare.ts'
import { xtermDriver } from './xtermOracle.ts'

/** Fixtures where nvterm and xterm.js already differ on purpose (triage.json). */
const triaged = new Set(Object.keys(JSON.parse(readFileSync(new URL('./triage.json', import.meta.url), 'utf8')) as Triage))

function replay(source: TerminalCore, options = {}): TerminalCore {
  const copy = new TerminalCore({ cols: source.cols, rows: source.rows, scrollback: 10000 })
  copy.write(serialize(source, options))
  return copy
}

describe('serialize', () => {
  it('round-trips every fixture through a fresh terminal of the same size', () => {
    const failures: string[] = []
    for (const f of fixtures) {
      const a = new TerminalCore({ cols: f.cols, rows: f.rows, scrollback: 10000 })
      for (const chunk of f.chunks) a.write(chunk)
      const b = replay(a)
      const diffs = diffSnapshots(a.snapshot(), b.snapshot())
        // The pending-wrap position (x === cols) comes back as the last column.
        .filter((d) => !(d.kind === 'cursor' && a.snapshot().cursor.x === f.cols))
      if (diffs.length) failures.push(`${f.id}: ${diffs.slice(0, 3).map((d) => JSON.stringify(d)).join(' ')}`)
    }
    expect(failures).toEqual([])
  })

  it('a serialized nvterm screen replays the same in xterm.js (the two cores can hand scrollback to each other)', async () => {
    const failures: string[] = []
    for (const f of fixtures.filter((x) => !triaged.has(x.id))) {
      const a = new TerminalCore({ cols: f.cols, rows: f.rows, scrollback: 10000 })
      for (const chunk of f.chunks) a.write(chunk)
      const payload = new TextEncoder().encode(serialize(a))
      const replayed = await xtermDriver.run({ ...f, chunks: [payload] })
      const direct = await xtermDriver.run(f)
      const diffs = diffSnapshots(direct, replayed).filter((d) => d.kind !== 'cursor' && d.kind !== 'mode')
      if (diffs.length) failures.push(`${f.id}: ${diffs.slice(0, 3).map((d) => JSON.stringify(d)).join(' ')}`)
    }
    expect(failures).toEqual([])
  })

  it('emits SGR only where the style changes and resets before line breaks', () => {
    const t = new TerminalCore({ cols: 20, rows: 3 })
    t.write('\x1b[1;31mred\x1b[0m plain\r\n\x1b[44mblue bg')
    expect(serialize(t)).toBe('\x1b[0;1;31mred\x1b[0m plain\r\n\x1b[0;44mblue bg\x1b[0m')
  })

  it('keeps wrapped lines joined so a replay re-wraps', () => {
    const t = new TerminalCore({ cols: 4, rows: 3 })
    t.write('abcdefg')
    expect(serialize(t)).toBe('abcdefg')
    const wide = new TerminalCore({ cols: 10, rows: 3 })
    wide.write(serialize(t))
    expect(wide.active.line(0).chars(6)).toBe('g')
  })

  it('limits the scrollback', () => {
    const t = new TerminalCore({ cols: 6, rows: 2, scrollback: 100 })
    t.write(Array.from({ length: 10 }, (_, i) => `l${i}`).join('\r\n'))
    expect(serialize(t, { scrollback: 2 })).toBe('l6\r\nl7\r\nl8\r\nl9')
  })

  it('appends the alternate screen after the boundary sequence, unless excluded', () => {
    const t = new TerminalCore({ cols: 10, rows: 3 })
    t.write('normal\x1b[?1049h\x1b[2;3Htui')
    const full = serialize(t)
    expect(full).toBe('normal\x1b[?1049h\x1b[H\r\n\x1b[2Ctui\x1b[2;6H')
    expect(serialize(t, { excludeAltBuffer: true })).toBe('normal')
  })

  it('restores the cursor relative to the text', () => {
    const t = new TerminalCore({ cols: 10, rows: 4 })
    t.write('one\r\ntwo\r\nthree\x1b[2;2H')
    expect(serialize(t)).toBe('one\r\ntwo\r\nthree\x1b[1A\x1b[2G')
  })

  it('writes the mode section', () => {
    const t = new TerminalCore({ cols: 10, rows: 2 })
    t.write('\x1b[?1h\x1b[?2004h\x1b[?1000;1006h\x1b[?7l\x1b[?25l')
    expect(serialize(t)).toBe('\x1b[?1h\x1b[?2004h\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[?25l')
  })

  it('keeps underline styles and colours', () => {
    const t = new TerminalCore({ cols: 10, rows: 1 })
    t.write('\x1b[4:3;58;5;196mx')
    expect(serialize(t)).toBe('\x1b[0;4:3;58;5;196mx\x1b[0m')
  })
})
