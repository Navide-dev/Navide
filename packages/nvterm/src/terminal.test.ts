import { describe, expect, it } from 'vitest'
import { CellFlag } from './snapshot.ts'
import { TerminalCore, type TerminalCoreOptions } from './terminal.ts'

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

/** [description, input, cols, rows, expected rows, expected cursor] */
type Case = [string, string, number, number, string[], [number, number]]

const cases: Case[] = [
  // Printing and wrapping (DEC STD 070 autowrap, last column flag)
  ['prints text', 'hello', 10, 2, ['hello', ''], [5, 0]],
  ['wrap is pending after the last column', 'abcd', 4, 2, ['abcd', ''], [4, 0]],
  ['the next character wraps', 'abcde', 4, 2, ['abcd', 'e'], [1, 1]],
  ['wrapping at the bottom scrolls', 'abcdefghi', 4, 2, ['efgh', 'i'], [1, 1]],
  ['CR cancels a pending wrap', 'abcd\rX', 4, 2, ['Xbcd', ''], [1, 0]],
  ['autowrap off overwrites the last column', `${CSI}?7labcdef`, 4, 2, ['abcf', ''], [3, 0]],
  ['autowrap back on', `${CSI}?7l${CSI}?7habcde`, 4, 2, ['abcd', 'e'], [1, 1]],
  // C0 controls (ECMA-48 8.3)
  ['LF keeps the column', 'ab\ncd', 10, 3, ['ab', '  cd', ''], [4, 1]],
  ['VT and FF act like LF', 'a\x0bb\x0cc', 10, 3, ['a', ' b', '  c'], [3, 2]],
  ['CR returns to column 0', 'abc\rX', 10, 1, ['Xbc'], [1, 0]],
  ['BS moves left', 'abc\b\bX', 10, 1, ['aXc'], [2, 0]],
  ['BS stops at column 0', '\b\bX', 10, 1, ['X'], [1, 0]],
  ['BS from a pending wrap', 'abcd\bX', 4, 1, ['abXd'], [3, 0]],
  ['HT to the next stop', 'a\tb', 20, 1, ['a       b'], [9, 0]],
  ['HT stops at the last column', '\t\t\tX', 10, 1, ['         X'], [10, 0]],
  ['BEL prints nothing', 'a\x07b', 10, 1, ['ab'], [2, 0]],
  ['LNM makes LF a newline', `${CSI}20hab\ncd`, 10, 2, ['ab', 'cd'], [2, 1]],
  ['NUL is ignored', 'a\x00b', 10, 1, ['ab'], [2, 0]],
  // C1 controls given as code points
  ['NEL', 'ab\u0085c', 10, 2, ['ab', 'c'], [1, 1]],
  ['IND keeps the column', 'ab\u0084c', 10, 2, ['ab', '  c'], [3, 1]],
  ['ESC D (IND)', `ab${ESC}Dc`, 10, 2, ['ab', '  c'], [3, 1]],
  ['ESC E (NEL)', `ab${ESC}Ec`, 10, 2, ['ab', 'c'], [1, 1]],
  // Cursor movement (ECMA-48 8.3.18-22, 8.3.9, 8.3.57-59, 8.3.158-160)
  ['CUP 1-based', `${CSI}2;3HX`, 10, 3, ['', '  X', ''], [3, 1]],
  ['CUP defaults to home', `abc${CSI}HX`, 10, 2, ['Xbc', ''], [1, 0]],
  ['CUP with 0 means 1', `${CSI}0;0HX`, 10, 2, ['X', ''], [1, 0]],
  ['CUP clamps to the screen', `${CSI}99;99HX`, 5, 2, ['', '    X'], [5, 1]],
  ['HVP', `${CSI}2;2fX`, 10, 2, ['', ' X'], [2, 1]],
  ['CUU', `${CSI}3;3H${CSI}AX`, 10, 3, ['', '  X', ''], [3, 1]],
  ['CUU stops at the top', `${CSI}2;1H${CSI}9AX`, 10, 3, ['X', '', ''], [1, 0]],
  ['CUD', `${CSI}BX`, 10, 3, ['', 'X', ''], [1, 1]],
  ['CUD stops at the bottom', `${CSI}9BX`, 10, 3, ['', '', 'X'], [1, 2]],
  ['CUF', `${CSI}3CX`, 10, 1, ['   X'], [4, 0]],
  ['CUF stops at the last column', `${CSI}99CX`, 5, 1, ['    X'], [5, 0]],
  ['CUB', `abcd${CSI}2DX`, 10, 1, ['abXd'], [3, 0]],
  ['CUB stops at column 0', `ab${CSI}9DX`, 10, 1, ['Xb'], [1, 0]],
  ['CNL', `ab${CSI}EX`, 10, 2, ['ab', 'X'], [1, 1]],
  ['CPL', `${CSI}2;5H${CSI}FX`, 10, 2, ['X', ''], [1, 0]],
  ['CHA', `abcdef${CSI}3GX`, 10, 1, ['abXdef'], [3, 0]],
  ['HPA', `abcdef${CSI}2\`X`, 10, 1, ['aXcdef'], [2, 0]],
  ['HPR', `ab${CSI}2aX`, 10, 1, ['ab  X'], [5, 0]],
  ['VPA keeps the column', `ab${CSI}3dX`, 10, 3, ['ab', '', '  X'], [3, 2]],
  ['VPR', `ab${CSI}2eX`, 10, 3, ['ab', '', '  X'], [3, 2]],
  ['CHT', `${CSI}2IX`, 20, 1, ['                X'], [17, 0]],
  ['CBT', `${CSI}1;19H${CSI}ZX`, 20, 1, ['                X'], [17, 0]],
  ['CBT twice', `${CSI}1;19H${CSI}2ZX`, 20, 1, ['        X'], [9, 0]],
  // Tab stops (ECMA-48 8.3.60 HTS, 8.3.154 TBC)
  ['HTS sets a stop', `${CSI}4G${ESC}H\r\tX`, 20, 1, ['   X'], [4, 0]],
  ['TBC 0 clears the stop at the cursor', `${CSI}9G${CSI}0g\r\tX`, 20, 1, ['                X'], [17, 0]],
  ['TBC 3 clears all stops', `${CSI}3g\tX`, 10, 1, ['         X'], [10, 0]],
  // Erasing (ECMA-48 8.3.39 ED, 8.3.41 EL, 8.3.38 ECH)
  ['EL 0', `abcdef${CSI}4G${CSI}K`, 10, 1, ['abc'], [3, 0]],
  ['EL 1', `abcdef${CSI}3G${CSI}1K`, 10, 1, ['   def'], [2, 0]],
  ['EL 2', `abcdef${CSI}3G${CSI}2K`, 10, 1, [''], [2, 0]],
  ['ED 0', `aaa\r\nbbb\r\nccc${CSI}2;2H${CSI}J`, 10, 3, ['aaa', 'b', ''], [1, 1]],
  ['ED 1', `aaa\r\nbbb\r\nccc${CSI}2;2H${CSI}1J`, 10, 3, ['', '  b', 'ccc'], [1, 1]],
  ['ED 2 keeps the cursor', `aaa\r\nbbb${CSI}2J`, 10, 3, ['', '', ''], [3, 1]],
  ['ECH', `abcdef${CSI}2G${CSI}3X`, 10, 1, ['a   ef'], [1, 0]],
  ['ECH clamps at the line end', `abcdef${CSI}5G${CSI}99X`, 10, 1, ['abcd'], [4, 0]],
  ['EL 0 at a pending wrap keeps the last cell', `abcd${CSI}K`, 4, 2, ['abcd', ''], [4, 0]],
  // Insert and delete (ECMA-48 8.3.64 ICH, 8.3.26 DCH, 8.3.67 IL, 8.3.32 DL)
  ['ICH', `abcdef${CSI}3G${CSI}2@`, 10, 1, ['ab  cdef'], [2, 0]],
  ['ICH pushes characters off the end', `abcdef${CSI}2G${CSI}3@`, 6, 1, ['a   bc'], [1, 0]],
  ['DCH', `abcdef${CSI}2G${CSI}2P`, 10, 1, ['adef'], [1, 0]],
  ['DCH more than the rest', `abcdef${CSI}3G${CSI}99P`, 10, 1, ['ab'], [2, 0]],
  ['IL', `aa\r\nbb\r\ncc${CSI}2H${CSI}L`, 10, 3, ['aa', '', 'bb'], [0, 1]],
  ['DL', `aa\r\nbb\r\ncc${CSI}1H${CSI}M`, 10, 3, ['bb', 'cc', ''], [0, 0]],
  ['IL outside the scroll region does nothing', `aa\r\nbb\r\ncc${CSI}2;3r${CSI}1H${CSI}L`, 10, 3, ['aa', 'bb', 'cc'], [0, 0]],
  ['IL inside the region', `aa\r\nbb\r\ncc${CSI}1;2r${CSI}1H${CSI}L`, 10, 3, ['', 'aa', 'cc'], [0, 0]],
  ['DL inside the region', `aa\r\nbb\r\ncc${CSI}1;2r${CSI}1H${CSI}M`, 10, 3, ['bb', '', 'cc'], [0, 0]],
  ['IRM inserts', `abcd${CSI}2G${CSI}4hXY${CSI}4l`, 10, 1, ['aXYbcd'], [3, 0]],
  ['REP repeats the last character', `ab${CSI}3b`, 10, 1, ['abbbb'], [5, 0]],
  // Scrolling and margins (DECSTBM, ECMA-48 8.3.147 SU, 8.3.113 SD, 8.3.104 RI)
  ['LF at the bottom margin scrolls the region only', `1\r\n2\r\n3\r\n4${CSI}2;3r${CSI}3H\nX`, 4, 4, ['1', '3', 'X', '4'], [1, 2]],
  ['DECSTBM homes the cursor', `ab${CSI}2;3r`, 4, 3, ['ab', '', ''], [0, 0]],
  ['invalid DECSTBM is ignored (LF at the screen bottom still scrolls)', `${CSI}3;2r${CSI}3H\nX`, 4, 3, ['', '', 'X'], [1, 2]],
  ['SU', `1\r\n2\r\n3${CSI}S`, 4, 3, ['2', '3', ''], [1, 2]],
  ['SD', `1\r\n2\r\n3${CSI}T`, 4, 3, ['', '1', '2'], [1, 2]],
  ['SU within a region', `1\r\n2\r\n3\r\n4${CSI}2;3r${CSI}S`, 4, 4, ['1', '3', '', '4'], [0, 0]],
  ['RI moves up', `${CSI}3HX${ESC}MY`, 4, 3, ['', ' Y', 'X'], [2, 1]],
  ['RI at the top scrolls down', `1\r\n2${CSI}H${ESC}MX`, 4, 3, ['X', '1', '2'], [1, 0]],
  ['CUD stops at the bottom margin', `${CSI}1;2r${CSI}9BX`, 4, 4, ['', 'X', '', ''], [1, 1]],
  ['CUD below the region goes to the screen bottom', `${CSI}1;2r${CSI}3H${CSI}9BX`, 4, 4, ['', '', '', 'X'], [1, 3]],
  // Origin mode (DECOM)
  ['DECOM homes to the region top', `${CSI}2;3r${CSI}?6hX`, 4, 4, ['', 'X', '', ''], [1, 1]],
  ['DECOM makes CUP relative', `${CSI}2;3r${CSI}?6h${CSI}2;2HX`, 4, 4, ['', '', ' X', ''], [2, 2]],
  ['DECOM clamps CUP to the region', `${CSI}2;3r${CSI}?6h${CSI}9;1HX`, 4, 4, ['', '', 'X', ''], [1, 2]],
  ['CUU at the region top stops in origin mode', `${CSI}2;3r${CSI}?6h${CSI}AX`, 4, 4, ['', 'X', '', ''], [1, 1]],
  // Save and restore (DECSC / DECRC, SCOSC / SCORC)
  ['DECSC / DECRC', `${CSI}2;3H${ESC}7${CSI}H${ESC}8X`, 10, 3, ['', '  X', ''], [3, 1]],
  ['CSI s / CSI u', `${CSI}2;3H${CSI}s${CSI}H${CSI}uX`, 10, 3, ['', '  X', ''], [3, 1]],
  ['DECRC without a save goes home', `${CSI}2;3H${ESC}8X`, 10, 3, ['X', '', ''], [1, 0]],
  // Character sets (SCS, SO / SI)
  ['DEC special graphics', `${ESC}(0lqk${ESC}(B`, 10, 1, ['┌─┐'], [3, 0]],
  ['G1 through SO / SI', `${ESC})0\x0eqx\x0fq`, 10, 1, ['─│q'], [3, 0]],
  ['only 0x60-0x7E are remapped', `${ESC}(0AB_${ESC}(B`, 10, 1, ['AB_'], [3, 0]],
  // DECALN
  ['DECALN fills with E', `${ESC}#8`, 3, 2, ['EEE', 'EEE'], [0, 0]],
  // Wide characters and combining marks
  ['wide characters take two cells', '中文', 10, 1, ['中文'], [4, 0]],
  ['a wide character wraps whole at the last column', 'abc中', 4, 2, ['abc', '中'], [2, 1]],
  ['writing over a leading half empties the trailing half', `中${CSI}1GX`, 10, 1, ['X'], [1, 0]],
  ['writing over a trailing half empties the leading half', `中${CSI}2GX`, 10, 1, [' X'], [2, 0]],
  ['a wide character over a narrow pair', `ab${CSI}1G中`, 10, 1, ['中'], [2, 0]],
  ['a wide character over the left half of another', `中文${CSI}2G字`, 10, 1, [' 字'], [3, 0]],
  ['combining mark joins the previous cell', 'éx', 10, 1, ['éx'], [2, 0]],
  ['combining mark at a pending wrap joins the last cell', 'abcd́', 4, 2, ['abcd́', ''], [4, 0]],
  ['combining mark on a wide character', '中́', 10, 1, ['中́'], [2, 0]],
  ['combining mark at column 0 is dropped', '́a', 10, 1, ['a'], [1, 0]],
  ['ZWJ sequence stays as separate wide cells', '👨‍👩', 10, 1, ['👨‍👩'], [4, 0]],
  ['VS16 joins without widening (Unicode 11)', '❤️x', 10, 1, ['❤️x'], [2, 0]],
  ['DCH on a trailing half empties the wide character', `中文${CSI}2G${CSI}P`, 10, 1, [' 文'], [1, 0]],
  ['ICH pushing a wide character off the edge removes it', `ab中${CSI}1G${CSI}@`, 4, 1, [' ab'], [0, 0]],
  ['EL starting on a trailing half empties the wide character', `中文${CSI}2G${CSI}K`, 10, 1, [''], [1, 0]],
  // Alternate screen
  ['1049 enters a cleared alternate screen', `normal${CSI}?1049hX`, 10, 2, ['      X', ''], [7, 0]],
  ['1049 leaves and restores the cursor', `ab${CSI}?1049h${CSI}2;5Hzz${CSI}?1049lX`, 10, 2, ['abX', ''], [3, 0]],
  ['47 switches without clearing on exit', `n${CSI}?47ha${CSI}?47l${CSI}?47h`, 10, 1, [' a'], [2, 0]],
  ['1047 clears the alternate screen when leaving', `n${CSI}?1047ha${CSI}?1047l${CSI}?1047h`, 10, 1, [''], [2, 0]],
  ['the alternate screen has no scrollback', `${CSI}?1049h1\r\n2\r\n3\r\n4`, 4, 2, ['3', '4'], [1, 1]],
  ['1048 saves and restores the cursor', `${CSI}2;3H${CSI}?1048h${CSI}H${CSI}?1048lX`, 10, 3, ['', '  X', ''], [3, 1]],
  // Resets
  ['RIS clears the screen and modes', `abc${CSI}?7l${ESC}cdefgh`, 4, 2, ['defg', 'h'], [1, 1]],
  ['DECSTR resets margins and attributes but keeps the screen', `ab${CSI}2;3r${CSI}1m${CSI}!pX`, 4, 3, ['Xb', '', ''], [1, 0]],
]

describe('TerminalCore screen behaviour', () => {
  it.each(cases)('%s', (_name, input, cols, rowCount, expectedRows, expectedCursor) => {
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
    expect(t.active.lines.slice(0, 3).map((l) => l.chars(0))).toEqual(['1', '2', '3'])
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

describe('TerminalCore resize (no reflow yet)', () => {
  it('growing columns keeps content', () => {
    const t = term('abc', 4, 2)
    t.resize(8, 2)
    expect(rows(t)).toEqual(['abc', ''])
    expect(t.snapshot().cols).toBe(8)
  })

  it('shrinking columns truncates and clamps the cursor', () => {
    const t = term('abcdef', 8, 2)
    t.resize(3, 2)
    expect(rows(t)).toEqual(['abc', ''])
    expect(cursor(t)[0]).toBeLessThanOrEqual(3)
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

  it('a wide character cut by the new width disappears', () => {
    const t = term('ab中', 4, 1)
    t.resize(3, 1)
    expect(rows(t)).toEqual(['ab'])
  })
})
