import { isMac } from '../shared/osplat'

/**
 * Off macOS, closing the last window quits the app (`window-all-closed` →
 * `app.quit()`), and the quit confirmation in `before-quit` used to be the only
 * gate. By then the window is already destroyed, so Cancel left a windowless
 * process running — no dock entry, no way back in, the backend still up. The
 * prompt therefore has to run from the window's own `close` event, while a
 * Cancel can still veto it.
 *
 * macOS never quits on window close (the app stays in the Dock), so its prompt
 * stays where it is: ⌘Q, with the window still on screen.
 */
export function lastWindowCloseNeedsPrompt(args: {
  mac: boolean
  confirmEnabled: boolean
  quitConfirmed: boolean
  promptOpen: boolean
  liveWindows: number
}): boolean {
  if (args.mac || !args.confirmEnabled || args.quitConfirmed) return false
  // A second close while the dialog is up must not stack another dialog, but
  // it must still be vetoed: letting it through would destroy the window the
  // open dialog is parented to.
  if (args.promptOpen) return true
  return args.liveWindows <= 1
}

export interface LastWindowCloseDeps {
  liveWindows: () => number
  confirmEnabled: () => boolean
  quitConfirmed: () => boolean
  promptOpen: () => boolean
  /** Shows the quit dialog; resolves true when the user chose Quit. */
  ask: () => Promise<boolean>
  /** The user confirmed: mark the quit and start it (app.quit()). */
  quit: () => void
}

/** The `close` listener for a main window; returns whether the close was vetoed. */
export function guardLastWindowClose(e: { preventDefault(): void }, deps: LastWindowCloseDeps): boolean {
  if (!lastWindowCloseNeedsPrompt({
    mac: isMac(),
    confirmEnabled: deps.confirmEnabled(),
    quitConfirmed: deps.quitConfirmed(),
    promptOpen: deps.promptOpen(),
    liveWindows: deps.liveWindows(),
  })) return false
  e.preventDefault()
  if (deps.promptOpen()) return true
  void deps.ask().then((confirmed) => { if (confirmed) deps.quit() })
  return true
}
