// Pure terminal link parsing shared by Host terminal surfaces.

const _EXCL_S = `[^\\x00<>?\\s!\`&*()[\\]'"\\\\;]`
const _EXCL = `[^\\x00<>?\\s!\`&*()'"\\\\;]`
const FILE_LINK_RE = new RegExp(
  `((?<![A-Za-z0-9_])[A-Za-z]:(?:\\\\${_EXCL}+)+|(?:\\.{1,2}|~|(?:${_EXCL_S}${_EXCL}*))?(?:\\/${_EXCL}+)+)`,
  'g'
)

const URL_LINK_RE = /https?:\/\/[^\s<>"'`\u00A0-\uFFFF]+/gi
const _URL_TRAIL = new Set(['.', ',', ';', ':', '!', '?'])
const _URL_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

export function trimUrlTrailing(raw: string): string {
  let url = raw
  while (url.length) {
    const last = url[url.length - 1]
    if (_URL_TRAIL.has(last)) { url = url.slice(0, -1); continue }
    const open = _URL_BRACKETS[last]
    if (open) {
      const opens = url.split(open).length - 1
      const closes = url.split(last).length - 1
      if (closes > opens) { url = url.slice(0, -1); continue }
    }
    break
  }
  return url
}

const _BARE_TLDS = 'com|net|org|edu|gov|tw|jp'
const BARE_URL_RE = new RegExp(
  '(?<![A-Za-z0-9@.\\-/])' +
    `(?:www\\.[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}|[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.(?:${_BARE_TLDS}))` +
    '(?::\\d+)?' +
    '(?![A-Za-z0-9\\-/:]|\\.[A-Za-z0-9])',
  'gi'
)

const _CJK_PUNCT_RE =
  /[\u3000-\u3004\u3008-\u3020\u3030\u303D-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]+/

/** All '/'-containing pieces after splitting on full-width CJK punctuation. */
export function shedCjkPieces(raw: string): Array<{ index: number; text: string }> {
  const re = new RegExp(_CJK_PUNCT_RE.source, 'g')
  const out: Array<{ index: number; text: string }> = []
  let last = 0
  let sawPunct = false
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    sawPunct = true
    const t = raw.slice(last, m.index)
    if (t.includes('/')) out.push({ index: last, text: t })
    last = m.index + m[0].length
  }
  if (!sawPunct) return []
  const tail = raw.slice(last)
  if (tail.includes('/')) out.push({ index: last, text: tail })
  return out
}

/** The shed piece containing 0-based `pos` in `raw`. */
export function shedCjkProse(raw: string, pos = -1): string | undefined {
  const pieces = shedCjkPieces(raw)
  if (!pieces.length) return undefined
  return (pieces.find((p) => pos >= p.index && pos < p.index + p.text.length) ?? pieces[0]).text
}

/** A logical line reconstructed from xterm rows for link hit testing. */
export interface WrappedLineGroup {
  groupStart: number
  lineLengths: number[]
  strips: number[]
  fullText: string
  heuristicBreaks: number[]
}

export function findFileLinkMatches(text: string): Array<{ text: string; index: number }> {
  FILE_LINK_RE.lastIndex = 0
  const out: Array<{ text: string; index: number }> = []
  let m: RegExpExecArray | null
  while ((m = FILE_LINK_RE.exec(text)) !== null) {
    if (!m[0].includes('://')) out.push({ text: m[0], index: m.index })
  }
  return out
}

/** The FILE_LINK_RE match containing 0-based `pos` in `text`, or null. */
export function findFileLinkMatchAt(text: string, pos: number): { text: string; index: number } | null {
  if (pos < 0) return null
  return findFileLinkMatches(text).find((m) => pos >= m.index && pos < m.index + m.text.length) ?? null
}

export function findFileLinkAt(text: string, pos: number): string | null {
  return findFileLinkMatchAt(text, pos)?.text ?? null
}

/** Whole-tail candidate for rooted paths whose folder names contain spaces or parens. */
export function rootedTailCandidate(
  text: string,
  pos: number
): { index: number; text: string } | undefined {
  FILE_LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FILE_LINK_RE.exec(text)) !== null) {
    if (m[0].includes('://')) continue
    let root = -1
    if (m[0][0] === '/' || m[0][0] === '~') root = m.index
    else {
      const piece = shedCjkPieces(m[0]).find((p) => p.text[0] === '/' || p.text[0] === '~')
      if (piece) root = m.index + piece.index
    }
    if (root < 0) continue
    if (root > pos) return undefined
    return { index: root, text: text.slice(root).trimEnd() }
  }
  return undefined
}

export interface UrlMatch {
  index: number
  text: string
  href: string
}

/** Every scheme URL and conservative bare domain, with trailing punctuation trimmed. */
export function findUrlMatches(text: string, breaks: number[] = []): UrlMatch[] {
  const bounds = [0, ...breaks.filter((b) => b > 0 && b < text.length), text.length]
  const out: UrlMatch[] = []
  let prevSegCapped = false
  for (let i = 0; i < bounds.length - 1; i++) {
    const seg = text.slice(bounds[i], bounds[i + 1])
    const segOut: UrlMatch[] = []
    let capped = false
    let m: RegExpExecArray | null
    URL_LINK_RE.lastIndex = 0
    while ((m = URL_LINK_RE.exec(seg)) !== null) {
      const trimmed = trimUrlTrailing(m[0])
      segOut.push({ index: bounds[i] + m.index, text: trimmed, href: trimmed })
      if (m.index + m[0].length === seg.length) capped = true
    }
    BARE_URL_RE.lastIndex = 0
    while ((m = BARE_URL_RE.exec(seg)) !== null) {
      if (m.index === 0 && prevSegCapped) continue
      const trimmed = trimUrlTrailing(m[0])
      const start = bounds[i] + m.index
      const end = start + trimmed.length
      if (segOut.some((u) => start < u.index + u.text.length && end > u.index)) continue
      segOut.push({ index: start, text: trimmed, href: `https://${trimmed}` })
    }
    segOut.sort((a, b) => a.index - b.index)
    out.push(...segOut)
    prevSegCapped = capped
  }
  return out
}

/** The URL match containing 0-based `pos` in `text`, or null. */
export function findUrlLinkMatchAt(text: string, pos: number, breaks: number[] = []): UrlMatch | null {
  if (pos < 0) return null
  return findUrlMatches(text, breaks).find((u) => pos >= u.index && pos < u.index + u.text.length) ?? null
}

/** Split a fullText match at row boundaries where a fresh absolute path starts. */
export function splitMatchAtRowStarts(
  group: WrappedLineGroup,
  matchIndex: number,
  matchText: string
): Array<{ index: number; text: string }> {
  const end = matchIndex + matchText.length
  const cuts: number[] = []
  let boundary = 0
  for (let i = 0; i < group.lineLengths.length - 1; i++) {
    boundary += group.lineLengths[i]
    if (boundary <= matchIndex || boundary >= end) continue
    const c = group.fullText[boundary]
    if (c === '/' || c === '~') cuts.push(boundary)
  }
  const pieces: Array<{ index: number; text: string }> = []
  let start = matchIndex
  for (const cut of [...cuts, end]) {
    pieces.push({ index: start, text: group.fullText.slice(start, cut) })
    start = cut
  }
  return pieces
}
