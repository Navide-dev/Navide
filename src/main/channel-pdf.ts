/**
 * Prints a chat attachment's HTML to an A4 PDF for the backend
 * (backend/agent_team_backend/channels/pdf.py).
 *
 * The backend writes a print copy into `<backend data>/channels-pdf/<16 hex>/print.html`
 * and sends `channels.pdf_render.request` on the Host socket; this loads that one file in
 * a hidden window with JavaScript off, in an in-memory session that cancels every request
 * except the file itself and `data:` URLs, prints it to `out.pdf` beside it, and answers
 * `channels.pdf_render.result`. A window that has not printed within the timeout is
 * destroyed. Requests are served one at a time.
 */
import { BrowserWindow, session as electronSession } from 'electron'
import type { BrowserWindowConstructorOptions, PrintToPDFOptions, Session } from 'electron'
import { writeFile } from 'node:fs/promises'
import path, { join, type PlatformPath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { backendDataDir } from './backend'

export const PDF_RENDER_REQUEST = 'channels.pdf_render.request'
export const PDF_RENDER_RESULT = 'channels.pdf_render.result'
export const PDF_RENDER_MAX_TIMEOUT_MS = 120_000
export const PDF_PARTITION = 'channel-pdf' // no "persist:" prefix: memory only

const WORK_DIR_RE = /^[0-9a-f]{16}$/
// 12 mm on every side, in inches.
const MARGIN_IN = 0.47
export const PRINT_OPTIONS: PrintToPDFOptions = {
  pageSize: 'A4',
  printBackground: true,
  margins: { top: MARGIN_IN, bottom: MARGIN_IN, left: MARGIN_IN, right: MARGIN_IN },
}

export type PdfRenderResponse =
  | { ok: true; bytes: number }
  | { ok: false; error_code: 'bad_request' | 'timeout' | 'error'; error: string }

export interface PdfRenderRequest {
  requestId: string
  htmlPath: string
  pdfPath: string
  timeoutMs: number
}

/** The request, or why it is refused (with its id when it had one, to answer it).
 *  `paths` is the platform's path module; tests pass `path.win32` to check Windows. */
export function parsePdfRenderRequest(
  payload: unknown,
  root: string,
  paths: PlatformPath = path,
): PdfRenderRequest | { requestId: string | null; error: string } {
  const { basename, dirname, isAbsolute, resolve } = paths
  // NTFS and the Windows API ignore case: C:\Users and c:\users are one folder.
  const same = paths.sep === '\\'
    ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string) => a === b
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const requestId = typeof record.request_id === 'string' && record.request_id ? record.request_id : null
  const keys = Object.keys(record).sort().join(',')
  if (requestId === null || keys !== 'html_path,pdf_path,request_id,timeout_ms') {
    return { requestId, error: 'malformed request' }
  }
  const { html_path: htmlPath, pdf_path: pdfPath, timeout_ms: timeoutMs } = record
  if (typeof htmlPath !== 'string' || typeof pdfPath !== 'string' || !isAbsolute(htmlPath) || !isAbsolute(pdfPath)) {
    return { requestId, error: 'paths must be absolute' }
  }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      timeoutMs > PDF_RENDER_MAX_TIMEOUT_MS) {
    return { requestId, error: 'bad timeout' }
  }
  // Only the backend's own conversion folder: <root>/<16 hex>/print.html and out.pdf.
  const work = dirname(resolve(htmlPath))
  if (resolve(htmlPath) !== htmlPath || resolve(pdfPath) !== pdfPath ||
      basename(htmlPath) !== 'print.html' || basename(pdfPath) !== 'out.pdf' ||
      !same(dirname(pdfPath), work) || !same(dirname(work), resolve(root)) || !WORK_DIR_RE.test(basename(work))) {
    return { requestId, error: 'not a conversion folder' }
  }
  return { requestId, htmlPath, pdfPath, timeoutMs }
}

export interface PdfWindow {
  loadURL(url: string): Promise<void>
  isDestroyed(): boolean
  destroy(): void
  webContents: {
    printToPDF(options: PrintToPDFOptions): Promise<Buffer>
    setWindowOpenHandler(handler: () => { action: 'deny' }): void
    on(event: 'will-navigate' | 'will-redirect', listener: (event: { preventDefault(): void }) => void): void
  }
}

export interface PdfRenderDeps {
  createWindow(options: BrowserWindowConstructorOptions): PdfWindow
  session(): Pick<Session, 'webRequest' | 'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setProxy'>
  writeFile(path: string, data: Buffer): Promise<void>
}

const allowedUrls = new Set<string>()
let guardedSession: object | null = null

/** Install the session's guards once: every request but an allowed file URL or data: is cancelled. */
function guard(ses: ReturnType<PdfRenderDeps['session']>): Promise<void> {
  if (guardedSession === ses) return Promise.resolve()
  guardedSession = ses
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !(allowedUrls.has(details.url) || details.url.startsWith('data:')) })
  })
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  // A second wall for anything that would not pass through webRequest (preconnects).
  return ses.setProxy({ proxyRules: '127.0.0.1:9', proxyBypassRules: '' })
}

export const defaultPdfRenderDeps: PdfRenderDeps = {
  createWindow: (options) => new BrowserWindow(options) as unknown as PdfWindow,
  session: () => electronSession.fromPartition(PDF_PARTITION),
  writeFile: (path, data) => writeFile(path, data, { mode: 0o600, flag: 'wx' }),
}

let queue: Promise<unknown> = Promise.resolve()

/** Print `htmlPath` to `pdfPath`; never throws. */
export function renderPdf(
  htmlPath: string,
  pdfPath: string,
  timeoutMs: number,
  deps: PdfRenderDeps = defaultPdfRenderDeps,
): Promise<PdfRenderResponse> {
  const run = queue.then(() => renderOne(htmlPath, pdfPath, timeoutMs, deps))
  queue = run.catch(() => undefined)
  return run
}

async function renderOne(
  htmlPath: string,
  pdfPath: string,
  timeoutMs: number,
  deps: PdfRenderDeps,
): Promise<PdfRenderResponse> {
  const url = pathToFileURL(htmlPath).href
  let win: PdfWindow | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  allowedUrls.add(url)
  try {
    const ses = deps.session()
    await guard(ses)
    const window = deps.createWindow({
      show: false,
      width: 794,
      height: 1123,
      webPreferences: {
        session: ses as Session,
        javascript: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    })
    win = window
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-redirect', (event) => event.preventDefault())
    const expired = new Promise<'timeout'>((done) => {
      timer = setTimeout(() => done('timeout'), timeoutMs)
    })
    const printed = (async () => {
      await window.loadURL(url)
      return window.webContents.printToPDF(PRINT_OPTIONS)
    })()
    const data = await Promise.race([printed, expired])
    if (data === 'timeout') {
      printed.catch(() => undefined)
      return { ok: false, error_code: 'timeout', error: `no PDF within ${timeoutMs} ms` }
    }
    await deps.writeFile(pdfPath, data)
    return { ok: true, bytes: data.length }
  } catch (error) {
    return { ok: false, error_code: 'error', error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timer !== null) clearTimeout(timer)
    allowedUrls.delete(url)
    if (win !== null && !win.isDestroyed()) win.destroy()
  }
}

export interface PdfRenderClient {
  send(type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown>
}

/** Where the backend keeps its conversion folders (channels/pdf.py PDF_DIRNAME). */
export function pdfRoot(): string {
  return join(backendDataDir(process.env), 'channels-pdf')
}

/** Serve one `channels.pdf_render.request` from the backend and answer it. */
export async function handlePdfRenderRequest(
  client: PdfRenderClient,
  payload: unknown,
  root: string = pdfRoot(),
  deps: PdfRenderDeps = defaultPdfRenderDeps,
): Promise<void> {
  const request = parsePdfRenderRequest(payload, root)
  let response: PdfRenderResponse
  if ('error' in request) {
    console.warn(`[channel-pdf] request ${request.requestId ?? '(no request_id)'} refused: ${request.error}`)
    if (request.requestId === null) return
    response = { ok: false, error_code: 'bad_request', error: request.error }
  } else {
    response = await renderPdf(request.htmlPath, request.pdfPath, request.timeoutMs, deps)
  }
  await client.send(PDF_RENDER_RESULT, { request_id: request.requestId, response }, 10_000).catch(() => {
    // The backend waits with its own timeout; a closed socket is reported there.
  })
}
