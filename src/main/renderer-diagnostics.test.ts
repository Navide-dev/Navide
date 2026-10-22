import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CONSOLE_REPEAT_FLUSH_MS,
  type ConsoleMessage,
  watchConsoleMessages,
  watchProcessGone,
} from './renderer-diagnostics'
import { isRendererCrashWatched, watchRendererCrashes } from './renderer-crash-reload'
import { PLUGIN_FRAME_SCHEME } from './plugins/pluginFrameAssetProtocol'

const APP_JS = 'file:///app/out/renderer/assets/index.js'
const APP_PAGE = 'file:///app/out/renderer/index.html'

function fakeContents(url = APP_PAGE) {
  let listener: ((e: ConsoleMessage) => void) | undefined
  const ends: Record<string, () => void> = {}
  const mainFrame = { url, frameTreeNodeId: 1 }
  const contents = {
    id: 7,
    mainFrame,
    getType: () => 'window',
    on: (event: string, l: (e: ConsoleMessage) => void) => {
      if (event === 'console-message') listener = l
      else ends[event] = l as () => void
    },
    once: (event: string, l: () => void) => {
      ends[event] = l
    },
  }
  /** A message from the main frame unless `frame` says otherwise. */
  const emit = (level: string, message: string, extra: Partial<ConsoleMessage> = {}) =>
    listener?.({ level, message, sourceId: APP_JS, lineNumber: 12, frame: mainFrame, ...extra })
  return { contents, mainFrame, emit, end: (event: string) => ends[event]?.() }
}

function watch(url?: string, appOrigin: string | null = null) {
  const lines: string[] = []
  const fake = fakeContents(url)
  watchConsoleMessages(fake.contents, { log: (l) => lines.push(l), appOrigin })
  return { lines, ...fake }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('watchConsoleMessages', () => {
  it('logs warnings and errors as one line with level, contents and source', () => {
    const { lines, emit } = watch()

    emit('error', 'Uncaught TypeError: x is undefined\n    at boot (index.js:12)')
    emit('warning', 'deprecated')

    expect(lines).toEqual([
      `[renderer-console] error wc=7 type=window src=${APP_JS}:12 Uncaught TypeError: x is undefined |     at boot (index.js:12)`,
      `[renderer-console] warning wc=7 type=window src=${APP_JS}:12 deprecated`,
    ])
  })

  it('drops info, log and debug lines, which can carry user content', () => {
    const { lines, emit } = watch()

    emit('info', 'typed: my secret note')
    emit('debug', 'x')
    emit('verbose', 'y')

    expect(lines).toEqual([])
  })

  it('keeps a long message whole and strips the query from the source', () => {
    const { lines, emit } = watch(`${PLUGIN_FRAME_SCHEME}://git/index.html`)
    const long = 'é'.repeat(5000)

    emit('error', long, { sourceId: `${PLUGIN_FRAME_SCHEME}://git/main.js?token=abc#x`, lineNumber: 3 })

    expect(lines).toEqual([`[renderer-console] error wc=7 type=window src=${PLUGIN_FRAME_SCHEME}://git/main.js:3 ${long}`])
  })

  it('writes a data: script source as its scheme only', () => {
    const { lines, emit } = watch()
    emit('error', 'boom', { sourceId: 'data:text/javascript,console.error(secret)', lineNumber: 1 })
    expect(lines).toEqual(['[renderer-console] error wc=7 type=window src=data::1 boom'])
  })

  it('never drops a distinct message, however many arrive', () => {
    const { lines, emit } = watch()
    for (let i = 0; i < 500; i++) emit('error', `e${i}`)
    expect(lines).toHaveLength(500)
  })

  it('writes a repeated message once, then its count when a different one arrives', () => {
    vi.useFakeTimers()
    const { lines, emit } = watch()

    for (let i = 0; i < 4; i++) emit('error', 'same')
    emit('warning', 'other')

    expect(lines).toEqual([
      `[renderer-console] error wc=7 type=window src=${APP_JS}:12 same`,
      '[renderer-console] wc=7 type=window previous message repeated 3 more times',
      `[renderer-console] warning wc=7 type=window src=${APP_JS}:12 other`,
    ])
  })

  it('reports a run of repeats after 10 seconds', () => {
    vi.useFakeTimers()
    const { lines, emit } = watch()

    emit('error', 'same')
    emit('error', 'same')
    emit('error', 'same')
    expect(lines).toHaveLength(1)
    vi.advanceTimersByTime(CONSOLE_REPEAT_FLUSH_MS)
    expect(lines[1]).toBe('[renderer-console] wc=7 type=window previous message repeated 2 more times')
  })

  it.each(['render-process-gone', 'destroyed'])('writes the pending count on %s', (event) => {
    vi.useFakeTimers()
    const { lines, emit, end } = watch()
    emit('error', 'same')
    emit('error', 'same')
    end(event)
    expect(lines).toEqual([
      `[renderer-console] error wc=7 type=window src=${APP_JS}:12 same`,
      '[renderer-console] wc=7 type=window previous message repeated 1 more times',
    ])
  })

  it('records nothing from a contents the caller skips (the chat-attachment print window)', () => {
    const lines: string[] = []
    const fake = fakeContents()
    watchConsoleMessages(fake.contents, { log: (l) => lines.push(l), skip: (c) => c === fake.contents })
    fake.emit('error', 'Not allowed to load local resource: file:///Users/me/secret/photo.png')
    expect(lines).toEqual([])
  })

  it('keeps the dev server and skips a site', () => {
    const dev = watch('http://localhost:5173/', 'http://localhost:5173')
    dev.emit('error', 'app error', { sourceId: 'http://localhost:5173/src/main.ts' })
    const web = watch('https://example.com/inbox', 'http://localhost:5173')
    web.emit('error', 'site error')

    expect(dev.lines).toHaveLength(1)
    expect(web.lines).toEqual([])
  })

  it.each([
    'about:blank',
    'data:text/html,<p>note</p>',
    'blob:file:///4f1c',
    'chrome-error://chromewebdata/',
    'devtools://devtools/bundled/inspector.html',
    'http://example.com/',
  ])('skips a main frame showing %s', (url) => {
    const { lines, emit } = watch(url)
    emit('error', 'not ours')
    expect(lines).toEqual([])
  })

  it('skips a contents that loaded the app and then navigated to a site', () => {
    const { lines, emit, mainFrame } = watch()
    emit('error', 'before')
    mainFrame.url = 'https://example.com/'
    emit('error', 'after')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('before')
  })

  it('skips every subframe, even one showing an app page (plan HTML, file previews)', () => {
    const { lines, emit } = watch()
    emit('error', 'plan script', { frame: { url: APP_PAGE, frameTreeNodeId: 2 } })
    emit('error', 'preview', { frame: { url: 'about:srcdoc', frameTreeNodeId: 3 } })
    emit('error', 'gone frame', { frame: null })
    expect(lines).toEqual([])
  })
})

describe('watchProcessGone', () => {
  function fakeApp() {
    const handlers: Record<string, (...args: unknown[]) => void> = {}
    return {
      handlers,
      on: (event: string, l: (...args: unknown[]) => void) => {
        handlers[event] = l
      },
    }
  }

  it('logs a GPU process that died and ignores a clean exit', () => {
    const lines: string[] = []
    const app = fakeApp()
    watchProcessGone(app as never, { log: (l) => lines.push(l), alreadyWatched: () => false })

    app.handlers['child-process-gone']({}, { type: 'GPU', reason: 'crashed', exitCode: -1073741819, name: 'GPU' })
    app.handlers['child-process-gone']({}, { type: 'Utility', reason: 'clean-exit', exitCode: 0 })

    expect(lines).toEqual(['[main] child process gone type=GPU reason=crashed exitCode=-1073741819 name=GPU'])
  })

  it('logs a renderer only when its window does not log it already', () => {
    const lines: string[] = []
    const app = fakeApp()
    const watched = { id: 1, getType: () => 'window' }
    const other = { id: 2, getType: () => 'webview' }
    watchProcessGone(app as never, { log: (l) => lines.push(l), alreadyWatched: (c) => c === watched })

    app.handlers['render-process-gone']({}, watched, { reason: 'crashed', exitCode: 1 })
    app.handlers['render-process-gone']({}, other, { reason: 'oom', exitCode: 2 })
    app.handlers['render-process-gone']({}, other, { reason: 'clean-exit', exitCode: 0 })

    expect(lines).toEqual(['[main] renderer gone wc=2 type=webview reason=oom exitCode=2'])
  })

  it('treats a window watchRendererCrashes covers as already watched', () => {
    const webContents = { on: () => undefined, isDestroyed: () => false, reload: () => undefined }
    expect(isRendererCrashWatched(webContents)).toBe(false)
    watchRendererCrashes({ isDestroyed: () => false, webContents }, { kind: 'main', log: () => undefined })
    expect(isRendererCrashWatched(webContents)).toBe(true)
  })
})

describe('main wiring', () => {
  const main = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

  it('watches every WebContents and the app-level process events', () => {
    const at = main.indexOf("app.on('web-contents-created'")
    const handler = main.slice(at, main.indexOf('\n})', at))
    expect(handler).toContain('watchConsoleMessages(contents, {')
    expect(handler).toContain('log: logRendererConsole')
    // channel-pdf.ts prints a chat attachment from file: in its own partition.
    expect(handler).toContain('skip: () => contents.session === session.fromPartition(PDF_PARTITION)')
    expect(main).toContain('watchProcessGone(app, { log: warnMain, alreadyWatched: isRendererCrashWatched })')
  })
})
