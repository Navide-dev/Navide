import { describe, expect, it } from 'vitest'
import { TerminalCore } from './terminal'

/** Every line in the buffer (scrollback + screen) joined into logical lines, trailing spaces trimmed. */
function logicalText(t: TerminalCore): string[] {
  const buf = t.active
  const out: string[] = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.absoluteLine(i)!
    let text = ''
    for (let x = 0; x < line.cols; x++) if (line.widths[x] !== 0) text += line.chars(x) || ' '
    if (line.wrapped && out.length) out[out.length - 1] += text
    else out.push(text)
  }
  return out.map((s) => s.trimEnd()).filter((s, i, all) => s !== '' || all.slice(i).some((r) => r !== ''))
}

function core(cols: number, rows: number, text: string, scrollback = 1000): TerminalCore {
  const t = new TerminalCore({ cols, rows, scrollback })
  t.write(text)
  return t
}

const longLine = 'The quick brown fox jumps over the lazy dog, again and again and again.'

describe('reflow on resize', () => {
  it('re-wraps a long line when narrowed and joins it again when widened', () => {
    const t = core(80, 5, `${longLine}\r\nshort`)
    t.resize(20, 5)
    expect(t.active.absoluteLine(0)!.chars(0)).toBe('T')
    expect(t.active.absoluteLine(1)!.wrapped).toBe(true)
    t.resize(80, 5)
    expect(logicalText(t)).toEqual([longLine, 'short'])
    expect(t.active.absoluteLine(1)!.wrapped).toBe(false)
  })

  it('narrowing then widening keeps every scrollback line (nothing is cleared)', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(i % 50)} 中文`)
    const t = core(60, 10, lines.join('\r\n'), 5000)
    const before = logicalText(t)
    t.resize(17, 10)
    t.resize(33, 7)
    t.resize(60, 10)
    expect(logicalText(t)).toEqual(before)
    expect(t.snapshot().scrollbackLength).toBeGreaterThan(280)
  })

  it('keeps styles and wide characters, wrapping a wide character whole', () => {
    const t = core(10, 3, '\x1b[31mab中文字\x1b[0m')
    t.resize(5, 3)
    const l0 = t.active.absoluteLine(t.active.length - 3)!
    expect(l0.chars(2)).toBe('中')
    expect(l0.codes[4]).toBe(0) // 文 did not fit in column 4
    const l1 = t.active.absoluteLine(t.active.length - 2)!
    expect(l1.wrapped).toBe(true)
    expect(l1.chars(0)).toBe('文')
    expect(t.style(l1.styles[0]!).fg).not.toBe(0)
    t.resize(10, 3)
    expect(logicalText(t)).toEqual(['ab中文字'])
  })

  it('keeps the cursor at the same place in its logical line', () => {
    const t = core(20, 4, `prompt> ${'y'.repeat(15)}`)
    expect(t.snapshot().cursor).toEqual({ x: 3, y: 1 })
    t.resize(10, 4)
    const s = t.snapshot()
    // 23 characters at width 10: the cursor follows the 23rd, on the third row.
    expect(s.cursor).toEqual({ x: 3, y: 2 })
    t.write('Z')
    t.resize(20, 4)
    expect(logicalText(t)).toEqual([`prompt> ${'y'.repeat(15)}Z`])
  })

  it('does not push the screen into scrollback when there is room below the cursor', () => {
    const t = core(40, 10, 'one\r\ntwo\r\nthree')
    t.resize(20, 10)
    expect(t.snapshot().scrollbackLength).toBe(0)
    expect(logicalText(t)).toEqual(['one', 'two', 'three'])
  })

  it('respects the scrollback cap when narrowing creates more lines', () => {
    const t = core(40, 4, Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(30, '-')).join('\r\n'), 10)
    const dropped = t.active.dropped
    t.resize(10, 4)
    expect(t.snapshot().scrollbackLength).toBeLessThanOrEqual(10)
    expect(t.active.dropped).toBeGreaterThan(dropped)
  })

  it('a background band filled by EL is not content: it neither wraps into an extra row nor disappears', () => {
    const t = core(40, 4, '\x1b[44mstatus\x1b[K\x1b[0m\r\nnext')
    t.resize(20, 4)
    expect(logicalText(t)).toEqual(['status', 'next'])
    const band = t.active.absoluteLine(0)!
    expect(t.style(band.styles[19]!).bg).not.toBe(0)
    t.resize(40, 4)
    expect(t.style(t.active.absoluteLine(0)!.styles[39]!).bg).not.toBe(0)
  })

  it('wide characters before the cursor count as two columns', () => {
    const t = core(30, 3, 'mixed 中 a 文 b')
    const x = t.snapshot().cursor.x
    t.resize(20, 3)
    expect(t.snapshot().cursor.x).toBe(x)
  })

  it('leaves the alternate screen unwrapped', () => {
    const t = core(20, 3, `\x1b[?1049h${'z'.repeat(15)}`)
    t.resize(10, 3)
    expect(t.active.line(0).chars(9)).toBe('z')
    expect(t.active.line(1).wrapped).toBe(false)
    t.write('\x1b[?1049l')
    expect(t.active).toBe(t.normal)
  })

  it('a height-only change does not reflow', () => {
    const t = core(10, 5, 'abcdefghijKLM')
    t.resize(10, 3)
    expect(logicalText(t)).toEqual(['abcdefghijKLM'])
  })
})
