// Synthetic byte streams that exercise the sequence classes CLI TUIs use.
// Written by hand from the specifications; no real CLI output is recorded
// (no signed-in sessions, per the nvterm plan).
import {
  BEL, ESC, cha, cub, cud, cuf, cup, cuu, dch, decrc, decrst, decsc, decset, decstbm, dl, ech, ed, el, ich, il,
  link, ri, rm, sd, sgr, sm, su, syncBegin, syncEnd, title, vpa,
} from './seq.ts'

export interface Fixture {
  id: string
  description: string
  cols: number
  rows: number
  /** Written in order; boundaries may split UTF-8 sequences and escape sequences on purpose. */
  chunks: Uint8Array[]
}

const encoder = new TextEncoder()

function fixture(id: string, description: string, text: string, size: { cols?: number; rows?: number } = {}): Fixture {
  return { id, description, cols: size.cols ?? 80, rows: size.rows ?? 24, chunks: [encoder.encode(text)] }
}

/** Splits the encoded text into chunks of `size` bytes, ignoring character boundaries. */
function chopped(id: string, description: string, text: string, size: number, dims: { cols?: number; rows?: number } = {}): Fixture {
  const bytes = encoder.encode(text)
  const chunks: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size))
  return { id, description, cols: dims.cols ?? 80, rows: dims.rows ?? 24, chunks }
}

const lines = (n: number, make: (i: number) => string): string =>
  Array.from({ length: n }, (_, i) => make(i)).join('\r\n')

/** Ink-style log-update: move up over the previous frame, erase it, draw the next. */
function inkFrames(frames: string[][]): string {
  let out = ''
  let previous = 0
  for (const frame of frames) {
    for (let i = 0; i < previous; i++) out += (i === 0 ? '' : cuu(1)) + el(2)
    if (previous > 0) out += cha(1)
    out += frame.join('\r\n')
    previous = frame.length
  }
  return out
}

export const fixtures: Fixture[] = [
  // Plain text and line discipline
  fixture('ascii-lines', 'Plain ASCII lines with CRLF', lines(10, (i) => `line ${i}: the quick brown fox`)),
  fixture('long-line-wrap', 'A line longer than the width wraps (autowrap on)', 'x'.repeat(200) + '\r\nend', { cols: 40 }),
  fixture('lf-without-cr', 'LF alone moves down without returning to column 0', 'abc\ndef\nghi'),
  fixture('tabs', 'Default tab stops every 8 columns', 'a\tb\tc\r\n\tindented\r\n1234567\tx'),
  fixture('backspace-cr-overwrite', 'BS and CR overwrite earlier text', 'hello\b\b\bXY\r\nworld\rW'),
  fixture('exact-width-no-wrap', 'Text exactly as wide as the screen leaves the wrap pending', 'y'.repeat(40) + 'Z', { cols: 40 }),

  // SGR
  fixture('sgr-16', '16 colours foreground and background', lines(8, (i) => `${sgr(30 + i)}fg${i}${sgr(90 + i)}br${i}${sgr(40 + i)}bg${i}${sgr(0)}`)),
  fixture('sgr-256', '256-colour palette', lines(16, (r) => Array.from({ length: 16 }, (_, c) => `${sgr(38, 5, r * 16 + c)}#`).join('') + sgr(0))),
  fixture('sgr-truecolor', '24-bit colour, semicolon form', lines(8, (i) => `${sgr(38, 2, i * 30, 255 - i * 30, 128)}${sgr(48, 2, 10, 20, i * 30)}rgb ${i}${sgr(0)}`)),
  fixture('sgr-attributes', 'Bold, dim, italic, underline, blink, inverse, hidden, strike, overline and their resets',
    `${sgr(1)}bold${sgr(22)} ${sgr(2)}dim${sgr(22)} ${sgr(3)}italic${sgr(23)} ${sgr(4)}under${sgr(24)} ${sgr(5)}blink${sgr(25)} ` +
    `${sgr(7)}inverse${sgr(27)} ${sgr(8)}hidden${sgr(28)} ${sgr(9)}strike${sgr(29)} ${sgr(53)}over${sgr(55)} ${sgr(1, 3, 4, 31)}combo${sgr(0)} plain`),
  fixture('sgr-underline-styles', 'Underline styles (4:n) and underline colour (58)',
    `${sgr('4:1')}single${sgr('4:0')} ${sgr('4:2')}double${sgr(24)} ${sgr('4:3')}curly${sgr(24)} ${sgr(4, 58, 5, 196)}coloured${sgr(0)}`),
  fixture('sgr-reset-variants', 'SGR with no parameters and with 0 both reset', `${sgr(1, 31)}a${CSI_m()}b${sgr(1, 32)}c${sgr(0)}d`),

  // Cursor movement and editing
  fixture('cursor-movement', 'CUP, CUU, CUD, CUF, CUB, CHA, VPA',
    `${cup(5, 10)}A${cuu(2)}B${cud(4)}C${cuf(5)}D${cub(3)}E${cha(1)}F${vpa(20)}G${cup(1, 1)}H${cuu(5)}I${cup(99, 999)}J`),
  fixture('erase-display-line', 'ED and EL in all three modes, ECH',
    `${lines(6, () => 'abcdefghijklmnopqrstuvwxyz')}${cup(2, 5)}${el(0)}${cup(3, 5)}${el(1)}${cup(4, 1)}${el(2)}${cup(5, 3)}${ech(4)}${cup(6, 10)}${ed(1)}`),
  fixture('erase-below', 'ED 0 from the middle of the screen', `${lines(10, () => '#'.repeat(30))}${cup(4, 8)}${ed(0)}`),
  fixture('erase-at-pending-wrap', 'EL 0 and ED 0 while a wrap is pending keep the last cell', `${'e'.repeat(40)}${el(0)}X\r\n${'f'.repeat(40)}${ed(0)}Y`, { cols: 40 }),
  fixture('ich-on-wide-trailing-half', 'ICH on the trailing half of a wide character', `中文字${cup(1, 2)}${ich(1)}`),
  fixture('cuu-origin-mode-top', 'CUU at the top margin in origin mode stays at the margin (DEC STD 070)', `${decstbm(5, 10)}${decset(6)}${cuu(1)}x${decrst(6)}${decstbm(1, 24)}`),
  fixture('insert-delete-chars', 'ICH and DCH shift the rest of the line', `0123456789${cup(1, 3)}${ich(3)}${cup(1, 9)}${dch(2)}\r\nabcdef${cub(4)}${dch(10)}`),
  fixture('insert-delete-lines', 'IL and DL inside the scroll region', `${lines(10, (i) => `row ${i}`)}${cup(3, 1)}${il(2)}${cup(7, 1)}${dl(3)}`),
  fixture('scroll-region', 'DECSTBM limits LF scrolling to the region', `${lines(10, (i) => `fixed ${i}`)}${decstbm(3, 6)}${cup(6, 1)}\nA\nB\nC${decstbm(1, 24)}`, { rows: 10 }),
  fixture('scroll-up-down', 'SU and SD scroll the region without moving the cursor', `${lines(8, (i) => `line ${i}`)}${cup(4, 4)}${su(2)}X${sd(3)}Y`, { rows: 8 }),
  fixture('reverse-index', 'RI at the top margin scrolls down', `${lines(5, (i) => `r${i}`)}${cup(1, 1)}${ri}${ri}top`, { rows: 5 }),
  fixture('save-restore-cursor', 'DECSC / DECRC restore position and attributes', `${cup(3, 3)}${sgr(31)}${decsc}${cup(10, 10)}${sgr(0)}x${decrc}y${sgr(0)}`),
  fixture('autowrap-off', 'DECAWM off: output past the edge overwrites the last column', `${decrst(7)}${'z'.repeat(50)}${decset(7)}\r\n${'w'.repeat(50)}`, { cols: 40 }),
  fixture('origin-mode', 'DECOM makes CUP relative to the scroll region', `${decstbm(5, 10)}${decset(6)}${cup(1, 1)}origin${decrst(6)}${decstbm(1, 24)}`),
  fixture('insert-mode', 'IRM inserts instead of overwriting', `abcdef${cha(3)}${sm(4)}XY${rm(4)}Z`),
  fixture('dec-special-graphics', 'ESC ( 0 switches G0 to line drawing', `${ESC}(0lqqk\r\nx  x\r\nmqqj${ESC}(B ascii`),

  // Alternate screen
  fixture('alt-screen-1049', 'Enter 1049, draw, exit: the normal screen comes back with the cursor restored',
    `before${decset(1049)}${ed(2)}${cup(1, 1)}inside alt${decrst(1049)} after`),
  fixture('alt-screen-left-open', 'Ends while still in the alternate screen', `normal text${decset(1049)}${cup(5, 5)}TUI frame`),
  fixture('alt-screen-47', 'Mode 47 alternate screen without cursor save', `n${decset(47)}a${decrst(47)}b`),

  // Wide characters, emoji, combining marks
  fixture('cjk-wide', 'CJK characters are two cells wide', '中文字元測試\r\n日本語のテキスト\r\n한국어 텍스트\r\nmixed 中 a 文 b'),
  fixture('cjk-wrap-at-edge', 'A wide character that does not fit in the last column wraps whole', 'a'.repeat(39) + '中文', { cols: 40 }),
  fixture('cjk-overwrite-half', 'Overwriting half of a wide character clears the other half', `中文${cha(2)}x${cha(3)}y`),
  fixture('emoji-basic', 'Single-codepoint emoji are wide', '😀 🚀 ✅ ❌ 🎉 done'),
  fixture('emoji-sequences', 'ZWJ family, skin tone modifier, VS16, flags, keycap', '👨‍👩‍👧 👍🏽 ❤️ ☺️ 🇹🇼 1️⃣ end'),
  fixture('combining-marks', 'Combining marks attach to the previous cell', 'é ä ñ कि end'),
  chopped('utf8-split-chunks', 'UTF-8 sequences split across write() boundaries', '中文😀é─│'.repeat(20), 3),
  chopped('escape-split-chunks', 'Escape sequences split across write() boundaries', `${sgr(1, 38, 2, 10, 20, 30)}split${sgr(0)}${cup(5, 5)}here${el(0)}`.repeat(4), 2),

  // TUI behaviour
  fixture('spinner-cr-redraw', 'Spinner redrawn in place with CR and EL',
    ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'].map((f, i) => `\r${el(2)}${f} working ${i}`).join('') + `\r${el(2)}✔ done\r\n`),
  fixture('ink-log-update', 'Ink-style frames: cursor up, erase, redraw, with a shrinking frame',
    inkFrames([['╭──────╮', '│ one  │', '╰──────╯'], ['╭──────╮', '│ two  │', '│ more │', '╰──────╯'], ['> done']])),
  fixture('synchronized-output', 'Frames wrapped in mode 2026 begin / end',
    Array.from({ length: 5 }, (_, i) => `${syncBegin}${cup(1, 1)}${ed(2)}frame ${i}\r\n${'='.repeat(i * 5)}${syncEnd}`).join('')),
  fixture('colored-diff', 'A coloured diff the way coding CLIs print one',
    lines(12, (i) => i % 3 === 0 ? `${sgr(48, 2, 40, 0, 0)}${sgr(31)}- removed line ${i}${el(0)}${sgr(0)}` : i % 3 === 1
      ? `${sgr(48, 2, 0, 40, 0)}${sgr(32)}+ added line ${i}${el(0)}${sgr(0)}` : `${sgr(2)}  context ${i}${sgr(0)}`)),
  fixture('large-scroll', '300 lines into 24 rows fills the scrollback', lines(300, (i) => `scroll ${i}`)),
  fixture('status-line-bottom', 'Fixed status line drawn with save/restore while text scrolls above',
    `${decstbm(1, 22)}${lines(40, (i) => `${decsc}${cup(24, 1)}${sgr(7)} status ${i} ${el(0)}${sgr(0)}${decrc}log ${i}`)}${decstbm(1, 24)}`),

  // Modes and OSC
  fixture('modes-input', 'Bracketed paste, SGR mouse, focus reporting and application cursor keys turned on',
    `${decset(2004)}${decset(1000, 1002, 1006)}${decset(1004)}${decset(1)}${decrst(25)}modes set`),
  fixture('modes-reset', 'The same modes turned on and off again', `${decset(2004, 1000, 1006, 1)}${decrst(2004, 1000, 1006, 1)}${decset(25)}reset`),
  fixture('osc-title', 'OSC 0 and OSC 2 set the title; terminated by BEL and by ST', `${title('first')}${ESC}]0;second${ESC}\\text${ESC}]2;third${BEL}`),
  fixture('osc8-hyperlink', 'OSC 8 hyperlinks around text', `see ${link('https://example.com/a', 'docs')} and ${link('file:///tmp/x.txt', '/tmp/x.txt')} end`),
  fixture('osc-unknown-ignored', 'Unknown OSC and DCS strings are consumed without printing', `a${ESC}]777;notify;x;y${BEL}b${ESC}P1$qm${ESC}\\c`),
]

function CSI_m(): string {
  return `${ESC}[m`
}
