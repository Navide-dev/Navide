import type { RenderProcessGoneDetails } from 'electron'

/** The slice of a BrowserWindow this needs, so tests can drive it with a fake. */
export interface CrashWatchedWindow {
  isDestroyed(): boolean
  webContents: {
    on(event: 'render-process-gone', listener: (event: unknown, details: RenderProcessGoneDetails) => void): unknown
    on(event: 'unresponsive' | 'responsive', listener: () => void): unknown
    isDestroyed(): boolean
    reload(): void
  }
}

export interface RendererCrashWatchOptions {
  /** Which kind of window this is ('main', 'plans', ...), for the log line. */
  kind: string
  log: (line: string) => void
  now?: () => number
  /** At most this many automatic reloads inside `windowMs`. */
  maxReloads?: number
  windowMs?: number
}

export const RENDERER_RELOAD_MAX = 3
export const RENDERER_RELOAD_WINDOW_MS = 60_000

/**
 * Reload a window whose renderer process died, so it reconnects and its panes
 * reattach to the PTYs the backend kept alive. Without this a killed renderer
 * left a blank window behind and never reconnected, and the backend's
 * ownerless-PTY janitor eventually killed every pane it had owned.
 *
 * Bounded: a renderer that keeps crashing is reloaded at most `maxReloads`
 * times per `windowMs`, then left as it is so a crash loop cannot spin.
 */
export function watchRendererCrashes(win: CrashWatchedWindow, opts: RendererCrashWatchOptions): void {
  const now = opts.now ?? Date.now
  const maxReloads = opts.maxReloads ?? RENDERER_RELOAD_MAX
  const windowMs = opts.windowMs ?? RENDERER_RELOAD_WINDOW_MS
  const reloadTimes: number[] = []
  const contents = win.webContents

  contents.on('render-process-gone', (_event, details) => {
    const what = `[main] renderer gone kind=${opts.kind} reason=${details.reason} exitCode=${details.exitCode}`
    if (details.reason === 'clean-exit') {
      opts.log(`${what}; not reloading`)
      return
    }
    if (win.isDestroyed() || contents.isDestroyed()) {
      opts.log(`${what}; window already destroyed, not reloading`)
      return
    }
    const t = now()
    while (reloadTimes.length && t - reloadTimes[0] >= windowMs) reloadTimes.shift()
    if (reloadTimes.length >= maxReloads) {
      opts.log(`${what}; reload limit reached (${maxReloads} in ${windowMs}ms), leaving window as is`)
      return
    }
    reloadTimes.push(t)
    opts.log(`${what}; reloading (${reloadTimes.length}/${maxReloads})`)
    try {
      contents.reload()
    } catch (error) {
      opts.log(`[main] renderer reload failed kind=${opts.kind}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  contents.on('unresponsive', () => opts.log(`[main] renderer unresponsive kind=${opts.kind}`))
  contents.on('responsive', () => opts.log(`[main] renderer responsive again kind=${opts.kind}`))
}
