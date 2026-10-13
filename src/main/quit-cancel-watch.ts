/**
 * Once before-quit lets the native quit proceed, Electron closes every window
 * and cancels the whole quit — silently, with no event — if any one of those
 * closes is prevented (a renderer's beforeunload, or a close participant that
 * showed up after the quit was prepared). The app then keeps running with its
 * quit flags still set. The only sign is that 'quit' never comes (nor does it
 * when a will-quit listener prevents the quit), so the quit is given a
 * deadline to reach it.
 */
export interface QuitCancelWatchDeps {
  timeoutMs: number
  /** Titles of the windows still open. The quit closes every window, so the
   *  ones that survived are what stopped it. */
  openWindowTitles(): string[]
  onCancelled(openWindowTitles: string[]): void
}

export interface QuitCancelWatch {
  /** before-quit let the native quit proceed. */
  arm(): void
  /** 'quit': the quit got past closing the windows and will-quit. */
  disarm(): void
}

export function createQuitCancelWatch(deps: QuitCancelWatchDeps): QuitCancelWatch {
  let timer: ReturnType<typeof setTimeout> | null = null
  function disarm(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }
  function arm(): void {
    disarm()
    timer = setTimeout(() => {
      timer = null
      deps.onCancelled(deps.openWindowTitles())
    }, deps.timeoutMs)
  }
  return { arm, disarm }
}

export interface QuitCancelResetDeps {
  /** dockQuitInProgress and quittingWindowsPrepared. */
  clearQuitFlags(): void
  clearCleanExit(): void
  /** Whether the teardown stopped the backend for this quit; reading it
   *  consumes it, so only one cancel brings the teardown back. */
  takeTeardownRan(): boolean
  restartBackend(): Promise<unknown>
  reopenBackendPlugins(): void
  /** Lifts the shutdown screen. */
  broadcastCancelled(): void
}

/**
 * Undoes a quit that did not happen, wherever it was cancelled. Telling the
 * user why is left to the caller: a refusal has already said so itself.
 */
export function createQuitCancelReset(deps: QuitCancelResetDeps): () => Promise<void> {
  return async () => {
    deps.clearQuitFlags()
    deps.clearCleanExit()
    // The teardown stopped the backend and the plugin backends and put up the
    // shutdown screen; the app is staying, so bring them back.
    if (!deps.takeTeardownRan()) return
    try {
      await deps.restartBackend()
    } catch (err) {
      console.error('[main] restarting the backend after a cancelled quit failed', err)
    }
    deps.reopenBackendPlugins()
    deps.broadcastCancelled()
  }
}
