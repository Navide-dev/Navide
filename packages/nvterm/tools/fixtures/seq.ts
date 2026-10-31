// Helpers for writing control sequences by name. Each one cites the
// specification it follows (see CLEAN_ROOM.md).

export const ESC = '\x1b'
export const CSI = `${ESC}[`
export const OSC = `${ESC}]`
export const ST = `${ESC}\\`
export const BEL = '\x07'

/** ECMA-48 8.3.21 CUP: 1-based row and column. */
export const cup = (row: number, col: number): string => `${CSI}${row};${col}H`
/** ECMA-48 8.3.22/19/20/18: CUU, CUD, CUF, CUB. */
export const cuu = (n = 1): string => `${CSI}${n}A`
export const cud = (n = 1): string => `${CSI}${n}B`
export const cuf = (n = 1): string => `${CSI}${n}C`
export const cub = (n = 1): string => `${CSI}${n}D`
/** ECMA-48 8.3.9 CHA. */
export const cha = (col: number): string => `${CSI}${col}G`
/** ECMA-48 8.3.158 VPA. */
export const vpa = (row: number): string => `${CSI}${row}d`
/** ECMA-48 8.3.39 ED and 8.3.41 EL: 0 = to end, 1 = to start, 2 = all. */
export const ed = (mode = 0): string => `${CSI}${mode}J`
export const el = (mode = 0): string => `${CSI}${mode}K`
/** ECMA-48 8.3.38 ECH. */
export const ech = (n: number): string => `${CSI}${n}X`
/** ECMA-48 8.3.64 ICH, 8.3.26 DCH, 8.3.67 IL, 8.3.32 DL. */
export const ich = (n: number): string => `${CSI}${n}@`
export const dch = (n: number): string => `${CSI}${n}P`
export const il = (n: number): string => `${CSI}${n}L`
export const dl = (n: number): string => `${CSI}${n}M`
/** ECMA-48 8.3.147 SU, 8.3.113 SD. */
export const su = (n: number): string => `${CSI}${n}S`
export const sd = (n: number): string => `${CSI}${n}T`
/** ECMA-48 8.3.117 SGR. */
export const sgr = (...params: (number | string)[]): string => `${CSI}${params.join(';')}m`
/** DEC STD 070 DECSTBM: top and bottom margins, 1-based. */
export const decstbm = (top: number, bottom: number): string => `${CSI}${top};${bottom}r`
/** DEC private mode set / reset (DECSET / DECRST in xterm ctlseqs). */
export const decset = (...modes: number[]): string => `${CSI}?${modes.join(';')}h`
export const decrst = (...modes: number[]): string => `${CSI}?${modes.join(';')}l`
/** ECMA-48 ANSI mode set / reset (SM / RM), e.g. 4 = IRM. */
export const sm = (mode: number): string => `${CSI}${mode}h`
export const rm = (mode: number): string => `${CSI}${mode}l`
/** DEC DECSC / DECRC (ESC 7 / ESC 8). */
export const decsc = `${ESC}7`
export const decrc = `${ESC}8`
/** ECMA-48 8.3.104 RI (ESC M in 7-bit form). */
export const ri = `${ESC}M`
/** xterm ctlseqs OSC 0 / OSC 2: window title. */
export const title = (text: string): string => `${OSC}2;${text}${BEL}`
/** OSC 8 hyperlink: open with a URI, close with an empty one. */
export const link = (uri: string, text: string): string => `${OSC}8;;${uri}${ST}${text}${OSC}8;;${ST}`
/** Synchronized output (mode 2026): begin / end a frame. */
export const syncBegin = decset(2026)
export const syncEnd = decrst(2026)
