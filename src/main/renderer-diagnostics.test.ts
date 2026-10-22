import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CONSOLE_BURST,
  CONSOLE_LINE_MAX_BYTES,
  CONSOLE_WINDOW_MS,
  type ConsoleMessage,
  watchConsoleMessages,
  watchProcessGone,
} from './renderer-diagnostics'
import { isRendererCrashWatched, watchRendererCrashes } from './renderer-crash-reload'

function fakeContents(url = 'file:///app/out/renderer/index.html') {
  let listener: ((e: ConsoleMessage) => void) | undefined
  const contents = {
    id: 7,
    url,
    getType: () => 'window',
    getURL: () => contents.url,
    on: (_event: 'console-message', l: (e: ConsoleMessage) => void) => {
      listener = l
    },
  }
  const emit = (level: string, message: string, sourceId = 'file:///app/out/renderer/assets/index.js', lineNumber = 12) =>
    listener?.({ level, message, sourceId, lineNumber })
  return { contents, emit }
}

describe('watchConsoleMessages', () => {
  it('logs warnings and errors as one line with level, contents and source', () => {
    const lines: string[] = []
    const { contents, emit } = fakeContents()
    watchConsoleMessages(contents, { log: (l) => lines.push(l) })

    emit('error', 'Uncaught TypeError: x is undefined\n    at boot (index.js:12)')
    emit('warning', 'deprecated')

    expect(lines).toEqual([
      '[renderer-console] error wc=7 type=window src=file:///app/out/renderer/assets/index.js:12 Uncaught TypeError: x is undefined |     at boot (index.js:12)',
      '[renderer-console] warning wc=7 type=window src=file:///app/out/renderer/assets/index.js:12 deprecated',
    ])
  })

  it('drops info, log and debug lines, which can carry user content', () => {
    const lines: string[] = []
    const { contents, emit } = fakeContents()
    watchConsoleMessages(contents, { log: (l) => lines.push(l) })

    emit('info', 'typed: my secret note')
    emit('debug', 'x')
    emit('verbose', 'y')

    expect(lines).toEqual([])
  })

  it("skips a web page's own console but keeps the dev server's", () => {
    const lines: string[] = []
    const web = fakeContents('https://example.com/inbox')
    watchConsoleMessages(web.contents, { log: (l) => lines.push(l), appOrigin: 'http://localhost:5173' })
    web.emit('error', 'site error')
    const dev = fakeContents('http://localhost:5173/')
    watchConsoleMessages(dev.contents, { log: (l) => lines.push(l), appOrigin: 'http://localhost:5173' })
    dev.emit('error', 'app error')

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('app error')
  })

  it('cuts a long message and strips the query from the source', () => {
    const lines: string[] = []
    const { contents, emit } = fakeContents()
    watchConsoleMessages(contents, { log: (l) => lines.push(l) })

    emit('error', 'é'.repeat(CONSOLE_LINE_MAX_BYTES), 'app://plugin/main.js?token=abc#x', 3)

    expect(lines[0]).toContain('src=app://plugin/main.js:3 ')
    expect(lines[0]).not.toContain('token')
    const text = lines[0].split('main.js:3 ')[1]
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(CONSOLE_LINE_MAX_BYTES)
  })

  it('writes at most a burst per window, then one line saying how many were dropped', () => {
    const lines: string[] = []
    let t = 1000
    const { contents, emit } = fakeContents()
    watchConsoleMessages(contents, { log: (l) => lines.push(l), now: () => t })

    for (let i = 0; i < CONSOLE_BURST + 5; i++) emit('error', `e${i}`)
    expect(lines).toHaveLength(CONSOLE_BURST)

    t += CONSOLE_WINDOW_MS
    emit('error', 'next')
    expect(lines.slice(CONSOLE_BURST)).toEqual([
      '[renderer-console] wc=7 type=window suppressed 5 more warning/error lines',
      '[renderer-console] error wc=7 type=window src=file:///app/out/renderer/assets/index.js:12 next',
    ])
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
    expect(main.slice(at, main.indexOf('\n})', at))).toContain('watchConsoleMessages(contents')
    expect(main).toContain('watchProcessGone(app, { log: warnMain, alreadyWatched: isRendererCrashWatched })')
  })
})
