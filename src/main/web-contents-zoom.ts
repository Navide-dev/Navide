import type { WebContents } from 'electron'

type ZoomLockedWebContents = Pick<
  WebContents,
  'on' | 'setVisualZoomLevelLimits' | 'setZoomFactor'
>

/**
 * Pin Electron's page zoom to the factor the app owns.
 *
 * Chromium can retain a zoom factor for an origin across reloads, and pinch
 * gestures would change it behind the app's back. Pin it whenever a document
 * commits and again after it finishes loading, while disabling pinch/visual
 * zoom. The pinned value is the user's interface-scale setting (`getFactor`),
 * defaulting to 1 when the caller owns no scale — so a WebContents with no
 * scale source behaves exactly as before.
 *
 * Nothing runs while the WebContents is being created: `web-contents-created`
 * hands it over before its render frame exists, and Electron 45 throws
 * "Render frame was disposed before WebFrameMain could be accessed" from a
 * frame-backed call then. Thrown out of that listener, the error failed the
 * `new BrowserWindow()` / `new WebContentsView()` that created it. Each call is
 * also guarded, so a frame torn down mid-load is logged, never thrown.
 *
 * Terminal and editor font-size shortcuts remain independent and continue to
 * work in the renderer; interface scale multiplies on top of them, the way a
 * browser's page zoom multiplies with a site's own font size.
 */
export function lockPageZoom(
  contents: ZoomLockedWebContents,
  getFactor: () => number = () => 1,
  log: (line: string) => void = console.warn,
): void {
  const guarded = (name: string, call: () => unknown): void => {
    const report = (err: unknown): void =>
      log(`[zoom] ${name} failed: ${err instanceof Error ? err.message : String(err)}`)
    try {
      const result = call()
      if (result instanceof Promise) result.catch(report)
    } catch (err) {
      report(err)
    }
  }
  const pinPageZoom = (): void => {
    const factor = getFactor()
    guarded('setZoomFactor', () =>
      contents.setZoomFactor(Number.isFinite(factor) && factor > 0 ? factor : 1),
    )
  }

  contents.on('did-navigate', pinPageZoom)
  contents.on('did-finish-load', () => {
    pinPageZoom()
    guarded('setVisualZoomLevelLimits', () => contents.setVisualZoomLevelLimits(1, 1))
  })
  contents.on('zoom-changed', pinPageZoom)
}
