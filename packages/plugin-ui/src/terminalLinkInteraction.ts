import type { Terminal } from '@xterm/xterm'
import {
  findFileLinkMatches,
  findFileLinkMatchAt,
  findUrlLinkMatchAt,
  findUrlMatches,
  rootedTailCandidate,
  shedCjkPieces,
  shedCjkProse,
  splitMatchAtRowStarts,
  type WrappedLineGroup,
} from './terminalLinks'
import { isMacPlatform } from './shared/keybindings/parseKey'

const _EXCL = `[^\\x00<>?\\s!\`&*()'"\\\\;]`
const _PATH_CHAR_RE = new RegExp(_EXCL)
const _PREWRAP_WINDOW = 4
const _PREWRAP_SLACK = 8
const _SUFFIX_RE = /(?::([\d]+)(?:[.:]([\d]+))?|[(\[]([\d]+)(?:[,:]([\d]+))?[)\]]|#([\d]+)(?::([\d]+))?|:([\d]+)-([\d]+))$/

const _PLAN_DOC_RE = /\.agent-team\/plans\/[A-Za-z0-9.-][A-Za-z0-9._-]*\.html/
export function extractPlanDocRelPath(raw: string): string | undefined {
  return raw.match(_PLAN_DOC_RE)?.[0]
}

export function htmlReportRoute(
  absPath: string,
  wsPath: string | undefined
): { workspace_path: string; rel_path: string } | undefined {
  if (!wsPath || !/\.html?$/i.test(absPath)) return undefined
  const root = wsPath.replace(/\/+$/, '')
  if (!absPath.startsWith(`${root}/`)) return undefined
  return { workspace_path: root, rel_path: absPath.slice(root.length + 1) }
}

export function splitTerminalLinkSuffix(raw: string): { filepath: string; line?: number; endLine?: number } {
  const m = raw.match(_SUFFIX_RE)
  if (!m || m.index === undefined) return { filepath: raw }
  const lineStr = m[1] ?? m[3] ?? m[5] ?? m[7]
  const out: { filepath: string; line?: number; endLine?: number } = {
    filepath: raw.slice(0, m.index),
    line: lineStr ? parseInt(lineStr, 10) : undefined,
  }
  const endLine = m[8] ? parseInt(m[8], 10) : 0
  if (out.line && endLine >= out.line) out.endLine = endLine
  return out
}

const _WIDE_CH_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/
export function visualWidth(s: string): number {
  let w = 0
  for (const ch of s) w += ch.length > 1 || _WIDE_CH_RE.test(ch) ? 2 : 1
  return w
}

export function getWrappedLineGroup(term: Terminal, bufferRow: number): WrappedLineGroup {
  const buffer = term.buffer.active
  const lineTextAt = (r: number): string | null => {
    const ln = buffer.getLine(r)
    return ln ? ln.translateToString(true) : null
  }
  const leadingWs = (s: string): number => s.length - s.trimStart().length
  const nearWidthLimit = (r: number): boolean => {
    const len = visualWidth(lineTextAt(r) ?? '')
    for (let i = r - _PREWRAP_WINDOW; i <= r + _PREWRAP_WINDOW; i++) {
      if (i !== r && visualWidth(lineTextAt(i) ?? '') > len + _PREWRAP_SLACK) return false
    }
    return true
  }
  const continuesFromPrev = (r: number): boolean => {
    if (r <= 0) return false
    if (buffer.getLine(r)?.isWrapped) return true
    const cur = lineTextAt(r)
    const prev = lineTextAt(r - 1)
    if (!cur || !prev) return false
    // A row that repeats the previous row's last token (`ls src/a.ts` then
    // `src/a.ts`) is command output, not the second half of a wrapped path.
    const prevTail = prev.match(/\S+$/)?.[0]
    if (prevTail && prevTail === cur.trimStart().match(/^\S+/)?.[0]) return false
    return (
      _PATH_CHAR_RE.test(prev[prev.length - 1]) &&
      _PATH_CHAR_RE.test(cur[leadingWs(cur)]) &&
      nearWidthLimit(r - 1)
    )
  }

  let groupStart = bufferRow
  for (let steps = 0; steps < 8 && groupStart > 0 && continuesFromPrev(groupStart); steps++) groupStart--

  const lineLengths: number[] = []
  const strips: number[] = []
  const heuristicBreaks: number[] = []
  let fullText = ''
  for (let r = groupStart, steps = 0; steps < 16; r++, steps++) {
    const lineText = lineTextAt(r)
    if (lineText === null) break
    const strip = r === groupStart || buffer.getLine(r)?.isWrapped ? 0 : leadingWs(lineText)
    strips.push(strip)
    lineLengths.push(lineText.length - strip)
    fullText += lineText.slice(strip)
    if (!continuesFromPrev(r + 1)) break
    if (!buffer.getLine(r + 1)?.isWrapped) heuristicBreaks.push(fullText.length)
  }

  return { groupStart, lineLengths, strips, fullText, heuristicBreaks }
}

export function groupPosToRowCol(group: WrappedLineGroup, pos: number): { row: number; col: number } {
  let remaining = pos
  for (let i = 0; i < group.lineLengths.length; i++) {
    const len = group.lineLengths[i]
    if (i === group.lineLengths.length - 1 || remaining < len) {
      return { row: group.groupStart + i, col: remaining + group.strips[i] }
    }
    remaining -= len
  }
  return { row: group.groupStart, col: pos }
}

export function groupRowColToPos(group: WrappedLineGroup, bufferRow: number, col: number): number {
  const rowInGroup = bufferRow - group.groupStart
  if (rowInGroup < 0 || rowInGroup >= group.lineLengths.length) return -1
  const inRow = col - group.strips[rowInGroup]
  if (inRow < 0 || inRow >= group.lineLengths[rowInGroup]) return -1
  let pos = inRow
  for (let i = 0; i < rowInGroup; i++) pos += group.lineLengths[i]
  return pos
}

export function cellColToStrCol(term: Terminal, bufferRow: number, cellCol: number): number {
  const line = term.buffer.active.getLine(bufferRow)
  if (!line || typeof line.getCell !== 'function') return cellCol
  let str = 0
  let glyphStart = 0
  for (let x = 0; x <= cellCol && x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell) break
    if (cell.getWidth() === 0) continue
    glyphStart = str
    str += Math.max(1, cell.getChars().length)
  }
  return glyphStart
}

export function strColToCellCol(term: Terminal, bufferRow: number, strCol: number): number {
  const line = term.buffer.active.getLine(bufferRow)
  if (!line || typeof line.getCell !== 'function') return strCol
  let str = 0
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell) break
    if (cell.getWidth() === 0) continue
    const len = Math.max(1, cell.getChars().length)
    if (strCol < str + len) return x
    str += len
  }
  return strCol
}

export interface TerminalFileLinkRequest {
  query: string
  line?: number
  sessionId?: string
  /** Raw, untrusted path candidates. Host performs resolution and stat. */
  candidates: string[]
  /** The candidate to open when none stat-verifies: the piece under the
   *  click, shed of surrounding CJK prose. Not derivable from `candidates`,
   *  which are de-duplicated and so have no fixed positions. */
  fallback: string
}

export interface TerminalPlanLinkRequest {
  relPath: string
  workspacePath?: string
}

export interface TerminalLinkInteractionOptions {
  terminal: Terminal
  element: HTMLElement
  isCmdHeld: () => boolean
  openExternal(href: string): void | Promise<void>
  openFilePicker(request: TerminalFileLinkRequest): void
  openPlan?(request: TerminalPlanLinkRequest): void | Promise<void>
  workspacePath?: () => string | undefined
  sessionId?: () => string | undefined
  extractPlanDocRelPath?(raw: string): string | undefined
}

function buildFileLinkProvider(term: Terminal, isCmdHeld: () => boolean): import('@xterm/xterm').ILinkProvider {
  return {
    provideLinks(y, callback) {
      if (!isCmdHeld()) { callback(undefined); return }
      const group = getWrappedLineGroup(term, y - 1)
      const links: import('@xterm/xterm').ILink[] = []
      const pushLink = (index: number, text: string): void => {
        const start = groupPosToRowCol(group, index)
        const end = groupPosToRowCol(group, index + text.length - 1)
        links.push({
          range: {
            start: { x: strColToCellCol(term, start.row, start.col) + 1, y: start.row + 1 },
            end: { x: strColToCellCol(term, end.row, end.col) + 1, y: end.row + 1 },
          },
          text,
          decorations: { underline: true, pointerCursor: true },
          activate: () => { /* click handled by the Host-installed handler */ },
        })
      }
      const urls = findUrlMatches(group.fullText, group.heuristicBreaks)
      for (const u of urls) pushLink(u.index, u.text)
      for (const m of findFileLinkMatches(group.fullText)) {
        const s = m.index
        const e = m.index + m.text.length
        if (urls.some((u) => s < u.index + u.text.length && e > u.index)) continue
        for (const piece of splitMatchAtRowStarts(group, m.index, m.text)) {
          const shed = shedCjkPieces(piece.text)
          if (!shed.length) pushLink(piece.index, piece.text)
          else for (const part of shed) pushLink(piece.index + part.index, part.text)
        }
      }
      callback(links.length ? links : undefined)
    },
  }
}

/** Cmd on macOS; Ctrl elsewhere, where the OS takes Win/Super+click (Meta still accepted). */
export function isTerminalLinkModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.metaKey || (!isMacPlatform() && event.ctrlKey)
}

export function isTerminalLinkModifierKey(key: string): boolean {
  return key === 'Meta' || (!isMacPlatform() && key === 'Control')
}

export interface InstalledTerminalLinks {
  handler: (event: MouseEvent) => void
  dispose(): void
}

export function installTerminalLinks(options: TerminalLinkInteractionOptions): InstalledTerminalLinks {
  const { terminal: term, element: el } = options
  const provider = term.registerLinkProvider(buildFileLinkProvider(term, options.isCmdHeld))
  const handler = (event: MouseEvent): void => {
    if (!isTerminalLinkModifier(event) || event.button !== 0) return
    const xtermScreen = el.querySelector('.xterm-screen')
    if (!xtermScreen) return
    const rect = xtermScreen.getBoundingClientRect()
    const cellW = (term as any)._core?._renderService?.dimensions?.css?.cell?.width || 0
    const cellH = (term as any)._core?._renderService?.dimensions?.css?.cell?.height || 0
    if (!cellW || !cellH) return
    const col = Math.floor((event.clientX - rect.left) / cellW)
    const row = Math.floor((event.clientY - rect.top) / cellH)
    if (col < 0 || row < 0 || col >= term.cols || row >= term.rows) return
    const bufferRow = term.buffer.active.viewportY + row
    const group = getWrappedLineGroup(term, bufferRow)
    const strCol = cellColToStrCol(term, bufferRow, col)
    const clickPos = groupRowColToPos(group, bufferRow, strCol)
    const urlMatch = findUrlLinkMatchAt(group.fullText, clickPos, group.heuristicBreaks)
    if (urlMatch) {
      event.preventDefault()
      event.stopPropagation()
      void options.openExternal(urlMatch.href)
      return
    }

    const match = findFileLinkMatchAt(group.fullText, clickPos)
    if (!match) return
    event.preventDefault()
    event.stopPropagation()
    const piece = splitMatchAtRowStarts(group, match.index, match.text)
      .find((p) => clickPos >= p.index && clickPos < p.index + p.text.length)
    const pieceRaw = piece?.text ?? match.text
    const pieceStart = piece?.index ?? match.index
    const rowText = term.buffer.active.getLine(bufferRow)?.translateToString(true) ?? ''
    const singleMatch = findFileLinkMatchAt(rowText, strCol)
    const singleRaw = singleMatch?.text
    const shedPiece = shedCjkProse(pieceRaw, clickPos - pieceStart)
    const tail = rootedTailCandidate(group.fullText, clickPos)
    const cands = [
      pieceRaw, shedPiece,
      match.text, shedCjkProse(match.text, clickPos - match.index),
      singleRaw, singleMatch ? shedCjkProse(singleMatch.text, strCol - singleMatch.index) : undefined,
      tail?.text, tail ? shedCjkProse(tail.text, clickPos - tail.index) : undefined,
    ].filter((c, i, arr): c is string => !!c && arr.indexOf(c) === i)
    const chosen = shedPiece ?? pieceRaw
    const { filepath, line: lineNum } = splitTerminalLinkSuffix(chosen)
    if (!filepath) return
    const planRel = options.extractPlanDocRelPath?.(pieceRaw) ?? options.extractPlanDocRelPath?.(match.text)
    const workspacePath = options.workspacePath?.()
    if (planRel && workspacePath && options.openPlan) {
      void options.openPlan({ relPath: planRel, workspacePath })
      return
    }
    const basename = filepath.split(/[\\/]/).filter(Boolean).pop() ?? filepath
    options.openFilePicker({ query: basename, line: lineNum, sessionId: options.sessionId?.(), candidates: cands, fallback: chosen })
  }
  return { handler, dispose: () => provider.dispose() }
}
