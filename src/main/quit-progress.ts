import { BrowserWindow } from 'electron'

/**
 * Progress reporting for the quit sequence.
 *
 * Quitting is not instant: a backend that is still starting is waited for (up
 * to 3s), then the running one is stopped with a SIGTERM grace of its own
 * (up to 6s) during which the backend sweeps every PTY child. The windows stay
 * on screen for all of it with nothing to show for it, which reads as a hang.
 * Main narrates the stages instead, and the renderer puts up a shutdown screen.
 */
/** 'cancelled': the quit stopped after the shutdown screen went up and the app
 *  stays, so the screen comes down again. */
export type QuitStage = 'saving' | 'stopping' | 'closing' | 'cancelled'

export const QUIT_PROGRESS_CHANNEL = 'app:quitProgress'

/** The slice of BrowserWindow this needs, so tests do not need a real one. */
export interface QuitProgressWindow {
  isDestroyed(): boolean
  webContents: { send(channel: string, ...args: unknown[]): void }
}

/**
 * Announce a stage to every open window. Failures are swallowed: a window
 * tearing down mid-quit is expected, and nothing about the shutdown screen may
 * stand between the user and the app actually exiting.
 */
export function broadcastQuitStage(
  stage: QuitStage,
  windows: () => QuitProgressWindow[] = () => BrowserWindow.getAllWindows()
): void {
  let open: QuitProgressWindow[]
  try {
    open = windows()
  } catch {
    return
  }
  for (const win of open) {
    try {
      if (!win.isDestroyed()) win.webContents.send(QUIT_PROGRESS_CHANNEL, stage)
    } catch {
      /* window went away between the check and the send */
    }
  }
}
