// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import DOMPurify from 'dompurify'
import { applyActivity, isSafeLinkHref, markdownToHtml, renderMarkdown, resetSanitizerProbe, RICH_TURNS_MAX, sanitizerWorks, type RichTurn } from '../richTurns'

const labels = { copy: 'Copy' }

describe('applyActivity', () => {
  it('pairs a user prompt with the turn_complete text that follows', () => {
    const turns: RichTurn[] = []
    expect(applyActivity(turns, { event_type: 'agent_active', detail: 'user', text: 'fix it' })).toBe(true)
    expect(applyActivity(turns, { event_type: 'agent_active', detail: 'tool_use', text: '' })).toBe(false)
    expect(applyActivity(turns, { event_type: 'turn_complete', detail: 'end_turn', text: '# Done' })).toBe(true)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ prompt: 'fix it', reply: '# Done' })
  })

  it('ignores text-less events and a repeated turn end', () => {
    const turns: RichTurn[] = []
    expect(applyActivity(turns, { event_type: 'turn_complete', detail: 'hook:stop', text: '' })).toBe(false)
    applyActivity(turns, { event_type: 'turn_complete', text: 'a' })
    expect(applyActivity(turns, { event_type: 'turn_complete', text: 'a' })).toBe(false)
    expect(turns).toHaveLength(1)
  })

  it('starts a new turn for a reply with no prompt before it', () => {
    const turns: RichTurn[] = []
    applyActivity(turns, { event_type: 'turn_complete', text: 'one' })
    applyActivity(turns, { event_type: 'turn_complete', text: 'two' })
    expect(turns.map((t) => t.reply)).toEqual(['one', 'two'])
  })

  it('keeps only the latest RICH_TURNS_MAX turns', () => {
    const turns: RichTurn[] = []
    for (let i = 0; i < RICH_TURNS_MAX + 5; i++) applyActivity(turns, { event_type: 'turn_complete', text: `r${i}` })
    expect(turns).toHaveLength(RICH_TURNS_MAX)
    expect(turns[0].reply).toBe('r5')
  })
})

// Structure is checked on markdownToHtml: happy-dom's DOM makes DOMPurify drop
// h1-h6, table, div, a and more, which a real Chromium keeps.
describe('markdownToHtml', () => {
  it('renders headings, emphasis, lists and tables', () => {
    const { html } = markdownToHtml('## Title\n\n**bold** text\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n', labels)
    expect(html).toContain('<h2')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toMatch(/<li>a\s*<\/li>/)
    expect(html).toContain('<table>')
    expect(html).toContain('<td>2</td>')
  })

  it('highlights a fenced code block and keeps its raw text for copying', () => {
    const src = 'const x = 1 < 2'
    const { html, codes } = markdownToHtml('```ts\n' + src + '\n```\n', labels)
    expect(html).toContain('class="hljs"')
    expect(html).toContain('hljs-keyword')
    expect(html).toContain('data-code="0"')
    expect(html).toContain('>Copy</button>')
    expect(codes).toEqual([src])
  })

  it('escapes code in an unknown language', () => {
    const { html } = markdownToHtml('```nope\n<b>x</b>\n```\n', labels)
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })

  it('shows raw HTML as text instead of passing it through', () => {
    const { html } = markdownToHtml('<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)>', labels)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('keeps only http(s) links and drops script schemes', () => {
    const scheme = ['java', 'script:'].join('')
    const { html } = markdownToHtml(`[ok](https://example.com) [bad](${scheme}alert(1)) [file](file:///etc/passwd)`, labels)
    expect(html).toContain('<a href="https://example.com"')
    expect(html).not.toContain(scheme)
    expect(html).not.toContain('file:')
    expect(html).toContain('bad')
  })

  it('turns an image into a link, loading nothing', () => {
    const { html } = markdownToHtml('![shot](https://example.com/a.png)', labels)
    expect(html).not.toContain('<img')
    expect(html).toContain('<a href="https://example.com/a.png"')
  })
})

describe('isSafeLinkHref', () => {
  it('accepts http(s) only', () => {
    expect(isSafeLinkHref('https://a.b/c')).toBe(true)
    expect(isSafeLinkHref('http://a.b')).toBe(true)
    expect(isSafeLinkHref('mailto:a@b.c')).toBe(false)
    expect(isSafeLinkHref('data:text/html,x')).toBe(false)
    expect(isSafeLinkHref('/relative')).toBe(false)
  })
})

describe('renderMarkdown', () => {
  afterEach(() => resetSanitizerProbe())

  it('fails closed to escaped plain text when the sanitizer passes markup through', () => {
    resetSanitizerProbe()
    const spy = vi.spyOn(DOMPurify, 'sanitize').mockImplementation(((html: string) => html) as never)
    try {
      expect(sanitizerWorks()).toBe(false)
      const out = renderMarkdown('# t\n\n<script>x()</script>', labels)
      expect(out.html).not.toContain('<script')
      expect(out.html).toContain('&lt;script&gt;')
      expect(out.html.startsWith('<p class="rich-plain">')).toBe(true)
      expect(out.codes).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('sanitizes when the sanitizer works', () => {
    resetSanitizerProbe()
    const spy = vi.spyOn(DOMPurify, 'sanitize').mockImplementation(((html: string) =>
      html === '<p onclick="x()">a</p><script>x()</script>' ? '<p>a</p>' : `[clean]${html}`) as never)
    try {
      expect(sanitizerWorks()).toBe(true)
      expect(renderMarkdown('**b**', labels).html).toBe('[clean]<p><strong>b</strong></p>\n')
      renderMarkdown('_c_', labels)
      // One probe call, then one sanitize per render.
      expect(spy).toHaveBeenCalledTimes(3)
    } finally {
      spy.mockRestore()
    }
  })
})
