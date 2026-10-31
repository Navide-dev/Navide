// Text search over the buffer. Lines joined by autowrap are searched as one
// logical line, so a match may span a wrap.
import { WIDTH_TRAILING, type Buffer } from './buffer'

export interface SearchOptions {
  regex?: boolean
  caseSensitive?: boolean
  /** Match whole words only (word = letters, digits, underscore, any non-ASCII letter). */
  wholeWord?: boolean
}

/** A match from (x, y) to (endX, endY), end exclusive; y values are absolute line indexes. */
export interface SearchMatch {
  x: number
  y: number
  endX: number
  endY: number
}

interface LogicalLine {
  text: string
  /** For each UTF-16 index of `text`: absolute row and column of that character. */
  rows: number[]
  cols: number[]
}

function logicalLines(buf: Buffer): LogicalLine[] {
  const out: LogicalLine[] = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.absoluteLine(i)!
    if (!line.wrapped || out.length === 0) out.push({ text: '', rows: [], cols: [] })
    const current = out[out.length - 1]!
    for (let x = 0; x < line.cols; x++) {
      if (line.widths[x] === WIDTH_TRAILING) continue
      const chars = line.chars(x) || ' '
      for (let k = 0; k < chars.length; k++) {
        current.rows.push(i)
        current.cols.push(x)
      }
      current.text += chars
    }
  }
  return out
}

function pattern(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null
  let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
  try {
    return new RegExp(source, `gu${options.caseSensitive ? '' : 'i'}`)
  } catch {
    return null
  }
}

/** Every match in the buffer, in reading order. Empty for an empty or invalid query. */
export function findAll(buf: Buffer, query: string, options: SearchOptions = {}): SearchMatch[] {
  const re = pattern(query, options)
  if (!re) return []
  const matches: SearchMatch[] = []
  for (const line of logicalLines(buf)) {
    re.lastIndex = 0
    for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      const start = m.index
      const last = m.index + m[0].length - 1
      const lastCol = line.cols[last]!
      const lastRow = line.rows[last]!
      const wide = buf.absoluteLine(lastRow)!.widths[lastCol] === 2
      matches.push({ x: line.cols[start]!, y: line.rows[start]!, endX: lastCol + (wide ? 2 : 1), endY: lastRow })
    }
  }
  return matches
}

/** The first match after (x, y) (or before it, backwards), wrapping around the buffer. */
export function findFrom(buf: Buffer, query: string, from: { x: number; y: number }, backwards: boolean, options: SearchOptions = {}): SearchMatch | undefined {
  const all = findAll(buf, query, options)
  if (!all.length) return undefined
  const after = (m: SearchMatch): boolean => m.y > from.y || (m.y === from.y && m.x > from.x)
  const before = (m: SearchMatch): boolean => m.y < from.y || (m.y === from.y && m.x < from.x)
  if (backwards) return [...all].reverse().find(before) ?? all[all.length - 1]
  return all.find(after) ?? all[0]
}
