// Helpers used by the pipeline orchestrator to scrape clean text out of raw
// PTY output and detect sentinels / question blocks.

// Match ANSI/VT escape sequences. Mirrors the backend stripper (terminals.py)
// so the cleanBuffer is scrubbed identically on both sides:
//   CSI:  \x1b[ … final-byte
//   OSC:  \x1b] … terminated by BEL (\x07) OR ST (\x1b\\)
//   DCS/APC/SOS/PM: \x1bP|X|^|_ … \x1b\\
//   single-byte Fe: \x1b followed by 0x40-0x5A or 0x5C-0x7E
// The previous pattern only handled BEL-terminated OSC, so an ST-terminated
// title sequence (e.g. set-title `\x1b]0;t\x1b\\`) left its body as residue.
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-~])/g
// Carriage returns alone (without paired \n) get used as cursor-back; we
// normalise to nothing so detectors don't get fooled by partial overwrites.
const LONE_CR_RE = /\r(?!\n)/g

// TUI decorative glyphs that Claude Code renders around YAML key-value lines
// and choice items.  These are NOT content and must be stripped.
// Includes: arrows ›❯▶, em/en dashes —–, box-drawing ─━─, full-width chars, etc.
const TUI_GLYPH_RE = /[›❯▶＞’’»«‹—–─-╿]/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(LONE_CR_RE, '')
}

// TUI chrome that Claude / Codex / Gemini repeatedly redraw at the bottom of
// the screen. After ANSI stripping these lines still pollute the cleanBuffer
// and confuse the question-block parser / sentinel matcher / local analyzer.
// We drop any cleaned line that, after lower+despace, contains a known
// status-line keyword.
// Matched against each line AFTER lowercasing + removing all whitespace.
// `tointerrupt` already covers both "esc to interrupt" and "esctointerrupt".
// `/effort` and `[end of text]` are Claude status-bar chrome the backend
// stripper also drops (terminals.py). We deliberately do NOT include
// "for agents": compacted to "foragents" it would mis-drop ordinary prose.
const TUI_NOISE_RE = /(bypasspermissions|shift\+tab|tointerrupt|esctointerrupt|loadingpasted|pressentertoconfirm|\/effort|\[endoftext\])/i

export function dropTuiNoise(text: string): string {
  let dirty = false
  const lines = text.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const compact = line.toLowerCase().replace(/\s+/g, '')
    if (TUI_NOISE_RE.test(compact)) {
      dirty = true
      continue
    }
    kept.push(line)
  }
  return dirty ? kept.join('\n') : text
}

export interface QuestionBlock {
  type: 'text' | 'choice'
  prompt: string
  options: string[]
  startIndex: number
  endIndex: number
}

const QUESTION_START = '---QUESTION-START---'
const QUESTION_END = '---QUESTION-END---'

/**
 * Find the first complete QUESTION block in `text` at or after `from`.
 * Returns null if no complete block is present.
 *
 * Uses a line-by-line state-machine parser instead of lookahead regexes so
 * it handles PTY-corrupted output (extra indentation, \r\n endings, partial
 * ANSI strips, interleaved TUI chrome) reliably.
 */
/**
 * Normalise the inner content of a QUESTION block before key extraction.
 * - Full-width colon ：→ ASCII : (agents sometimes use full-width in Chinese text)
 * - TUI glyphs stripped (arrows, em-dashes used as decoration around key names)
 */
function normaliseInner(raw: string): string {
  return raw
    .replace(TUI_GLYPH_RE, ' ')   // replace TUI decoration with a space (preserves word boundaries)
    .replace(/：/g, ':')           // full-width colon → ASCII
}

export function findQuestionBlock(text: string, from: number = 0): QuestionBlock | null {
  const firstStart = text.indexOf(QUESTION_START, from)
  if (firstStart < 0) return null
  const endIdx = text.indexOf(QUESTION_END, firstStart + QUESTION_START.length)
  if (endIdx < 0) return null
  // Pair the END with the START closest before it. When an earlier block's
  // END was mangled by a TUI redraw (#733: an echoed kickoff example lost a
  // dash), that orphan START would otherwise swallow everything up to the
  // next block's END.
  const startIdx = text.lastIndexOf(QUESTION_START, endIdx - QUESTION_START.length)
  const rawInner = text.slice(startIdx + QUESTION_START.length, endIdx)
  if (!rawInner.trim()) return null

  // Normalise TUI decoration and full-width colons so key matching works even
  // when the agent TUI renders lines like "—prompt:—content" or "options：".
  const inner = normaliseInner(rawInner)

  // Section extractor: tolerant to both well-formed multi-line YAML-ish output
  // and single-line "type: x prompt: y options: - a - b" (flattened by PTY).
  // Uses (?:^|\s) so the key can appear after any whitespace (newline, space,
  // or the spaces that TUI glyphs were replaced with above).
  const KEY_LOOKAHEAD = '(?=\\s*(?:type\\s*:|prompt\\s*:|options\\s*:|$))'

  function section(key: string): string {
    const re = new RegExp(`(?:^|\\s)${key}\\s*:\\s*([\\s\\S]*?)${KEY_LOOKAHEAD}`, 'i')
    const m = inner.match(re)
    return m?.[1]?.trim() ?? ''
  }

  const rawType = section('type').toLowerCase()
  const parsedType: 'text' | 'choice' = rawType === 'choice' ? 'choice' : 'text'
  const prompt = section('prompt')
  const optsText = section('options')

  if (!prompt) return null

  const options = parseOptions(optsText)

  // KEY ROBUSTNESS RULE: if we successfully parsed ≥2 options the question IS
  // a choice question, regardless of what the type: field says (or whether it
  // was garbled by PTY noise).  This eliminates the dependency on the fragile
  // "type: choice" line being present and correctly read.
  const finalType: 'text' | 'choice' = options.length >= 2 ? 'choice' : parsedType

  // Diagnostic when declared choice but no options could be extracted.
  if (parsedType === 'choice' && options.length === 0) {
    console.debug('[findQuestionBlock] choice declared but 0 options parsed — inner:', JSON.stringify(inner.slice(0, 400)))
  }

  return {
    type: finalType,
    prompt,
    options,
    startIndex: startIdx,
    endIndex: endIdx + QUESTION_END.length
  }
}

// Bullet character class — covers ASCII hyphen, common Unicode dashes, the
// full-width form Chinese agents often use (`－` U+FF0D), and bullet markers.
// Without these, lines like `－ 台灣` or `— 全球` get treated as plain prose.
const BULLET_CHARS = '[-*•‐‒–—−－]'
// Numbered-list marker after the digits — ASCII "." / ")", plus the full-width
// and ideographic forms Chinese agents use. Mirrors splitNumberedPrompt so a
// "1) foo / 2) bar" list parses as options, not just "1. foo".
const NUM_MARK = '[.、．）)]'

/**
 * Extract bullet items from an options section. Handles:
 *   - "- foo\n- bar\n- baz"     (multi-line, dash bullets)
 *   - "* foo\n* bar"             (asterisk bullets)
 *   - "- foo - bar - baz"        (inline, single line)
 *   - "1. foo\n2. bar" / "1) foo\n2) bar"  (numbered, dot or paren)
 *   - mixed leading whitespace
 *   - Unicode dash variants (en/em dash, full-width hyphen)
 */
export function parseOptions(optsText: string): string[] {
  if (!optsText) return []
  // First pass: line-based bullets.
  const lineOpts: string[] = []
  const lineRe = new RegExp(`^(?:${BULLET_CHARS}|\\d+${NUM_MARK})\\s*(.+?)\\s*$`)
  for (const raw of optsText.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(lineRe)
    if (m) lineOpts.push(m[1])
  }
  if (lineOpts.length > 1) return lineOpts

  // Second pass: inline " - a - b - c" or "- a - b - c".
  const flat = optsText.replace(/\s+/g, ' ').trim()
  const inlineSplit = new RegExp(`\\s+${BULLET_CHARS}\\s+`)
  const inlineHead = new RegExp(`^${BULLET_CHARS}\\s*`)
  const parts = flat
    .split(inlineSplit)
    .map((p) => p.replace(inlineHead, '').trim())
    .filter((p) => p.length > 0)
  if (parts.length > 1) return parts

  // Fallback: numbered inline "1. a 2. b 3. c" / "1) a 2) b 3) c".
  const numbered = flat
    .split(new RegExp(`\\s+\\d+${NUM_MARK}\\s+`))
    .map((p) => p.replace(new RegExp(`^\\d+${NUM_MARK}\\s*`), '').trim())
    .filter((p) => p.length > 0)
  if (numbered.length > 1) return numbered

  return lineOpts.length === 1 ? lineOpts : []
}

/**
 * Split a single question prompt that embeds multiple numbered sub-questions
 * (e.g. "有三個問題：\n1. 問A\n2. 問B\n3. 問C") into individual prompt strings.
 * Returns the original prompt in a single-element array if no split applies.
 *
 * Handles Chinese numbering (1. 2. 3.) and variants (1、 1） 1）).
 */
export function splitNumberedPrompt(prompt: string): string[] {
  // Same numbered-marker set as parseOptions — share NUM_MARK so the two never
  // diverge (a "1)" list must split here exactly as it parses as options).
  const lineRe = new RegExp(`^\\s*\\d+${NUM_MARK}\\s+(.+)`)
  const lines = prompt.split(/\r?\n/)
  const numbered: string[] = []
  let cur = ''
  for (const line of lines) {
    const m = line.match(lineRe)
    if (m) {
      if (cur) numbered.push(cur.trim())
      cur = m[1].trim()
    } else if (cur && line.trim()) {
      // continuation line for current sub-question
      cur += ' ' + line.trim()
    }
  }
  if (cur) numbered.push(cur.trim())
  return numbered.length >= 2 ? numbered : [prompt]
}

/**
 * Find ALL QUESTION blocks that appear back-to-back starting at or after
 * `from`. "Back-to-back" allows a small gap (`maxGap`) of agent narration
 * between blocks — anything larger is treated as a separate question round
 * and left for the next watcher tick.
 *
 * Blocks whose prompt contains multiple numbered sub-questions are automatically
 * expanded into individual QuestionBlock entries (one per sub-question).
 *
 * Returned blocks are in order of appearance. Empty array means no blocks.
 */
export function findConsecutiveQuestionBlocks(
  text: string,
  from: number = 0,
  maxGap: number = 600,
  skipPrompts: readonly string[] = []
): QuestionBlock[] {
  const blocks: QuestionBlock[] = []
  let cursor = from
  while (true) {
    const b = findQuestionBlock(text, cursor)
    if (!b) break
    // A block whose prompt is one of `skipPrompts` (the protocol's own
    // examples, echoed with the kickoff) is stepped over without anchoring
    // the gap check, so the agent's real block after it is still reached.
    if (skipPrompts.includes(b.prompt)) {
      cursor = b.endIndex
      continue
    }
    if (blocks.length > 0) {
      const gap = b.startIndex - blocks[blocks.length - 1].endIndex
      if (gap > maxGap) break
    }
    // Expand single block with multiple numbered sub-questions into individual blocks
    const subPrompts = splitNumberedPrompt(b.prompt)
    if (subPrompts.length > 1) {
      for (const sub of subPrompts) {
        blocks.push({ ...b, prompt: sub, type: 'text', options: [] })
      }
    } else {
      blocks.push(b)
    }
    cursor = b.endIndex
  }
  return blocks
}

/**
 * Find a stage sentinel like "---SPEC-DONE---" at or after `from`.
 * Returns the index of the sentinel's first character, or -1 if not found.
 *
 * STRICT line anchoring (no leading whitespace before the sentinel) to avoid
 * a class of false-positives: when Claude TUI word-wraps long instruction
 * lines from the kickoff body, a wrap continuation can place the sentinel
 * at the start of a visual line preceded by indentation spaces. The
 * protocol explicitly says "單獨一行、無任何標點" (own line, no
 * punctuation) — a compliant agent will not indent, so disallowing leading
 * whitespace removes wrap-fragment false-positives without rejecting any
 * legitimate emission.
 *
 * Trailing whitespace is still tolerated (some terminals pad lines).
 *
 * Callers should still scan from a position AFTER the kickoff was sent to
 * avoid matching the sentinel string within the kickoff echo itself.
 */
export function findSentinel(text: string, sentinel: string, from: number = 0): number {
  const escaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Match the sentinel as the LAST token on a line. It may sit at column 0
  // (`(?:^|\n)`), OR be preceded by terminal text separated by ≥2 spaces — that
  // gap is the Claude TUI status bar (`globalVersion: x · latest`) bleeding onto
  // the sentinel's grid row, which otherwise hides a genuine completion signal.
  // A single space is NOT tolerated, so instructional echoes such as
  // "最後一行只有 ---PLAN-DONE---" stay rejected (only one space before them).
  // After the sentinel we also tolerate trailing TUI chrome on the SAME line
  // (e.g. `---PLAN-DONE---✻ Hullaballooing… (1m 59s)`): Claude appends its
  // spinner/status to the sentinel's row with no newline.  `[^\\n]*` swallows it.
  //
  // BEFORE the sentinel we tolerate two prefix forms:
  //   (a) a Claude bullet glyph + space  — `⏺ ---X---` / `● ---X---`.  Claude
  //       prints its final message under a tool-result/bullet marker, so the
  //       sentinel lands as `⏺ ---X---` with only ONE space. This is the most
  //       common real-world miss (the agent DID print it, we just didn't match).
  //   (b) terminal text + ≥2 spaces      — TUI status bar bleeding onto the row.
  // Single-space text prefixes are still rejected, so instructional echoes like
  // "最後一行只有 ---PLAN-DONE---" (text + one space) stay rejected.
  const BULLET = '[⏺●◯○◌•▪▸‣⎿⢿⣿]'
  const re = new RegExp(
    `(?:^|\\n)(?:${BULLET}\\s*)?(?:[^\\n]*?  +)?${escaped}[^\\n]*(?=\\r?\\n|$)`,
    'g'
  )
  re.lastIndex = from
  const match = re.exec(text)
  if (!match) return -1
  // Sentinel is always the trailing token; lastIndexOf avoids a false hit if the
  // tolerated status-bar prefix happened to contain the sentinel string.
  return match.index + match[0].lastIndexOf(sentinel)
}

export function bufferTail(text: string, maxBytes: number = 64 * 1024): string {
  if (text.length <= maxBytes) return text
  let start = text.length - maxBytes
  // Don't start the slice inside a surrogate pair: a lone low surrogate
  // (0xDC00-0xDFFF) at the cut point renders as a replacement char (�) — an
  // emoji or non-BMP CJK char straddling the boundary would be broken. Step
  // one code unit forward so the tail begins on a whole character.
  const code = text.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start++
  return text.slice(start)
}

// A focus/resize repaint makes the CLI re-emit content already on screen. After
// ANSI + TUI-noise stripping those bytes look like fresh output and would flip
// the RUNNING badge on for a mere click or resize. Detect the replay by
// normalizing both sides to a whitespace-free character stream — a resize only
// moves newlines around (reflow), it doesn't change the characters, so this
// survives one — and checking whether the incoming chunk is a substring of the
// recent tail. Short chunks are ignored: they'd collide by coincidence and
// can't build a RUNNING burst anyway.
const REDRAW_MIN_CHARS = 40
const REDRAW_TAIL_WINDOW = 64 * 1024

export interface RedrawGuard {
  /** True if `cleaned` is content already in the window (a repaint). */
  isReplay(cleaned: string): boolean
  /** Record a chunk the caller kept, extending the comparison window. */
  accept(cleaned: string): void
  /** Rebuild the window from scratch (buffer rewritten out of band). */
  reset(seed?: string): void
}

/** Stateful replay detector. The window is normalized incrementally: the
 *  previous implementation re-normalized the whole 64KB tail on EVERY chunk,
 *  so a streaming CLI paid a full-window regex sweep per PTY wakeup on the
 *  renderer's main thread — which is exactly when the user is trying to type.
 *  Now each chunk is normalized once, when it is accepted. */
export function createRedrawGuard(windowChars: number = REDRAW_TAIL_WINDOW): RedrawGuard {
  let tail = ''
  // Raw (pre-normalization) length of each accepted chunk, so the window still
  // spans roughly windowChars of ORIGINAL text the way bufferTail used to.
  // Whole chunks are dropped, so the span is >= windowChars, never less.
  const segs: { raw: number; norm: number }[] = []
  let rawTotal = 0
  // appendClean calls isReplay(chunk) and then accept(chunk) with the SAME
  // string, and both normalize it — two full passes over every chunk. Keep the
  // last result so the pair costs one. The key is the string itself, so a
  // caller that does not follow that order simply misses the cache.
  let normCacheKey: string | null = null
  let normCacheValue = ''

  function normalize(cleaned: string): string {
    if (normCacheKey === cleaned) return normCacheValue
    normCacheKey = cleaned
    normCacheValue = cleaned.replace(/\s+/g, '')
    return normCacheValue
  }

  function accept(cleaned: string): void {
    if (!cleaned) return
    const norm = normalize(cleaned)
    segs.push({ raw: cleaned.length, norm: norm.length })
    rawTotal += cleaned.length
    tail += norm
    while (segs.length > 1 && rawTotal - segs[0].raw >= windowChars) {
      const drop = segs.shift()!
      rawTotal -= drop.raw
      tail = tail.slice(drop.norm)
    }
  }

  return {
    isReplay(cleaned: string): boolean {
      const inc = normalize(cleaned)
      if (inc.length < REDRAW_MIN_CHARS) return false
      return tail.includes(inc)
    },
    accept,
    reset(seed = ''): void {
      segs.length = 0
      tail = ''
      rawTotal = 0
      accept(seed)
    }
  }
}
