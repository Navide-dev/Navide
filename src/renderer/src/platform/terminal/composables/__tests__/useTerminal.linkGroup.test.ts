// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import {
  getWrappedLineGroup,
  groupPosToRowCol,
  groupRowColToPos,
  findFileLinkAt,
  findFileLinkMatchAt,
  findUrlLinkMatchAt,
  findUrlMatches,
  trimUrlTrailing,
  shedCjkProse,
  shedCjkPieces,
  rootedTailCandidate,
  visualWidth,
  htmlReportRoute,
  splitMatchAtRowStarts,
  cellColToStrCol,
  strColToCellCol,
} from '../useTerminal'

// Minimal stand-in for the xterm buffer surface getWrappedLineGroup reads.
// Fixture texts are pre-trimmed (translateToString(true) right-trims).
function mockTerm(rows: Array<{ text: string; wrapped?: boolean }>): Terminal {
  return {
    cols: 80,
    buffer: {
      active: {
        getLine: (r: number) =>
          rows[r] === undefined
            ? undefined
            : { isWrapped: !!rows[r].wrapped, translateToString: () => rows[r].text },
      },
    },
  } as unknown as Terminal
}

// The exact CLI pre-wrap case from the bug report: Claude Code wraps a long
// path at its own content width (narrower than the pane) with a real newline,
// indenting the continuation with the block's gutter. isWrapped is false.
const PREWRAP_ROWS = [
  { text: '     /Users/neillu/Desktop/Leankoo/Leankoo1/vendor/seba' },
  { text: '     stian/cli-parser/README.md' },
]
const PREWRAP_FULL = '/Users/neillu/Desktop/Leankoo/Leankoo1/vendor/sebastian/cli-parser/README.md'

describe('getWrappedLineGroup', () => {
  it('keeps an isolated line as its own group', () => {
    const term = mockTerm([{ text: 'hello world' }, { text: '' }])
    const g = getWrappedLineGroup(term, 0)
    expect(g).toEqual({
      groupStart: 0, lineLengths: [11], strips: [0], fullText: 'hello world', heuristicBreaks: [],
    })
  })

  it('joins genuine xterm wraps via isWrapped regardless of content', () => {
    const term = mockTerm([{ text: 'abc def' }, { text: 'ghi', wrapped: true }])
    const g = getWrappedLineGroup(term, 0)
    expect(g.fullText).toBe('abc defghi')
    expect(g.strips).toEqual([0, 0])
    expect(g.heuristicBreaks).toEqual([])
  })

  it('joins CLI pre-wrapped rows and strips the continuation gutter', () => {
    const g = getWrappedLineGroup(mockTerm(PREWRAP_ROWS), 0)
    expect(g.fullText).toContain(PREWRAP_FULL)
    expect(g.strips).toEqual([0, 5])
    expect(g.heuristicBreaks).toEqual([PREWRAP_ROWS[0].text.length])
  })

  it('finds the same group when starting from the continuation row', () => {
    const term = mockTerm(PREWRAP_ROWS)
    expect(getWrappedLineGroup(term, 1)).toEqual(getWrappedLineGroup(term, 0))
  })

  it('joins across differing indents (tool-result ⎿ gutter)', () => {
    const term = mockTerm([
      { text: '  ⎿  /Users/x/very-long-' },
      { text: '     name.md' },
    ])
    const g = getWrappedLineGroup(term, 0)
    expect(findFileLinkAt(g.fullText, g.fullText.indexOf('/Users'))).toBe('/Users/x/very-long-name.md')
  })

  it('does not join across a blank row', () => {
    const term = mockTerm([{ text: '/Users/a/one.md' }, { text: '' }, { text: '/Users/a/two.md' }])
    expect(getWrappedLineGroup(term, 0).fullText).toBe('/Users/a/one.md')
  })

  it('joins CJK-heavy pre-wrapped rows measured by cell width, not string length', () => {
    // A CJK row near the 80-cell limit holds ~half the string characters of
    // an ASCII neighbour; string-length comparison used to reject this join,
    // truncating Chinese paths at every wrap point.
    const rows = [
      { text: 'x'.repeat(79) + '!' }, // long ASCII prose neighbour ('!' blocks gluing)
      { text: '/Users/nt/' + '客'.repeat(34) }, // 78 cells but only 44 chars
      { text: '戶'.repeat(28) + '/報告書 (1).html' },
    ]
    expect(visualWidth(rows[1].text)).toBe(78)
    const g = getWrappedLineGroup(mockTerm(rows), 1)
    expect(g.fullText).toBe(rows[1].text + rows[2].text)
  })

  it('keeps the clicked path intact in column-aligned output (git create mode)', () => {
    // Rows here end where their content ends, not at a width limit — a
    // measurably longer neighbour proves that, so the clicked row must not
    // have the next row glued onto it ('…Test.phpcreate').
    const rows = [
      { text: '      create mode 100644 lang/zh_TW/conversations.php' },
      { text: '      create mode 100644 resources/views/employer/conversations/index.blade.php' },
      { text: '      create mode 100644 tests/Feature/WaTemplateControllerTest.php' },
      { text: '      create mode 100644 tests/Unit/OrganizationTest.php' },
    ]
    const g = getWrappedLineGroup(mockTerm(rows), 2)
    expect(g.fullText).not.toContain('OrganizationTest')
    const pos = groupRowColToPos(g, 2, rows[2].text.indexOf('tests/'))
    expect(findFileLinkAt(g.fullText, pos)).toBe('tests/Feature/WaTemplateControllerTest.php')
  })
})

describe('getWrappedLineGroup — command echo', () => {
  it('does not glue a command row onto output that repeats its path', () => {
    // `ls src/main.ts` prints the path back on the next row; gluing the two
    // turned the click into "src/main.tssrc/main.ts" on Windows and Linux.
    const rows = [{ text: 'user@vm:~/proj$ ls src/main.ts' }, { text: 'src/main.ts' }, { text: '' }]
    const g = getWrappedLineGroup(mockTerm(rows), 1)
    expect(g.fullText).toBe('src/main.ts')
    expect(findFileLinkAt(getWrappedLineGroup(mockTerm(rows), 0).fullText, 20)).toBe('src/main.ts')
  })
})

describe('findFileLinkAt — Windows drive paths', () => {
  it('matches a backslash path with a drive letter', () => {
    const text = 'error in C:\\Users\\u\\proj\\src\\main.ts:12'
    expect(findFileLinkAt(text, text.indexOf('main'))).toBe('C:\\Users\\u\\proj\\src\\main.ts:12')
  })

  it('does not take a drive letter glued to a word', () => {
    expect(findFileLinkAt('abC:\\x\\y', 4)).toBeNull()
  })

  it('still matches forward-slash drive paths as before', () => {
    expect(findFileLinkAt('C:/Users/u/a.ts', 5)).toBe('C:/Users/u/a.ts')
  })
})

describe('position mapping', () => {
  const g = getWrappedLineGroup(mockTerm(PREWRAP_ROWS), 0)

  it('maps a click on the continuation row into fullText and back', () => {
    const pos = groupRowColToPos(g, 1, 7)
    expect(g.fullText[pos]).toBe('i') // '     stian…'[7] === 'i'
    expect(groupPosToRowCol(g, pos)).toEqual({ row: 1, col: 7 })
  })

  it('returns -1 for clicks in the stripped gutter or right of the content', () => {
    expect(groupRowColToPos(g, 1, 3)).toBe(-1)
    expect(groupRowColToPos(g, 1, 999)).toBe(-1)
  })

  it('hit-tests the full joined path from either row', () => {
    expect(findFileLinkAt(g.fullText, groupRowColToPos(g, 0, 10))).toBe(PREWRAP_FULL)
    expect(findFileLinkAt(g.fullText, groupRowColToPos(g, 1, 7))).toBe(PREWRAP_FULL)
  })
})

describe('splitMatchAtRowStarts', () => {
  // find-output where every row is near the same width: the width-limit check
  // cannot tell "one wrapped path" from "adjacent full-width paths", so the
  // whole block still glues into one regex match — the genuinely ambiguous
  // case the split-back heuristic exists for.
  const GLUE_PATHS = ['alpha', 'bravo', 'gamma'].map(
    (n) => `/Users/neillu/Desktop/Leankoo/Leankoo1/vendor/sebastian/pkg-${n}/README.md`
  )
  const WRAP = 40 // pre-wrap column; must not fall on a '/' (asserted below)
  const term = mockTerm(
    GLUE_PATHS.flatMap((p) => [
      { text: '     ' + p.slice(0, WRAP) },
      { text: '     ' + p.slice(WRAP) },
    ])
  )
  const g = getWrappedLineGroup(term, 5)
  const clickPos = groupRowColToPos(g, 5, 7) // click inside the last path's tail
  const m = findFileLinkMatchAt(g.fullText, clickPos)!

  it('splits a glued find-output block back into per-path pieces', () => {
    expect(GLUE_PATHS.every((p) => p[WRAP] !== '/' && p[WRAP] !== '~')).toBe(true)
    expect(splitMatchAtRowStarts(g, m.index, m.text).map((p) => p.text)).toEqual(GLUE_PATHS)
  })

  it('the piece under the click is the wrapped path, not the whole block', () => {
    const piece = splitMatchAtRowStarts(g, m.index, m.text).find(
      (p) => clickPos >= p.index && clickPos < p.index + p.text.length
    )
    expect(piece?.text).toBe(GLUE_PATHS[2])
  })

  it('leaves a match with no fresh-path row starts as a single piece', () => {
    const g2 = getWrappedLineGroup(mockTerm(PREWRAP_ROWS), 0)
    const m2 = findFileLinkMatchAt(g2.fullText, groupRowColToPos(g2, 1, 7))!
    expect(splitMatchAtRowStarts(g2, m2.index, m2.text)).toEqual([
      { index: m2.index, text: PREWRAP_FULL },
    ])
  })
})

describe('findFileLinkAt', () => {
  it('returns the row-local path for adjacent unrelated paths (find output)', () => {
    // In `find` output every row is a path, so rows join into one mega token;
    // the click handler falls back to this row-local match via fs.stat_path.
    expect(findFileLinkAt('     /Users/a/two.md', 7)).toBe('/Users/a/two.md')
  })

  it('ignores URLs and out-of-range positions', () => {
    expect(findFileLinkAt('see https://example.com/x', 10)).toBeNull()
    expect(findFileLinkAt('/Users/a/b.md', -1)).toBeNull()
  })
})

describe('shedCjkProse', () => {
  it('sheds CJK prose glued to both ends of a path (real CLI output)', () => {
    // The regex swallows prose joined by full-width punctuation; shedding
    // splits on that punctuation and keeps the piece with a '/'.
    const raw =
      '報告書：Leankoo1/.claude/loop-reports/loop-report-2026-07-22-recruit-status-complete.html（盤點結果、六項實作、輪次紀錄、7'
    expect(shedCjkProse(raw)).toBe(
      'Leankoo1/.claude/loop-reports/loop-report-2026-07-22-recruit-status-complete.html'
    )
  })

  it('keeps ideograph (Chinese) filenames intact', () => {
    expect(shedCjkProse('說明：文件/會議記錄.md。')).toBe('文件/會議記錄.md')
    expect(shedCjkProse('文件/會議記錄.md')).toBeUndefined() // no punctuation → no variant
  })

  it('never splits on CJK word characters inside path segments', () => {
    // U+3005 々 (iteration mark), U+3007 〇, and full-width alphanumerics
    // (０-９Ａ-Ｚａ-ｚ) are word characters, not punctuation seams.
    expect(shedCjkProse('報告書：佐々木/notes.md。')).toBe('佐々木/notes.md')
    expect(shedCjkProse('說明：第２章/draft.md（草稿）')).toBe('第２章/draft.md')
    expect(shedCjkProse('見：〇塾/ＡＢｃ９.md！')).toBe('〇塾/ＡＢｃ９.md')
  })

  it('still sheds genuine trailing CJK punctuation', () => {
    expect(shedCjkProse('路徑：a/b.md。」！？')).toBe('a/b.md')
  })

  it('returns undefined for plain ASCII paths', () => {
    expect(shedCjkProse('/Users/a/b.md')).toBeUndefined()
  })

  it('sheds to the path under the click when two paths are joined by 、', () => {
    const raw = '結果：src/a.ts、src/b.ts'
    const bPos = raw.indexOf('src/b')
    expect(shedCjkProse(raw, bPos + 2)).toBe('src/b.ts')
    expect(shedCjkProse(raw, raw.indexOf('src/a') + 2)).toBe('src/a.ts')
    expect(shedCjkProse(raw)).toBe('src/a.ts') // no position → first piece
    expect(shedCjkPieces(raw).map((p) => p.text)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('treats full-width alphanumerics and iteration marks as word chars', () => {
    // １ (U+FF11) and 々 are legitimate CJK filename characters — never split.
    expect(shedCjkProse('報告：第１章/内容.md')).toBe('第１章/内容.md')
    expect(shedCjkProse('日々の記録/memo.md')).toBeUndefined()
  })
})

describe('rootedTailCandidate', () => {
  // The real reported path: Chinese folder names containing spaces and
  // half-width parens, which FILE_LINK_RE must exclude and so truncates.
  const FULL =
    '/Users/neillu/Library/CloudStorage/SynologyDrive-NT/01.客戶資料/003-執行中/恩典健康事業/01.專案管理/看護媒合平台 (1)/01.規劃開發/03.設計相關/報告書/20260725-測試帳號清單(含後台管理).html'

  it('offers the whole tail from the rooted start, spaces and parens included', () => {
    const text = '報告存放在：' + FULL
    const t = rootedTailCandidate(text, text.indexOf('看護'))
    expect(t?.text).toBe(FULL)
    expect(t?.index).toBe(text.indexOf('/Users'))
  })

  it('returns undefined when there is no rooted path at/before the click', () => {
    expect(rootedTailCandidate('相對路徑 src/foo.ts 而已', 6)).toBeUndefined()
    expect(rootedTailCandidate('前面文字 /tmp/x.md', 2)).toBeUndefined() // click before the root
  })
})

describe('htmlReportRoute', () => {
  it('routes a workspace-internal html report (sub-project included) to the Plan window', () => {
    expect(
      htmlReportRoute('/ws/Leankoo1/.claude/loop-reports/loop-report-x.html', '/ws')
    ).toEqual({
      workspace_path: '/ws',
      rel_path: 'Leankoo1/.claude/loop-reports/loop-report-x.html',
    })
    expect(htmlReportRoute('/ws/report.HTM', '/ws/')).toEqual({
      workspace_path: '/ws',
      rel_path: 'report.HTM',
    })
  })

  it('returns undefined outside the workspace, for non-html, or without a workspace', () => {
    expect(htmlReportRoute('/elsewhere/r.html', '/ws')).toBeUndefined()
    expect(htmlReportRoute('/ws/notes.md', '/ws')).toBeUndefined()
    expect(htmlReportRoute('/ws/r.html', undefined)).toBeUndefined()
  })
})

describe('trimUrlTrailing', () => {
  it('sheds sentence punctuation the prose contributed', () => {
    expect(trimUrlTrailing('https://example.com/a.')).toBe('https://example.com/a')
    expect(trimUrlTrailing('https://example.com/a,')).toBe('https://example.com/a')
    expect(trimUrlTrailing('https://example.com/a?x=1;')).toBe('https://example.com/a?x=1')
  })

  it('drops an unbalanced closing bracket but keeps a matched one', () => {
    expect(trimUrlTrailing('https://example.com/a)')).toBe('https://example.com/a')
    expect(trimUrlTrailing('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)'
    )
  })
})

describe('findUrlLinkMatchAt', () => {
  it('returns the URL under the click with query string intact', () => {
    const text = 'open https://example.com/a?x=1&y=2 now'
    expect(findUrlLinkMatchAt(text, 10)).toEqual({
      text: 'https://example.com/a?x=1&y=2',
      href: 'https://example.com/a?x=1&y=2',
      index: 5,
    })
  })

  it('stops at CJK prose glued after the URL', () => {
    const text = '請看 https://example.com/docs。謝謝'
    expect(findUrlLinkMatchAt(text, 5)?.text).toBe('https://example.com/docs')
  })

  it('returns null off the URL, on trimmed punctuation, and for non-URLs', () => {
    const text = 'open https://example.com/a. now'
    expect(findUrlLinkMatchAt(text, 0)).toBeNull()
    expect(findUrlLinkMatchAt(text, 26)).toBeNull() // the trimmed '.'
    expect(findUrlLinkMatchAt('/Users/a/b.md', 3)).toBeNull()
  })
})

describe('findUrlMatches with heuristic breaks', () => {
  it('never lets a URL cross a heuristic row join (glued prose)', () => {
    // Pre-wrap glue: 'see https://example.com/docs' + 'and then run …' joined
    // with no separator. The break offset caps the URL at the row boundary.
    const text = 'see https://example.com/docsand then run'
    expect(findUrlMatches(text, [28])).toEqual([
      { index: 4, text: 'https://example.com/docs', href: 'https://example.com/docs' },
    ])
    // Without the break the glue would poison the URL.
    expect(findUrlMatches(text)[0].text).toBe('https://example.com/docsand')
  })

  it('lets a URL span a genuine xterm wrap (no break recorded)', () => {
    const wrapped = mockTerm([
      { text: 'https://example.com/very/long' },
      { text: '/path?q=1', wrapped: true },
    ])
    const g = getWrappedLineGroup(wrapped, 0)
    expect(findUrlMatches(g.fullText, g.heuristicBreaks)).toEqual([
      {
        index: 0,
        text: 'https://example.com/very/long/path?q=1',
        href: 'https://example.com/very/long/path?q=1',
      },
    ])
  })

  it('finds a URL that starts after a break', () => {
    const text = 'https://a.com/xhttps://b.com/y'
    expect(findUrlMatches(text, [15])).toEqual([
      { index: 0, text: 'https://a.com/x', href: 'https://a.com/x' },
      { index: 15, text: 'https://b.com/y', href: 'https://b.com/y' },
    ])
  })
})

describe('bare-domain URLs', () => {
  it('detects a bare domain in CJK prose (the reported line)', () => {
    const text =
      '- 上線：ef11923 已部署至正式站 leankoo.com（HEAD 已更新、view cache 已刷、6 個 x-cloak 確認在線上）、站點 200。'
    const urls = findUrlMatches(text)
    expect(urls).toHaveLength(1)
    expect(urls[0].text).toBe('leankoo.com')
    expect(urls[0].href).toBe('https://leankoo.com')
  })

  it('accepts www-prefixed dotted hosts and bare ports, but never a path tail', () => {
    expect(findUrlMatches('see www.example.foo now')[0]?.text).toBe('www.example.foo')
    expect(findUrlMatches('api on leankoo.com:8080 up')[0]?.text).toBe('leankoo.com:8080')
    // A following '/' means "relative file path in a domain-named checkout
    // dir" — the file pipeline can stat-verify that; a URL guess cannot.
    expect(findUrlMatches('grep leankoo.com/app/config.php hit')).toEqual([])
  })

  it('does not double-match the host inside a scheme URL', () => {
    const urls = findUrlMatches('open https://leankoo.com/x now')
    expect(urls).toHaveLength(1)
    expect(urls[0].href).toBe('https://leankoo.com/x')
  })

  it('never linkifies filenames whose extension looks like a TLD', () => {
    expect(findUrlMatches('run deploy.sh now')).toEqual([])
    expect(findUrlMatches('deploy.sh:12: warning')).toEqual([])
    expect(findUrlMatches('open Electron.app bundle')).toEqual([])
    expect(findUrlMatches('install socket.io v4')).toEqual([])
  })

  it('rejects domain-shaped filenames, junk www, glued ports, and e-mail hosts', () => {
    expect(findUrlMatches('edit package.json and config.yaml')).toEqual([])
    expect(findUrlMatches('bundle is dist/index.com.js here')).toEqual([])
    expect(findUrlMatches('mail user@leankoo.com please')).toEqual([])
    expect(findUrlMatches('see www.a now')).toEqual([])
    expect(findUrlMatches('id is leankoo.com:8080abc here')).toEqual([])
  })

  it('does not re-match the severed tail of a break-capped scheme URL', () => {
    // "https://lean" | "koo.com" glued at a heuristic break: the tail must
    // not become a clickable https://koo.com on a different host.
    const text = 'https://leankoo.com'
    const urls = findUrlMatches(text, [12])
    expect(urls).toHaveLength(1)
    expect(urls[0].text).toBe('https://lean')
  })
})

describe('cell column ↔ string offset mapping', () => {
  // A buffer line surface with per-cell widths/chars: CJK chars and emoji
  // occupy two cells (width 2 then width 0); an emoji additionally spans two
  // string code units (surrogate pair) in its single glyph cell.
  function mockTermWithCells(text: string): Terminal {
    const cells: Array<{ w: number; ch: string }> = []
    for (const ch of text) {
      // for..of iterates code points: a non-BMP emoji arrives as one ch of length 2
      if (ch.length > 1 || /[\u1100-\uFFFF]/.test(ch)) cells.push({ w: 2, ch }, { w: 0, ch: '' })
      else cells.push({ w: 1, ch })
    }
    return {
      buffer: {
        active: {
          getLine: () => ({
            isWrapped: false,
            length: cells.length,
            translateToString: () => text,
            getCell: (x: number) => ({ getWidth: () => cells[x].w, getChars: () => cells[x].ch }),
          }),
        },
      },
    } as unknown as Terminal
  }

  it('maps cell columns past CJK glyphs back to string offsets', () => {
    const term = mockTermWithCells('請看 https://x.com')
    // '請'=cells 0-1, '看'=cells 2-3, ' '=cell 4, 'h'=cell 5.
    expect(cellColToStrCol(term, 0, 0)).toBe(0)
    expect(cellColToStrCol(term, 0, 1)).toBe(0) // trailing half-cell → same char
    expect(cellColToStrCol(term, 0, 2)).toBe(1)
    expect(cellColToStrCol(term, 0, 5)).toBe(3) // 'h' of https
  })

  it('maps string offsets to the glyph-leading cell column', () => {
    const term = mockTermWithCells('請看 https://x.com')
    expect(strColToCellCol(term, 0, 0)).toBe(0)
    expect(strColToCellCol(term, 0, 1)).toBe(2)
    expect(strColToCellCol(term, 0, 3)).toBe(5)
  })

  it('accounts for multi-code-unit glyphs (emoji surrogate pairs)', () => {
    // '😀 https://x.com': 😀 = 2 string code units in 1 glyph cell (+spacer).
    // String: 😀=0-1, ' '=2, 'h'=3. Cells: 😀=0-1, ' '=2, 'h'=3.
    const term = mockTermWithCells('😀 https://x.com')
    expect(cellColToStrCol(term, 0, 0)).toBe(0)
    expect(cellColToStrCol(term, 0, 1)).toBe(0) // spacer half-cell → same glyph
    expect(cellColToStrCol(term, 0, 2)).toBe(2) // the space
    expect(cellColToStrCol(term, 0, 3)).toBe(3) // 'h' — width-only counting would say 2
    expect(strColToCellCol(term, 0, 1)).toBe(0) // second surrogate → emoji's cell
    expect(strColToCellCol(term, 0, 3)).toBe(3)
  })

  it('is the identity for pure-ASCII rows and getCell-less mocks', () => {
    const ascii = mockTermWithCells('plain ascii row')
    expect(cellColToStrCol(ascii, 0, 7)).toBe(7)
    expect(strColToCellCol(ascii, 0, 7)).toBe(7)
    const bare = mockTerm([{ text: 'no cells here' }])
    expect(cellColToStrCol(bare, 0, 4)).toBe(4)
    expect(strColToCellCol(bare, 0, 4)).toBe(4)
  })
})
