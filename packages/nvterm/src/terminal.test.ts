import { describe, expect, it } from 'vitest'
import { CellFlag } from './snapshot'
import { screenCases } from './terminal.cases'
import { TerminalCore, type TerminalCoreOptions } from './terminal'

const ESC = '\x1b'
const CSI = `${ESC}[`

function term(input: string, cols = 10, rows = 4, options: Partial<TerminalCoreOptions> = {}): TerminalCore {
  const t = new TerminalCore({ cols, rows, ...options })
  t.write(input)
  return t
}

/** Visible rows as text: empty cells are spaces, trailing halves vanish, trailing spaces are trimmed. */
function rows(t: TerminalCore): string[] {
  return t.snapshot().lines.map((line) => line.cells.map((c) => (c.width === 0 ? '' : c.chars || ' ')).join('').trimEnd())
}

function cursor(t: TerminalCore): [number, number] {
  const { x, y } = t.snapshot().cursor
  return [x, y]
}

function cell(t: TerminalCore, row: number, col: number) {
  return t.snapshot().lines[row]!.cells[col]!
}


describe('TerminalCore screen behaviour', () => {
  it.each(screenCases)('%s', (_name, input, cols, rowCount, expectedRows, expectedCursor) => {
    const t = term(input, cols, rowCount)
    expect(rows(t)).toEqual(expectedRows)
    expect(cursor(t)).toEqual(expectedCursor)
  })
})

describe('TerminalCore attributes', () => {
  it.each([
    ['bold', `${CSI}1mx`, { flags: CellFlag.Bold }],
    ['dim', `${CSI}2mx`, { flags: CellFlag.Dim }],
    ['italic', `${CSI}3mx`, { flags: CellFlag.Italic }],
    ['underline', `${CSI}4mx`, { flags: CellFlag.Underline }],
    ['curly underline', `${CSI}4:3mx`, { flags: CellFlag.Underline }],
    ['underline off via 4:0', `${CSI}4m${CSI}4:0mx`, { flags: 0 }],
    ['double underline (21)', `${CSI}21mx`, { flags: CellFlag.Underline }],
    ['blink', `${CSI}5mx`, { flags: CellFlag.Blink }],
    ['inverse', `${CSI}7mx`, { flags: CellFlag.Inverse }],
    ['invisible', `${CSI}8mx`, { flags: CellFlag.Invisible }],
    ['strikethrough', `${CSI}9mx`, { flags: CellFlag.Strikethrough }],
    ['overline', `${CSI}53mx`, { flags: CellFlag.Overline }],
    ['22 clears bold and dim', `${CSI}1;2;22mx`, { flags: 0 }],
    ['23 24 25 27 28 29 55 clear', `${CSI}3;4;5;7;8;9;53m${CSI}23;24;25;27;28;29;55mx`, { flags: 0 }],
    ['0 resets', `${CSI}1;31;42m${CSI}0mx`, { flags: 0, fg: 'd', bg: 'd' }],
    ['empty SGR resets', `${CSI}1;31m${CSI}mx`, { flags: 0, fg: 'd' }],
    ['16 colours', `${CSI}31;42mx`, { fg: 'p:1', bg: 'p:2' }],
    ['bright colours', `${CSI}91;102mx`, { fg: 'p:9', bg: 'p:10' }],
    ['256 colours', `${CSI}38;5;196;48;5;21mx`, { fg: 'p:196', bg: 'p:21' }],
    ['truecolor', `${CSI}38;2;1;2;3;48;2;255;128;0mx`, { fg: 'r:010203', bg: 'r:ff8000' }],
    ['truecolor with colons and a colour space', `${CSI}38:2::10:20:30mx`, { fg: 'r:0a141e' }],
    ['truecolor with colons, no colour space', `${CSI}38:2:10:20:30mx`, { fg: 'r:0a141e' }],
    ['256 colours with colons', `${CSI}38:5:99mx`, { fg: 'p:99' }],
    ['39 and 49 reset colours', `${CSI}31;41m${CSI}39;49mx`, { fg: 'd', bg: 'd' }],
    ['parameters after an extended colour still apply', `${CSI}38;5;1;1mx`, { fg: 'p:1', flags: CellFlag.Bold }],
    ['bold does not change the colour', `${CSI}1;32mx`, { fg: 'p:2', flags: CellFlag.Bold }],
  ])('%s', (_name, input, expected) => {
    expect(cell(term(input), 0, 0)).toMatchObject(expected)
  })

  it('erase uses the current background (BCE) and no other attributes', () => {
    const t = term(`ab${CSI}1;31;44m${CSI}K`)
    expect(cell(t, 0, 5)).toMatchObject({ chars: '', bg: 'p:4', fg: 'd', flags: 0 })
    expect(cell(t, 0, 0)).toMatchObject({ chars: 'a', bg: 'd' })
  })

  it('lines scrolled in take the current background', () => {
    const t = term(`${CSI}45m\n\n\n\n`, 4, 2)
    expect(cell(t, 1, 0).bg).toBe('p:5')
  })

  it('DECSC saves and DECRC restores attributes', () => {
    const t = term(`${CSI}1;31m${ESC}7${CSI}0m${ESC}8x`)
    expect(cell(t, 0, 0)).toMatchObject({ fg: 'p:1', flags: CellFlag.Bold })
  })
})

describe('TerminalCore modes', () => {
  it.each([
    ['DECCKM', `${CSI}?1h`, 'applicationCursorKeysMode', true],
    ['DECKPAM', `${ESC}=`, 'applicationKeypadMode', true],
    ['DECKPNM', `${ESC}=${ESC}>`, 'applicationKeypadMode', false],
    ['bracketed paste', `${CSI}?2004h`, 'bracketedPasteMode', true],
    ['IRM', `${CSI}4h`, 'insertMode', true],
    ['DECOM', `${CSI}?6h`, 'originMode', true],
    ['reverse wraparound', `${CSI}?45h`, 'reverseWraparoundMode', true],
    ['focus reporting', `${CSI}?1004h`, 'sendFocusMode', true],
    ['DECAWM off', `${CSI}?7l`, 'wraparoundMode', false],
    ['X10 mouse', `${CSI}?9h`, 'mouseTrackingMode', 'x10'],
    ['VT200 mouse', `${CSI}?1000h`, 'mouseTrackingMode', 'vt200'],
    ['button-event mouse', `${CSI}?1002h`, 'mouseTrackingMode', 'drag'],
    ['any-event mouse', `${CSI}?1003h`, 'mouseTrackingMode', 'any'],
    ['the last mouse mode wins', `${CSI}?1000;1003h`, 'mouseTrackingMode', 'any'],
    ['resetting the active mouse mode', `${CSI}?1002h${CSI}?1002l`, 'mouseTrackingMode', 'none'],
    ['resetting an inactive mouse mode keeps the active one', `${CSI}?1002h${CSI}?1000l`, 'mouseTrackingMode', 'drag'],
    ['several modes in one sequence', `${CSI}?1;2004h`, 'bracketedPasteMode', true],
  ])('%s', (_name, input, key, value) => {
    expect(term(input).snapshot().modes[key]).toBe(value)
  })

  it('tracks modes the snapshot does not report', () => {
    const t = term(`${CSI}?25l${CSI}?12h${CSI}?2026h${CSI}?1006h${CSI}?5h${CSI}4 q`)
    expect(t.modes).toMatchObject({ cursorVisible: false, cursorBlink: true, synchronizedOutput: true, mouseEncoding: 'sgr', reverseVideo: true })
    expect(t.cursorStyle).toBe(4)
  })

  it('DECSTR turns insert, origin and keypad modes off', () => {
    const t = term(`${CSI}4h${CSI}?6h${ESC}=${CSI}?7l${CSI}!p`)
    expect(t.snapshot().modes).toMatchObject({ insertMode: false, originMode: false, applicationKeypadMode: false, wraparoundMode: true })
  })
})

describe('TerminalCore replies and events', () => {
  function replies(input: string, cols = 10, rows = 4): string[] {
    const out: string[] = []
    term(input, cols, rows, { onResponse: (d) => out.push(d) })
    return out
  }

  it.each([
    ['DSR 5 (status)', `${CSI}5n`, ['\x1b[0n']],
    ['DSR 6 (cursor position)', `${CSI}3;4H${CSI}6n`, ['\x1b[3;4R']],
    ['DSR 6 at a pending wrap reports the last column', `abcd${CSI}6n`, ['\x1b[1;4R']],
    ['DSR 6 in origin mode is region-relative', `${CSI}2;4r${CSI}?6h${CSI}2;1H${CSI}6n`, ['\x1b[2;1R']],
    ['DECXCPR', `${CSI}2;2H${CSI}?6n`, ['\x1b[?2;2R']],
    ['DA1', `${CSI}c`, ['\x1b[?62;22c']],
    ['DA1 with 0', `${CSI}0c`, ['\x1b[?62;22c']],
    ['DA2', `${CSI}>c`, ['\x1b[>0;10;1c']],
    ['unknown sequences do not reply', `${CSI}99n${CSI}?999h`, []],
  ])('%s', (_name, input, expected) => {
    expect(replies(input, 4, 4)).toEqual(expected)
  })

  it('OSC 0 and 2 set the title', () => {
    const titles: string[] = []
    const t = term(`${ESC}]0;one\x07${ESC}]2;two${ESC}\\`, 10, 1, { onTitle: (s) => titles.push(s) })
    expect(titles).toEqual(['one', 'two'])
    expect(t.title).toBe('two')
  })

  it('other OSC codes go to onOsc', () => {
    const seen: [number, string][] = []
    term(`${ESC}]52;c;aGk=\x07${ESC}]133;A\x07${ESC}]7;file:///tmp\x07`, 10, 1, { onOsc: (code, data) => seen.push([code, data]) })
    expect(seen).toEqual([[52, 'c;aGk='], [133, 'A'], [7, 'file:///tmp']])
  })

  it('BEL calls onBell', () => {
    let bells = 0
    term('a\x07\x07', 10, 1, { onBell: () => bells++ })
    expect(bells).toBe(2)
  })

  it('OSC 8 attaches a hyperlink to the cells between open and close', () => {
    const t = term(`a${ESC}]8;;https://e.com${ESC}\\link${ESC}]8;;${ESC}\\b`)
    const line = t.active.line(0)
    expect(t.linkUri(t.style(line.styles[1]!).link)).toBe('https://e.com')
    expect(t.style(line.styles[4]!).link).not.toBe(0)
    expect(t.style(line.styles[0]!).link).toBe(0)
    expect(t.style(line.styles[5]!).link).toBe(0)
  })
})

describe('TerminalCore scrollback', () => {
  it('lines leaving the top of the screen become scrollback', () => {
    const t = term('1\r\n2\r\n3\r\n4\r\n5', 4, 2)
    expect(t.snapshot().scrollbackLength).toBe(3)
    expect([0, 1, 2].map((i) => t.active.scrollbackLine(i)?.chars(0))).toEqual(['1', '2', '3'])
  })

  it('scrollback stays capped and ordered across many compactions', () => {
    const t = term(Array.from({ length: 5000 }, (_, i) => String(i)).join('\r\n'), 6, 2, { scrollback: 100 })
    expect(t.snapshot().scrollbackLength).toBe(100)
    expect(t.active.scrollbackLine(0)?.chars(0)).toBe('4')
    expect(rows(t)).toEqual(['4998', '4999'])
    t.write(`${CSI}3J`)
    expect(t.snapshot().scrollbackLength).toBe(0)
    expect(rows(t)).toEqual(['4998', '4999'])
  })

  it('scrollback is capped', () => {
    const t = term(Array.from({ length: 50 }, (_, i) => String(i)).join('\r\n'), 4, 2, { scrollback: 10 })
    expect(t.snapshot().scrollbackLength).toBe(10)
    expect(rows(t)).toEqual(['48', '49'])
  })

  it('a region starting at the top row feeds the scrollback', () => {
    const t = term(`${CSI}1;2r1\r\n2\r\n3`, 4, 3)
    expect(t.snapshot().scrollbackLength).toBe(1)
    expect(rows(t)).toEqual(['2', '3', ''])
  })

  it('a region below the top row does not', () => {
    const t = term(`${CSI}2;3r${CSI}2H1\r\n2\r\n3`, 4, 3)
    expect(t.snapshot().scrollbackLength).toBe(0)
  })

  it('SU and DL never feed the scrollback', () => {
    expect(term(`1\r\n2${CSI}2S`, 4, 2).snapshot().scrollbackLength).toBe(0)
    expect(term(`1\r\n2${CSI}H${CSI}M`, 4, 2).snapshot().scrollbackLength).toBe(0)
  })

  it('ED 3 clears the scrollback and keeps the screen', () => {
    const t = term(`1\r\n2\r\n3\r\n4${CSI}3J`, 4, 2)
    expect(t.snapshot().scrollbackLength).toBe(0)
    expect(rows(t)).toEqual(['3', '4'])
  })

  it('wrapped lines are marked', () => {
    const t = term('abcdef', 4, 2)
    expect(t.snapshot().lines.map((l) => l.wrapped)).toEqual([false, true])
  })
})

describe('TerminalCore resize', () => {
  it('growing columns keeps content', () => {
    const t = term('abc', 4, 2)
    t.resize(8, 2)
    expect(rows(t)).toEqual(['abc', ''])
    expect(t.snapshot().cols).toBe(8)
  })

  it('shrinking columns re-wraps the line and keeps the cursor after the text', () => {
    const t = term('abcdef', 8, 2)
    t.resize(3, 2)
    expect(rows(t)).toEqual(['abc', 'def'])
    expect(cursor(t)).toEqual([3, 1])
  })

  it('shrinking rows pushes the top into scrollback when the cursor would fall off', () => {
    const t = term('1\r\n2\r\n3\r\n4', 4, 4)
    t.resize(4, 2)
    expect(rows(t)).toEqual(['3', '4'])
    expect(t.snapshot().scrollbackLength).toBe(2)
    expect(cursor(t)).toEqual([1, 1])
  })

  it('growing rows pulls lines back from scrollback', () => {
    const t = term('1\r\n2\r\n3\r\n4', 4, 2)
    t.resize(4, 4)
    expect(rows(t)).toEqual(['1', '2', '3', '4'])
    expect(cursor(t)).toEqual([1, 3])
  })

  it('a wide character that no longer fits moves to the next line', () => {
    const t = term('ab中', 4, 1)
    t.resize(3, 1)
    expect(rows(t)).toEqual(['中'])
    expect(t.active.scrollbackLine(0)?.chars(0)).toBe('a')
  })
})
