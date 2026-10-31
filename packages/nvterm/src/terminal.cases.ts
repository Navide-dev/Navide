// Screen behaviour cases: [description, input, cols, rows, expected rows, expected cursor].
// Expected rows show empty cells as spaces, omit trailing halves of wide
// characters and trim trailing spaces. terminal.test.ts checks nvterm against
// them; tools/golden checks the same inputs against the xterm.js oracle.

const ESC = '\x1b'
const CSI = `${ESC}[`

/** [description, input, cols, rows, expected rows, expected cursor] */
export type ScreenCase = [string, string, number, number, string[], [number, number]]

export const screenCases: ScreenCase[] = [
  // Printing and wrapping (DEC STD 070 autowrap, last column flag)
  ['prints text', 'hello', 10, 2, ['hello', ''], [5, 0]],
  ['wrap is pending after the last column', 'abcd', 4, 2, ['abcd', ''], [4, 0]],
  ['the next character wraps', 'abcde', 4, 2, ['abcd', 'e'], [1, 1]],
  ['wrapping at the bottom scrolls', 'abcdefghi', 4, 2, ['efgh', 'i'], [1, 1]],
  ['CR cancels a pending wrap', 'abcd\rX', 4, 2, ['Xbcd', ''], [1, 0]],
  ['autowrap off overwrites the last column', `${CSI}?7labcdef`, 4, 2, ['abcf', ''], [4, 0]],
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
  ['combining mark at column 0 takes its own cell', '\u0301a', 10, 1, ['\u0301a'], [2, 0]],
  ['ZWJ sequence stays as separate wide cells', '👨‍👩', 10, 1, ['👨‍👩'], [4, 0]],
  ['VS16 joins without widening (Unicode 11)', '❤️x', 10, 1, ['❤️x'], [2, 0]],
  ['DCH on a trailing half empties the wide character', `中文${CSI}2G${CSI}P`, 10, 1, [' 文'], [1, 0]],
  ['ICH pushing a wide character off the edge removes it', `ab中${CSI}1G${CSI}@`, 4, 1, [' ab'], [0, 0]],
  ['EL starting on a trailing half empties the wide character', `中文${CSI}2G${CSI}K`, 10, 1, [''], [1, 0]],
  // Alternate screen
  ['1049 enters a cleared alternate screen', `normal${CSI}?1049hX`, 10, 2, ['      X', ''], [7, 0]],
  ['1049 leaves and restores the cursor', `ab${CSI}?1049h${CSI}2;5Hzz${CSI}?1049lX`, 10, 2, ['abX', ''], [3, 0]],
  ['47 enters an empty alternate screen every time', `n${CSI}?47ha${CSI}?47l${CSI}?47h`, 10, 1, [''], [2, 0]],
  ['1047 clears the alternate screen when leaving', `n${CSI}?1047ha${CSI}?1047l${CSI}?1047h`, 10, 1, [''], [2, 0]],
  ['the alternate screen has no scrollback', `${CSI}?1049h1\r\n2\r\n3\r\n4`, 4, 2, ['3', '4'], [1, 1]],
  ['1048 saves and restores the cursor', `${CSI}2;3H${CSI}?1048h${CSI}H${CSI}?1048lX`, 10, 3, ['', '  X', ''], [3, 1]],
  // Resets
  ['RIS clears the screen and modes', `abc${CSI}?7l${ESC}cdefgh`, 4, 2, ['defg', 'h'], [1, 1]],
  ['DECSTR resets margins and attributes but keeps the screen', `ab${CSI}2;3r${CSI}1m${CSI}!pX`, 4, 3, ['Xb', '', ''], [1, 0]],
  // More printing, wrapping and control edge cases
  ['wrapping continues across several lines', 'abcdefghij', 4, 3, ['abcd', 'efgh', 'ij'], [2, 2]],
  ['a wide character exactly filling the line leaves a wrap pending', 'ab中', 4, 2, ['ab中', ''], [4, 0]],
  ['wide characters wrap one by one', '中文字', 4, 2, ['中文', '字'], [2, 1]],
  ['LF from a pending wrap moves down', 'abcd\nX', 4, 2, ['abcd', '   X'], [4, 1]],
  ['CR LF from a pending wrap', 'abcd\r\nX', 4, 2, ['abcd', 'X'], [1, 1]],
  ['CUB from a pending wrap counts from the last column', `abcd${CSI}DX`, 4, 1, ['abXd'], [3, 0]],
  ['CUF from a pending wrap stays at the last column', `abcd${CSI}CX`, 4, 2, ['abcX', ''], [4, 0]],
  ['CHA cancels a pending wrap', `abcd${CSI}1GX`, 4, 2, ['Xbcd', ''], [1, 0]],
  ['HT from a pending wrap keeps the wrap pending', 'abcd\tX', 4, 2, ['abcd', 'X'], [1, 1]],
  ['CAN in the middle of CSI prints nothing', `a${CSI}3\x18b`, 10, 1, ['ab'], [2, 0]],
  ['an unknown CSI final is ignored', `a${CSI}5~b`, 10, 1, ['ab'], [2, 0]],
  ['an unknown private CSI is ignored', `a${CSI}?5zb`, 10, 1, ['ab'], [2, 0]],
  ['an unknown ESC final is ignored', `a${ESC}Zb`, 10, 1, ['ab'], [2, 0]],
  ['a DCS string is swallowed', `a${ESC}P1$qm${ESC}\\b`, 10, 1, ['ab'], [2, 0]],
  ['an APC string is swallowed', `a${ESC}_Gf=24;AAAA${ESC}\\b`, 10, 1, ['ab'], [2, 0]],
  ['an OSC string prints nothing', `a${ESC}]0;title\x07b`, 10, 1, ['ab'], [2, 0]],
  ['8-bit CSI as a code point', `\u009b2;2HX`, 10, 2, ['', ' X'], [2, 1]],
  ['window manipulation (CSI t) is ignored', `a${CSI}8;24;80tb`, 10, 1, ['ab'], [2, 0]],
  ['SD with five parameters scrolls by the first (xterm.js)', `1\r\n2${CSI}1;2;3;4;5T`, 4, 2, ['', '1'], [1, 1]],
  ['CSI s with parameters still saves (no DECLRMM)', `${CSI}2;2H${CSI}1;2s${CSI}H${CSI}uX`, 10, 2, ['', ' X'], [2, 1]],
  // Erase and edit edge cases
  ['ED 0 at column 0 clears the whole line', `aaa\r\nbbb${CSI}1;1H${CSI}J`, 10, 2, ['', ''], [0, 0]],
  ['ED 1 at the last column clears the line', `aaa\r\nbbb${CSI}1;10H${CSI}1J`, 10, 2, ['', 'bbb'], [9, 0]],
  ['EL 1 at a pending wrap clears the whole line', `abcd${CSI}1K`, 4, 2, ['', ''], [4, 0]],
  ['ECH 0 erases one cell', `abc${CSI}1G${CSI}0X`, 10, 1, [' bc'], [0, 0]],
  ['ICH 0 inserts one cell', `abc${CSI}1G${CSI}0@`, 10, 1, [' abc'], [0, 0]],
  ['DCH 0 deletes one cell', `abc${CSI}1G${CSI}0P`, 10, 1, ['bc'], [0, 0]],
  ['IL more than the region height', `aa\r\nbb\r\ncc${CSI}1H${CSI}9L`, 10, 3, ['', '', ''], [0, 0]],
  ['DL more than the region height', `aa\r\nbb\r\ncc${CSI}2H${CSI}9M`, 10, 3, ['aa', '', ''], [0, 1]],
  ['IL resets the column', `aa\r\nbb${CSI}1;2H${CSI}LX`, 10, 3, ['X', 'aa', 'bb'], [1, 0]],
  ['IRM with a wide character', `abc${CSI}1G${CSI}4h中${CSI}4l`, 10, 1, ['中abc'], [2, 0]],
  ['REP after a wide character', `中${CSI}2b`, 10, 1, ['中中中'], [6, 0]],
  ['REP without a previous character does nothing', `${CSI}3bX`, 10, 1, ['X'], [1, 0]],
  // Scrolling, regions and screens
  ['SU more than the region height clears it', `1\r\n2\r\n3${CSI}9S`, 4, 3, ['', '', ''], [1, 2]],
  ['SD within a region', `1\r\n2\r\n3\r\n4${CSI}2;3r${CSI}T`, 4, 4, ['1', '', '2', '4'], [0, 0]],
  ['RI inside a region at its top scrolls the region', `1\r\n2\r\n3\r\n4${CSI}2;3r${CSI}2H${ESC}MX`, 4, 4, ['1', 'X', '2', '4'], [1, 1]],
  ['RI above the region does not scroll', `1\r\n2\r\n3${CSI}2;3r${CSI}1H${ESC}MX`, 4, 3, ['X', '2', '3'], [1, 0]],
  ['LF below the region stops at the screen bottom', `${CSI}1;2r${CSI}4H\n\nX`, 4, 4, ['', '', '', 'X'], [1, 3]],
  ['DECOM off returns CUP to screen coordinates', `${CSI}2;3r${CSI}?6h${CSI}?6l${CSI}1;1HX`, 4, 4, ['X', '', '', ''], [1, 0]],
  ['the normal screen survives the alternate screen', `abc${CSI}?1049h${CSI}2Jxyz${CSI}?1049l`, 10, 2, ['abc', ''], [3, 0]],
  ['entering 1049 twice keeps the first saved cursor', `${CSI}2;3H${CSI}?1049h${CSI}H${CSI}?1049h${CSI}?1049lX`, 10, 3, ['', '  X', ''], [3, 1]],
]

// ---- Systematic families (M6): every position or count of a function, with
// the expected screen computed by hand from the specification. ----

/** Rows of a blank screen with `marks` placed: [row, col, text]. Wide text takes two columns. */
function screen(cols: number, rows: number, marks: [number, number, string][]): string[] {
  const grid = Array.from({ length: rows }, () => Array<string>(cols).fill(' '))
  for (const [r, c, text] of marks) {
    let x = c
    for (const ch of text) {
      grid[r]![x] = ch
      if (/[　-鿿]/.test(ch)) {
        grid[r]![x + 1] = ''
        x += 2
      } else {
        x++
      }
    }
  }
  return grid.map((row) => row.join('').trimEnd())
}

const fam: ScreenCase[] = []

// CUP to every cell of a 6x5 screen (ECMA-48 8.3.21).
for (let r = 1; r <= 5; r++) {
  for (let c = 1; c <= 6; c++) {
    fam.push([`family CUP ${r};${c}`, `${CSI}${r};${c}HX`, 6, 5, screen(6, 5, [[r - 1, c - 1, 'X']]), [c, r - 1]])
  }
}

// CUU / CUD / CUF / CUB by 1..5 from the middle of a 9x9 screen, clamped at the edges.
for (let n = 1; n <= 5; n++) {
  const up = Math.max(0, 4 - n)
  const down = Math.min(8, 4 + n)
  const right = Math.min(8, 4 + n)
  const left = Math.max(0, 4 - n)
  fam.push([`family CUU ${n}`, `${CSI}5;5H${CSI}${n}AX`, 9, 9, screen(9, 9, [[up, 4, 'X']]), [5, up]])
  fam.push([`family CUD ${n}`, `${CSI}5;5H${CSI}${n}BX`, 9, 9, screen(9, 9, [[down, 4, 'X']]), [5, down]])
  fam.push([`family CUF ${n}`, `${CSI}5;5H${CSI}${n}CX`, 9, 9, screen(9, 9, [[4, right, 'X']]), [right + 1, 4]])
  fam.push([`family CUB ${n}`, `${CSI}5;5H${CSI}${n}DX`, 9, 9, screen(9, 9, [[4, left, 'X']]), [left + 1, 4]])
}

// ECH / ICH / DCH by 1..6 at column 3 of "abcdefgh" (ECMA-48 8.3.38, 8.3.64, 8.3.26).
for (let n = 1; n <= 6; n++) {
  const s = 'abcdefgh'
  const ech = (s.slice(0, 2) + ' '.repeat(n) + s.slice(2 + n)).slice(0, 10).trimEnd()
  const ich = (s.slice(0, 2) + ' '.repeat(n) + s.slice(2)).slice(0, 10).trimEnd()
  const dch = (s.slice(0, 2) + s.slice(2 + n)).trimEnd()
  fam.push([`family ECH ${n}`, `${s}${CSI}3G${CSI}${n}X`, 10, 1, [ech], [2, 0]])
  fam.push([`family ICH ${n}`, `${s}${CSI}3G${CSI}${n}@`, 10, 1, [ich], [2, 0]])
  fam.push([`family DCH ${n}`, `${s}${CSI}3G${CSI}${n}P`, 10, 1, [dch], [2, 0]])
}

// EL 0 / 1 / 2 with the cursor in columns 1..4 (ECMA-48 8.3.41).
for (let c = 1; c <= 4; c++) {
  const s = 'abcdef'
  fam.push([`family EL0 at ${c}`, `${s}${CSI}${c}G${CSI}0K`, 8, 1, [s.slice(0, c - 1)], [c - 1, 0]])
  fam.push([`family EL1 at ${c}`, `${s}${CSI}${c}G${CSI}1K`, 8, 1, [' '.repeat(c) + s.slice(c)], [c - 1, 0]])
  fam.push([`family EL2 at ${c}`, `${s}${CSI}${c}G${CSI}2K`, 8, 1, [''], [c - 1, 0]])
}

// HT from every column of a 20-column line (default stops every 8).
for (let c = 0; c < 10; c++) {
  const stop = c < 8 ? 8 : 16
  fam.push([`family HT from ${c}`, `${CSI}${c + 1}G\tX`, 20, 1, [' '.repeat(stop) + 'X'], [stop + 1, 0]])
}

// IL / DL by 1..4 on each row of a 5-row screen (ECMA-48 8.3.67, 8.3.32).
const five = ['r0', 'r1', 'r2', 'r3', 'r4']
for (let row = 1; row <= 4; row++) {
  for (let n = 1; n <= 4; n++) {
    const il = [...five.slice(0, row), ...Array<string>(n).fill(''), ...five.slice(row)].slice(0, 5)
    const dl = [...five.slice(0, row), ...five.slice(row + n), ...Array<string>(n).fill('')].slice(0, 5)
    fam.push([`family IL ${n} at row ${row}`, `${five.join('\r\n')}${CSI}${row + 1}H${CSI}${n}L`, 4, 5, il, [0, row]])
    fam.push([`family DL ${n} at row ${row}`, `${five.join('\r\n')}${CSI}${row + 1}H${CSI}${n}M`, 4, 5, dl, [0, row]])
  }
}

// SU / SD by 1..4 (ECMA-48 8.3.147, 8.3.113); the cursor stays.
for (let n = 1; n <= 4; n++) {
  fam.push([`family SU ${n}`, `${five.join('\r\n')}${CSI}${n}S`, 4, 5, [...five.slice(n), ...Array<string>(n).fill('')], [2, 4]])
  fam.push([`family SD ${n}`, `${five.join('\r\n')}${CSI}${n}T`, 4, 5, [...Array<string>(n).fill(''), ...five.slice(0, 5 - n)], [2, 4]])
}

// A line feed at the bottom margin of regions [t, b] scrolls only the region (DEC STD 070 DECSTBM).
for (const [t, b] of [[1, 3], [2, 4], [2, 5], [3, 5], [1, 2], [4, 5]] as const) {
  const after = [...five]
  after.splice(t - 1, b - t + 1, ...five.slice(t, b), '')
  after[b - 1] = 'X'
  fam.push([`family DECSTBM ${t};${b} LF at bottom`, `${five.join('\r\n')}${CSI}${t};${b}r${CSI}${b}H\nX`, 4, 5, after, [1, b - 1]])
}

// A wide character printed at every column of a 6-column screen.
for (let c = 0; c < 6; c++) {
  if (c < 5) fam.push([`family wide at col ${c}`, `${CSI}${c + 1}G中`, 6, 2, screen(6, 2, [[0, c, '中']]), [c + 2, 0]])
  else fam.push([`family wide at col ${c} wraps`, `${CSI}${c + 1}G中`, 6, 2, screen(6, 2, [[1, 0, '中']]), [2, 1]])
}

// REP 1..4 after one character (ECMA-48 8.3.103).
for (let n = 1; n <= 4; n++) fam.push([`family REP ${n}`, `z${CSI}${n}b`, 10, 1, ['z'.repeat(n + 1)], [n + 1, 0]])

screenCases.push(...fam)
