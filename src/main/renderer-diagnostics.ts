import type { Details, RenderProcessGoneDetails } from 'electron'
import { truncateUtf8Bytes } from './main-log'

/**
 * Renderer and child-process evidence for main.log.
 *
 * A packaged launch discards stdout, and nothing forwarded a renderer's own
 * console: a window that came up black on Windows left no error anywhere, and
 * neither did a GPU process that died under it. These listeners keep the
 * failures — console warnings and errors, a renderer or child process that
 * went away — and nothing else: console info/log/debug lines are dropped
 * because they are where page content and user text end up.
 */

export const CONSOLE_LINE_MAX_BYTES = 1000
/** At most this many console lines per WebContents inside `CONSOLE_WINDOW_MS`;
 *  the rest are counted and reported as one line when the next window opens. */
export const CONSOLE_BURST = 20
export const CONSOLE_WINDOW_MS = 10_000

export interface ConsoleMessage {
  level: string
  message: string
  sourceId: string
  lineNumber: number
}

/** The slice of a WebContents the console listener needs. */
export interface ConsoleWatchedContents {
  id: number
  getType(): string
  getURL(): string
  on(event: 'console-message', listener: (event: ConsoleMessage) => void): unknown
}

export interface DiagnosticsOptions {
  log: (line: string) => void
  now?: () => number
}

/** A script URL without its query or fragment, which can carry tokens. */
function sourceLabel(sourceId: string, lineNumber: number): string {
  const src = (sourceId || '').replace(/[?#].*$/, '')
  return src ? `${src}:${lineNumber}` : '?'
}

/** A page served from the web rather than by Navide: its console is the
 *  site's business and can echo what the user is doing there. */
function isWebPage(url: string, appOrigin: string | null): boolean {
  try {
    const u = new URL(url)
    if (appOrigin && u.origin === appOrigin) return false
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Log a WebContents' console warnings and errors, one line each, rate limited. */
export function watchConsoleMessages(
  contents: ConsoleWatchedContents,
  opts: DiagnosticsOptions & { appOrigin?: string | null },
): void {
  const now = opts.now ?? Date.now
  let windowStart = -Infinity
  let written = 0
  let suppressed = 0
  const who = (): string => `wc=${contents.id} type=${contents.getType()}`

  contents.on('console-message', (event) => {
    if (event.level !== 'warning' && event.level !== 'error') return
    if (isWebPage(contents.getURL(), opts.appOrigin ?? null)) return
    const t = now()
    if (t - windowStart >= CONSOLE_WINDOW_MS) {
      if (suppressed > 0) {
        opts.log(`[renderer-console] ${who()} suppressed ${suppressed} more warning/error lines`)
      }
      windowStart = t
      written = 0
      suppressed = 0
    }
    if (written >= CONSOLE_BURST) {
      suppressed++
      return
    }
    written++
    const text = truncateUtf8Bytes(String(event.message ?? '').replace(/\r?\n/g, ' | '), CONSOLE_LINE_MAX_BYTES)
    opts.log(`[renderer-console] ${event.level} ${who()} src=${sourceLabel(event.sourceId, event.lineNumber)} ${text}`)
  })
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
