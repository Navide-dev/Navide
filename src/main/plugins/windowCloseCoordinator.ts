import type { BrowserWindow, WebContents } from 'electron'
export type NativeWindowCloseReason = 'native-window-close' | 'reload' | 'quit'

export type WindowCloseOutcome =
  | { ok: true; id: string }
  | { ok: false; reason: 'refused' | 'busy' | 'unavailable' | 'timeout' }

export interface WindowCloseHost {
  hasWindowCloseParticipants(hostWindow: BrowserWindow): boolean
  /** Report a refused close preparation so the user sees why the close did not
   *  happen instead of reaching for a force-quit. */
  notifyCloseRefused?(window: BrowserWindow, reason: NativeWindowCloseReason, cause: string): void
  /** Report a participant that did not prepare for a forced quit. The quit goes
   *  ahead anyway, so this is a log line, never a question for the user. */
  logForcedQuitIgnored?(window: BrowserWindow, cause: string): void
  prepareWindowClose(hostWindow: BrowserWindow, reason: NativeWindowCloseReason): Promise<WindowCloseOutcome>
  commitWindowClose(id: string): void
  cancelWindowClose(id: string): void
  /** Main owns the Electron lookup so this coordinator stays runtime-free. */
  windowForWebContents(target: WebContents): BrowserWindow | null
}

/**
 * Call order for every main-driven close:
 *   1. `prepare…` returns `ok` only when receiver consent and each provider
 *      prepare have settled; refusal/busy/timeout leaves the window usable.
 *   2. `commitWindowClose` destroys the prepared provider items exactly once.
 *   3. Only then is the window destroyed (or the reload applied).
 */

export interface WindowCloseCoordinator {
  /** Intercept native close, prepare every participant, then destroy once. */
  watch(window: BrowserWindow): void
  /** Route the View > Reload Window action through the same preparation. */
  prepareAndReload(target: WebContents): Promise<boolean>
  /** Prepare every affected window before any window or backend is committed.
   *  A forced quit (SIGTERM, logout, shutdown) still gives every participant up
   *  to `deadlineMs` to save, but always resolves true: nothing can veto it. */
  prepareForQuit(windows: readonly BrowserWindow[], options?: QuitPreparationOptions): Promise<boolean>
}

export interface QuitPreparationOptions {
  forced?: boolean
  deadlineMs?: number
}

/** How long a forced quit waits for the participants, all windows together. */
export const FORCED_QUIT_PREPARE_MS = 5000

function findWindowFor(host: WindowCloseHost, target: WebContents): BrowserWindow | null {
  return host.windowForWebContents(target)
}

export function createWindowCloseCoordinator(host: WindowCloseHost): WindowCloseCoordinator {
  // A refused preparation must leave the window fully usable, so the mark only
  // spans one close attempt and is cleared on both success and failure.
  const closing = new Set<number>()

  function watch(window: BrowserWindow): void {
    window.on('close', (event) => {
      if (!host.hasWindowCloseParticipants(window)) return
      if (closing.has(window.id)) {
        event.preventDefault()
        return
      }
      event.preventDefault()
      closing.add(window.id)
      void (async () => {
        try {
          const preparation = await host.prepareWindowClose(window, 'native-window-close')
          if (!preparation.ok) {
            host.notifyCloseRefused?.(window, 'native-window-close', preparation.reason)
            return
          }
          host.commitWindowClose(preparation.id)
          if (!window.isDestroyed()) window.destroy()
        } catch {
          host.notifyCloseRefused?.(window, 'native-window-close', 'unavailable')
        } finally {
          closing.delete(window.id)
        }
      })()
    })
    window.once('closed', () => {
      closing.delete(window.id)
    })
  }

  async function prepareAndReload(target: WebContents): Promise<boolean> {
    if (target.isDestroyed()) return true
    const window = findWindowFor(host, target)
    if (!window || window.isDestroyed() || !host.hasWindowCloseParticipants(window)) return false
    if (closing.has(window.id)) {
      host.notifyCloseRefused?.(window, 'reload', 'busy')
      return true
    }
    closing.add(window.id)
    try {
      const preparation = await host.prepareWindowClose(window, 'reload')
      if (!preparation.ok) {
        host.notifyCloseRefused?.(window, 'reload', preparation.reason)
        return true
      }
      host.commitWindowClose(preparation.id)
      if (!target.isDestroyed()) target.reload()
    } catch {
      host.notifyCloseRefused?.(window, 'reload', 'unavailable')
    } finally {
      closing.delete(window.id)
    }
    return true
  }

  // Nothing a participant answers can keep the app running: refused, busy,
  // failed and late windows are logged, and every target is destroyed so its
  // own close guard cannot stop the quit on the way out either.
  async function prepareForForcedQuit(targets: readonly BrowserWindow[], deadlineMs: number): Promise<true> {
    const free = targets.filter((target) => {
      if (!closing.has(target.id)) return true
      host.logForcedQuitIgnored?.(target, 'busy')
      return false
    })
    for (const target of free) closing.add(target.id)
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve() }, deadlineMs)
    })
    const prepared: string[] = []
    const settled = new Set<BrowserWindow>()
    try {
      await Promise.race([
        Promise.all(free.map(async (target) => {
          let outcome: WindowCloseOutcome
          try {
            outcome = await host.prepareWindowClose(target, 'quit')
          } catch {
            outcome = { ok: false, reason: 'unavailable' }
          }
          // A preparation that settles after the deadline belongs to a quit
          // that has already gone ahead: release it instead of committing.
          if (timedOut) {
            if (outcome.ok) host.cancelWindowClose(outcome.id)
            return
          }
          settled.add(target)
          if (outcome.ok) prepared.push(outcome.id)
          else host.logForcedQuitIgnored?.(target, outcome.reason)
        })),
        deadline,
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    for (const target of free) if (!settled.has(target)) host.logForcedQuitIgnored?.(target, 'timeout')
    for (const id of prepared) host.commitWindowClose(id)
    for (const target of free) closing.delete(target.id)
    for (const target of targets) {
      if (!target.isDestroyed()) target.destroy()
    }
    return true
  }

  async function prepareForQuit(windows: readonly BrowserWindow[], options: QuitPreparationOptions = {}): Promise<boolean> {
    const targets = windows.filter((window) => !window.isDestroyed() && host.hasWindowCloseParticipants(window))
    if (targets.length === 0) return true
    if (options.forced) return prepareForForcedQuit(targets, options.deadlineMs ?? FORCED_QUIT_PREPARE_MS)
    const busy = targets.find((target) => closing.has(target.id))
    if (busy) {
      host.notifyCloseRefused?.(busy, 'quit', 'busy')
      return false
    }
    for (const target of targets) closing.add(target.id)
    const prepared: Array<{ id: string; window: BrowserWindow }> = []
    let committed = false
    try {
      for (const target of targets) {
        const preparation = await host.prepareWindowClose(target, 'quit')
        if (!preparation.ok) {
          host.notifyCloseRefused?.(target, 'quit', preparation.reason)
          return false
        }
        prepared.push({ id: preparation.id, window: target })
      }
      for (const { id } of prepared) host.commitWindowClose(id)
      committed = true
      for (const { window } of prepared) {
        if (!window.isDestroyed()) window.destroy()
      }
      return true
    } catch {
      host.notifyCloseRefused?.(targets[0], 'quit', 'unavailable')
      return false
    } finally {
      if (!committed) for (const { id } of prepared) host.cancelWindowClose(id)
      for (const target of targets) closing.delete(target.id)
    }
  }

  return { watch, prepareAndReload, prepareForQuit }
}
