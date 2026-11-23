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

/**
 * How the interface scale reaches a WebContents of this `type`.
 *
 * Every page is pinned to the scale on load. A `<webview>` guest is not
 * tracked: Electron hands it its embedder's zoom whenever that changes, and
 * the guest does not compound it (a 110% embedder measures a 1.1 guest, not
 * 1.21). A native WebContentsView composites outside the DOM and gets no such
 * hand-down, so the store tracks it. Pinning a guest to 1 on load, as before,
 * showed the left-sidebar views at 100% inside a 125% window after a restart.
 */
export function interfaceScalePolicy(
  type: string,
  scale: () => number,
): { track: boolean; factor: () => number } {
  return { track: type !== 'webview', factor: scale }
}
