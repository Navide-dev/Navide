import { describe, expect, it, vi } from 'vitest'
import { join, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'

vi.mock('electron', () => ({ BrowserWindow: vi.fn(), session: { fromPartition: vi.fn() } }))
// resolve(): on Windows '/data' gains the current drive, like every path the backend sends.
vi.mock('./backend', async () => {
  const { resolve: resolvePath } = await import('node:path')
  return { backendDataDir: () => resolvePath('/data') }
})

import {
  PDF_RENDER_RESULT,
  PRINT_OPTIONS,
  handlePdfRenderRequest,
  parsePdfRenderRequest,
  renderPdf,
  type PdfRenderDeps,
} from './channel-pdf'

const ROOT = resolve('/data', 'channels-pdf')
const WORK = join(ROOT, '0123456789abcdef')
const HTML = join(WORK, 'print.html')
const PDF = join(WORK, 'out.pdf')

function request(overrides: Record<string, unknown> = {}) {
  return { request_id: 'pdf:1', html_path: HTML, pdf_path: PDF, timeout_ms: 1000, ...overrides }
}

function fakeDeps(opts: { print?: () => Promise<Buffer>; load?: () => Promise<void> } = {}) {
  let beforeRequest: ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void) | null = null
  const ses = {
    webRequest: { onBeforeRequest: vi.fn((listener) => { beforeRequest = listener }) },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setProxy: vi.fn(async () => undefined),
  }
  const win = {
    destroyed: false,
    isDestroyed: () => win.destroyed,
    destroy: vi.fn(() => { win.destroyed = true }),
    loadURL: vi.fn(opts.load ?? (async () => undefined)),
    webContents: {
      printToPDF: vi.fn(opts.print ?? (async () => Buffer.from('%PDF-1.7'))),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    },
  }
  const deps = {
    createWindow: vi.fn(() => win),
    session: () => ses,
    writeFile: vi.fn(async () => undefined),
  } as unknown as PdfRenderDeps & { createWindow: ReturnType<typeof vi.fn>; writeFile: ReturnType<typeof vi.fn> }
  const allows = (url: string): boolean => {
    let cancel = true
    beforeRequest?.({ url }, (r) => { cancel = r.cancel })
    return !cancel
  }
  return { deps, win, ses, allows }
}

describe('parsePdfRenderRequest', () => {
  it('accepts the backend conversion folder', () => {
    expect(parsePdfRenderRequest(request(), ROOT)).toEqual(
      { requestId: 'pdf:1', htmlPath: HTML, pdfPath: PDF, timeoutMs: 1000 })
  })

  it.each([
    ['another folder', { html_path: '/etc/print.html', pdf_path: '/etc/out.pdf' }],
    ['a nested folder', { html_path: join(WORK, 'x', 'print.html'), pdf_path: join(WORK, 'x', 'out.pdf') }],
    ['a parent reference', { html_path: `${WORK}/../0123456789abcdef/print.html` }],
    ['other names', { pdf_path: join(WORK, 'evil.sh') }],
    ['split folders', { pdf_path: join(ROOT, 'fedcba9876543210', 'out.pdf') }],
    ['a relative path', { html_path: 'print.html' }],
    ['a huge timeout', { timeout_ms: 10 * 60_000 }],
    ['an extra key', { extra: 1 }],
  ])('refuses %s', (_label, overrides) => {
    const parsed = parsePdfRenderRequest(request(overrides), ROOT)
    expect(parsed).toMatchObject({ requestId: 'pdf:1' })
    expect('error' in parsed).toBe(true)
  })

  describe('with Windows paths', () => {
    const winRoot = 'C:\\Users\\me\\AppData\\Roaming\\Agent-Team\\channels-pdf'
    const winWork = `${winRoot}\\0123456789abcdef`
    const winRequest = (overrides: Record<string, unknown> = {}) =>
      request({ html_path: `${winWork}\\print.html`, pdf_path: `${winWork}\\out.pdf`, ...overrides })

    it('accepts the conversion folder the backend names with str(Path)', () => {
      expect(parsePdfRenderRequest(winRequest(), winRoot, win32)).toEqual({
        requestId: 'pdf:1', htmlPath: `${winWork}\\print.html`, pdfPath: `${winWork}\\out.pdf`, timeoutMs: 1000,
      })
    })

    it('compares without regard to case, as NTFS does', () => {
      expect(parsePdfRenderRequest(winRequest(), winRoot.replace('C:', 'c:').toLowerCase(), win32))
        .toMatchObject({ htmlPath: `${winWork}\\print.html` })
    })

    it.each([
      ['another folder', { html_path: 'C:\\Windows\\print.html', pdf_path: 'C:\\Windows\\out.pdf' }],
      ['another drive', { html_path: `D${winWork.slice(1)}\\print.html`, pdf_path: `D${winWork.slice(1)}\\out.pdf` }],
      ['a path without a drive', { html_path: `${winWork.slice(2)}\\print.html`, pdf_path: `${winWork.slice(2)}\\out.pdf` }],
      ['a parent reference', { html_path: `${winWork}\\..\\0123456789abcdef\\print.html` }],
      ['a UNC share', { html_path: '\\\\host\\share\\0123456789abcdef\\print.html' }],
    ])('refuses %s', (_label, overrides) => {
      expect('error' in parsePdfRenderRequest(winRequest(overrides), winRoot, win32)).toBe(true)
    })
  })

  it('has no id to answer when the request carries none', () => {
    expect(parsePdfRenderRequest({}, ROOT)).toEqual({ requestId: null, error: 'malformed request' })
  })
})

describe('renderPdf', () => {
  it('prints A4 with backgrounds in a script-less sandboxed hidden window, then destroys it', async () => {
    const { deps, win } = fakeDeps()
    await expect(renderPdf(HTML, PDF, 1000, deps)).resolves.toEqual({ ok: true, bytes: 8 })
    const options = deps.createWindow.mock.calls[0][0]
    expect(options.show).toBe(false)
    expect(options.webPreferences).toMatchObject(
      { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true })
    expect(win.loadURL).toHaveBeenCalledWith(pathToFileURL(HTML).href)
    expect(win.webContents.printToPDF).toHaveBeenCalledWith(PRINT_OPTIONS)
    expect(PRINT_OPTIONS).toMatchObject({ pageSize: 'A4', printBackground: true })
    expect(deps.writeFile).toHaveBeenCalledWith(PDF, Buffer.from('%PDF-1.7'))
    expect(win.destroy).toHaveBeenCalled()
  })

  it('cancels every other request while a page loads', async () => {
    const results: Record<string, boolean> = {}
    const fake = fakeDeps({
      load: async () => {
        for (const url of [pathToFileURL(HTML).href, 'data:image/png;base64,AA', 'https://example.com/x.png',
          'file:///etc/passwd', pathToFileURL(PDF).href, 'ws://127.0.0.1:1/']) {
          results[url] = fake.allows(url)
        }
      },
    })
    await renderPdf(HTML, PDF, 1000, fake.deps)
    expect(Object.values(results)).toEqual([true, true, false, false, false, false])
    expect(fake.allows(pathToFileURL(HTML).href)).toBe(false) // closed again once printed
  })

  it('denies new windows, navigation and permissions', async () => {
    const { deps, win, ses } = fakeDeps()
    await renderPdf(HTML, PDF, 1000, deps)
    expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
    const events = win.webContents.on.mock.calls.map((c: unknown[]) => c[0])
    expect(events).toEqual(expect.arrayContaining(['will-navigate', 'will-redirect']))
    const prevent = vi.fn()
    for (const call of win.webContents.on.mock.calls) (call[1] as (e: unknown) => void)({ preventDefault: prevent })
    expect(prevent).toHaveBeenCalledTimes(2)
    const answer = vi.fn()
    ses.setPermissionRequestHandler.mock.calls[0][0]({}, 'media', answer)
    expect(answer).toHaveBeenCalledWith(false)
    expect(ses.setProxy).toHaveBeenCalledWith({ proxyRules: '127.0.0.1:9', proxyBypassRules: '' })
  })

  it('gives up after the timeout and destroys the window', async () => {
    const { deps, win } = fakeDeps({ load: () => new Promise(() => undefined) })
    await expect(renderPdf(HTML, PDF, 20, deps)).resolves.toMatchObject({ ok: false, error_code: 'timeout' })
    expect(win.destroy).toHaveBeenCalled()
    expect(deps.writeFile).not.toHaveBeenCalled()
  })

  it('reports a failed print without throwing', async () => {
    const { deps, win } = fakeDeps({ print: async () => { throw new Error('print failed') } })
    await expect(renderPdf(HTML, PDF, 1000, deps)).resolves.toEqual(
      { ok: false, error_code: 'error', error: 'print failed' })
    expect(win.destroy).toHaveBeenCalled()
  })

  it('serves one request at a time', async () => {
    let running = 0
    let most = 0
    const { deps } = fakeDeps({
      print: async () => {
        running += 1
        most = Math.max(most, running)
        await new Promise((r) => setTimeout(r, 5))
        running -= 1
        return Buffer.from('%PDF-')
      },
    })
    await Promise.all([renderPdf(HTML, PDF, 1000, deps), renderPdf(HTML, PDF, 1000, deps)])
    expect(most).toBe(1)
  })
})

describe('handlePdfRenderRequest', () => {
  it('answers with the request id', async () => {
    const { deps } = fakeDeps()
    const client = { send: vi.fn(async (_type: string, _payload: Record<string, unknown>, _timeoutMs: number) => undefined) }
    await handlePdfRenderRequest(client, request(), ROOT, deps)
    expect(client.send).toHaveBeenCalledWith(
      PDF_RENDER_RESULT, { request_id: 'pdf:1', response: { ok: true, bytes: 8 } }, 10_000)
  })

  it('refuses a request outside the conversion folder without printing', async () => {
    const { deps } = fakeDeps()
    const client = { send: vi.fn(async (_type: string, _payload: Record<string, unknown>, _timeoutMs: number) => undefined) }
    await handlePdfRenderRequest(client, request({ html_path: '/etc/print.html' }), ROOT, deps)
    expect(deps.createWindow).not.toHaveBeenCalled()
    expect(client.send.mock.calls[0][1]).toMatchObject({ response: { ok: false, error_code: 'bad_request' } })
  })

  it('uses the backend data folder by default', async () => {
    const { deps } = fakeDeps()
    const client = { send: vi.fn(async (_type: string, _payload: Record<string, unknown>, _timeoutMs: number) => undefined) }
    await handlePdfRenderRequest(client, request(), undefined, deps)
    expect(client.send.mock.calls[0][1]).toMatchObject({ response: { ok: true } })
  })
})
