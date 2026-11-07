import type { WebContents } from 'electron'

type ZoomLockedWebContents = Pick<
  WebContents,
  'on' | 'setVisualZoomLevelLimits' | 'setZoomFactor'
>

/**
 * Pin Electron's page zoom to the factor the app owns.
 *
 * Chromium can retain a zoom factor for an origin across reloads, and pinch
 * gestures would change it behind the app's back. Pin it as soon as the
 * WebContents exists and again after a document finishes loading, while
 * disabling pinch/visual zoom. The pinned value is the user's interface-scale
 * setting (`getFactor`), defaulting to 1 when the caller owns no scale —
 * so a WebContents with no scale source behaves exactly as before.
 *
 * Terminal and editor font-size shortcuts remain independent and continue to
 * work in the renderer; interface scale multiplies on top of them, the way a
 * browser's page zoom multiplies with a site's own font size.
 */
export function lockPageZoom(
  contents: ZoomLockedWebContents,
  getFactor: () => number = () => 1,
): void {
  const pinPageZoom = (): void => {
    const factor = getFactor()
    contents.setZoomFactor(Number.isFinite(factor) && factor > 0 ? factor : 1)
  }

  pinPageZoom()
  contents.on('did-finish-load', pinPageZoom)
  contents.on('zoom-changed', pinPageZoom)
  void contents.setVisualZoomLevelLimits(1, 1)
}
