import { describe, it, expect, vi } from 'vitest'
import {
  preparePlanDocHtml,
  createSafeTodoClickHandler,
} from './planSecurity'

describe('planSecurity', () => {
  const VALID_NONCE = '0123456789abcdef0123456789abcdef'
  const TRUSTED_SCRIPT = 'console.log("trusted runtime");'

  describe('preparePlanDocHtml', () => {
    it('strips executable scripts while preserving application/json plan-meta data island', () => {
      const input = `<!doctype html>
<html>
<head>
<script type="application/json" id="plan-meta">{"name":"test"}</script>
<script>alert("evil inline");</script>
<script src="https://evil.com/xss.js"></script>
</head>
<body>
<h1>Plan</h1>
<script>window.parent.postMessage("forged", "*");</script>
</body>
</html>`

      const { html, nonce, documentToken } = preparePlanDocHtml(input, {
        buildTrustedRuntimeScript: ({ documentToken }) => `${TRUSTED_SCRIPT} /* token:${documentToken} */`,
        nonce: VALID_NONCE,
      })

      expect(nonce).toBe(VALID_NONCE)
      expect(documentToken).toMatch(/^[0-9a-f]{32}$/)
      expect(html).toContain('<script type="application/json" id="plan-meta">{"name":"test"}</script>')
      expect(html).not.toContain('evil inline')
      expect(html).not.toContain('https://evil.com/xss.js')
      expect(html).not.toContain('window.parent.postMessage("forged"')
      expect(html).toContain(
        `<script nonce="${VALID_NONCE}">${TRUSTED_SCRIPT} /* token:${documentToken} */</script>`,
      )
    })

    it('always generates distinct document tokens for multiple preparations of the same document', () => {
      const input = '<html><body>Hello</body></html>'
      const first = preparePlanDocHtml(input, {
        buildTrustedRuntimeScript: () => TRUSTED_SCRIPT,
      })
      const second = preparePlanDocHtml(input, {
        buildTrustedRuntimeScript: () => TRUSTED_SCRIPT,
      })
      expect(first.documentToken).toMatch(/^[0-9a-f]{32}$/)
      expect(second.documentToken).toMatch(/^[0-9a-f]{32}$/)
      expect(first.documentToken).not.toBe(second.documentToken)
    })

    it('generates a valid 32-character hexadecimal nonce and documentToken when none are provided', () => {
      const input = '<html><body>Hello</body></html>'
      let capturedToken = ''
      const { html, nonce, documentToken } = preparePlanDocHtml(input, {
        buildTrustedRuntimeScript: ({ documentToken }) => {
          capturedToken = documentToken
          return `${TRUSTED_SCRIPT} /* bound:${documentToken} */`
        },
      })

      expect(nonce).toMatch(/^[0-9a-f]{32}$/)
      expect(documentToken).toMatch(/^[0-9a-f]{32}$/)
      expect(capturedToken).toBe(documentToken)
      expect(html).toContain(
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-${nonce}'">`,
      )
      expect(html).toContain(`<script nonce="${nonce}">${TRUSTED_SCRIPT} /* bound:${documentToken} */</script>`)
    })

    it('keeps a leading doctype first so the preview does not fall into quirks mode', () => {
      const { html } = preparePlanDocHtml('<!DOCTYPE html>\n<html><body>Hi</body></html>', {
        buildTrustedRuntimeScript: () => TRUSTED_SCRIPT,
        nonce: VALID_NONCE,
      })

      expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
      expect(html.indexOf('Content-Security-Policy')).toBeGreaterThan(html.indexOf('<!DOCTYPE html>'))
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
      const { html } = preparePlanDocHtml(`${lead}<!doctype html><html><body><img src="data:," onerror="x()"></body></html>`, {
        buildTrustedRuntimeScript: () => TRUSTED_SCRIPT,
        nonce: VALID_NONCE,
      })

      const before = html.slice(0, html.indexOf('<meta http-equiv="Content-Security-Policy"'))
      expect(before).toMatch(/^[\t\n\f\r ]*(?:<!doctype[^>]*>)?$/i)
    })

    it('keeps a doctype led by HTML whitespace first', () => {
      const { html } = preparePlanDocHtml(' \t\r\n\f<!doctype html><html><body>Hi</body></html>', {
        buildTrustedRuntimeScript: () => TRUSTED_SCRIPT,
        nonce: VALID_NONCE,
      })

      expect(html.startsWith(' \t\r\n\f<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true)
    })

    it('rejects invalid nonces', () => {
      for (const invalid of [
        'bad',
        'abc123',
        '0123456789ABCDEF0123456789ABCDEF', // uppercase hex rejected
        '0123456789abcdef0123456789abcdef01', // 34 chars rejected
        '0123456789abcdef0123456789abcde!', // symbol rejected
      ]) {
        expect(() => {
          preparePlanDocHtml('<html></html>', {
            buildTrustedRuntimeScript: () => TRUSTED_SCRIPT,
            nonce: invalid,
          })
        }).toThrow('nonce must be a 32-character hexadecimal string')
      }
    })

    it('rejects trusted scripts containing closing script tag (tag-breaking defense)', () => {
      expect(() => {
        preparePlanDocHtml('<html></html>', {
          buildTrustedRuntimeScript: () => 'alert(1); </script><script>alert(2);',
        })
      }).toThrow('trustedRuntimeScript cannot contain closing script tag')

      expect(() => {
        preparePlanDocHtml('<html></html>', {
          buildTrustedRuntimeScript: () => 'var x = "</sCrIpT>";',
        })
      }).toThrow('trustedRuntimeScript cannot contain closing script tag')
    })

    it('inserts trusted runtime script before </body> when present, or at the end otherwise', () => {
      const withBody = '<html><head></head><body><p>Test</p></body></html>'
      const resWithBody = preparePlanDocHtml(withBody, {
        buildTrustedRuntimeScript: () => TRUSTED_SCRIPT,
        nonce: VALID_NONCE,
      })
      expect(resWithBody.html).toContain(`<script nonce="${VALID_NONCE}">${TRUSTED_SCRIPT}</script></body>`)

      const withoutBody = '<p>Bare fragment</p>'
      const resWithoutBody = preparePlanDocHtml(withoutBody, {
        buildTrustedRuntimeScript: () => TRUSTED_SCRIPT,
        nonce: VALID_NONCE,
      })
      expect(resWithoutBody.html.endsWith(`<script nonce="${VALID_NONCE}">${TRUSTED_SCRIPT}</script>`)).toBe(true)
    })
  })

  describe('createSafeTodoClickHandler', () => {
    const DEFAULT_TOKEN = '0123456789abcdef0123456789abcdef'

    it('regression: rejects MessageEvent when both event.source and getSourceWindow() are null', () => {
      const onTodoClicked = vi.fn()
      const handler = createSafeTodoClickHandler({
        getSourceWindow: () => null,
        getDocumentToken: () => DEFAULT_TOKEN,
        getValidTodoIds: () => ['todo-1'],
        onTodoClicked,
      })

      const event = {
        source: null,
        data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: DEFAULT_TOKEN },
      } as unknown as MessageEvent

      const handled = handler(event)
      expect(handled).toBe(false)
      expect(onTodoClicked).not.toHaveBeenCalled()
    })

    it('rejects MessageEvent with mismatched window source', () => {
      const frameWindow = {} as Window
      const attackerWindow = {} as Window
      const onTodoClicked = vi.fn()

      const handler = createSafeTodoClickHandler({
        getSourceWindow: () => frameWindow,
        getDocumentToken: () => DEFAULT_TOKEN,
        getValidTodoIds: () => ['todo-1'],
        onTodoClicked,
      })

      const handled = handler({
        source: attackerWindow,
        data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: DEFAULT_TOKEN },
      } as unknown as MessageEvent)

      expect(handled).toBe(false)
      expect(onTodoClicked).not.toHaveBeenCalled()
    })

    it('rejects MessageEvent with invalid or non-object payloads', () => {
      const frameWindow = {} as Window
      const onTodoClicked = vi.fn()
      const handler = createSafeTodoClickHandler({
        getSourceWindow: () => frameWindow,
        getDocumentToken: () => DEFAULT_TOKEN,
        getValidTodoIds: () => ['todo-1'],
        onTodoClicked,
      })

      expect(handler({ source: frameWindow, data: null } as unknown as MessageEvent)).toBe(false)
      expect(handler({ source: frameWindow, data: 'string' } as unknown as MessageEvent)).toBe(false)
      expect(
        handler({
          source: frameWindow,
          data: { type: 'other-type', documentToken: DEFAULT_TOKEN },
        } as unknown as MessageEvent),
      ).toBe(false)
      expect(onTodoClicked).not.toHaveBeenCalled()
    })

    it('rejects MessageEvent with unknown or invalid todoId', () => {
      const frameWindow = {} as Window
      const onTodoClicked = vi.fn()
      const handler = createSafeTodoClickHandler({
        getSourceWindow: () => frameWindow,
        getDocumentToken: () => DEFAULT_TOKEN,
        getValidTodoIds: () => ['todo-1', 'todo-2'],
        onTodoClicked,
      })

      // Non-string todoId
      expect(
        handler({
          source: frameWindow,
          data: { type: 'todo-clicked', todoId: 123, documentToken: DEFAULT_TOKEN },
        } as unknown as MessageEvent),
      ).toBe(false)

      // Unlisted todoId (forged)
      expect(
        handler({
          source: frameWindow,
          data: { type: 'todo-clicked', todoId: 'forged-todo-99', documentToken: DEFAULT_TOKEN },
        } as unknown as MessageEvent),
      ).toBe(false)

      expect(onTodoClicked).not.toHaveBeenCalled()
    })

    it('accepts valid MessageEvent and invokes onTodoClicked with alt flag', () => {
      const frameWindow = {} as Window
      const onTodoClicked = vi.fn()
      const handler = createSafeTodoClickHandler({
        getSourceWindow: () => frameWindow,
        getDocumentToken: () => DEFAULT_TOKEN,
        getValidTodoIds: () => ['todo-1', 'todo-2'],
        onTodoClicked,
      })

      const handled1 = handler({
        source: frameWindow,
        data: { type: 'todo-clicked', todoId: 'todo-1', documentToken: DEFAULT_TOKEN },
      } as unknown as MessageEvent)

      expect(handled1).toBe(true)
      expect(onTodoClicked).toHaveBeenCalledWith('todo-1', false)

      const handled2 = handler({
        source: frameWindow,
        data: { type: 'todo-clicked', todoId: 'todo-2', alt: true, documentToken: DEFAULT_TOKEN },
      } as unknown as MessageEvent)

      expect(handled2).toBe(true)
      expect(onTodoClicked).toHaveBeenCalledWith('todo-2', true)
    })

    describe('single documentToken protocol validation', () => {
      it('rejects matching todoId when documentToken field is missing', () => {
        const frameWindow = {} as Window
        const onTodoClicked = vi.fn()
        const handler = createSafeTodoClickHandler({
          getSourceWindow: () => frameWindow,
          getDocumentToken: () => 'token-current',
          getValidTodoIds: () => ['todo-shared'],
          onTodoClicked,
        })

        const handled = handler({
          source: frameWindow,
          data: { type: 'todo-clicked', todoId: 'todo-shared' },
        } as unknown as MessageEvent)

        expect(handled).toBe(false)
        expect(onTodoClicked).not.toHaveBeenCalled()
      })

      it('rejects matching todoId when alias "token" is sent instead of "documentToken"', () => {
        const frameWindow = {} as Window
        const onTodoClicked = vi.fn()
        const handler = createSafeTodoClickHandler({
          getSourceWindow: () => frameWindow,
          getDocumentToken: () => 'token-current',
          getValidTodoIds: () => ['todo-shared'],
          onTodoClicked,
        })

        const handled = handler({
          source: frameWindow,
          data: { type: 'todo-clicked', todoId: 'todo-shared', token: 'token-current' },
        } as unknown as MessageEvent)

        expect(handled).toBe(false)
        expect(onTodoClicked).not.toHaveBeenCalled()
      })

      it('rejects message when own property "token" is present even if valid documentToken is also provided', () => {
        const frameWindow = {} as Window
        const onTodoClicked = vi.fn()
        const handler = createSafeTodoClickHandler({
          getSourceWindow: () => frameWindow,
          getDocumentToken: () => 'token-current',
          getValidTodoIds: () => ['todo-shared'],
          onTodoClicked,
        })

        const handled = handler({
          source: frameWindow,
          data: {
            type: 'todo-clicked',
            todoId: 'todo-shared',
            documentToken: 'token-current',
            token: 'token-current',
          },
        } as unknown as MessageEvent)

        expect(handled).toBe(false)
        expect(onTodoClicked).not.toHaveBeenCalled()
      })

      it('rejects when documentToken is empty string', () => {
        const frameWindow = {} as Window
        const onTodoClicked = vi.fn()
        const handler = createSafeTodoClickHandler({
          getSourceWindow: () => frameWindow,
          getDocumentToken: () => '',
          getValidTodoIds: () => ['todo-shared'],
          onTodoClicked,
        })

        const handled = handler({
          source: frameWindow,
          data: { type: 'todo-clicked', todoId: 'todo-shared', documentToken: '' },
        } as unknown as MessageEvent)

        expect(handled).toBe(false)
        expect(onTodoClicked).not.toHaveBeenCalled()
      })

      it('rejects matching todoId when token belongs to previous document', () => {
        const frameWindow = {} as Window
        const onTodoClicked = vi.fn()
        let currentToken = 'token-previous'
        const handler = createSafeTodoClickHandler({
          getSourceWindow: () => frameWindow,
          getDocumentToken: () => currentToken,
          getValidTodoIds: () => ['todo-shared'],
          onTodoClicked,
        })

        // Transition to new document token
        currentToken = 'token-current'

        const handled = handler({
          source: frameWindow,
          data: { type: 'todo-clicked', todoId: 'todo-shared', documentToken: 'token-previous' },
        } as unknown as MessageEvent)

        expect(handled).toBe(false)
        expect(onTodoClicked).not.toHaveBeenCalled()
      })

      it('rejects when both source values are null even if documentToken and todoId match', () => {
        const onTodoClicked = vi.fn()
        const handler = createSafeTodoClickHandler({
          getSourceWindow: () => null,
          getDocumentToken: () => 'token-current',
          getValidTodoIds: () => ['todo-shared'],
          onTodoClicked,
        })

        const handled = handler({
          source: null,
          data: { type: 'todo-clicked', todoId: 'todo-shared', documentToken: 'token-current' },
        } as unknown as MessageEvent)

        expect(handled).toBe(false)
        expect(onTodoClicked).not.toHaveBeenCalled()
      })

      it('rejects a stale Plan A message after Plan B has already been applied when sharing same todo ID', () => {
        const windowProxy = {} as Window
        const onTodoClicked = vi.fn()
        let activeToken = 'plan-a-token'
        let activeTodoIds = ['shared-todo-1']

        const handler = createSafeTodoClickHandler({
          getSourceWindow: () => windowProxy,
          getDocumentToken: () => activeToken,
          getValidTodoIds: () => activeTodoIds,
          onTodoClicked,
        })

        // Plan A click event queued
        const stalePlanAEvent = {
          source: windowProxy,
          data: { type: 'todo-clicked', todoId: 'shared-todo-1', documentToken: 'plan-a-token' },
        } as unknown as MessageEvent

        // Plan B becomes active with new token and shares 'shared-todo-1'
        activeToken = 'plan-b-token'
        activeTodoIds = ['shared-todo-1']

        // Delayed message from Plan A arrives
        const handledA = handler(stalePlanAEvent)
        expect(handledA).toBe(false)
        expect(onTodoClicked).not.toHaveBeenCalled()

        // Valid message from Plan B arrives
        const validPlanBEvent = {
          source: windowProxy,
          data: { type: 'todo-clicked', todoId: 'shared-todo-1', documentToken: 'plan-b-token' },
        } as unknown as MessageEvent

        const handledB = handler(validPlanBEvent)
        expect(handledB).toBe(true)
        expect(onTodoClicked).toHaveBeenCalledTimes(1)
        expect(onTodoClicked).toHaveBeenCalledWith('shared-todo-1', false)
      })

      it('accepts exactly one message with current source, current documentToken, and current whitelist entry', () => {
        const windowProxy = {} as Window
        const onTodoClicked = vi.fn()
        const currentToken = 'current-document-token-value'
        const handler = createSafeTodoClickHandler({
          getSourceWindow: () => windowProxy,
          getDocumentToken: () => currentToken,
          getValidTodoIds: () => ['todo-allowed'],
          onTodoClicked,
        })

        const event = {
          source: windowProxy,
          data: { type: 'todo-clicked', todoId: 'todo-allowed', documentToken: currentToken },
        } as unknown as MessageEvent

        expect(handler(event)).toBe(true)
        expect(onTodoClicked).toHaveBeenCalledTimes(1)
        expect(onTodoClicked).toHaveBeenCalledWith('todo-allowed', false)
      })
    })
  })
})
