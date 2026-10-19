// Unit tests for the Phase B render-time interactivity layer: outline
// extraction, srcdoc assembly (script stripping + CSP + runtime injection,
// including escaping safety for document-controlled anchor data), and the
// host-side postMessage validation — non-whitelisted events are ignored and
// malformed payloads never reach the write hooks.
// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { Window as HappyWindow } from 'happy-dom'
import {
  MAX_ANCHOR_LENGTH,
  MAX_OPEN_CODE_LINE,
  MAX_OPEN_CODE_PATH_LENGTH,
  MAX_SECTION_HTML_LENGTH,
  buildPlanRuntimeScript,
  createPlanRuntimeMessageHandler,
  extractPlanOutline,
  preparePlanDocHtml,
  sanitizePlanSectionHtml,
  type PlanRuntimeConfig,
  type PlanRuntimeHostHooks,
  type PlanRuntimeInit,
} from '../planRuntime'
import { replaceSectionBody } from '../../composables/usePlanHtml'

// Labels required by PlanRuntimeConfig for the inline edit/delete affordances.
const LABELS = { editLabel: 'Edit', deleteLabel: 'Delete', saveLabel: 'Save', cancelLabel: 'Cancel' }
function initOf(over: Partial<PlanRuntimeInit> = {}): PlanRuntimeInit {
  return {
    anchors: {},
    commentLabel: 'Comment',
    scrollY: 0,
    documentToken: '0123456789abcdef0123456789abcdef',
    ...LABELS,
    ...over,
  }
}
function configOf(over: Partial<PlanRuntimeConfig> = {}): PlanRuntimeConfig {
  return { anchors: {}, commentLabel: 'Comment', scrollY: 0, ...LABELS, ...over }
}

const DOC = [
  '<!doctype html><html><head><title>t</title>',
  '<script type="application/json" id="plan-meta">{"schemaVersion":1}</scr' + 'ipt>',
  '</head><body>',
  '<section><h2>Goals</h2><p>text</p></section>',
  '<section><h2>Phases</h2>',
  '<div class="phase"><div class="phase-head">Phase A · Alpha<span class="size">S</span></div></div>',
  '<div class="phase"><div class="phase-head">Phase B · Beta</div></div>',
  '</section>',
  '<section><h2>  Spaced   Title </h2></section>',
  '</body></html>',
].join('\n')

describe('extractPlanOutline', () => {
  it('extracts h2 and phase-head anchors in document order, whitespace-collapsed', () => {
    expect(extractPlanOutline(DOC)).toEqual([
      'Goals',
      'Phases',
      'Phase A · Alpha',
      'Phase B · Beta',
      'Spaced Title',
    ])
  })

  it('deduplicates repeated anchors and skips empty headings', () => {
    const html = '<h2>Goals</h2><h2>Goals</h2><h2></h2><h2><code>x</code></h2>'
    expect(extractPlanOutline(html)).toEqual(['Goals'])
  })

  it('returns an empty outline for a document without headings', () => {
    expect(extractPlanOutline('<html><body><h1>only h1</h1></body></html>')).toEqual([])
  })
})

describe('buildPlanRuntimeScript', () => {
  it('embeds the init data with "<" escaped so anchors cannot break out of the script', () => {
    const script = buildPlanRuntimeScript(
      initOf({ anchors: { '</script><img src=x onerror=alert(1)>': 2 }, commentLabel: '<b>Comment</b>' }),
    )
    expect(script).not.toContain('</script')
    expect(script).toContain('\\u003c')
  })

  it('embeds the scroll offset and comment label', () => {
    const script = buildPlanRuntimeScript(initOf({ scrollY: 420 }))
    expect(script).toContain('"scrollY":420')
    expect(script).toContain('"commentLabel":"Comment"')
  })

  it('binds file:line references in code elements to the open-code event', () => {
    const script = buildPlanRuntimeScript(initOf())
    expect(script).toContain("querySelectorAll('code')")
    expect(script).toContain("type: 'open-code'")
    // The embedded reference regex survives template-literal escaping intact.
    expect(script).toContain('CODE_REF_RE')
    expect(script).toContain('\\d{1,7}')
  })

  it('injects layout overrides so wide tables wrap and the document uses the frame width', () => {
    const script = buildPlanRuntimeScript(initOf())
    expect(script).toContain('.tablewrap td,.tablewrap td code{overflow-wrap:anywhere}')
    expect(script).toContain('.wrap{max-width:1180px}')
    expect(script).toContain('.wrap td ul,.wrap td p{max-width:none}')
  })
})

describe('preparePlanDocHtml', () => {
  const config = configOf()

  it('strips executable scripts but keeps the JSON plan-meta island', () => {
    const html = [
      '<html><head>',
      '<script type="application/json" id="plan-meta">{"a":1}</scr' + 'ipt>',
      '<script>alert(1)</scr' + 'ipt>',
      '<script src="https://evil.example/x.js"></scr' + 'ipt>',
      '</head><body></body></html>',
    ].join('')
    const { html: out, documentToken } = preparePlanDocHtml(html, config)
    expect(out).toContain('id="plan-meta"')
    expect(out).not.toContain('alert(1)')
    expect(out).not.toContain('evil.example')
    expect(documentToken).toMatch(/^[0-9a-f]{32}$/)
  })

  it('puts a nonce-restricted CSP meta right after the doctype and the runtime before </body>', () => {
    const nonce = '0123456789abcdef0123456789abcdef'
    const { html: out } = preparePlanDocHtml(DOC, config, { nonce })
    // The doctype stays the first token so the frame renders in standards mode.
    expect(out.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(out).toContain(`script-src 'nonce-${nonce}'`)
    expect(out).toContain("default-src 'none'")
    const runtimeAt = out.indexOf(`<script nonce="${nonce}">`)
    expect(runtimeAt).toBeGreaterThan(-1)
    expect(runtimeAt).toBeLessThan(out.indexOf('</body>'))
    // The plan-meta data island survives assembly.
    expect(out).toContain('id="plan-meta"')
  })

  // Only HTML whitespace and a doctype may precede the CSP meta: any other
  // character starts <body>, and a CSP meta outside <head> is ignored.
  it.each([
    ['NO-BREAK SPACE', ' '],
    ['LINE TABULATION', '\u000b'],
    ['LINE SEPARATOR', ' '],
    ['PARAGRAPH SEPARATOR', ' '],
    ['OGHAM SPACE MARK', ' '],
    ['IDEOGRAPHIC SPACE', '　'],
  ])('keeps the CSP ahead of body content when a doctype is preceded by %s', (_name, lead) => {
    const nonce = '0123456789abcdef0123456789abcdef'
    const { html: out } = preparePlanDocHtml(`${lead}${DOC}`, config, { nonce })
    const before = out.slice(0, out.indexOf('<meta http-equiv="Content-Security-Policy"'))
    expect(before).toMatch(/^[\t\n\f\r ]*(?:<!doctype[^>]*>)?$/i)
  })

  it('keeps a doctype led by HTML whitespace first', () => {
    const nonce = '0123456789abcdef0123456789abcdef'
    const { html: out } = preparePlanDocHtml(` \t\r\n\f${DOC}`, config, { nonce })
    expect(out.startsWith(' \t\r\n\f<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true)
  })

  const prepare = (content: string): string =>
    preparePlanDocHtml(content, config, { nonce: '0123456789abcdef0123456789abcdef' }).html

  // A meta refresh navigates the frame to a page the CSP above never reaches.
  it.each([
    ['double-quoted', '<meta http-equiv="refresh" content="0;url=https://attacker.invalid/">'],
    ['in upper case, unquoted', '<META HTTP-EQUIV=REFRESH CONTENT="0;url=https://attacker.invalid/">'],
    ['single-quoted with padding', "<meta http-equiv=' Refresh ' content='0;url=https://attacker.invalid/'>"],
    ['with spaces around =', '<meta http-equiv = "refresh" content="0;url=https://attacker.invalid/">'],
    ['slash-separated', '<meta/http-equiv=refresh/content="0;url=https://attacker.invalid/">'],
    ['after a value holding >', '<meta content="0;url=https://attacker.invalid/?a>b" http-equiv="refresh">'],
    ['as a character reference', '<meta http-equiv="&#x72;efresh" content="0;url=https://attacker.invalid/">'],
  ])('drops a meta refresh written %s', (_name, meta) => {
    const html = prepare(`<!doctype html><html><head>${meta}</head><body>Hi</body></html>`)
    expect(html).not.toContain('attacker.invalid')
    expect(html).toContain('<body>Hi')
  })

  it('keeps every other meta as written', () => {
    const metas = '<meta charset="utf-8"><meta name="refresh" content="x"><meta http-equiv="Content-Type" content="text/html">'
    expect(prepare(`<!doctype html><html><head>${metas}</head><body>Hi</body></html>`)).toContain(metas)
  })

  // `=` where an attribute name belongs starts that name, not a value, so a
  // quote after it opens nothing and the tag ends at the next `>`.
  it.each([
    ['a leading =', "<meta =' >"],
    ['= right after a quoted value', '<meta a="x"=" >'],
    ['an unterminated quoted value', '<meta a="x >'],
  ])('still drops a meta refresh after a tag with %s', (_name, tag) => {
    const html = prepare(`<head>${tag}<meta http-equiv=refresh content=0;url=https://attacker.invalid/r></head>`)
    expect(html).not.toContain('attacker.invalid')
  })

  // A `<meta` that is only text (a comment, an attribute value, a textarea)
  // may never close its quote; everything after it is still the document.
  it.each([
    ['a comment', '<!-- <meta x=" --><p>after</p>'],
    ['an attribute value', '<p title=\'<meta x="\'>after</p>'],
    ['a textarea', '<textarea><meta a="</textarea><p>after</p>'],
  ])('keeps what follows a never-ending <meta in %s', (_name, body) => {
    const html = prepare(`<body>${body}<meta http-equiv=refresh content=0;url=https://attacker.invalid/r></body>`)
    expect(html).toContain(body)
    expect(html).not.toContain('attacker.invalid')
  })

  // The browser reads `<me<meta>` as one unknown tag, so what surrounds a
  // removed meta refresh never becomes a meta refresh or a script of its own.
  it('leaves a bare meta where a refresh was, so its neighbours cannot join', () => {
    expect(prepare('<p>a</p><me<meta http-equiv=refresh>ta http-equiv=refresh>')).toContain('<p>a</p><me<meta>ta http-equiv=refresh>')
    expect(prepare('<p>a</p><scr<meta http-equiv=refresh>ipt>x()</script>')).toContain('<p>a</p><scr<meta>ipt>x()</script>')
  })

  // The JSON exemption is for the type attribute itself, not a name ending in it.
  it.each([
    ['data-type', '<script data-type="application/json">x()</script>'],
    ['a:type', '<script a:type="application/json">x()</script>'],
  ])('strips a script whose %s merely says application/json', (_name, script) => {
    expect(prepare(`<p>a</p>${script}`)).not.toContain('x()')
  })

  it('appends the runtime and prepends the CSP when head/body tags are missing', () => {
    const nonce = '0123456789abcdef0123456789abcdef'
    const { html: out } = preparePlanDocHtml('<p>bare fragment</p>', config, { nonce })
    expect(out.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(out).toContain(`<script nonce="${nonce}">`)
  })

  it('places the CSP before pre-head content, including an unclosed script the strip regex cannot consume', () => {
    const nonce = '0123456789abcdef0123456789abcdef'
    const html = '<script>window.leak=1<!doctype html><html><head><title>t</title></head><body></body></html>'
    const { html: out } = preparePlanDocHtml(html, config, { nonce })
    // The unclosed script survives stripping, but the CSP still precedes it.
    expect(out.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(out.indexOf('<meta http-equiv="Content-Security-Policy"')).toBeLessThan(
      out.indexOf('window.leak'),
    )
  })

  it('generates a fresh nonce and documentToken per render by default', () => {
    const a = preparePlanDocHtml(DOC, config)
    const b = preparePlanDocHtml(DOC, config)
    const nonceOf = (html: string): string => /script-src 'nonce-([0-9a-f]+)'/.exec(html)![1]
    expect(nonceOf(a.html)).toHaveLength(32)
    expect(nonceOf(a.html)).not.toBe(nonceOf(b.html))
    expect(a.documentToken).toMatch(/^[0-9a-f]{32}$/)
    expect(b.documentToken).toMatch(/^[0-9a-f]{32}$/)
    expect(a.documentToken).not.toBe(b.documentToken)
  })
})

describe('createPlanRuntimeMessageHandler', () => {
  function harness(overrides: Partial<PlanRuntimeHostHooks> = {}) {
    const frameWindow = {} as Window
    let activeToken = '0123456789abcdef0123456789abcdef'
    const hooks: PlanRuntimeHostHooks = {
      getSourceWindow: () => frameWindow,
      getDocumentToken: () => activeToken,
      getTodoIds: () => ['phase-a', 'phase-b'],
      getAnchors: () => ['Goals', 'Risks'],
      onTodoClicked: vi.fn(),
      onSectionComment: vi.fn(),
      onScrollPos: vi.fn(),
      onOpenCode: vi.fn(),
      onSectionEdit: vi.fn(),
      onSectionDelete: vi.fn(),
      onSectionEditing: vi.fn(),
      ...overrides,
    }
    const handler = createPlanRuntimeMessageHandler(hooks)
    const send = (data: unknown, source: unknown = frameWindow): void => {
      let payload = data
      if (
        typeof data === 'object' &&
        data !== null &&
        !('documentToken' in data) &&
        !('token' in data)
      ) {
        payload = { ...(data as Record<string, unknown>), documentToken: activeToken }
      }
      handler({ data: payload, source } as MessageEvent)
    }
    const sendRaw = (data: unknown, source: unknown = frameWindow): void => {
      handler({ data, source } as MessageEvent)
    }
    return {
      hooks,
      send,
      sendRaw,
      frameWindow,
      setToken: (t: string) => {
        activeToken = t
      },
    }
  }

  it('ignores messages from any other source window', () => {
    const { hooks, send } = harness()
    send({ type: 'todo-clicked', todoId: 'phase-a', alt: false }, {} as Window)
    send({ type: 'todo-clicked', todoId: 'phase-a', alt: false }, null)
    expect(hooks.onTodoClicked).not.toHaveBeenCalled()
  })

  it('ignores everything when no frame window is available', () => {
    const { hooks, send } = harness({ getSourceWindow: () => null })
    send({ type: 'todo-clicked', todoId: 'phase-a', alt: false }, null)
    expect(hooks.onTodoClicked).not.toHaveBeenCalled()
  })

  it('ignores non-whitelisted event types and non-object payloads', () => {
    const { hooks, send } = harness()
    send({ type: 'eval', code: 'alert(1)' })
    send({ type: 'approve-plan' })
    send('todo-clicked')
    send(null)
    send(42)
    expect(hooks.onTodoClicked).not.toHaveBeenCalled()
    expect(hooks.onSectionComment).not.toHaveBeenCalled()
    expect(hooks.onScrollPos).not.toHaveBeenCalled()
  })

  it('accepts a valid todo-clicked and normalizes alt to a boolean', () => {
    const { hooks, send } = harness()
    send({ type: 'todo-clicked', todoId: 'phase-b', alt: true })
    send({ type: 'todo-clicked', todoId: 'phase-a', alt: 'yes' })
    expect(hooks.onTodoClicked).toHaveBeenNthCalledWith(1, 'phase-b', true)
    expect(hooks.onTodoClicked).toHaveBeenNthCalledWith(2, 'phase-a', false)
  })

  it('rejects todo-clicked with an unknown or non-string todoId', () => {
    const { hooks, send } = harness()
    send({ type: 'todo-clicked', todoId: 'phase-z', alt: false })
    send({ type: 'todo-clicked', todoId: 7, alt: false })
    send({ type: 'todo-clicked' })
    expect(hooks.onTodoClicked).not.toHaveBeenCalled()
  })

  it('accepts a valid section-comment anchor', () => {
    const { hooks, send } = harness()
    send({ type: 'section-comment', anchor: 'Risks' })
    expect(hooks.onSectionComment).toHaveBeenCalledWith('Risks')
  })

  it('rejects section-comment with unknown, non-string, empty, or oversized anchors', () => {
    const { hooks, send } = harness()
    send({ type: 'section-comment', anchor: 'Not A Section' })
    send({ type: 'section-comment', anchor: 123 })
    send({ type: 'section-comment', anchor: '' })
    send({ type: 'section-comment', anchor: 'x'.repeat(MAX_ANCHOR_LENGTH + 1) })
    expect(hooks.onSectionComment).not.toHaveBeenCalled()
  })

  it('accepts a finite non-negative scroll-pos and rejects everything else', () => {
    const { hooks, send } = harness()
    send({ type: 'scroll-pos', y: 240 })
    send({ type: 'scroll-pos', y: -1 })
    send({ type: 'scroll-pos', y: Number.NaN })
    send({ type: 'scroll-pos', y: Number.POSITIVE_INFINITY })
    send({ type: 'scroll-pos', y: '240' })
    expect(hooks.onScrollPos).toHaveBeenCalledTimes(1)
    expect(hooks.onScrollPos).toHaveBeenCalledWith(240)
  })

  it('accepts a valid open-code with a workspace-relative path and line', () => {
    const { hooks, send } = harness()
    send({ type: 'open-code', path: 'src/renderer/src/App.vue', line: 42 })
    send({ type: 'open-code', path: 'backend/app.py', line: MAX_OPEN_CODE_LINE })
    expect(hooks.onOpenCode).toHaveBeenNthCalledWith(1, 'src/renderer/src/App.vue', 42)
    expect(hooks.onOpenCode).toHaveBeenNthCalledWith(2, 'backend/app.py', MAX_OPEN_CODE_LINE)
  })

  it('rejects open-code paths that are absolute, traversing, or otherwise unsafe', () => {
    const { hooks, send } = harness()
    send({ type: 'open-code', path: '/etc/passwd', line: 1 })
    send({ type: 'open-code', path: '../secrets.env', line: 1 })
    send({ type: 'open-code', path: 'src/../../outside.ts', line: 1 })
    send({ type: 'open-code', path: 'src\\windows\\file.ts', line: 1 })
    send({ type: 'open-code', path: 'C:/drive/file.ts', line: 1 })
    send({ type: 'open-code', path: '', line: 1 })
    send({ type: 'open-code', path: `${'a'.repeat(MAX_OPEN_CODE_PATH_LENGTH)}/x.ts`, line: 1 })
    send({ type: 'open-code', path: 42, line: 1 })
    send({ type: 'open-code', line: 1 })
    expect(hooks.onOpenCode).not.toHaveBeenCalled()
  })

  it('rejects open-code lines that are zero, negative, fractional, oversized, or non-numeric', () => {
    const { hooks, send } = harness()
    send({ type: 'open-code', path: 'src/app.ts', line: 0 })
    send({ type: 'open-code', path: 'src/app.ts', line: -5 })
    send({ type: 'open-code', path: 'src/app.ts', line: 1.5 })
    send({ type: 'open-code', path: 'src/app.ts', line: MAX_OPEN_CODE_LINE + 1 })
    send({ type: 'open-code', path: 'src/app.ts', line: '42' })
    send({ type: 'open-code', path: 'src/app.ts' })
    expect(hooks.onOpenCode).not.toHaveBeenCalled()
  })

  it('accepts a valid section-edit with a known anchor and bounded html', () => {
    const { hooks, send } = harness()
    send({ type: 'section-edit', anchor: 'Goals', html: '<p>new</p>' })
    expect(hooks.onSectionEdit).toHaveBeenCalledWith('Goals', '<p>new</p>')
  })

  it('rejects section-edit with unknown anchor, bad anchor, or oversized/non-string html', () => {
    const { hooks, send } = harness()
    send({ type: 'section-edit', anchor: 'Nope', html: '<p>x</p>' })
    send({ type: 'section-edit', anchor: 42, html: '<p>x</p>' })
    send({ type: 'section-edit', anchor: '', html: '<p>x</p>' })
    send({ type: 'section-edit', anchor: 'Goals', html: 42 })
    send({ type: 'section-edit', anchor: 'Goals', html: 'x'.repeat(MAX_SECTION_HTML_LENGTH + 1) })
    send({ type: 'section-edit', anchor: 'Goals' })
    expect(hooks.onSectionEdit).not.toHaveBeenCalled()
  })

  it('accepts a valid section-delete and rejects unknown/bad anchors', () => {
    const { hooks, send } = harness()
    send({ type: 'section-delete', anchor: 'Risks' })
    send({ type: 'section-delete', anchor: 'Unknown' })
    send({ type: 'section-delete', anchor: 99 })
    send({ type: 'section-delete', anchor: '' })
    expect(hooks.onSectionDelete).toHaveBeenCalledTimes(1)
    expect(hooks.onSectionDelete).toHaveBeenCalledWith('Risks')
  })

  it('notifies when inline section editing starts and stops', () => {
    const { hooks, send } = harness()
    send({ type: 'section-editing', active: true })
    send({ type: 'section-editing', active: false })
    send({ type: 'section-editing', active: 'not-a-bool' })
    expect(hooks.onSectionEditing).toHaveBeenNthCalledWith(1, true)
    expect(hooks.onSectionEditing).toHaveBeenNthCalledWith(2, false)
    expect(hooks.onSectionEditing).toHaveBeenCalledTimes(2)
  })

  describe('document token generation authorization', () => {
    it('authorizes privileged and state messages only when carrying the current documentToken', () => {
      let currentToken = 'token-generation-1'
      const { hooks, sendRaw } = harness({
        getDocumentToken: () => currentToken,
      })

      // Missing documentToken rejected across all messages
      sendRaw({ type: 'todo-clicked', todoId: 'phase-a', alt: false })
      sendRaw({ type: 'section-comment', anchor: 'Risks' })
      sendRaw({ type: 'section-edit', anchor: 'Risks', html: '<p>edited</p>' })
      sendRaw({ type: 'section-delete', anchor: 'Risks' })
      sendRaw({ type: 'open-code', path: 'src/app.ts', line: 10 })
      sendRaw({ type: 'scroll-pos', y: 150 })
      sendRaw({ type: 'section-editing', active: true })

      expect(hooks.onTodoClicked).not.toHaveBeenCalled()
      expect(hooks.onSectionComment).not.toHaveBeenCalled()
      expect(hooks.onSectionEdit).not.toHaveBeenCalled()
      expect(hooks.onSectionDelete).not.toHaveBeenCalled()
      expect(hooks.onOpenCode).not.toHaveBeenCalled()
      expect(hooks.onScrollPos).not.toHaveBeenCalled()
      expect(hooks.onSectionEditing).not.toHaveBeenCalled()

      // Rejected alias 'token'
      sendRaw({ type: 'section-comment', anchor: 'Risks', token: currentToken })
      sendRaw({ type: 'todo-clicked', todoId: 'phase-a', alt: false, token: currentToken })
      expect(hooks.onSectionComment).not.toHaveBeenCalled()
      expect(hooks.onTodoClicked).not.toHaveBeenCalled()

      // Stale token from prior generation rejected
      sendRaw({ type: 'section-comment', anchor: 'Risks', documentToken: 'stale-token' })
      sendRaw({ type: 'section-edit', anchor: 'Risks', html: '<p>edited</p>', documentToken: 'stale-token' })
      sendRaw({ type: 'section-delete', anchor: 'Risks', documentToken: 'stale-token' })
      sendRaw({ type: 'open-code', path: 'src/app.ts', line: 10, documentToken: 'stale-token' })
      expect(hooks.onSectionComment).not.toHaveBeenCalled()
      expect(hooks.onSectionEdit).not.toHaveBeenCalled()
      expect(hooks.onSectionDelete).not.toHaveBeenCalled()
      expect(hooks.onOpenCode).not.toHaveBeenCalled()

      // Valid current documentToken accepted
      sendRaw({ type: 'section-comment', anchor: 'Risks', documentToken: currentToken })
      expect(hooks.onSectionComment).toHaveBeenCalledWith('Risks')

      sendRaw({ type: 'section-edit', anchor: 'Risks', html: '<p>edited</p>', documentToken: currentToken })
      expect(hooks.onSectionEdit).toHaveBeenCalledWith('Risks', '<p>edited</p>')

      sendRaw({ type: 'section-delete', anchor: 'Risks', documentToken: currentToken })
      expect(hooks.onSectionDelete).toHaveBeenCalledWith('Risks')

      sendRaw({ type: 'open-code', path: 'src/app.ts', line: 10, documentToken: currentToken })
      expect(hooks.onOpenCode).toHaveBeenCalledWith('src/app.ts', 10)

      sendRaw({ type: 'todo-clicked', todoId: 'phase-a', alt: false, documentToken: currentToken })
      expect(hooks.onTodoClicked).toHaveBeenCalledWith('phase-a', false)

      // Rotate token
      currentToken = 'token-generation-2'
      sendRaw({ type: 'section-comment', anchor: 'Risks', documentToken: 'token-generation-1' })
      expect(hooks.onSectionComment).toHaveBeenCalledTimes(1) // Still 1, 2nd call rejected
    })
  })
})

describe('sanitizePlanSectionHtml', () => {
  it('keeps whitelisted tags and safe href, dropping other attributes', () => {
    const out = sanitizePlanSectionHtml(
      '<p class="x" onclick="alert(1)">hi <strong>bold</strong> <a href="https://a.example" target="_blank">l</a></p>',
    )
    expect(out).toContain('<p>hi <strong>bold</strong>')
    expect(out).toContain('<a href="https://a.example">l</a>')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('class=')
    expect(out).not.toContain('target=')
  })

  it('strips script/style entirely and unwraps non-whitelisted tags keeping their text', () => {
    const out = sanitizePlanSectionHtml(
      '<div><script>alert(1)</scr' + 'ipt><style>*{}</style><span>kept</span><p>para</p></div>',
    )
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
    expect(out).not.toContain('<style')
    expect(out).not.toContain('<div')
    expect(out).not.toContain('<span')
    expect(out).toContain('kept')
    expect(out).toContain('<p>para</p>')
  })

  it('drops javascript:/data:/vbscript: hrefs on anchors', () => {
    expect(sanitizePlanSectionHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>')
    expect(sanitizePlanSectionHtml('<a href="data:text/html,x">x</a>')).toBe('<a>x</a>')
    expect(sanitizePlanSectionHtml('<a href="vbscript:x">x</a>')).toBe('<a>x</a>')
  })

  it('drops hrefs that smuggle a dangerous scheme past embedded tab/control chars', () => {
    // Browsers strip embedded tab and leading control chars before resolving the
    // scheme, so these still run as javascript: — the href must be dropped.
    const tab = String.fromCharCode(9)
    expect(sanitizePlanSectionHtml(`<a href="java${tab}script:alert(1)">x</a>`)).toBe('<a>x</a>')
    const ctrl = String.fromCharCode(1)
    expect(sanitizePlanSectionHtml(`<a href="${ctrl}javascript:alert(1)">x</a>`)).toBe('<a>x</a>')
    // A benign https href with no control chars is not over-stripped.
    expect(sanitizePlanSectionHtml('<a href="https://example.com">x</a>')).toBe(
      '<a href="https://example.com">x</a>',
    )
  })

  it('preserves whitelisted table and list structure', () => {
    const out = sanitizePlanSectionHtml(
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>C</td></tr></tbody></table><ul><li>a</li></ul>',
    )
    expect(out).toContain('<table>')
    expect(out).toContain('<th>H</th>')
    expect(out).toContain('<td>C</td>')
    expect(out).toContain('<li>a</li>')
  })
})

// Regression: an <h2> with no <section> ancestor is editable like any other, so
// the preview must serialize only that heading's own sibling prose and the host
// must replace exactly that range — never the heading text, a sibling of the
// heading's container, or the container's own closing tag.
describe('section-less heading edits round-trip', () => {
  const windows: HappyWindow[] = []
  afterEach(async () => {
    await Promise.all(windows.splice(0).map((w) => w.happyDOM.abort()))
  })

  // Drives the real runtime in happy-dom (hover the region, click Edit, rewrite
  // the first paragraph, click Save) and feeds the real postMessage payload to
  // the real host-side writer.
  function editFirstHeading(source: string, anchor: string, rewritten: string) {
    const window = new HappyWindow()
    windows.push(window)
    window.document.body.innerHTML = source
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    window.eval(buildPlanRuntimeScript(initOf()))
    const heading = window.document.querySelector('h2')!
    const region = heading.closest('section') ?? heading.closest('.plan-rt-section') ?? heading
    region.dispatchEvent(new window.MouseEvent('mouseenter'))
    const button = (label: string) =>
      [...window.document.querySelectorAll('.plan-rt-secbar button')].find(
        (node) => node.textContent === label,
      )!
    button('Edit').dispatchEvent(new window.MouseEvent('click'))
    const editable = window.document.querySelector('[contenteditable="true"]')!
    // The editable region is the heading's prose body, never the bare heading.
    expect(editable.querySelector('p')).not.toBeNull()
    editable.querySelector('p')!.textContent = rewritten
    button('Save').dispatchEvent(new window.MouseEvent('click'))
    const edit = postMessage.mock.calls
      .map(([message]) => message)
      .find(
        (message): message is { type: 'section-edit'; anchor: string; html: string } =>
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === 'section-edit',
      )
    if (!edit) throw new Error('Runtime did not emit a section edit')
    return { edit, written: replaceSectionBody(source, anchor, edit.html) }
  }

  it('replaces only the prose of a heading that has no section ancestor', () => {
    const body = '<p>Original risk</p><h3>Mitigation</h3><p>Keep this detail</p>'
    const source = `<h1>Plan</h1><h2>Risks</h2>${body}<h2>Validation</h2><p>Keep validation</p>`
    const { edit, written } = editFirstHeading(source, 'Risks', 'Updated risk')
    expect(edit.html).toBe('<p>Updated risk</p><h3>Mitigation</h3><p>Keep this detail</p>')
    expect(written).toBe(source.replace(body, `\n${edit.html}\n`))
  })

  it.each([
    [
      'an aside followed by siblings',
      '<aside><h2>Note</h2><p>n</p></aside><p>after</p><h2>Next</h2><p>x</p>',
      'Note',
      '<p>n</p>',
    ],
    [
      'a table cell',
      '<table><tr><td><h2>Cell</h2><p>c</p></td><td>other</td></tr></table>',
      'Cell',
      '<p>c</p>',
    ],
    [
      'a list item',
      '<ul><li><h2>Alpha</h2><p>a</p></li><li><h2>Beta</h2><p>b</p></li></ul>',
      'Alpha',
      '<p>a</p>',
    ],
    ['a header element', '<header><h2>Subtitle</h2><p>meta</p></header>', 'Subtitle', '<p>meta</p>'],
  ])('clamps the edited body to %s', (_case, source, anchor, body) => {
    const { edit, written } = editFirstHeading(source, anchor, 'Rewritten')
    expect(edit.html).toBe('<p>Rewritten</p>')
    expect(written).toBe(source.replace(body, `\n${edit.html}\n`))
  })
})
