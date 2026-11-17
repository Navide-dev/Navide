import { describe, it, expect } from 'vitest'
import {
  dropNoiseRows,
  stripAnsi,
  dropTuiNoise,
  findQuestionBlock,
  parseOptions,
  splitNumberedPrompt,
  findConsecutiveQuestionBlocks,
  findSentinel,
  bufferTail,
  createRedrawGuard
} from '../buffer'

describe('stripAnsi', () => {
  it('removes CSI colour codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
  })

  it('removes OSC title sequences', () => {
    expect(stripAnsi('\x1b]0;my title\x07text')).toBe('text')
  })

  it('removes ST-terminated OSC sequences (no BEL)', () => {
    // Set-title terminated by ST (\x1b\\) instead of BEL — previously left
    // "0;my title" as residue in the cleanBuffer.
    expect(stripAnsi('\x1b]0;my title\x1b\\text')).toBe('text')
  })

  it('removes a DCS sequence terminated by ST', () => {
    expect(stripAnsi('\x1bPq;data\x1b\\text')).toBe('text')
  })

  it('drops a lone CR (cursor-back overwrite) but keeps CRLF', () => {
    expect(stripAnsi('abc\rxyz')).toBe('abcxyz')
    expect(stripAnsi('line1\r\nline2')).toBe('line1\r\nline2')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('hello 世界')).toBe('hello 世界')
  })
})

describe('dropNoiseRows', () => {
  // Claude Code 2.1.3xx writes no \n: each screen row is placed with a cursor
  // move. Run under --dangerously-skip-permissions its first frame ends in the
  // "bypass permissions on" footer, and with every row joined into one line
  // dropTuiNoise dropped the banner and prompt along with it — the pane never
  // counted a visible byte, and cli_open_agent reported its kickoff failed
  // without typing it (macOS VM 4/4, 0.2.42/0.2.43).
  const firstFrame =
    '\x1b[H Claude Code v2.1.319\r\x1b[1B Opus 5.5\r\x1b[1B ~/wh/wq\r\x1b[2B❯ \r\x1b[1B ▸▸ bypass permissions on'

  it('keeps the rest of a frame whose footer is status chrome', () => {
    const cleaned = dropTuiNoise(stripAnsi(dropNoiseRows(firstFrame)))
    expect(cleaned).toContain('Claude Code v2.1.319')
    expect(cleaned).toContain('❯')
    expect(cleaned).not.toContain('bypass')
    // Still one line, as the Manager router's screen scan expects.
    expect(cleaned.includes('\n')).toBe(false)
  })

  it('is the old result for a frame with no chrome row', () => {
    const frame = '\x1b[H top\r\x1b[1B next \x1b[3Grow'
    expect(dropNoiseRows(frame)).toBe(frame)
    expect(dropNoiseRows('plain\r\nlines')).toBe('plain\r\nlines')
  })

  it('still drops a chunk that is nothing but chrome', () => {
    expect(dropTuiNoise(stripAnsi(dropNoiseRows('\x1b[40;1H ▸▸ bypass permissions on\x1b[38;3H')))).toBe('')
  })
})

describe('dropTuiNoise', () => {
  it('drops Claude status-bar chrome lines', () => {
    const input = 'real content\nbypass permissions on\nmore content'
    expect(dropTuiNoise(input)).toBe('real content\nmore content')
  })

  it('drops "esc to interrupt" regardless of spacing/case', () => {
    expect(dropTuiNoise('keep\nEsc To Interrupt')).toBe('keep')
  })

  it('drops the /effort and [end of text] status chrome', () => {
    expect(dropTuiNoise('keep\n/effort high\n[end of text]\nalso keep')).toBe('keep\nalso keep')
  })

  it('does NOT drop prose containing "for agents"', () => {
    const prose = 'this guide is for agents to read'
    expect(dropTuiNoise(prose)).toBe(prose)
  })

  it('returns the SAME string when nothing matches', () => {
    const clean = 'nothing to drop here'
    expect(dropTuiNoise(clean)).toBe(clean)
  })
})

describe('parseOptions', () => {
  it('parses multi-line dash bullets', () => {
    expect(parseOptions('- foo\n- bar\n- baz')).toEqual(['foo', 'bar', 'baz'])
  })

  it('parses numbered lines', () => {
    expect(parseOptions('1. foo\n2. bar')).toEqual(['foo', 'bar'])
  })

  it('parses paren-numbered lines (1) 2))', () => {
    expect(parseOptions('1) foo\n2) bar\n3) baz')).toEqual(['foo', 'bar', 'baz'])
  })

  it('parses inline paren-numbered options', () => {
    expect(parseOptions('1) a 2) b 3) c')).toEqual(['a', 'b', 'c'])
  })

  it('parses inline dash-separated options', () => {
    expect(parseOptions('- a - b - c')).toEqual(['a', 'b', 'c'])
  })

  it('handles full-width / unicode dash bullets', () => {
    expect(parseOptions('－ 台灣\n－ 全球')).toEqual(['台灣', '全球'])
  })

  it('returns the single option when only one bullet present', () => {
    expect(parseOptions('- only')).toEqual(['only'])
  })

  it('returns [] for empty input', () => {
    expect(parseOptions('')).toEqual([])
  })
})

describe('splitNumberedPrompt', () => {
  it('splits an embedded numbered list into sub-prompts', () => {
    expect(splitNumberedPrompt('有三題：\n1. 問A\n2. 問B\n3. 問C')).toEqual(['問A', '問B', '問C'])
  })

  it('splits a paren-numbered list (1) 2)) like the dot form', () => {
    expect(splitNumberedPrompt('有兩題：\n1) 問A\n2) 問B')).toEqual(['問A', '問B'])
  })

  it('joins continuation lines onto the current sub-question', () => {
    expect(splitNumberedPrompt('1. 第一行\n接續\n2. 第二題')).toEqual(['第一行 接續', '第二題'])
  })

  it('returns the original prompt unchanged when no numbering', () => {
    expect(splitNumberedPrompt('只有一個問題嗎?')).toEqual(['只有一個問題嗎?'])
  })
})

describe('findQuestionBlock', () => {
  const block = [
    '---QUESTION-START---',
    'type: choice',
    'prompt: 要哪個資料庫?',
    'options:',
    '- PostgreSQL',
    '- MySQL',
    '---QUESTION-END---'
  ].join('\n')

  it('parses a well-formed choice block', () => {
    const q = findQuestionBlock(block)
    expect(q).not.toBeNull()
    expect(q!.type).toBe('choice')
    expect(q!.prompt).toBe('要哪個資料庫?')
    expect(q!.options).toEqual(['PostgreSQL', 'MySQL'])
  })

  it('reports start/end indices spanning the whole block', () => {
    const wrapped = 'noise before\n' + block + '\nnoise after'
    const q = findQuestionBlock(wrapped)!
    expect(wrapped.slice(q.startIndex, q.endIndex)).toBe(block)
  })

  it('upgrades to choice when ≥2 options parsed even if type says text', () => {
    const t = block.replace('type: choice', 'type: text')
    expect(findQuestionBlock(t)!.type).toBe('choice')
  })

  it('treats a block with no options as text', () => {
    const t = [
      '---QUESTION-START---',
      'type: text',
      'prompt: 專案名稱?',
      '---QUESTION-END---'
    ].join('\n')
    const q = findQuestionBlock(t)!
    expect(q.type).toBe('text')
    expect(q.options).toEqual([])
  })

  it('returns null when there is no prompt', () => {
    const t = '---QUESTION-START---\ntype: text\n---QUESTION-END---'
    expect(findQuestionBlock(t)).toBeNull()
  })

  it('returns null when the block is not closed', () => {
    expect(findQuestionBlock('---QUESTION-START---\nprompt: x')).toBeNull()
  })

  it('respects the `from` offset (finds the second block)', () => {
    const two = block + '\n---QUESTION-START---\ntype: text\nprompt: 第二題?\n---QUESTION-END---'
    const first = findQuestionBlock(two)!
    const second = findQuestionBlock(two, first.endIndex)!
    expect(second.prompt).toBe('第二題?')
  })
})

describe('findConsecutiveQuestionBlocks', () => {
  const mk = (prompt: string) =>
    `---QUESTION-START---\ntype: text\nprompt: ${prompt}\n---QUESTION-END---`

  it('returns [] when no blocks exist', () => {
    expect(findConsecutiveQuestionBlocks('just narration')).toEqual([])
  })

  it('collects back-to-back blocks', () => {
    const text = mk('A?') + '\n' + mk('B?')
    const blocks = findConsecutiveQuestionBlocks(text)
    expect(blocks.map((b) => b.prompt)).toEqual(['A?', 'B?'])
  })

  it('stops when the gap between blocks exceeds maxGap', () => {
    const text = mk('A?') + '\n' + 'x'.repeat(50) + '\n' + mk('B?')
    const blocks = findConsecutiveQuestionBlocks(text, 0, 10)
    expect(blocks.map((b) => b.prompt)).toEqual(['A?'])
  })

  it('expands a numbered multi-question prompt into separate blocks', () => {
    const text = mk('請回答：\n1. 問A\n2. 問B')
    const blocks = findConsecutiveQuestionBlocks(text)
    expect(blocks.map((b) => b.prompt)).toEqual(['問A', '問B'])
  })
})

describe('findSentinel', () => {
  const S = '---SPEC-DONE---'

  it('finds a sentinel at the start of a line', () => {
    const text = 'work output\n' + S + '\ntrailing'
    expect(findSentinel(text, S)).toBe(text.indexOf(S))
  })

  it('matches when preceded by a Claude bullet glyph', () => {
    const text = 'done\n⏺ ' + S
    expect(findSentinel(text, S)).toBe(text.indexOf(S))
  })

  it('matches with trailing TUI chrome on the same line', () => {
    const text = '\n' + S + '✻ Spinning… (1m)'
    expect(findSentinel(text, S)).toBe(text.indexOf(S))
  })

  it('matches a status-bar prefix separated by ≥2 spaces', () => {
    const text = '\nglobalVersion: x  ' + S
    expect(findSentinel(text, S)).toBe(text.indexOf(S))
  })

  it('rejects an instructional echo with a single leading space', () => {
    expect(findSentinel('最後一行只有 ' + S, S)).toBe(-1)
  })

  it('returns -1 when the sentinel is absent', () => {
    expect(findSentinel('no sentinel here', S)).toBe(-1)
  })

  it('honours the `from` start offset', () => {
    const text = '\n' + S + ' first\n' + S + ' second'
    const firstIdx = findSentinel(text, S)
    const secondIdx = findSentinel(text, S, firstIdx + 1)
    expect(secondIdx).toBeGreaterThan(firstIdx)
  })
})

describe('bufferTail', () => {
  it('returns the text unchanged when under the cap', () => {
    expect(bufferTail('short', 64)).toBe('short')
  })

  it('keeps only the trailing slice when over the cap', () => {
    expect(bufferTail('abcdef', 3)).toBe('def')
  })

  it('returns text unchanged when exactly at the cap', () => {
    expect(bufferTail('abc', 3)).toBe('abc')
  })

  it('does not start the tail on a lone low surrogate (emoji at the cut)', () => {
    // '😀' is two UTF-16 code units. text = 'aaaaa' + 😀 + 'bcd' (length 10);
    // cap 4 → cut index 6 lands on the low surrogate. The tail must drop it.
    const text = 'aaaaa\u{1F600}bcd'
    const tail = bufferTail(text, 4)
    expect(tail).toBe('bcd')
    const first = tail.charCodeAt(0)
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
  })
})

describe('createRedrawGuard', () => {
  // A screenful of prose already on screen; a click/resize repaints it verbatim.
  const screen =
    'Analyzing the request and planning the change across several files.\n' +
    'First I will read the terminal composable, then wire the new helper.\n' +
    'Running the test suite to confirm nothing regressed after the edit.'

  const seeded = (): ReturnType<typeof createRedrawGuard> => {
    const g = createRedrawGuard()
    g.accept(screen)
    return g
  }

  it('flags a verbatim repaint of on-screen content', () => {
    expect(seeded().isReplay(screen)).toBe(true)
  })

  it('flags a repaint after reflow (newlines moved, characters unchanged)', () => {
    // A resize rewraps the same characters onto different line boundaries.
    const reflowed = screen.replace(/\n/g, ' ').replace(/ /g, '\n')
    expect(seeded().isReplay(reflowed)).toBe(true)
  })

  it('flags a repaint of just the visible tail (scrolled viewport)', () => {
    expect(seeded().isReplay(screen.slice(-90))).toBe(true)
  })

  it('does not flag genuinely new output', () => {
    expect(seeded().isReplay('Here is a completely different fresh line of agent output now.')).toBe(false)
  })

  it('does not flag output that only partly overlaps then adds new content', () => {
    // Tail of the screen replayed, then real new work appended → not a pure replay.
    const mixed = screen.slice(-90) + ' and now writing brand new content that was never shown before.'
    expect(seeded().isReplay(mixed)).toBe(false)
  })

  it('ignores short chunks that could collide by coincidence', () => {
    // < REDRAW_MIN_CHARS of non-whitespace, even though it is a substring.
    expect(seeded().isReplay('Analyzing')).toBe(false)
  })

  it('matches content spread across several accepted chunks', () => {
    // The window is built incrementally, so a repaint may straddle the
    // boundaries of the chunks that originally delivered it.
    const g = createRedrawGuard()
    for (const line of screen.split('\n')) g.accept(line + '\n')
    expect(g.isReplay(screen)).toBe(true)
  })

  it('forgets content that scrolled out of the window', () => {
    const g = createRedrawGuard(1024)
    g.accept(screen)
    g.accept('z'.repeat(4096))
    expect(g.isReplay(screen)).toBe(false)
  })

  it('keeps at least one window worth of history', () => {
    const g = createRedrawGuard(1024)
    g.accept('a'.repeat(600))
    g.accept(screen)
    // The screen still fits inside the window, so it must still be recognized.
    expect(g.isReplay(screen)).toBe(true)
  })

  it('reset rebuilds the window from the given text', () => {
    const g = createRedrawGuard()
    g.accept('some earlier output that will be discarded by the reset below.')
    g.reset(screen)
    expect(g.isReplay(screen)).toBe(true)
    expect(g.isReplay('some earlier output that will be discarded by the reset below.')).toBe(false)
  })
})
