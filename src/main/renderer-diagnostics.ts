import type { Details, RenderProcessGoneDetails } from 'electron'
import { PLUGIN_FRAME_SCHEME } from './plugins/pluginFrameAssetProtocol'

/**
 * Renderer and child-process evidence for the logs folder.
 *
 * A packaged launch discards stdout, and nothing forwarded a renderer's own
 * console: a window that came up black on Windows left no error anywhere, and
 * neither did a GPU process that died under it. These listeners keep the
 * failures — console warnings and errors, a renderer or child process that
 * went away — and nothing else.
 *
 * Console lines are kept only from Navide's own pages: the main frame of a
 * contents showing a file: page, a plugin frame or the dev server. Subframes
 * (plan HTML, file previews), web pages, about:blank, data:, blob: and error
 * pages are never recorded, nor are info/log/debug lines, which is where page
 * content and user text end up.
 *
 * Nothing is capped or cut: a message repeated back to back is written once
 * and then counted, so a loop of one error costs one line plus a count.
 */

/** A run of one repeated message is reported this long after it started, or
 *  as soon as a different message arrives, whichever comes first. */
export const CONSOLE_REPEAT_FLUSH_MS = 10_000

interface FrameRef {
  url: string
  frameTreeNodeId: number
}

export interface ConsoleMessage {
  level: string
  message: string
  sourceId: string
  lineNumber: number
  /** The frame that logged it; null once that frame is gone. */
  frame: FrameRef | null
}

/** The slice of a WebContents the console listener needs. */
export interface ConsoleWatchedContents {
  id: number
  getType(): string
  readonly mainFrame: FrameRef
  on(event: 'console-message', listener: (event: ConsoleMessage) => void): unknown
  on(event: 'render-process-gone', listener: () => void): unknown
  once(event: 'destroyed', listener: () => void): unknown
}

export interface DiagnosticsOptions {
  log: (line: string) => void
}

/** A script URL without its query or fragment, which can carry tokens; a
 *  data: URL is the script itself, so only its scheme is kept. */
function sourceLabel(sourceId: string, lineNumber: number): string {
  if (/^data:/i.test(sourceId || '')) return `data::${lineNumber}`
  const src = (sourceId || '').replace(/[?#].*$/, '')
  return src ? `${src}:${lineNumber}` : '?'
}

/** A page Navide serves itself: file:, a plugin frame, or the dev server. */
function isAppPage(url: string, appOrigin: string | null): boolean {
  try {
    const u = new URL(url)
    if (appOrigin && u.origin === appOrigin) return true
    return u.protocol === 'file:' || u.protocol === `${PLUGIN_FRAME_SCHEME}:`
  } catch {
    return false
  }
}

/** Whether the main frame of an app page logged this message. Frames are
 *  compared by frame tree node id, which a main frame keeps across navigations. */
function fromAppMainFrame(contents: ConsoleWatchedContents, event: ConsoleMessage, appOrigin: string | null): boolean {
  const frame = event.frame
  if (!frame) return false
  try {
    if (frame.frameTreeNodeId !== contents.mainFrame.frameTreeNodeId) return false
  } catch {
    return false
  }
  return isAppPage(frame.url, appOrigin)
}

/** Log the console warnings and errors of a contents' app main frame, one line
 *  each; a message repeated back to back is written once and then counted. */
export function watchConsoleMessages(
  contents: ConsoleWatchedContents,
  opts: DiagnosticsOptions & { appOrigin?: string | null },
): void {
  const appOrigin = opts.appOrigin ?? null
  let last = ''
  let repeats = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const who = `wc=${contents.id} type=${contents.getType()}`

  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (repeats > 0) opts.log(`[renderer-console] ${who} previous message repeated ${repeats} more times`)
    repeats = 0
  }

  contents.on('console-message', (event) => {
    if (event.level !== 'warning' && event.level !== 'error') return
    if (!fromAppMainFrame(contents, event, appOrigin)) return
    const text = String(event.message ?? '').replace(/\r?\n/g, ' | ')
    const line = `[renderer-console] ${event.level} ${who} src=${sourceLabel(event.sourceId, event.lineNumber)} ${text}`
    if (line === last) {
      repeats++
      timer ??= setTimeout(flush, CONSOLE_REPEAT_FLUSH_MS)
      return
    }
    flush()
    last = line
    opts.log(line)
  })
  // A black window or a crash ends the stream: write the pending count first.
  contents.on('render-process-gone', flush)
  contents.once('destroyed', flush)
}

/** The slice of `app` the process-gone listeners need. */
export interface ProcessGoneSource {
  on(
    event: 'render-process-gone',
    listener: (event: unknown, contents: { id: number; getType(): string }, details: RenderProcessGoneDetails) => void,
  ): unknown
  on(event: 'child-process-gone', listener: (event: unknown, details: Details) => void): unknown
}

/**
 * Log every renderer and child process (GPU, utility, ...) that goes away for
 * any reason but a clean exit. A renderer whose window already logs its own
 * crash (watchRendererCrashes) is left to that line so it is not written twice.
 */
export function watchProcessGone(
  source: ProcessGoneSource,
  opts: DiagnosticsOptions & { alreadyWatched: (contents: { id: number }) => boolean },
): void {
  source.on('render-process-gone', (_event, contents, details) => {
    if (details.reason === 'clean-exit' || opts.alreadyWatched(contents)) return
    opts.log(
      `[main] renderer gone wc=${contents.id} type=${contents.getType()} reason=${details.reason} exitCode=${details.exitCode}`,
    )
  })
  source.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    const extra = [details.name && `name=${details.name}`, details.serviceName && `service=${details.serviceName}`]
      .filter(Boolean)
      .join(' ')
    opts.log(
      `[main] child process gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}${extra ? ` ${extra}` : ''}`,
    )
  })
}
