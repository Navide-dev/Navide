// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAIN_WINDOW_CSP, installMainWindowCsp } from './mainWindowCsp'

describe('main window CSP', () => {
  it('locks the exact policy string', () => {
    // A change here must be checked against every source the main window loads
    // (see the header comment in mainWindowCsp.ts) — never narrowed blindly.
    expect(MAIN_WINDOW_CSP).toBe(
      "default-src 'self'; " +
        "script-src 'self' blob:; " +
        "style-src 'self' 'unsafe-inline' https: http://127.0.0.1:* http://localhost:*; " +
        "img-src * 'self' data: blob: file: navide-plugin-frame:; " +
        "media-src * 'self' data: blob: file:; " +
        "font-src 'self' data: https: http://127.0.0.1:* http://localhost:*; " +
        "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* https: wss: data: blob:; " +
        "worker-src 'self' blob: data:; " +
        "frame-src * 'self' data: blob: about: file: navide-plugin-frame:; " +
        "object-src 'none'; " +
        "base-uri 'self'",
    )
  })

  it('keeps the backend, Marketplace icons, help screenshots and the voice worklet reachable', () => {
    const directives = new Map(
      MAIN_WINDOW_CSP.split('; ').map((d) => {
        const [name, ...values] = d.split(' ')
        return [name, values] as const
      }),
    )
    expect(directives.get('connect-src')).toEqual(expect.arrayContaining(['ws://127.0.0.1:*', 'http://127.0.0.1:*']))
    expect(directives.get('img-src')).toContain('*')
    expect(directives.get('script-src')).toContain('blob:')
    expect(directives.get('worker-src')).toContain('blob:')
    expect(directives.get('frame-src')).toEqual(expect.arrayContaining(['file:', 'navide-plugin-frame:']))
    expect(directives.get('style-src')).toContain("'unsafe-inline'")
    expect(directives.get('script-src')).not.toContain("'unsafe-eval'")
  })

  it('installs one meta tag in the document head', () => {
    document.head.innerHTML = ''
    installMainWindowCsp(document)
    installMainWindowCsp(document)
    const metas = document.head.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')
    expect(metas).toHaveLength(1)
    expect(metas[0].getAttribute('content')).toBe(MAIN_WINDOW_CSP)
  })

  it('is applied by the window dispatcher only for the main root', () => {
    // hostMount.ts is the production entry for every `?window=` app; the
    // policy must be installed on the App.vue branch and nowhere else, since
    // the Plans/Editor windows run a nonce'd script in an inheriting srcdoc.
    const src = readFileSync(resolve(__dirname, '../hostMount.ts'), 'utf8')
    expect(src.match(/installMainWindowCsp\(\)/g)).toHaveLength(1)
    expect(src).toMatch(/default:\s*\n\s*installMainWindowCsp\(\)\s*\n\s*return import\('\.\/App\.vue'\)/)
  })
})
